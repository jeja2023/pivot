/* 智能体 DAG 可视化编辑器 Agent DAG Visual Editor
 *
 * 用法：
 *   window.PivotDagEditor.mount({
 *       canvas:    HTMLElement,    // SVG 容器
 *       textarea:  HTMLTextAreaElement, // 双向同步的 JSON textarea
 *       toolbar:   HTMLElement,    // 工具栏容器（[+节点] 等按钮注入到这里）
 *       inspector: HTMLElement,    // 节点详情面板
 *       getTools:  () => [{name, title}], // 可用工具列表
 *       onChange:  (spec) => void
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

    const SVG_NS = 'http://www.w3.org/2000/svg';
    const NODE_WIDTH = 160;
    const NODE_HEIGHT = 56;
    const NODE_GAP_X = 60;
    const NODE_GAP_Y = 36;
    const PADDING = 24;

    const escapeHtml = (window.PivotSafeHtml && window.PivotSafeHtml.escapeHtml)
        || ((value) => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'));

    function uniqueId(existing, base = 'node') {
        let i = existing.length + 1;
        const set = new Set(existing);
        while (set.has(`${base}_${i}`)) i += 1;
        return `${base}_${i}`;
    }

    function clampDependsOn(nodes) {
        const ids = new Set(nodes.map(n => n.id));
        nodes.forEach(node => {
            node.dependsOn = (node.dependsOn || []).filter(dep => ids.has(dep) && dep !== node.id);
        });
    }

    // 按拓扑层次分层（Kahn 风格）；环边视作"已满足"避免死循环
    function autoLayout(nodes) {
        const remaining = new Map(nodes.map(n => [n.id, new Set(n.dependsOn || [])]));
        const layers = [];
        const placed = new Set();
        // 兜底：节点数 <= 50 时层次清晰；更多节点也接受较粗略布局
        while (placed.size < nodes.length) {
            const layer = [];
            nodes.forEach(node => {
                if (placed.has(node.id)) return;
                const deps = remaining.get(node.id);
                const ready = [...deps].every(dep => placed.has(dep));
                if (ready) layer.push(node);
            });
            if (layer.length === 0) {
                // 出现环时把还没排的节点全部放到下一层，避免死循环
                nodes.forEach(node => {
                    if (!placed.has(node.id)) layer.push(node);
                });
            }
            layers.push(layer);
            layer.forEach(node => placed.add(node.id));
        }
        layers.forEach((layer, layerIndex) => {
            layer.forEach((node, slot) => {
                node._x = PADDING + layerIndex * (NODE_WIDTH + NODE_GAP_X);
                node._y = PADDING + slot * (NODE_HEIGHT + NODE_GAP_Y);
            });
        });
    }

    function ensureDefaults(spec) {
        const nodes = Array.isArray(spec?.nodes) ? spec.nodes.map(n => ({
            id: String(n.id || '').trim() || 'node',
            title: String(n.title || n.id || '').trim() || '未命名',
            tool: String(n.tool || '').trim(),
            input: n.input && typeof n.input === 'object' ? n.input : {},
            dependsOn: Array.isArray(n.dependsOn) ? n.dependsOn.slice() : [],
            condition: ['always', 'success'].includes(n.condition) ? n.condition : 'success'
        })) : [];
        clampDependsOn(nodes);
        autoLayout(nodes);
        return { nodes };
    }

    // 把内部带 _x/_y 的 spec 序列化为 normalizeDagSpec 接受的最小形态
    function serialize(spec) {
        return {
            nodes: spec.nodes.map(({ id, title, tool, input, dependsOn, condition }) => ({
                id, title, tool, input, dependsOn: [...(dependsOn || [])], condition
            }))
        };
    }

    function readJson(text) {
        const raw = String(text || '').trim();
        if (!raw) return { nodes: [] };
        try {
            const value = JSON.parse(raw);
            if (Array.isArray(value)) return { nodes: value };
            if (value && typeof value === 'object') return value;
        } catch (e) {
            // 静默 — 编辑器会保留上次成功的快照
        }
        return null;
    }

    function writeJson(textarea, spec) {
        if (!textarea) return;
        textarea.value = JSON.stringify(serialize(spec), null, 2);
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
    }

    function createEdgePath(fromNode, toNode) {
        const startX = fromNode._x + NODE_WIDTH;
        const startY = fromNode._y + NODE_HEIGHT / 2;
        const endX = toNode._x;
        const endY = toNode._y + NODE_HEIGHT / 2;
        const c1x = startX + Math.max(40, (endX - startX) / 2);
        const c2x = endX - Math.max(40, (endX - startX) / 2);
        return `M ${startX},${startY} C ${c1x},${startY} ${c2x},${endY} ${endX},${endY}`;
    }

    function makeSvgEl(tag, attrs = {}) {
        const el = document.createElementNS(SVG_NS, tag);
        Object.entries(attrs).forEach(([k, v]) => el.setAttribute(k, String(v)));
        return el;
    }

    function makeButton(label, title, onClick) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'btn-secondary pivot-dag-toolbar-btn';
        btn.textContent = label;
        if (title) btn.title = title;
        btn.addEventListener('click', onClick);
        return btn;
    }

    function mount({ canvas, textarea, toolbar, inspector, getTools, onChange }) {
        if (!canvas) return null;

        // 幂等：如果已有实例先销毁
        if (canvas._pivotDagDestroy) canvas._pivotDagDestroy();

        let spec = ensureDefaults(readJson(textarea ? textarea.value : ''));
        let selectedId = null;
        let connecting = null; // { fromId, ghost: <path> }
        let pendingFlush = null;
        let suppressTextareaSync = false;

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

        const flushOut = () => {
            if (pendingFlush) cancelAnimationFrame(pendingFlush);
            pendingFlush = requestAnimationFrame(() => {
                pendingFlush = null;
                suppressTextareaSync = true;
                writeJson(textarea, spec);
                suppressTextareaSync = false;
                if (typeof onChange === 'function') onChange(serialize(spec));
            });
        };

        const updateViewBox = () => {
            const width = Math.max(640, ...spec.nodes.map(n => n._x + NODE_WIDTH)) + PADDING;
            const height = Math.max(280, ...spec.nodes.map(n => n._y + NODE_HEIGHT)) + PADDING;
            root.setAttribute('viewBox', `0 0 ${width} ${height}`);
            root.setAttribute('width', '100%');
            root.style.minHeight = `${Math.min(540, height + 16)}px`;
        };

        const renderInspector = () => {
            if (!inspector) return;
            const node = spec.nodes.find(n => n.id === selectedId);
            if (!node) {
                inspector.innerHTML = '<div class="pivot-dag-inspector-empty">选中节点后可在此编辑标题、工具与输入。</div>';
                return;
            }
            const tools = typeof getTools === 'function' ? (getTools() || []) : [];
            const otherIds = spec.nodes.filter(n => n.id !== node.id).map(n => n.id);
            const dependsChecks = otherIds.map(id => `
                <label class="pivot-dag-depends-item">
                    <input type="checkbox" data-pivot-dag-depend="${escapeHtml(id)}" ${node.dependsOn.includes(id) ? 'checked' : ''}>
                    <span>${escapeHtml(id)}</span>
                </label>
            `).join('') || '<span class="pivot-dag-inspector-empty">暂无其他节点可依赖</span>';
            const toolOptions = ['<option value="">— 选择工具 —</option>']
                .concat(tools.map(t => `<option value="${escapeHtml(t.name || t.fullName || '')}" ${node.tool === (t.name || t.fullName) ? 'selected' : ''}>${escapeHtml(t.title || t.name || t.fullName)}</option>`))
                .join('');
            inspector.innerHTML = `
                <div class="pivot-dag-inspector-row">
                    <label><span>节点 ID</span><input type="text" data-pivot-dag-field="id" value="${escapeHtml(node.id)}" maxlength="60"></label>
                    <label><span>标题</span><input type="text" data-pivot-dag-field="title" value="${escapeHtml(node.title)}" maxlength="120"></label>
                </div>
                <div class="pivot-dag-inspector-row">
                    <label><span>工具</span>
                        <select data-pivot-dag-field="tool">${toolOptions}</select>
                    </label>
                    <label><span>条件</span>
                        <select data-pivot-dag-field="condition">
                            <option value="success" ${node.condition === 'success' ? 'selected' : ''}>依赖成功后执行</option>
                            <option value="always" ${node.condition === 'always' ? 'selected' : ''}>始终执行</option>
                        </select>
                    </label>
                </div>
                <label class="pivot-dag-inspector-input">
                    <span>输入参数 (JSON)</span>
                    <textarea data-pivot-dag-field="input" rows="3" spellcheck="false">${escapeHtml(JSON.stringify(node.input || {}, null, 2))}</textarea>
                </label>
                <div class="pivot-dag-inspector-depends">
                    <div class="pivot-dag-inspector-depends-head">依赖节点</div>
                    <div class="pivot-dag-inspector-depends-list">${dependsChecks}</div>
                </div>
                <div class="pivot-dag-inspector-actions">
                    <button type="button" class="btn-secondary btn-red-outline" data-pivot-dag-delete="1">删除节点</button>
                </div>
            `;
            inspector.querySelectorAll('[data-pivot-dag-field]').forEach(input => {
                input.addEventListener('input', (e) => handleInspectorEdit(e.target));
                input.addEventListener('change', (e) => handleInspectorEdit(e.target));
            });
            inspector.querySelectorAll('[data-pivot-dag-depend]').forEach(checkbox => {
                checkbox.addEventListener('change', (e) => handleDependsToggle(e.target));
            });
            inspector.querySelector('[data-pivot-dag-delete]')?.addEventListener('click', () => deleteNode(node.id));
        };

        const handleInspectorEdit = (input) => {
            const node = spec.nodes.find(n => n.id === selectedId);
            if (!node) return;
            const field = input.dataset.pivotDagField;
            if (field === 'id') {
                const next = String(input.value || '').trim().replace(/[^\w.-]/g, '_').slice(0, 60);
                if (!next || next === node.id) return;
                if (spec.nodes.some(n => n.id === next)) return;
                spec.nodes.forEach(n => {
                    n.dependsOn = (n.dependsOn || []).map(dep => dep === node.id ? next : dep);
                });
                node.id = next;
                selectedId = next;
            } else if (field === 'title') {
                node.title = String(input.value || '').slice(0, 120);
            } else if (field === 'tool') {
                node.tool = String(input.value || '');
            } else if (field === 'condition') {
                node.condition = ['always', 'success'].includes(input.value) ? input.value : 'success';
            } else if (field === 'input') {
                try {
                    const parsed = JSON.parse(input.value || '{}');
                    node.input = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
                    input.classList.remove('is-invalid');
                } catch (e) {
                    input.classList.add('is-invalid');
                    return;
                }
            }
            render();
            flushOut();
        };

        const handleDependsToggle = (checkbox) => {
            const node = spec.nodes.find(n => n.id === selectedId);
            if (!node) return;
            const dep = checkbox.dataset.pivotDagDepend;
            const deps = new Set(node.dependsOn || []);
            if (checkbox.checked) deps.add(dep); else deps.delete(dep);
            node.dependsOn = [...deps];
            clampDependsOn(spec.nodes);
            render();
            flushOut();
        };

        const deleteNode = (id) => {
            spec.nodes = spec.nodes.filter(n => n.id !== id);
            clampDependsOn(spec.nodes);
            if (selectedId === id) selectedId = null;
            autoLayout(spec.nodes);
            render();
            flushOut();
        };

        const addNode = () => {
            const baseId = uniqueId(spec.nodes.map(n => n.id));
            const tools = typeof getTools === 'function' ? (getTools() || []) : [];
            const node = {
                id: baseId,
                title: '新节点',
                tool: (tools[0]?.name || tools[0]?.fullName || ''),
                input: {},
                dependsOn: selectedId ? [selectedId] : [],
                condition: 'success'
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

        const renderEdges = () => {
            edgesLayer.replaceChildren();
            const byId = new Map(spec.nodes.map(n => [n.id, n]));
            spec.nodes.forEach(node => {
                (node.dependsOn || []).forEach(depId => {
                    const from = byId.get(depId);
                    if (!from) return;
                    const path = makeSvgEl('path', {
                        class: 'pivot-dag-edge',
                        d: createEdgePath(from, node),
                        'marker-end': 'url(#pivot-dag-arrow)'
                    });
                    edgesLayer.appendChild(path);
                });
            });
        };

        const renderNodes = () => {
            nodesLayer.replaceChildren();
            spec.nodes.forEach(node => {
                const group = makeSvgEl('g', {
                    class: `pivot-dag-node ${selectedId === node.id ? 'is-selected' : ''}`,
                    transform: `translate(${node._x}, ${node._y})`,
                    'data-pivot-dag-id': node.id
                });
                group.appendChild(makeSvgEl('rect', {
                    class: 'pivot-dag-node-body',
                    width: NODE_WIDTH,
                    height: NODE_HEIGHT,
                    rx: 8,
                    ry: 8
                }));
                const title = makeSvgEl('text', { class: 'pivot-dag-node-title', x: 12, y: 22 });
                title.textContent = node.title || node.id;
                group.appendChild(title);
                const tool = makeSvgEl('text', { class: 'pivot-dag-node-tool', x: 12, y: 42 });
                tool.textContent = node.tool ? `→ ${node.tool}` : '未选择工具';
                group.appendChild(tool);
                // 出端口（拖出去创建依赖）
                const outPort = makeSvgEl('circle', {
                    class: 'pivot-dag-port pivot-dag-port-out',
                    cx: NODE_WIDTH,
                    cy: NODE_HEIGHT / 2,
                    r: 6,
                    'data-pivot-dag-port': 'out',
                    'data-pivot-dag-id': node.id
                });
                group.appendChild(outPort);
                // 入端口（接收依赖的连接落点）
                const inPort = makeSvgEl('circle', {
                    class: 'pivot-dag-port pivot-dag-port-in',
                    cx: 0,
                    cy: NODE_HEIGHT / 2,
                    r: 6,
                    'data-pivot-dag-port': 'in',
                    'data-pivot-dag-id': node.id
                });
                group.appendChild(inPort);
                nodesLayer.appendChild(group);
            });
        };

        const render = () => {
            updateViewBox();
            renderEdges();
            renderNodes();
            renderInspector();
        };

        // —— 交互：节点拖拽、端口连线、选中 ——
        let dragging = null;
        const pointFromEvent = (event) => {
            const rect = root.getBoundingClientRect();
            const vb = root.viewBox.baseVal || { x: 0, y: 0, width: rect.width, height: rect.height };
            const scaleX = vb.width / rect.width;
            const scaleY = vb.height / rect.height;
            return {
                x: (event.clientX - rect.left) * scaleX + vb.x,
                y: (event.clientY - rect.top) * scaleY + vb.y
            };
        };

        const onPointerDown = (event) => {
            const target = event.target;
            if (target.dataset.pivotDagPort === 'out') {
                event.preventDefault();
                const node = spec.nodes.find(n => n.id === target.dataset.pivotDagId);
                if (!node) return;
                const ghost = makeSvgEl('path', { class: 'pivot-dag-edge pivot-dag-edge-ghost' });
                edgesLayer.appendChild(ghost);
                connecting = { fromId: node.id, ghost };
                root.setPointerCapture?.(event.pointerId);
                return;
            }
            const nodeGroup = target.closest('[data-pivot-dag-id]');
            if (!nodeGroup) {
                selectedId = null;
                render();
                return;
            }
            const id = nodeGroup.dataset.pivotDagId;
            const node = spec.nodes.find(n => n.id === id);
            if (!node) return;
            selectedId = id;
            render();
            const pointer = pointFromEvent(event);
            dragging = { id, offsetX: pointer.x - node._x, offsetY: pointer.y - node._y };
            root.setPointerCapture?.(event.pointerId);
        };

        const onPointerMove = (event) => {
            if (connecting) {
                const node = spec.nodes.find(n => n.id === connecting.fromId);
                if (!node) return;
                const pointer = pointFromEvent(event);
                const startX = node._x + NODE_WIDTH;
                const startY = node._y + NODE_HEIGHT / 2;
                connecting.ghost.setAttribute('d', `M ${startX},${startY} C ${startX + 60},${startY} ${pointer.x - 60},${pointer.y} ${pointer.x},${pointer.y}`);
                return;
            }
            if (dragging) {
                const node = spec.nodes.find(n => n.id === dragging.id);
                if (!node) return;
                const pointer = pointFromEvent(event);
                node._x = Math.max(0, pointer.x - dragging.offsetX);
                node._y = Math.max(0, pointer.y - dragging.offsetY);
                renderEdges();
                const group = nodesLayer.querySelector(`[data-pivot-dag-id="${CSS.escape(dragging.id)}"]`);
                if (group) group.setAttribute('transform', `translate(${node._x}, ${node._y})`);
                updateViewBox();
            }
        };

        const onPointerUp = (event) => {
            if (connecting) {
                const target = document.elementFromPoint(event.clientX, event.clientY);
                const inPort = target?.closest?.('[data-pivot-dag-port="in"]');
                const targetId = inPort?.dataset?.pivotDagId;
                if (targetId && targetId !== connecting.fromId) {
                    const targetNode = spec.nodes.find(n => n.id === targetId);
                    if (targetNode && !targetNode.dependsOn.includes(connecting.fromId)) {
                        targetNode.dependsOn.push(connecting.fromId);
                        clampDependsOn(spec.nodes);
                        flushOut();
                    }
                }
                connecting.ghost.remove();
                connecting = null;
                render();
                return;
            }
            if (dragging) {
                dragging = null;
                flushOut();
            }
        };

        const onDoubleClick = (event) => {
            const nodeGroup = event.target.closest('[data-pivot-dag-id]');
            if (!nodeGroup) return;
            selectedId = nodeGroup.dataset.pivotDagId;
            render();
            // 把焦点放到 inspector 第一个输入，便于直接改名
            inspector?.querySelector('input[data-pivot-dag-field="title"]')?.focus();
        };

        root.addEventListener('pointerdown', onPointerDown);
        root.addEventListener('pointermove', onPointerMove);
        root.addEventListener('pointerup', onPointerUp);
        root.addEventListener('pointercancel', onPointerUp);
        root.addEventListener('dblclick', onDoubleClick);

        // —— 工具栏 ——
        if (toolbar) {
            toolbar.replaceChildren();
            toolbar.appendChild(makeButton('+ 添加节点', '新增 DAG 节点', addNode));
            toolbar.appendChild(makeButton('自动布局', '按依赖层次重新排列', resetLayout));
            toolbar.appendChild(makeButton('从 JSON 同步', '把右侧 JSON 文本应用到画布', () => {
                const parsed = readJson(textarea ? textarea.value : '');
                if (!parsed) {
                    if (typeof onChange === 'function') onChange({ error: 'invalid_json' });
                    return;
                }
                spec = ensureDefaults(parsed);
                selectedId = null;
                render();
            }));
        }

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

        const destroy = () => {
            root.removeEventListener('pointerdown', onPointerDown);
            root.removeEventListener('pointermove', onPointerMove);
            root.removeEventListener('pointerup', onPointerUp);
            root.removeEventListener('pointercancel', onPointerUp);
            root.removeEventListener('dblclick', onDoubleClick);
            if (textarea) textarea.removeEventListener('input', onTextareaInput);
            canvas.replaceChildren();
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
            refresh: () => render()
        };
    }

    window.PivotDagEditor = { mount };
})();
