(function () {
    'use strict';
    const byId = id => document.getElementById(id);
    const geometry = () => window.Pivot.presentationGeometry;
    const graphics = () => window.Pivot.presentationGraphics;
    function node(tag, className = '', text = '') { const value = document.createElement(tag); value.className = className; value.textContent = text; return value; }
    function field(label, value, { id, type = 'text', maxLength = 600, options, rows = 2 } = {}) {
        const wrapper = node('label'), input = node(options ? 'select' : type === 'textarea' ? 'textarea' : 'input', 'form-input');
        wrapper.appendChild(node('span', '', label));
        if (options) for (const [key, label] of Object.entries(options)) input.appendChild(new Option(label, key));
        else if (type === 'textarea') input.rows = rows;
        else input.type = type;
        input.maxLength = maxLength; input.value = value ?? ''; if (id) input.id = id;
        wrapper.appendChild(input); return { wrapper, input };
    }
    function renderShapeProperties(element) {
        const select = byId('presentation-shape-type'), controls = byId('presentation-shape-adjustments');
        if (!select || !controls) return;
        if (!select.options.length) {
            const groups = new Map();
            for (const name of geometry().list()) {
                const category = geometry().category(name);
                if (!groups.has(category)) { const group = node('optgroup'); group.label = category; groups.set(category, group); select.appendChild(group); }
                groups.get(category).appendChild(new Option(geometry().label(name), name));
            }
        }
        select.value = element.shapeType;
        if (controls.contains(document.activeElement)) return;
        controls.replaceChildren();
        const scene = geometry().shapeScene(element.shapeType, element.width, element.height, geometry().effectiveAdjustments(element));
        for (const control of scene.controls) {
            const entry = field(control.label + (control.scale === 60000 ? '（度）' : '（%）'), Math.round(control.value / control.scale * 100) / 100, { type: 'number' });
            entry.input.min = String(control.min / control.scale); entry.input.max = String(control.max / control.scale); entry.input.step = '0.1';
            entry.input.dataset.presentationShapeAdjust = control.name; entry.input.dataset.scale = String(control.scale); controls.appendChild(entry.wrapper);
        }
    }
    function applyShapeProperties(element) {
        const selected = byId('presentation-shape-type')?.value;
        if (!selected) return;
        if (selected !== element.shapeType) { element.shapeType = selected; delete element.adjustments; return; }
        const overrides = { ...(element.adjustments || {}) };
        for (const input of document.querySelectorAll('[data-presentation-shape-adjust]')) {
            const value = Number(input.value) * Number(input.dataset.scale);
            if (input.value.trim() && Number.isFinite(value)) overrides[input.dataset.presentationShapeAdjust] = Math.round(Math.max(Number(input.min) * Number(input.dataset.scale), Math.min(Number(input.max) * Number(input.dataset.scale), value)));
        }
        element.adjustments = overrides;
    }
    function renderDiagramProperties(element) {
        const panel = byId('presentation-diagram-style-fields'); if (!panel) return;
        panel.classList.toggle('hidden', element?.type !== 'diagram');
        if (element?.type !== 'diagram' || panel.contains(document.activeElement)) return;
        panel.replaceChildren(node('div', 'presentation-form-section-title', '图示节点与连接'));
        const layout = field('布局方式', element.diagramType, { id: 'presentation-diagram-type', options: { process: '流程', cycle: '循环', hierarchy: '层级', relationship: '关系' } });
        panel.appendChild(layout.wrapper);
        const scene = graphics().diagramScene(element);
        for (const item of scene.nodes) {
            const entry = field('节点 ' + (scene.nodes.indexOf(item) + 1), item.label, { maxLength: 240 });
            entry.input.dataset.presentationDiagramNode = item.id; panel.appendChild(entry.wrapper);
        }
        const connections = node('div', 'presentation-studio-edges'); connections.id = 'presentation-diagram-edges';
        for (const edge of scene.edges) connections.appendChild(edgeEditor(edge, scene.nodes));
        panel.appendChild(node('p', 'presentation-empty-note', '连接关系随节点保留；修改布局不会自动改写父子关系。'));
        panel.appendChild(connections);
        const add = node('button', 'btn-secondary', '添加连接'); add.type = 'button'; add.id = 'presentation-diagram-add-edge'; panel.appendChild(add);
    }
    function edgeEditor(edge, nodes) {
        const row = node('div', 'presentation-studio-edge'); row.dataset.presentationDiagramEdge = edge.id;
        const options = Object.fromEntries(nodes.map(item => [item.id, item.label]));
        for (const [key, label] of [['from', '起点'], ['to', '终点']]) {
            const entry = field(label, edge[key], { options }); entry.input.dataset.edgeField = key; row.appendChild(entry.wrapper);
        }
        const label = field('连接说明', edge.label || '', { maxLength: 120 }); label.input.dataset.edgeField = 'label'; row.appendChild(label.wrapper);
        const directed = field('方向', String(edge.directed !== false), { options: { true: '有向', false: '无向' } }); directed.input.dataset.edgeField = 'directed'; row.appendChild(directed.wrapper);
        const remove = node('button', 'btn-secondary', '移除连接'); remove.type = 'button'; remove.dataset.presentationRemoveEdge = '1'; row.appendChild(remove);
        return row;
    }
    function applyDiagramProperties(element, toast) {
        const panel = byId('presentation-diagram-style-fields'); if (!panel) return;
        const nodes = [...panel.querySelectorAll('[data-presentation-diagram-node]')].map(input => ({ id: input.dataset.presentationDiagramNode, label: input.value }));
        if (!nodes.length) return;
        const edges = [...panel.querySelectorAll('[data-presentation-diagram-edge]')].map(row => ({ id: row.dataset.presentationDiagramEdge,
            ...Object.fromEntries([...row.querySelectorAll('[data-edge-field]')].map(input => [input.dataset.edgeField, input.dataset.edgeField === 'directed' ? input.value === 'true' : input.value])) }));
        const diagramType = byId('presentation-diagram-type')?.value || element.diagramType;
        const ids = new Set(nodes.map(item => item.id)), pairs = new Set();
        if (nodes.some(item => !item.label.trim()) || edges.some(edge => !ids.has(edge.from) || !ids.has(edge.to) || edge.from === edge.to || pairs.has(`${edge.from}:${edge.to}`) || !pairs.add(`${edge.from}:${edge.to}`))) { toast('请保留有效节点，避免重复连接或连接自身。', 'warning'); return; }
        const next = { ...element, diagramType, items: nodes.map(item => item.label), graph: { nodes, edges } };
        try { graphics().diagramScene(next); Object.assign(element, next); }
        catch (error) { if (byId('presentation-diagram-type')) byId('presentation-diagram-type').value = element.diagramType; toast(error.message, 'warning'); }
    }
    function renderStory(state, helpers) { window.Pivot.moduleApi('apps.presentations.storyline')?.render(state, helpers); }
    function bind(state, helpers) {
        const view = byId('presentations-view'); if (!view || view.dataset.studioBound) return;
        view.dataset.studioBound = '1';
        const scroll = byId('presentation-stage-scroll');
        if (scroll && typeof ResizeObserver !== 'undefined') {
            const observer = new ResizeObserver(() => { if (state.active && state.zoomMode === 'fit') helpers.renderStage(); });
            observer.observe(scroll);
        }
        view.addEventListener('click', event => {
            const add = event.target.closest('#presentation-diagram-add-edge'), remove = event.target.closest('[data-presentation-remove-edge]');
            if (!add && !remove) return;
            const element = helpers.selectedElement();
            if (!helpers.canEdit() || !element || element.locked || helpers.activeSlide()?.review?.status === 'approved') return;
            if (remove) remove.closest('[data-presentation-diagram-edge]').remove();
            else {
                const scene = graphics().diagramScene(element), rows = [...byId('presentation-diagram-edges').children];
                if (rows.length >= 60) { helpers.toast('连接数量已达上限。', 'warning'); return; }
                const pair = scene.nodes.flatMap(from => scene.nodes.filter(to => to.id !== from.id).map(to => [from.id, to.id])).find(([from, to]) => !rows.some(row => row.querySelector('[data-edge-field="from"]').value === from && row.querySelector('[data-edge-field="to"]').value === to));
                if (!pair) return;
                byId('presentation-diagram-edges').appendChild(edgeEditor({ id: 'edge_' + Date.now(), from: pair[0], to: pair[1], directed: true }, scene.nodes));
            }
            applyDiagramProperties(element, helpers.toast); helpers.recordHistory(); helpers.renderEditor();
        });
    }
    function fitZoom(state) {
        if (state.zoomMode !== 'fit' || !state.active?.content) return state.zoom;
        const scroll = byId('presentation-stage-scroll');
        if (!scroll?.clientWidth || !scroll?.clientHeight) return state.zoom;
        const { width, height } = state.active.content;
        return Math.max(0.1, Math.min(1, (scroll.clientWidth - 56) / width, (scroll.clientHeight - 56) / height));
    }
    function renderEvidence(list, state) {
        const content = state.active?.content, slide = content?.slides.find(item => item.id === state.selectedSlideId) || content?.slides[0];
        if (!slide || (!slide.intent && !slide.claims?.length)) return;
        const card = node('article', 'presentation-evidence-card'); card.appendChild(node('strong', '', '本页论点与证据'));
        if (slide.intent?.purpose) card.appendChild(node('p', '', '页面职责：' + slide.intent.purpose));
        if (slide.intent?.takeaway) card.appendChild(node('p', '', '核心结论：' + slide.intent.takeaway));
        const sourceMap = new Map(content.sources.map(source => [source.id, source]));
        const receipts = state.active.validation?.semantics?.receipts || [];
        for (const claim of slide.claims || []) {
            const item = node('section', 'presentation-claim');
            const receipt = receipts.find(item => item.slideId === slide.id && item.claimId === claim.id);
            item.appendChild(node('strong', '', ({ fact: '事实', calculation: '推导', assumption: '假设', recommendation: '建议' })[claim.type] + '：' + claim.text));
            item.appendChild(node('p', 'presentation-empty-note', state.dirty ? '页面有未保存修改，请保存并重新检查。' : !receipt || receipt.pageBinding !== 'current' ? '尚未针对当前页面内容完成核对。' :
                receipt.evidence.length && receipt.evidence.every(item => ['excerpt_matched', 'snapshot_slice_matched'].includes(item.status)) ? '已匹配保存的材料片段；事实含义仍需核对。' : '原文证据尚未确认，请查看检查面板。'));
            for (const evidence of claim.evidence) {
                item.appendChild(node('blockquote', '', evidence.quote));
                item.appendChild(node('small', '', `${sourceMap.get(evidence.sourceId)?.title || evidence.sourceId} · ${evidence.locator || sourceMap.get(evidence.sourceId)?.locator || '定位待补充'}`));
            }
            if (claim.calculation) item.appendChild(node('p', '', `可复算输入：${claim.calculation.values.join('、')}；结果：${claim.calculation.result}${claim.calculation.unit || ''}。${receipt?.calculation === 'matched' ? '计算一致。' : '计算尚未确认。'}`));
            card.appendChild(item);
        }
        list.appendChild(card);
    }
    window.Pivot?.exposeModule?.('apps.presentations.studio', { renderShapeProperties, applyShapeProperties, renderDiagramProperties, applyDiagramProperties, renderStory, renderEvidence, fitZoom, bind });
})();
