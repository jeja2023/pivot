/* 工作流产品工作区：画布编辑、模板起点与草稿保存恢复。 */
(function () {
    let mounted = false;
    let suppress = false;
    let preferences = [];
    let recentRuns = [];
    let draftId = '';
    let startSequence = 0;
    let startReturnFocus = null;
    const bridge = () => window.Pivot.moduleApi('agent.workflowBridge');
    const drafts = () => window.Pivot.moduleApi('agent.workflowDrafts');
    const escape = text => window.Pivot.legacy.PivotSafeHtml.escapeHtml(String(text ?? ''));
    const el = id => document.getElementById(id);
    function startTemplateIcon(id) {
        if (id === 'knowledge') return '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"></path><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"></path></svg>';
        if (id === 'table') return '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"></rect><line x1="3" y1="9" x2="21" y2="9"></line><line x1="9" y1="21" x2="9" y2="9"></line></svg>';
        return '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 11l3 3L22 4"></path><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"></path></svg>';
    }
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
    function updateRunButtonState() {
        const runBtn = el('workflow-product-run');
        if (!runBtn) return;
        const specEl = el('agent-dag-spec');
        let disabled = false;
        try {
            const text = specEl?.value || '';
            const parsed = JSON.parse(text);
            if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.nodes)) disabled = true;
        } catch (_) {
            disabled = true;
        }
        runBtn.disabled = disabled;
    }
    function mount() {
        if (mounted) return;
        const editor = el('automation-editor-view');
        if (!editor) return;
        mounted = true;
        editor.classList.add('workflow-product-modern');
        const libraryBar = editor.querySelector('.agent-dag-library-bar');
        const actionsGroup = editor.querySelector('.agent-dag-library-bar-actions') || libraryBar;
        let save = el('workflow-product-save');
        if (!save) {
            save = document.createElement('span');
            save.id = 'workflow-product-save';
            save.className = 'workflow-product-save';
            save.setAttribute('role', 'status');
            const management = el('agent-workflow-management-menu');
            if (management && management.parentElement === actionsGroup) {
                actionsGroup.insertBefore(save, management);
            } else {
                actionsGroup.appendChild(save);
            }
        }
        let runBtn = el('workflow-product-run');
        let publishBtn = el('workflow-product-publish');
        if (!publishBtn) {
            publishBtn = document.createElement('button');
            publishBtn.id = 'workflow-product-publish';
            publishBtn.type = 'button';
            publishBtn.className = 'btn-primary';
            publishBtn.textContent = '发布';
            publishBtn.setAttribute('title', '发布当前工作流');
            const management = el('agent-workflow-management-menu');
            if (management && management.parentElement === actionsGroup) {
                actionsGroup.insertBefore(publishBtn, management);
            } else {
                actionsGroup.appendChild(publishBtn);
            }
            publishBtn.addEventListener('click', () => release());
        }
        if (!runBtn) {
            runBtn = document.createElement('button');
            runBtn.id = 'workflow-product-run';
            runBtn.type = 'button';
            runBtn.className = 'btn-secondary';
            runBtn.textContent = '运行';
            runBtn.setAttribute('title', '运行当前工作流');
            actionsGroup.insertBefore(runBtn, publishBtn);
            runBtn.addEventListener('click', () => bridge().run('draft', { inline: true }));
        }
        let results = el('agent-dag-canvas-view-results');
        if (!results) {
            results = document.createElement('button');
            results.id = 'agent-dag-canvas-view-results';
            results.type = 'button';
            results.className = 'btn-secondary agent-dag-canvas-results-btn';
            results.hidden = true;
            PivotSafeHtml.setHtml(results, '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg><span>查看结果</span>');
            const management = el('agent-workflow-management-menu');
            if (management && management.parentElement === actionsGroup) {
                actionsGroup.insertBefore(results, management);
            } else {
                actionsGroup.appendChild(results);
            }
        }
        if (results && results.dataset.boundViewResults !== '1') {
            results.dataset.boundViewResults = '1';
            results.addEventListener('click', () => window.Pivot.moduleApi('agent.workflowResults').open());
        }
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
        for (const [id, label, action] of [
            ['workflow-product-rename-draft', '修改草稿名称', () => void renameDraft()],
            ['agent-workflow-ai-edit-btn', '用自然语言修改', () => window.Pivot.moduleApi('agent.workflowAuthoring').describe()],
            ['agent-workflow-export-draft-btn', '导出当前草稿', () => download()]
        ]) {
            let button = el(id);
            if (!button && management) {
                const menu = management.querySelector('[role="menu"]');
                button = document.createElement('button');
                button.id = id;
                button.type = 'button';
                button.className = 'agent-workflow-management-item';
                button.setAttribute('role', 'menuitem');
                const span = document.createElement('span');
                span.textContent = label;
                button.appendChild(span);
                const deleteBtn = el('agent-workflow-delete-btn');
                if (deleteBtn) menu.insertBefore(button, deleteBtn);
                else menu.appendChild(button);
            }
            if (button && button.dataset.boundWorkflowProductAction !== '1') {
                button.dataset.boundWorkflowProductAction = '1';
                button.addEventListener('click', () => {
                    if (management) management.open = false;
                    if (!bridge().readOnly()) action();
                });
            }
        }
        for (const id of ['workflow-product-results', 'workflow-product-run-form', 'workflow-product-start', 'workflow-product-release']) {
            const panel = document.createElement('section'); panel.id = id; panel.className = 'workflow-product-panel'; panel.hidden = true;
            if (id === 'workflow-product-start') {
                panel.className = 'modal-overlay workflow-product-start-overlay';
                document.body.appendChild(panel);
            }
            else if (id === 'workflow-product-results') document.body.appendChild(panel);
            else editor.appendChild(panel);
        }
        el('agent-dag-spec')?.addEventListener('input', event => {
            updateRunButtonState();
            if (event.detail?.programmatic) return;
            if (!bridge().readOnly()) changed();
        });
    }
    function draftBridge() { return { request: bridge().request, capture: bridge().capture, restore: bridge().restore, readOnly: bridge().readOnly }; }
    function opened() {
        mount(); if (!mounted) return;
        window.Pivot.moduleApi('agent.workflowRunForm')?.close();
        window.Pivot.moduleApi('agent.workflowResults')?.reset();
        window.Pivot.moduleApi('agent.workflowRelease')?.close();
        const isOpeningDraft = suppress;
        suppress = true;
        el('automation-editor-view').classList.remove('workflow-product-run-mode');
        el('workflow-product-results').hidden = true; el('workflow-product-run-form').hidden = true;
        el('workflow-product-release').hidden = true;
        if (!isOpeningDraft) el('workflow-product-recovery').hidden = true;
        el('workflow-product-status').textContent = ''; el('workflow-product-save-actions').hidden = true;
        el('workflow-product-save').textContent = ''; el('workflow-product-save').hidden = bridge().readOnly();
        const aiEditBtn = el('agent-workflow-ai-edit-btn');
        const exportDraftBtn = el('agent-workflow-export-draft-btn');
        if (aiEditBtn) aiEditBtn.hidden = bridge().readOnly();
        if (exportDraftBtn) exportDraftBtn.hidden = bridge().readOnly();
        updateRenameDraft();
        updateRunButtonState();
        refreshFeedback();
        if (!isOpeningDraft) {
            draftId = bridge().current()?.id ? `workflow-${bridge().current().id}` : `new-${globalThis.crypto.randomUUID()}`;
            if (!bridge().readOnly()) { const identity = draftId; void drafts().load(draftId, draftBridge()).then(() => { if (draftId === identity) void window.Pivot.moduleApi('agent.workflowResults').restore(identity); }); }
            else drafts().detach();
        }
        suppress = isOpeningDraft;
        bridge().refreshInputs();
    }
    function changed() {
        if (mounted && !suppress) {
            drafts().changed();
            updateRunButtonState();
        }
    }
    function updateRenameDraft() {
        const button = el('workflow-product-rename-draft');
        if (button) button.hidden = bridge().readOnly() || Boolean(bridge().current()?.id);
    }
    async function chooseDraftName(value = '') {
        const selected = await window.Pivot.legacy.showInputPrompt({ title: '工作流草稿名称', message: '填写工作流名称，之后可在更多操作中修改。', value, maxLength: 100, required: true, requiredMessage: '请填写工作流名称。' });
        return selected === null || selected === undefined ? null : String(selected).trim().slice(0, 100) || null;
    }
    async function renameDraft() {
        if (bridge().readOnly() || bridge().current()?.id) return;
        const before = drafts().current()?.key, owner = bridge().userId(), name = await chooseDraftName(bridge().capture().name);
        if (name && owner === bridge().userId() && el('automation-editor-view')?.getClientRects().length && !bridge().readOnly() && !bridge().current()?.id && before === drafts().current()?.key) bridge().setName(name);
    }
    async function release() { await window.Pivot.moduleApi('agent.workflowRelease').open(); }
    function closeStart({ restoreFocus = true } = {}) {
        startSequence++;
        const panel = el('workflow-product-start');
        if (!panel || panel.hidden) return;
        panel.hidden = true;
        if (restoreFocus && startReturnFocus?.isConnected) startReturnFocus.focus();
        startReturnFocus = null;
    }
    async function start() {
        mount(); const panel = el('workflow-product-start');
        const sequence = ++startSequence, owner = bridge().userId();
        if (panel.hidden) startReturnFocus = document.activeElement;
        panel.hidden = false;
        PivotSafeHtml.setHtml(panel, '<section class="modal workspace-modal workflow-product-start-dialog" role="dialog" aria-modal="true" aria-labelledby="workflow-product-start-title"><header class="workspace-modal-header workflow-product-start-header"><div class="workflow-product-start-title-wrap"><span class="workflow-product-start-title-icon" aria-hidden="true"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1.5"></rect><rect x="14" y="3" width="7" height="7" rx="1.5"></rect><rect x="14" y="14" width="7" height="7" rx="1.5"></rect><path d="M10 6.5h4"></path><path d="M17.5 10v4"></path></svg></span><div class="workflow-product-start-title-copy"><h3 id="workflow-product-start-title">新建工作流</h3><p class="workflow-product-start-subtitle">选择场景模板快速起步，或使用空白画布、自然语言草稿与已保存进度</p></div></div><button type="button" class="btn-secondary workspace-modal-close" data-start-close aria-label="关闭新建工作流">关闭</button></header><div class="workspace-modal-body workflow-product-start-body" id="workflow-product-start-content"><p class="workflow-product-start-loading" role="status">正在加载工作流模板和草稿…</p></div></section>');
        panel.onclick = event => { if (event.target === panel || event.target.closest('[data-start-close]')) closeStart(); };
        panel.onkeydown = event => {
            if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeStart(); return; }
            if (event.key !== 'Tab') return;
            const controls = [...panel.querySelectorAll('button:not([disabled]), select:not([disabled]), textarea:not([disabled]), input:not([disabled]), summary, a[href]')].filter(item => item.getClientRects().length);
            if (!controls.length) return;
            if (event.shiftKey && document.activeElement === controls[0]) { event.preventDefault(); controls.at(-1).focus(); }
            else if (!event.shiftKey && document.activeElement === controls.at(-1)) { event.preventDefault(); controls[0].focus(); }
        };
        panel.querySelector('[data-start-close]').focus();
        const templates = window.Pivot.moduleApi('agent.workflowTemplates').templates;
        let remote = [], listUnavailable = false;
        try {
            const response = await bridge().request('/agents/workflow-editor/drafts');
            if (!response.ok) throw new Error('读取失败');
            const data = await response.json();
            if (!Array.isArray(data.data)) throw new Error('返回格式无效');
            remote = data.data;
        } catch (_) { listUnavailable = true; }
        if (sequence !== startSequence || owner !== bridge().userId() || panel.hidden) return;
        const local = drafts().listLocal();
        const draftMap = new Map(remote.map(item => [item.draft_key, item]));
        local.forEach(item => { if (item.pending || !draftMap.has(item.key)) draftMap.set(item.key, { ...draftMap.get(item.key), draft_key: item.key, name: item.name, workflow_id: item.workflowId, updated_at: '本机副本，待同步', local: item }); });
        const saved = [...draftMap.values()];
        const content = el('workflow-product-start-content');
        PivotSafeHtml.setHtml(content, `<div class="workflow-product-start-toolbar"><div class="workflow-product-start-section-head"><h3>从要完成的工作开始</h3><p>挑选预设场景查看示例结果，生成后可在画布中自由编排</p></div></div><div class="workflow-product-templates">${templates.map(item => `<section class="workflow-product-template-card"><div class="workflow-product-template-head"><span class="workflow-product-template-icon workflow-product-template-icon--${escape(item.id)}" aria-hidden="true">${startTemplateIcon(item.id)}</span><h3>${escape(item.name)}</h3></div><p class="workflow-product-template-desc">${escape(item.description)}</p><small class="workflow-product-template-needs">需要：${escape(item.needs)}</small><details class="workflow-product-template-example"><summary>查看示例结果（非实际运行）</summary><p>${escape(item.example)}</p></details><div class="workflow-product-template-actions"><button type="button" class="btn-primary workflow-product-template-btn" data-template="${item.id}">使用模板</button></div></section>`).join('')}</div><div class="workflow-product-start-alt"><div class="workflow-product-start-alt-copy"><strong>其他构建方式</strong><span>从空画布手动编排节点，或通过一句话描述生成初始草稿</span></div><div class="workflow-product-row workflow-product-start-alt-actions"><button type="button" class="btn-secondary workflow-product-start-alt-btn" data-start-blank><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2"></rect><line x1="12" y1="8" x2="12" y2="16"></line><line x1="8" y1="12" x2="16" y2="12"></line></svg><span>从空白开始</span></button><button type="button" class="btn-secondary workflow-product-start-alt-btn" data-start-ai aria-expanded="false"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3l1.9 4.5L18.5 9.4l-4.6 1.9L12 16l-1.9-4.7-4.6-1.9 4.6-1.9L12 3z"></path><path d="M5 18l.8 1.8L7.5 20.5l-1.7.7L5 23l-.8-1.8-1.7-.7 1.7-.7L5 18z"></path></svg><span>用自然语言生成 / 修改草稿</span></button></div></div>${saved.length ? `<details class="workflow-product-start-drafts" open><summary><span class="workflow-product-start-drafts-title">继续已保存的草稿</span><span class="workflow-product-start-draft-count">${saved.length}</span></summary><div class="workflow-product-start-draft-list">${saved.map(item => `<button class="btn-secondary workflow-product-draft-item" type="button" data-open-draft="${escape(item.draft_key)}" title="${escape(item.name)} · ${escape(item.updated_at)}"><span class="workflow-product-draft-name">${escape(item.name)}</span><span class="workflow-product-draft-time"><span aria-hidden="true">· </span>${escape(item.updated_at)}</span></button>`).join('')}</div></details>` : ''}<div id="workflow-product-start-detail"></div>`);
        const models = bridge().models(); const chooser = document.createElement('label'); chooser.className = 'workflow-product-field workflow-product-start-model-field';
        PivotSafeHtml.setHtml(chooser, `<span>模板使用的文本模型</span><select class="form-input workflow-authoring-select" data-template-model>${models.map(model => `<option value="${escape(model.id)}">${escape(model.name)}</option>`).join('')}<option value="">稍后配置，先查看示例与画布</option></select>${!models.length ? '<small class="workflow-product-start-model-hint">当前没有可用文本模型。示例结果可以直接查看，正式试运行前请在模型设置中配置授权模型。</small>' : ''}`);
        content.querySelector('.workflow-product-start-toolbar').appendChild(chooser);
        if (listUnavailable) {
            const notice = document.createElement('div'); notice.className = 'workflow-product-notice workflow-product-start-notice';
            PivotSafeHtml.setHtml(notice, '<span role="status">服务器草稿暂时无法读取，仍可使用模板或本机草稿。</span> <button type="button" class="btn-secondary btn-xs" data-start-retry>重试读取</button>');
            content.appendChild(notice);
            notice.querySelector('[data-start-retry]').addEventListener('click', () => void start());
        }
        panel.querySelectorAll('[data-template]').forEach(button => button.addEventListener('click', async () => {
            const value = window.Pivot.moduleApi('agent.workflowTemplates').instantiate(button.dataset.template, chooser.querySelector('select').value);
            const owner = bridge().userId();
            const name = await chooseDraftName(value.name);
            if (!name || owner !== bridge().userId() || sequence !== startSequence || panel.hidden || !panel.getClientRects().length) return;
            closeStart({ restoreFocus: false }); bridge().newWorkflow({ name, description: value.description }); bridge().write(value.spec); drafts().changed();
        }));
        panel.querySelector('[data-start-blank]').addEventListener('click', async () => { const owner = bridge().userId(), name = await chooseDraftName(); if (!name || owner !== bridge().userId() || sequence !== startSequence || panel.hidden || !panel.getClientRects().length) return; closeStart({ restoreFocus: false }); bridge().newWorkflow({ name }); });
        const startAiBtn = panel.querySelector('[data-start-ai]');
        startAiBtn.addEventListener('click', () => {
            const detailEl = el('workflow-product-start-detail');
            startAiBtn.setAttribute('aria-expanded', 'true');
            startAiBtn.classList.add('is-active');
            window.Pivot.moduleApi('agent.workflowAuthoring').describe(detailEl);
            detailEl?.scrollIntoView?.({ block: 'nearest' });
        });
        panel.querySelectorAll('[data-open-draft]').forEach(button => button.addEventListener('click', async () => {
            const entry = draftMap.get(button.dataset.openDraft);
            const draftResponse = await bridge().request(`/agents/workflow-editor/drafts/${encodeURIComponent(button.dataset.openDraft)}`).catch(() => null);
            const data = draftResponse ? await draftResponse.json() : {};
            if (sequence !== startSequence || owner !== bridge().userId() || panel.hidden) return;
            if (draftResponse && !draftResponse.ok && draftResponse.status !== 404) { el('workflow-product-start-detail').textContent = data.error || '无法读取原草稿，请重试。'; return; }
            const draft = data.draft || (entry?.local ? { draft_key: entry.draft_key, workflow_id: entry.local.workflowId, name: entry.local.name, description: entry.local.description, spec_text: entry.local.specText } : null);
            if (!draft) return;
            closeStart({ restoreFocus: false }); drafts().detach();
            draftId = draft.draft_key;
            suppress = true;
            if (draft.workflow_id) bridge().openEditor(draft.workflow_id, { readOnly: false });
            else bridge().newWorkflow({ name: draft.name });
            bridge().restore({ specText: draft.spec_text, name: draft.name, description: draft.description });
            suppress = false;
            await drafts().load(draftId, draftBridge());
            if (!data.draft && entry?.local?.pending) drafts().changed();
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
    function closed() { closeStart({ restoreFocus: false }); draftId = null; drafts().detach(); window.Pivot.moduleApi('agent.workflowResults').stop(); window.Pivot.moduleApi('agent.workflowResults').close({ restoreFocus: false }); window.Pivot.moduleApi('agent.workflowRunForm')?.close(); window.Pivot.moduleApi('agent.workflowRelease')?.close(); }
    window.Pivot.registerModule('agent.workflowExperience', { mount, opened, changed, status, saveStatus, offerRecovery, compareDraft, start, closeStart, release, closed, updateRenameDraft,
        showNodeResult: (...args) => window.Pivot.moduleApi('agent.workflowResults').nodeResult(...args),
        refreshPreferences, toggleFavorite, recent, openRecent, preferences: () => preferences });
})();
