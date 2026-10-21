/* 工作流产品工作区：画布编辑、模板起点与草稿保存恢复。 */
(function () {
    let mounted = false;
    let suppress = false;
    let preferences = [];
    let recentRuns = [];
    let draftId = '';
    const bridge = () => window.Pivot.moduleApi('agent.workflowBridge');
    const drafts = () => window.Pivot.moduleApi('agent.workflowDrafts');
    const escape = text => window.Pivot.legacy.PivotSafeHtml.escapeHtml(String(text ?? ''));
    const el = id => document.getElementById(id);
    function status(message, tone = '') {
        const target = el('workflow-product-status');
        if (!target) return;
        target.textContent = message; target.dataset.tone = tone; refreshFeedback();
    }
    function download(value = bridge().capture()) {
        const blob = new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' });
        const link = document.createElement('a'); link.href = URL.createObjectURL(blob); link.download = `${value.name || '工作流'}-草稿.json`; link.click(); URL.revokeObjectURL(link.href);
    }
    function saveStatus(message, tone, error) {
        const target = el('workflow-product-save');
        if (!target) return;
        target.textContent = message;
        target.dataset.tone = tone || '';
        el('workflow-product-save-actions').hidden = !error;
        if (error) status(error.message, tone);
        else { status(''); refreshFeedback(); }
    }
    function offerRecovery(candidate, restore) {
        const target = el('workflow-product-recovery');
        if (!target) return;
        target.hidden = false; refreshFeedback();
        PivotSafeHtml.setHtml(target, `<span>找到“${escape(candidate.name)}”的编辑草稿。</span><button type="button" class="btn-secondary" data-restore>恢复编辑</button><button type="button" class="btn-secondary" data-dismiss>保留当前画布</button>`);
        target.querySelector('[data-restore]').addEventListener('click', () => { restore(); target.hidden = true; refreshFeedback(); });
        target.querySelector('[data-dismiss]').addEventListener('click', () => { target.hidden = true; refreshFeedback(); });
    }
    function compareDraft(local, remote, load) {
        const target = el('workflow-product-recovery'); target.hidden = false; refreshFeedback();
        PivotSafeHtml.setHtml(target, `<h3>草稿冲突</h3><p>本地修改仍保留。请先导出或另存副本，再决定是否载入服务器版本。</p><details><summary>查看差异</summary><pre>${escape(JSON.stringify({ local, server: remote }, null, 2))}</pre></details><button type="button" class="btn-secondary" data-remote>载入服务器版本</button><button type="button" class="btn-secondary" data-export>导出本地副本</button>`);
        target.querySelector('[data-remote]').addEventListener('click', () => { load(); target.hidden = true; refreshFeedback(); });
        target.querySelector('[data-export]').addEventListener('click', () => download(local));
    }
    function refreshFeedback() {
        const feedback = el('workflow-product-feedback');
        if (feedback) feedback.hidden = el('workflow-product-save-actions').hidden && el('workflow-product-recovery').hidden && !el('workflow-product-status').textContent;
    }
    function mount() {
        if (mounted) return;
        const editor = el('automation-editor-view');
        if (!editor) return;
        mounted = true;
        const libraryBar = editor.querySelector('.agent-dag-library-bar');
        const save = document.createElement('span'); save.id = 'workflow-product-save'; save.setAttribute('role', 'status');
        libraryBar.appendChild(save);
        const results = document.createElement('button'); results.id = 'agent-dag-canvas-view-results'; results.type = 'button'; results.className = 'btn-secondary'; results.hidden = true; results.textContent = '查看结果';
        results.addEventListener('click', () => window.Pivot.moduleApi('agent.workflowResults').open());
        libraryBar.appendChild(results);
        const feedback = document.createElement('section'); feedback.id = 'workflow-product-feedback'; feedback.hidden = true;
        PivotSafeHtml.setHtml(feedback, '<div id="workflow-product-save-actions" class="workflow-product-row" hidden><button type="button" class="btn-secondary" data-save-retry>重试保存</button><button type="button" class="btn-secondary" data-draft-compare>查看冲突</button><button type="button" class="btn-secondary" data-draft-copy>另存草稿副本</button><button type="button" class="btn-secondary" data-draft-export>导出副本</button></div><div id="workflow-product-recovery" class="workflow-product-notice" hidden></div><div id="workflow-product-status" role="status" aria-live="polite"></div>');
        libraryBar.after(feedback);
        feedback.querySelector('[data-save-retry]').addEventListener('click', () => void drafts().flush());
        feedback.querySelector('[data-draft-compare]').addEventListener('click', () => void drafts().latest());
        feedback.querySelector('[data-draft-copy]').addEventListener('click', () => {
            const captured = bridge().capture(); drafts().detach(); bridge().choose(null);
            draftId = `new-${globalThis.crypto.randomUUID()}`;
            void drafts().load(draftId, draftBridge()).then(() => { bridge().restore({ ...captured, name: `${captured.name} 副本` }); drafts().changed(); });
        });
        feedback.querySelector('[data-draft-export]').addEventListener('click', () => download());
        const management = el('agent-workflow-management-menu');
        const menu = management.querySelector('[role="menu"]');
        for (const [id, label, action] of [
            ['agent-workflow-ai-edit-btn', '用自然语言修改', () => window.Pivot.moduleApi('agent.workflowAuthoring').describe()],
            ['agent-workflow-export-draft-btn', '导出当前草稿', () => download()]
        ]) {
            const button = document.createElement('button'); button.id = id; button.type = 'button'; button.className = 'agent-workflow-management-item'; button.setAttribute('role', 'menuitem'); button.textContent = label;
            button.addEventListener('click', () => { management.open = false; if (!bridge().readOnly()) action(); });
            menu.appendChild(button);
        }
        for (const id of ['workflow-product-results', 'workflow-product-run-form', 'workflow-product-start', 'workflow-product-release']) {
            const panel = document.createElement('section'); panel.id = id; panel.className = 'workflow-product-panel'; panel.hidden = true;
            if (id === 'workflow-product-start') el('automation-assets-view').prepend(panel);
            else editor.appendChild(panel);
        }
        el('agent-dag-spec').addEventListener('input', event => { if (event.isTrusted && !bridge().readOnly()) changed(); });
    }
    function draftBridge() { return { request: bridge().request, capture: bridge().capture, restore: bridge().restore, readOnly: bridge().readOnly }; }
    function opened() {
        mount(); if (!mounted) return;
        window.Pivot.moduleApi('agent.workflowRunForm')?.close();
        window.Pivot.moduleApi('agent.workflowResults')?.reset();
        window.Pivot.moduleApi('agent.workflowRelease')?.close();
        suppress = true;
        el('automation-editor-view').classList.remove('workflow-product-run-mode');
        el('workflow-product-results').hidden = true; el('workflow-product-run-form').hidden = true;
        el('workflow-product-release').hidden = true; el('workflow-product-recovery').hidden = true;
        el('workflow-product-status').textContent = ''; el('workflow-product-save-actions').hidden = true;
        el('workflow-product-save').textContent = ''; el('workflow-product-save').hidden = bridge().readOnly();
        el('agent-workflow-ai-edit-btn').hidden = bridge().readOnly(); el('agent-workflow-export-draft-btn').hidden = bridge().readOnly();
        refreshFeedback();
        draftId = bridge().current()?.id ? `workflow-${bridge().current().id}` : `new-${globalThis.crypto.randomUUID()}`;
        if (!bridge().readOnly()) { const identity = draftId; void drafts().load(draftId, draftBridge()).then(() => { if (draftId === identity) void window.Pivot.moduleApi('agent.workflowResults').restore(identity); }); }
        else drafts().detach();
        suppress = false;
        bridge().refreshInputs();
    }
    function changed() { if (mounted && !suppress) drafts().changed(); }
    async function release() { await window.Pivot.moduleApi('agent.workflowRelease').open(); }
    async function start() {
        mount(); const panel = el('workflow-product-start'); panel.hidden = false;
        const templates = window.Pivot.moduleApi('agent.workflowTemplates').templates;
        const response = await bridge().request('/agents/workflow-editor/drafts').catch(() => null);
        const remote = response?.ok ? (await response.json()).data : [];
        const local = drafts().listLocal();
        const draftMap = new Map(remote.map(item => [item.draft_key, item]));
        local.forEach(item => { if (item.pending || !draftMap.has(item.key)) draftMap.set(item.key, { ...draftMap.get(item.key), draft_key: item.key, name: item.name, workflow_id: item.workflowId, updated_at: '本机副本，待同步', local: item }); });
        const saved = [...draftMap.values()];
        PivotSafeHtml.setHtml(panel, `<h3>从要完成的工作开始</h3><div class="workflow-product-templates">${templates.map(item => `<section><h3>${escape(item.name)}</h3><p>${escape(item.description)}</p><small>需要：${escape(item.needs)}</small><details><summary>查看示例结果（非实际运行）</summary><p>${escape(item.example)}</p></details><button type="button" class="btn-primary" data-template="${item.id}">使用模板</button></section>`).join('')}</div><div class="workflow-product-row"><button type="button" class="btn-secondary" data-start-blank>从空白开始</button><button type="button" class="btn-secondary" data-start-ai>用自然语言生成 / 修改草稿</button></div>${saved.length ? `<details open><summary>继续已保存的草稿</summary>${saved.map(item => `<button class="btn-secondary" type="button" data-open-draft="${escape(item.draft_key)}">${escape(item.name)} · ${escape(item.updated_at)}</button>`).join('')}</details>` : ''}<div id="workflow-product-start-detail"></div>`);
        const models = bridge().models(); const chooser = document.createElement('label'); chooser.className = 'workflow-product-field';
        PivotSafeHtml.setHtml(chooser, `<span>模板使用的文本模型</span><select class="form-input" data-template-model>${models.map(model => `<option value="${escape(model.id)}">${escape(model.name)}</option>`).join('')}<option value="">稍后配置，先查看示例与画布</option></select>${!models.length ? '<small>当前没有可用文本模型。示例结果可以直接查看，正式试运行前请在模型设置中配置授权模型。</small>' : ''}`);
        panel.querySelector('h3').after(chooser);
        panel.querySelectorAll('[data-template]').forEach(button => button.addEventListener('click', () => {
            const value = window.Pivot.moduleApi('agent.workflowTemplates').instantiate(button.dataset.template, chooser.querySelector('select').value);
            bridge().newWorkflow({ name: value.name, description: value.description }); bridge().write(value.spec); drafts().changed(); panel.hidden = true;
        }));
        panel.querySelector('[data-start-blank]').addEventListener('click', () => { panel.hidden = true; bridge().newWorkflow({}); });
        panel.querySelector('[data-start-ai]').addEventListener('click', () => window.Pivot.moduleApi('agent.workflowAuthoring').describe(el('workflow-product-start-detail')));
        panel.querySelectorAll('[data-open-draft]').forEach(button => button.addEventListener('click', async () => {
            const entry = draftMap.get(button.dataset.openDraft);
            const draftResponse = await bridge().request(`/agents/workflow-editor/drafts/${encodeURIComponent(button.dataset.openDraft)}`).catch(() => null);
            const data = draftResponse ? await draftResponse.json() : {};
            if (draftResponse && !draftResponse.ok && draftResponse.status !== 404) { el('workflow-product-start-detail').textContent = data.error || '无法读取原草稿，请重试。'; return; }
            const draft = data.draft || (entry?.local ? { draft_key: entry.draft_key, workflow_id: entry.local.workflowId, name: entry.local.name, description: entry.local.description, spec_text: entry.local.specText } : null);
            if (!draft) return;
            if (draft.workflow_id) bridge().openEditor(draft.workflow_id, { readOnly: false });
            else bridge().newWorkflow({ name: draft.name });
            drafts().detach(); draftId = draft.draft_key;
            bridge().restore({ specText: draft.spec_text, name: draft.name, description: draft.description });
            await drafts().load(draftId, draftBridge());
            if (!data.draft && entry?.local?.pending) drafts().changed();
            panel.hidden = true;
            void window.Pivot.moduleApi('agent.workflowResults').restore(draftId);
        }));
    }
    async function refreshPreferences() {
        try {
            const [response, runs] = await Promise.all([bridge().request('/agents/workflow-editor/preferences'), bridge().request('/agents/workflow-editor/recent-runs')]);
            if (response.ok) preferences = (await response.json()).data;
            if (runs.ok) recentRuns = (await runs.json()).data;
        } catch (_) { /* 收藏或历史不可用时保留工作流列表。 */ }
    }
    function recent(workflowId) { return recentRuns.find(item => String(item.workflow_id) === String(workflowId)); }
    async function openRecent(workflowId) {
        const run = recent(workflowId); if (!run) return;
        const workflow = bridge().workflows().find(item => String(item.id) === String(workflowId));
        bridge().openEditor(workflowId, { readOnly: !workflow?.can_edit });
        await window.Pivot.moduleApi('agent.workflowResults').watch(run, '历史发布运行');
    }
    async function toggleFavorite(id) {
        const favorite = !preferences.find(item => String(item.workflow_id) === String(id))?.favorite;
        await bridge().request(`/agents/workflows/${id}/preference`, { method: 'PATCH', body: JSON.stringify({ favorite }) });
        await refreshPreferences(); window.Pivot.moduleApi('agent.automation').renderAssetCenter();
    }
    function closed() { drafts().detach(); window.Pivot.moduleApi('agent.workflowResults').stop(); window.Pivot.moduleApi('agent.workflowRunForm')?.close(); window.Pivot.moduleApi('agent.workflowRelease')?.close(); }
    window.Pivot.registerModule('agent.workflowExperience', { mount, opened, changed, status, saveStatus, offerRecovery, compareDraft, start, release, closed,
        showNodeResult: (...args) => window.Pivot.moduleApi('agent.workflowResults').nodeResult(...args),
        refreshPreferences, toggleFavorite, recent, openRecent, preferences: () => preferences });
})();
