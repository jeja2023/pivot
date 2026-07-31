/* 智能体 DAG 可视化编辑器 Agent DAG Visual Editor
 *
 * 用法：
 *   window.PivotDagEditor.mount({
 *       canvas:    HTMLElement,    // SVG 容器
 *       textarea:  HTMLTextAreaElement, // 双向同步的 JSON textarea
 *       toolbar:   HTMLElement,    // 工具栏容器（[+节点] 等按钮注入到这里）
 *       inspector: HTMLElement,    // 节点详情面板
 *       getTools:  () => [{name, title}], // 可用工具列表
 *       onChange:  (spec) => void,
 *       onOpenJson: () => void, // 打开高级 JSON 弹窗
 *       onNodeSelectionChange: (node|null) => void // 控制节点属性抽屉
 *   })
 *
 * 数据格式与 server/services/agent-validators.js 中的 normalizeDagSpec 完全一致：
 *   { nodes: [{ id, title, tool, input, dependsOn: [], condition: 'always'|'success' }] }
 *
 * 节点坐标通过根级 layout 元数据持久化；执行节点与视图状态保持分离。
 * 旧版节点内 _x/_y 坐标仍可读取，并会在下次同步时迁移到 layout。
 *
 * 设计原则：
 *   - 零依赖，纯原生 JS + SVG
 *   - 不破坏现有 textarea 的存在；textarea 仍可手动编辑作为"专家模式"
 *   - CSP 兼容：所有事件都用 addEventListener，无内联 onclick
 *   - 多次 mount 同一容器幂等：先 destroy 旧实例
 */
