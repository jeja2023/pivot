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
 * 节点坐标 (x, y) 仅在编辑器内部维护，写入 textarea 时不会保留（normalizeDagSpec 会丢弃），
 * 加载已有 JSON 时编辑器会用拓扑层次自动布局重新生成坐标。
 *
 * 设计原则：
 *   - 零依赖，纯原生 JS + SVG
 *   - 不破坏现有 textarea 的存在；textarea 仍可手动编辑作为"专家模式"
 *   - CSP 兼容：所有事件都用 addEventListener，无内联 onclick
 *   - 多次 mount 同一容器幂等：先 destroy 旧实例
 */
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
                    fill: selectedId === node.id ? '#3b82f6' : '#cbd5e1',
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

        const nodePositionRank = (node) => {
            const x = Number(node?._x);
            const y = Number(node?._y);
            const index = spec.nodes.findIndex(item => item.id === node?.id);
            return {
                x: Number.isFinite(x) ? x : index * (NODE_WIDTH + NODE_GAP_X),
                y: Number.isFinite(y) ? y : 0,
                index
            };
        };

        const isForwardDependency = (dependencyId, targetId) => {
            if (!dependencyId || !targetId || dependencyId === targetId) return false;
            const dependency = spec.nodes.find(item => item.id === dependencyId);
            const target = spec.nodes.find(item => item.id === targetId);
            if (!dependency || !target) return false;
            const depRank = nodePositionRank(dependency);
            const targetRank = nodePositionRank(target);
            if (depRank.x !== targetRank.x) return depRank.x < targetRank.x;
            return depRank.index >= 0 && targetRank.index >= 0 && depRank.index < targetRank.index;
        };

        const getDependencyCandidateNodes = (node) => spec.nodes
            .filter(candidate => isForwardDependency(candidate.id, node?.id))
            .sort((a, b) => {
                const rankA = nodePositionRank(a);
                const rankB = nodePositionRank(b);
                return rankA.x - rankB.x || rankA.y - rankB.y || rankA.index - rankB.index;
            });

        const validateWorkflow = () => {
            const tools = currentTools();
            const toolNames = new Set(tools.map(toolValue).filter(Boolean));
            const errors = [];
            const warnings = [];
            const byId = new Map(spec.nodes.map(node => [node.id, node]));
            const edgeCount = spec.nodes.reduce((sum, node) => sum + (node.dependsOn || []).length, 0);
            if (!spec.nodes.length) errors.push('至少需要 1 个节点');
            const requiredLlmNodes = llmNodes(spec.nodes);
            if (!requiredLlmNodes.length) errors.push('工作流必须包含 1 个大模型节点');
            requiredLlmNodes.forEach(node => {
                if (!llmNodeModel(node)) errors.push(`${node.title || node.id} 需要填写节点模型`);
            });
            validateLlmNodePlacement(spec.nodes).forEach(message => errors.push(message));
            spec.nodes.forEach(node => {
                if (!node.tool) errors.push(`${node.title || node.id} 未选择工具`);
                if (node.tool && toolNames.size && !isKnownToolValue(tools, node.tool)) warnings.push(`${node.title || node.id} 使用的工具当前不可用`);
                (node.dependsOn || []).forEach(dep => {
                    if (!byId.has(dep)) errors.push(`${node.title || node.id} 依赖了不存在的节点 ${dep}`);
                    else if (!isForwardDependency(dep, node.id)) errors.push(`${node.title || node.id} 只能连接左侧的上游节点 ${dep}`);
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
            const parallelNote = report.nodeCount > 1 ? ` · 运行时最多并发执行` : '';
            toolbarStatus.textContent = `${report.nodeCount} 节点 · ${report.edgeCount} 依赖 · ${message}${parallelNote}`;
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
            isForwardDependency,
            wouldCreateCycle,
            render: () => render(),
            flushOut: () => flushOut()
        });
        const deleteNode = (id) => {
            const node = spec.nodes.find(n => n.id === id);
            if (!node) return false;
            if (isLlmNode(node) && llmNodes(spec.nodes).length <= 1) {
                window.showToast?.('工作流必须保留 1 个大模型节点', 'warning');
                return false;
            }
            spec.nodes = spec.nodes.filter(n => n.id !== id);
            clampDependsOn(spec.nodes);
            if (selectedId === id) selectedId = null;
            autoLayout(spec.nodes);
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
            spec.nodes.push(node);
            autoLayout(spec.nodes);
            selectedId = node.id;
            render();
            flushOut();
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
                tool: toolValue(preferred),
                input: { ...inputTemplate },
                dependsOn: selectedId ? [selectedId] : [],
                condition: 'success',
                retryLimit: 0,
                timeoutMs: 0,
                onError: 'skip_dependents'
            };
            spec.nodes.push(node);
            autoLayout(spec.nodes);
            selectedId = node.id;
            render();
            flushOut();
        };

        const resetLayout = () => {
            autoLayout(spec.nodes);
            render();
        };

                const { renderEdges, renderNodes } = createDagRenderController({
            edgesLayer,
            nodesLayer,
            currentTools,
            get spec() { return spec; },
            get selectedId() { return selectedId; }
        });

        const render = () => {
            updateViewBox();
            renderEdges();
            renderNodes();
            renderInspector();
            renderToolbarStatus();
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
            isForwardDependency: (fromId, targetId) => isForwardDependency(fromId, targetId),
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
            fitToContent,
            openStatsChartWizard,
            resetLayout,
            showValidationResult,
            onOpenJson
        });

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
