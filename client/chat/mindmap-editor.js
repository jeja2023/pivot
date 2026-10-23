(function () {
    function mount(container, artifact) {
        const old = container.querySelector('[data-mindmap-editor]'); old?.remove();
        if (artifact.type !== 'mindmap') return;
        let tree;
        try { tree = JSON.parse(artifact.content); } catch (_) { return; }
        const panel = document.createElement('section'); panel.dataset.mindmapEditor = '1';
        const heading = document.createElement('strong'); heading.textContent = '思维导图节点编辑'; panel.appendChild(heading);
        const body = document.createElement('div'); panel.appendChild(body);
        const preview = document.createElement('div'); preview.className = 'pivot-artifact-viewport'; panel.appendChild(preview);
        function button(text, handler) { const node = document.createElement('button'); node.type = 'button'; node.className = 'btn-secondary'; node.textContent = text; node.onclick = handler; return node; }
        function redraw() {
            body.replaceChildren();
            function visit(node, parent, depth) {
                const row = document.createElement('div'); row.className = 'agent-harness-form-actions';
                const label = document.createElement('label'); label.textContent = `${'› '.repeat(depth)}节点`;
                const input = document.createElement('input'); input.className = 'form-input'; input.maxLength = 120; input.value = node.text;
                input.addEventListener('input', () => { node.text = input.value; }); label.appendChild(input); row.appendChild(label);
                row.appendChild(button('添加子节点', () => {
                    const count = current => 1 + (current.children || []).reduce((sum, child) => sum + count(child), 0);
                    if (depth >= 6 || count(tree) >= 120) return showToast('脑图最多支持 120 个节点、6 层。', 'warning');
                    node.children ||= []; node.children.push({ id: `node-${Date.now()}-${Math.floor(Math.random() * 10000)}`, text: '新节点', children: [] }); redraw();
                }));
                if (parent) {
                    row.appendChild(button('上移', () => { const i = parent.children.indexOf(node); if (i > 0) [parent.children[i - 1], parent.children[i]] = [node, parent.children[i - 1]]; redraw(); }));
                    row.appendChild(button('删除分支', () => { parent.children = parent.children.filter(child => child !== node); redraw(); }));
                }
                body.appendChild(row); (node.children || []).forEach(child => visit(child, node, depth + 1));
            }
            visit(tree, null, 0);
        }
        redraw();
        panel.appendChild(button('预览脑图', async () => {
            try {
                const response = await apiFetch(`${API_BASE}/apps/mindmaps/preview`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tree }) });
                const data = await response.json(); if (!response.ok) throw new Error(data.error || '脑图预览失败。');
                PivotSafeHtml.setHtml(preview, data.svg, { USE_PROFILES: { svg: true, svgFilters: true } });
            } catch (error) { showToast(error.message, 'error'); }
        }));
        const save = button('保存脑图并生成新图形', async () => {
            save.disabled = true;
            try {
                const response = await apiFetch(`${API_BASE}/apps/mindmaps`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ artifactId: artifact.id, tree }) });
                const data = await response.json(); if (!response.ok) throw new Error(data.error || '脑图保存失败。');
                showToast('脑图和图形已保存到产物。', 'success');
                await window.Pivot.moduleApi('agent.artifacts').openVersions(artifact.id);
            } catch (error) { showToast(error.message, 'error'); } finally { save.disabled = false; }
        });
        panel.appendChild(save); container.prepend(panel);
    }
    window.Pivot.exposeModule('chat.mindmapEditor', { mount });
}());