/* global createDagIcon, placeNewNode */
(function () {
if (window.PivotDagEditor) return;

function mount({ canvas, textarea, toolbar, inspector, getTools, onChange, onOpenJson, onNodeSelectionChange }) {
        if (!canvas) return null;

        // 幂等：如果已有实例先销毁
        if (canvas._pivotDagDestroy) canvas._pivotDagDestroy();

        const initialParsedSpec = readJson(textarea ? textarea.value : '');
        let spec = ensureDefaults(initialParsedSpec);
        const shouldFlushInitialDefaults = !Array.isArray(initialParsedSpec?.nodes) || initialParsedSpec.nodes.length === 0;
        let selectedId = null;
        let pendingFlush = null;
        let suppressTextareaSync = false;
        let toolbarStatus = null;
        // v0.0.51 缩放与平移状态：内容坐标原点固定，通过 viewBox 偏移 + 缩放呈现
        const viewState = { x: 0, y: 0, scale: DEFAULT_VIEW_SCALE };

        const root = makeSvgEl('svg', {
            class: 'pivot-dag-svg',
            xmlns: SVG_NS,
            preserveAspectRatio: 'xMinYMin meet'
        });
        const defs = makeSvgEl('defs');
        const marker = makeSvgEl('marker', {
            id: 'pivot-dag-arrow',
            viewBox: '0 0 10 10',
            refX: 9,
            refY: 5,
            markerWidth: 6,
            markerHeight: 6,
            orient: 'auto-start-reverse'
        });
        marker.appendChild(makeSvgEl('path', { d: 'M0,0 L10,5 L0,10 z', fill: '#94a3b8' }));
        defs.appendChild(marker);
        root.appendChild(defs);
        const edgesLayer = makeSvgEl('g', { class: 'pivot-dag-edges' });
        const nodesLayer = makeSvgEl('g', { class: 'pivot-dag-nodes' });
        root.appendChild(edgesLayer);
        root.appendChild(nodesLayer);
        canvas.replaceChildren(root);

        // 小地图 overlay：固定在 canvas 右下角，独立 SVG，点击跳转视口
        const minimap = (() => {
            const wrap = document.createElement('div');
            wrap.className = 'pivot-dag-minimap';
            const mini = makeSvgEl('svg', { class: 'pivot-dag-minimap-svg', xmlns: SVG_NS });
            const miniNodes = makeSvgEl('g', { class: 'pivot-dag-minimap-nodes' });
            const viewport = makeSvgEl('rect', { class: 'pivot-dag-minimap-viewport', fill: 'rgba(59,130,246,0.18)', stroke: '#3b82f6', 'stroke-width': 1.5 });
            mini.appendChild(miniNodes);
            mini.appendChild(viewport);
            wrap.appendChild(mini);
            canvas.appendChild(wrap);
            return { wrap, svg: mini, nodesLayer: miniNodes, viewport };
        })();

        const updateMinimap = () => {
            if (!minimap) return;
            const { width, height } = contentBounds();
            minimap.svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
            minimap.nodesLayer.replaceChildren();
            spec.nodes.forEach(node => {
                const rect = makeSvgEl('rect', {
                    x: node._x,
                    y: node._y,
                    width: NODE_WIDTH,
                    height: NODE_HEIGHT,
                    rx: 4,
                    ry: 4,
                    fill: selectedId === node.id
                        ? '#3b82f6'
                        : isLlmNode(node) ? '#5eead4' : '#cbd5e1',
                    opacity: '0.7'
                });
                minimap.nodesLayer.appendChild(rect);
            });
            // 视口框：viewState 对应内容坐标系下的矩形
            const vbWidth = width / viewState.scale;
            const vbHeight = height / viewState.scale;
            minimap.viewport.setAttribute('x', viewState.x);
            minimap.viewport.setAttribute('y', viewState.y);
            minimap.viewport.setAttribute('width', vbWidth);
            minimap.viewport.setAttribute('height', vbHeight);
        };

        // 点击小地图：把视口中心移到点击位置
        const minimapClickHandler = (event) => {
            const rect = minimap.svg.getBoundingClientRect();
            const { width, height } = contentBounds();
            const contentX = (event.clientX - rect.left) * width / rect.width;
            const contentY = (event.clientY - rect.top) * height / rect.height;
            const vbWidth = width / viewState.scale;
            const vbHeight = height / viewState.scale;
            viewState.x = Math.max(0, contentX - vbWidth / 2);
            viewState.y = Math.max(0, contentY - vbHeight / 2);
            updateViewBox();
        };
        minimap.svg.addEventListener('click', minimapClickHandler);

        const flushOut = () => {
            if (pendingFlush) caf(pendingFlush);
            pendingFlush = raf(() => {
                pendingFlush = null;
                suppressTextareaSync = true;
                writeJson(textarea, spec);
                suppressTextareaSync = false;
                if (typeof onChange === 'function') onChange(serialize(spec));
            });
        };

        // 计算内容包围盒；保证空 DAG 也有合理底盘
        const contentBounds = () => {
            const w = Math.max(MIN_CONTENT_WIDTH, ...spec.nodes.map(n => n._x + NODE_WIDTH)) + PADDING;
            const h = Math.max(MIN_CONTENT_HEIGHT, ...spec.nodes.map(n => n._y + NODE_HEIGHT)) + PADDING;
            return { width: w, height: h };
        };

        const updateViewBox = () => {
            const { width, height } = contentBounds();
            const vbWidth = width / viewState.scale;
            const vbHeight = height / viewState.scale;
            root.setAttribute('viewBox', `${viewState.x} ${viewState.y} ${vbWidth} ${vbHeight}`);
            root.setAttribute('width', '100%');
            root.setAttribute('height', '100%');
            root.style.minHeight = '100%';
            updateMinimap();
        };

        // 重置缩放/平移到完整内容可见
        const fitToContent = () => {
            viewState.x = 0;
            viewState.y = 0;
            viewState.scale = DEFAULT_VIEW_SCALE;
            updateViewBox();
        };

        const currentTools = () => typeof getTools === 'function' ? (getTools() || []) : [];

        const {
            renderInputSummary,
            openNodeInputWizard,
            openStatsChartWizard
        } = createDagWizardController({
            currentTools,
            get spec() { return spec; },
            set spec(value) { spec = value; },
            get selectedId() { return selectedId; },
            set selectedId(value) { selectedId = value; },
            textarea,
            render: () => render(),
            flushOut: () => flushOut(),
            fitToContent: () => fitToContent()
        });

        const wouldCreateCycle = (dependencyId, targetId) => {
            if (!dependencyId || !targetId || dependencyId === targetId) return true;
            const byId = new Map(spec.nodes.map(n => [n.id, n]));
            const visit = (id, seen = new Set()) => {
                if (id === targetId) return true;
                if (seen.has(id)) return false;
                seen.add(id);
                const node = byId.get(id);
                return Boolean(node?.dependsOn?.some(dep => visit(dep, seen)));
            };
            return visit(dependencyId);
        };

        const getDependencyCandidateNodes = (node) => spec.nodes
            .filter(candidate => candidate.id !== node?.id && !wouldCreateCycle(candidate.id, node?.id))
            .sort((a, b) => Number(a._x || 0) - Number(b._x || 0) || Number(a._y || 0) - Number(b._y || 0));

        const validateWorkflow = () => {
            const tools = currentTools();
            const toolNames = new Set(tools.map(toolValue).filter(Boolean));
            const errors = [];
            const warnings = [];
            const byId = new Map(spec.nodes.map(node => [node.id, node]));
            const edgeCount = spec.nodes.reduce((sum, node) => sum + (node.dependsOn || []).length, 0);
            if (!spec.nodes.length) errors.push('至少需要 1 个节点');
            llmNodes(spec.nodes).forEach(node => {
                if (!llmNodeModel(node)) errors.push(`${node.title || node.id} 需要填写节点模型`);
            });
            validateLlmNodePlacement(spec.nodes).forEach(message => errors.push(message));
            spec.nodes.forEach(node => {
                if (!node.tool) errors.push(`${node.title || node.id} 未选择工具`);
                if (node.tool && toolNames.size && !isKnownToolValue(tools, node.tool)) warnings.push(`${node.title || node.id} 使用的工具当前不可用`);
                (node.dependsOn || []).forEach(dep => {
                    if (!byId.has(dep)) errors.push(`${node.title || node.id} 依赖了不存在的节点 ${dep}`);
                });
            });
            const visiting = new Set();
            const visited = new Set();
            const hasCycle = (id) => {
                if (visiting.has(id)) return true;
                if (visited.has(id)) return false;
                visiting.add(id);
                const node = byId.get(id);
                const cyclic = Boolean(node?.dependsOn?.some(dep => byId.has(dep) && hasCycle(dep)));
                visiting.delete(id);
                visited.add(id);
                return cyclic;
            };
            if (spec.nodes.some(node => hasCycle(node.id))) errors.push('存在循环依赖');
            const dependencyTargets = new Set(spec.nodes.flatMap(node => node.dependsOn || []));
            const startCount = spec.nodes.filter(node => !(node.dependsOn || []).length).length;
            const endCount = spec.nodes.filter(node => !dependencyTargets.has(node.id)).length;
            if (spec.nodes.length > 1 && startCount === 0) errors.push('缺少起始节点');
            if (spec.nodes.length > 1 && endCount === 0) warnings.push('缺少结束节点');
            return { errors, warnings, nodeCount: spec.nodes.length, edgeCount, startCount, endCount };
        };

        const renderToolbarStatus = () => {
            if (!toolbarStatus) return;
            const report = validateWorkflow();
            const state = report.errors.length ? 'error' : report.warnings.length ? 'warn' : 'ok';
            toolbarStatus.className = `pivot-dag-toolbar-status ${state}`;
            const message = report.errors[0] || report.warnings[0] || '工作流校验通过';
            toolbarStatus.textContent = `${report.nodeCount} 节点 · ${report.edgeCount} 依赖 · ${message}`;
            toolbarStatus.title = [
                ...report.errors, ...report.warnings,
                '提示：互不依赖的节点会并行执行，可在环境变量 AGENT_DAG_NODE_CONCURRENCY 调整并发数（默认 4）。'
            ].join('\n') || '工作流校验通过';
        };

        const showValidationResult = () => {
            const report = validateWorkflow();
            const message = report.errors[0] || report.warnings[0] || '工作流校验通过';
            window.showToast?.(message, report.errors.length ? 'error' : report.warnings.length ? 'warning' : 'success');
            renderToolbarStatus();
        };

        const { renderInspector } = createDagInspectorController({
            inspector,
            onNodeSelectionChange,
            currentTools,
            get spec() { return spec; },
            set spec(value) { spec = value; },
            get selectedId() { return selectedId; },
            set selectedId(value) { selectedId = value; },
            openNodeInputWizard,
            renderInputSummary,
            getDependencyCandidateNodes,
            wouldCreateCycle,
            render: () => render(),
            flushOut: () => flushOut()
        });
        const deleteNode = (id) => {
            const node = spec.nodes.find(n => n.id === id);
            if (!node) return false;
            spec.nodes = spec.nodes.filter(n => n.id !== id);
            clampDependsOn(spec.nodes);
            if (selectedId === id) selectedId = null;
            render();
            flushOut();
            return true;
        };

        const addNode = () => {
            const baseId = uniqueId(spec.nodes.map(n => n.id));
            const tools = currentTools();
            // 智能推断默认工具：统计当前画布上使用最多的工具
            const toolCounts = new Map();
            spec.nodes.forEach(n => { if (n.tool) toolCounts.set(n.tool, (toolCounts.get(n.tool) || 0) + 1); });
            const mostUsedTool = [...toolCounts.entries()].sort((a, b) => b[1] - a[1])[0];
            const defaultTool = mostUsedTool && mostUsedTool[1] >= 2 && tools.some(t => toolValue(t) === mostUsedTool[0])
                ? mostUsedTool[0]
                : '';
            const node = {
                id: baseId,
                title: '新节点',
                tool: defaultTool,
                input: {},
                dependsOn: selectedId ? [selectedId] : [],
                condition: 'success',
                retryLimit: 0,
                timeoutMs: 0,
                onError: 'skip_dependents'
            };
            const anchorId = selectedId;
            const anchorNode = spec.nodes.find(n => n.id === anchorId);
            spec.nodes.push(node);
            placeNewNode(spec.nodes, node, anchorId);
            selectedId = node.id;
            render();
            flushOut();
            window.showToast?.(anchorNode ? `已在「${anchorNode.title || anchorNode.id}」后添加新节点` : '已添加新的起始节点', 'success');
        };

        const addPresetNode = (preset) => {
            const tools = currentTools();
            const preferred = findPreferredTool(tools, preset.patterns || []);
            const baseId = uniqueId(spec.nodes.map(n => n.id), preset.base || 'node');
            const selectedNode = spec.nodes.find(n => n.id === selectedId);
            const inputTemplate = typeof preset.input === 'function'
                ? preset.input({ selectedId, selectedNode, baseId })
                : (preset.input || {});
            const node = {
                id: baseId,
                title: preset.title,
                tool: toolValue(preferred) || ((preset.patterns || []).includes('agent.llm') ? 'agent.llm' : ''),
                input: { ...inputTemplate },
                inputSchema: preset.inputSchema && typeof preset.inputSchema === 'object' ? preset.inputSchema : {},
                outputSchema: preset.outputSchema && typeof preset.outputSchema === 'object'
                    ? preset.outputSchema
                    : ((preset.patterns || []).includes('agent.llm') ? { type: 'string' } : {}),
                dependsOn: selectedId ? [selectedId] : [],
                condition: 'success',
                retryLimit: 0,
                timeoutMs: 0,
                onError: 'skip_dependents'
            };
            spec.nodes.push(node);
            placeNewNode(spec.nodes, node, selectedId);
            selectedId = node.id;
            render();
            flushOut();
            window.showToast?.(
                selectedNode
                    ? `已在「${selectedNode.title || selectedNode.id}」后添加${node.title}`
                    : `已添加${node.title}起始节点`,
                'success'
            );
        };

        const addAgentTeamTemplate = () => {
            const existingIds = spec.nodes.map(node => node.id);
            const anchorId = selectedId || '';
            const model = defaultWorkflowModelId();
            const researcherId = uniqueId(existingIds, 'researcher');
            existingIds.push(researcherId);
            const reviewerId = uniqueId(existingIds, 'reviewer');
            existingIds.push(reviewerId);
            const supervisorId = uniqueId(existingIds, 'supervisor');
            const baseContext = anchorId ? `{{nodes.${anchorId}.output}}` : '{{goal}}';
            const delegateOutputSchema = {
                type: 'object',
                required: ['content', 'agent', 'handoff'],
                properties: {
                    content: { type: 'string' },
                    agent: { type: 'object' },
                    handoff: { type: 'object' }
                }
            };
            const delegates = [
                {
                    id: researcherId,
                    title: '研究智能体',
                    tool: 'agent.delegate',
                    input: {
                        agentName: '研究员', role: 'researcher', model,
                        task: '围绕工作流目标收集事实、依据与未知信息，形成可核验的研究结论。',
                        context: baseContext, responseFormat: 'markdown', temperature: 0.1, maxTokens: 1200
                    },
                    inputSchema: {}, outputSchema: delegateOutputSchema,
                    dependsOn: anchorId ? [anchorId] : [], condition: 'success', retryLimit: 1, timeoutMs: 0, onError: 'continue'
                },
                {
                    id: reviewerId,
                    title: '审阅智能体',
                    tool: 'agent.delegate',
                    input: {
                        agentName: '审阅员', role: 'reviewer', model,
                        task: '独立检查目标、约束、证据充分性与潜在风险，指出遗漏和反例。',
                        context: baseContext, responseFormat: 'markdown', temperature: 0.1, maxTokens: 1200
                    },
                    inputSchema: {}, outputSchema: delegateOutputSchema,
                    dependsOn: anchorId ? [anchorId] : [], condition: 'success', retryLimit: 1, timeoutMs: 0, onError: 'continue'
                }
            ];
            const supervisor = {
                id: supervisorId,
                title: 'Supervisor 裁决',
                tool: 'agent.llm',
                input: {
                    model,
                    maxSteps: 20,
                    systemPrompt: '你是多智能体团队的 Supervisor。请核对各专家的事实依据与分歧，拒绝未经支持的结论，并形成最终可交付结果。',
                    prompt: `工作流目标：\n{{goal}}\n\n研究员 Handoff：\n{{nodes.${researcherId}.output.handoff.summary}}\n\n审阅员 Handoff：\n{{nodes.${reviewerId}.output.handoff.summary}}\n\n请先解决分歧，再给出结论、依据、风险和下一步。`,
                    responseFormat: 'markdown', temperature: 0.1, maxTokens: 1600
                },
                inputSchema: {}, outputSchema: { type: 'string' },
                dependsOn: [researcherId, reviewerId], condition: 'success', retryLimit: 0, timeoutMs: 0, onError: 'stop'
            };
            spec.nodes.push(...delegates, supervisor);
            autoLayout(spec.nodes);
            selectedId = supervisorId;
            render();
            flushOut();
            window.showToast?.('已添加并行专家与 Supervisor，可继续调整角色、模型和交接契约', 'success');
        };

        const resetLayout = () => {
            autoLayout(spec.nodes);
            render();
            flushOut();
        };

                const { renderEdges, renderNodes } = createDagRenderController({
            edgesLayer,
            nodesLayer,
            currentTools,
            get spec() { return spec; },
            get selectedId() { return selectedId; }
        });

        // 空画布引导：无节点时在画布中央提示从左侧节点库开始
        let emptyHintEl = null;
        const renderEmptyHint = () => {
            const isEmpty = !spec.nodes.length;
            if (!isEmpty) {
                emptyHintEl?.remove();
                emptyHintEl = null;
                return;
            }
            if (emptyHintEl?.isConnected) return;
            emptyHintEl = document.createElement('div');
            emptyHintEl.className = 'pivot-dag-empty-hint';
            const icon = document.createElement('span');
            icon.className = 'pivot-dag-empty-hint-icon';
            icon.setAttribute('aria-hidden', 'true');
            icon.appendChild(createDagIcon('puzzle'));
            const title = document.createElement('strong');
            title.textContent = '画布还是空的';
            const desc = document.createElement('small');
            desc.textContent = '从左侧「节点」面板点选类型即可添加，拖动节点端口可连成依赖。也可用工具栏「模板」一键生成。';
            emptyHintEl.append(icon, title, desc);
            canvas.appendChild(emptyHintEl);
        };

        const render = () => {
            updateViewBox();
            renderEdges();
            renderNodes();
            renderInspector();
            renderToolbarStatus();
            renderEmptyHint();
        };

        // —— 交互：节点拖拽、端口连线、选中 ——
                const {
            onPointerDown,
            onPointerMove,
            onPointerUp,
            onWheel,
            onDoubleClick,
            onKeyDown,
            closeToolbarDropdowns
        } = createDagInteractionController({
            root,
            edgesLayer,
            nodesLayer,
            inspector,
            toolbar,
            viewState,
            onNodeSelectionChange,
            get spec() { return spec; },
            get selectedId() { return selectedId; },
            set selectedId(value) { selectedId = value; },
            contentBounds,
            updateViewBox,
            render: () => render(),
            renderEdges: () => renderEdges(),
            flushOut: () => flushOut(),
            deleteNode: (id) => deleteNode(id),
            wouldCreateCycle: (fromId, targetId) => wouldCreateCycle(fromId, targetId)
        });
        document.addEventListener('keydown', onKeyDown);
        document.addEventListener('pointerdown', closeToolbarDropdowns);

        // pointermove 每帧可触发数十次，用 rafThrottle 合并到每帧最多一次，降低拖拽时的重复计算与重排
        const rafThrottle = window.Pivot?.rafThrottle;
        const throttledPointerMove = typeof rafThrottle === 'function' ? rafThrottle(onPointerMove) : onPointerMove;
        root.addEventListener('pointerdown', onPointerDown);
        root.addEventListener('pointermove', throttledPointerMove);
        root.addEventListener('pointerup', onPointerUp);
        root.addEventListener('pointercancel', onPointerUp);
        root.addEventListener('dblclick', onDoubleClick);
        root.addEventListener('wheel', onWheel, { passive: false });

        // —— 工具栏 ——
                toolbarStatus = renderDagToolbar({
            toolbar,
            addNode,
            addPresetNode,
            addAgentTeamTemplate,
            fitToContent,
            openStatsChartWizard,
            resetLayout,
            showValidationResult,
            onOpenJson
        });

        // —— 左侧节点库面板 ——
        let nodeLibraryInstance = null;
        let libraryExpandBtn = null;
        const setLibraryCollapsed = (collapsed) => {
            canvas.classList.toggle('is-library-collapsed', !!collapsed);
            if (libraryExpandBtn) libraryExpandBtn.hidden = !collapsed;
            updateViewBox();
        };
        const mountNodeLibrary = () => {
            if (!window.PivotDagNodeLibrary) return;
            // host 必须挂在 canvas 本身内部，才能正确相对定位
            let host = canvas.querySelector('.pivot-dag-node-library-host');
            if (!host) {
                host = document.createElement('div');
                host.className = 'pivot-dag-node-library-host';
                canvas.appendChild(host);
            }
            nodeLibraryInstance = window.PivotDagNodeLibrary.mount({
                container: host,
                onAddNode: (preset) => addPresetNode(preset),
                onToggleCollapse: (collapsed) => setLibraryCollapsed(collapsed)
            });
            // 折叠态下的展开按钮
            libraryExpandBtn = document.createElement('button');
            libraryExpandBtn.type = 'button';
            libraryExpandBtn.className = 'pivot-node-library-toggle';
            libraryExpandBtn.title = '展开节点面板';
            libraryExpandBtn.setAttribute('aria-label', '展开节点面板');
            libraryExpandBtn.textContent = '»';
            libraryExpandBtn.hidden = true;
            libraryExpandBtn.addEventListener('click', () => setLibraryCollapsed(false));
            canvas.appendChild(libraryExpandBtn);
            canvas.classList.add('has-node-library');
        };
        mountNodeLibrary();

        // —— textarea 外部改动同步回画布 ——
        const onTextareaInput = () => {
            if (suppressTextareaSync) return;
            const parsed = readJson(textarea.value);
            if (!parsed) return;
            spec = ensureDefaults(parsed);
            selectedId = null;
            render();
        };
        if (textarea) textarea.addEventListener('input', onTextareaInput);

        render();
        if (shouldFlushInitialDefaults && spec.nodes.length) flushOut();

        const destroy = () => {
            document.removeEventListener('keydown', onKeyDown);
            document.removeEventListener('pointerdown', closeToolbarDropdowns);
            root.removeEventListener('pointerdown', onPointerDown);
            root.removeEventListener('pointermove', throttledPointerMove);
            root.removeEventListener('pointerup', onPointerUp);
            root.removeEventListener('pointercancel', onPointerUp);
            root.removeEventListener('dblclick', onDoubleClick);
            root.removeEventListener('wheel', onWheel);
            if (minimap?.svg && typeof minimapClickHandler === 'function') {
                minimap.svg.removeEventListener('click', minimapClickHandler);
            }
            if (textarea) textarea.removeEventListener('input', onTextareaInput);
            emptyHintEl?.remove();
            emptyHintEl = null;
            libraryExpandBtn?.remove();
            libraryExpandBtn = null;
            nodeLibraryInstance?.destroy?.();
            canvas.classList.remove('has-node-library', 'is-library-collapsed');
            canvas.replaceChildren();
            if (minimap?.wrap?.parentNode === canvas) {
                // canvas.replaceChildren 已清空
            }
            if (inspector) inspector.replaceChildren();
            if (toolbar) toolbar.replaceChildren();
            canvas._pivotDagDestroy = null;
        };
        canvas._pivotDagDestroy = destroy;

        return {
            destroy,
            getValue: () => serialize(spec),
            setValue: (value) => {
                spec = ensureDefaults(value || { nodes: [] });
                selectedId = null;
                render();
                flushOut();
            },
            clearSelection: () => {
                selectedId = null;
                render();
            },
            deleteSelectedNode: () => {
                if (!selectedId) return false;
                return deleteNode(selectedId);
            },
            syncFromJson: () => {
                const parsed = readJson(textarea ? textarea.value : '');
                if (!parsed) {
                    if (typeof onChange === 'function') onChange({ error: 'invalid_json' });
                    return false;
                }
                spec = ensureDefaults(parsed);
                selectedId = null;
                render();
                flushOut();
                return true;
            },
            refresh: () => render(),
            // 暴露校验方法用于保存/发布前门禁
            validate: () => validateWorkflow()
        };
    }

window.PivotDagEditor = { mount };
})();
