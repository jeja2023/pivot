/* 聊天任务草案审阅器：任务规划仅作为审阅步骤，绝不直接执行。 */
(function () {
    const modal = document.getElementById('chat-task-draft-modal');
    const titleInput = document.getElementById('chat-task-draft-title');
    const goalInput = document.getElementById('chat-task-draft-goal');
    const status = document.getElementById('chat-task-draft-status');
    const plan = document.getElementById('chat-task-draft-plan');
    const saveButton = document.getElementById('chat-task-draft-save');
    const startButton = document.getElementById('chat-task-draft-start');
    const closeButton = document.getElementById('chat-task-draft-close');
    const dismissButton = document.getElementById('chat-task-draft-dismiss');
    const openRunButton = document.getElementById('chat-task-draft-open-run');
    let activeDraft = null;
    let opener = null;
    let onRunCreated = null;
    let busy = false;

    function showToastSafe(message, type = 'info') {
        if (typeof showToast === 'function') showToast(message, type);
    }

    async function request(path, options = {}) {
        const response = await apiFetch(`${API_BASE}${path}`, {
            headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
            ...options
        });
        const body = await response.json().catch(() => ({}));
        if (!response.ok) {
            const error = new Error(body.error || '任务草案请求失败。');
            error.code = body.code || 'AGENT_TASK_DRAFT_REQUEST_FAILED';
            throw error;
        }
        return body.data;
    }

    function clearChildren(node) {
        while (node?.firstChild) node.removeChild(node.firstChild);
    }

    function make(tag, className, value) {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (value !== undefined && value !== null) node.textContent = String(value);
        return node;
    }

    function formatPolicy(policy = {}) {
        const parts = [];
        if (policy.maxSteps) parts.push(`最多 ${policy.maxSteps} 步`);
        if (policy.maxTokenBudget) parts.push(`${Number(policy.maxTokenBudget).toLocaleString('zh-CN')} Token`);
        if (policy.timeoutMs) parts.push(`${Math.round(Number(policy.timeoutMs) / 60000)} 分钟上限`);
        if (policy.toolPolicy) parts.push(policy.toolPolicy === 'builtin_only' ? '仅内置能力' : policy.toolPolicy);
        return parts.join(' · ');
    }

    function renderPlan(draft) {
        clearChildren(plan);
        const data = draft?.plan || {};
        const risk = data.risk || {};
        const clarification = data.clarification || {};
        const overview = make('section', 'chat-task-draft-summary');
        const meta = make('div', 'chat-task-draft-meta');
        meta.append(make('span', `chat-task-draft-risk risk-${risk.level || 'low'}`, `风险：${risk.level === 'high' ? '高' : risk.level === 'medium' ? '中' : '低'}`));
        meta.append(make('span', 'chat-task-draft-revision', `计划修订 ${draft.revision}`));
        overview.append(meta);
        overview.append(make('p', 'chat-task-draft-delivery', data.delivery?.description || '将在当前会话交付可追溯结果。'));
        plan.append(overview);

        const stepsSection = make('section', 'chat-task-draft-section');
        stepsSection.append(make('h4', '', '计划步骤'));
        const steps = make('ol', 'chat-task-draft-steps');
        (Array.isArray(data.steps) ? data.steps : []).forEach(step => {
            const item = make('li');
            const title = make('strong', '', step.title || '未命名步骤');
            const note = make('span', '', step.approval ? '执行前可能需要额外审批' : '只读或受控执行');
            item.append(title, note);
            steps.append(item);
        });
        stepsSection.append(steps);
        plan.append(stepsSection);

        const policySection = make('section', 'chat-task-draft-section');
        policySection.append(make('h4', '', '执行边界'));
        policySection.append(make('p', '', formatPolicy(data.budget || draft.policySnapshot || {})));
        policySection.append(make('p', 'chat-task-draft-resource-note', data.resources?.externalTools || '外部工具须按运行时策略审批。'));
        plan.append(policySection);

        if (clarification.required || (Array.isArray(clarification.items) && clarification.items.length)) {
            const clarificationSection = make('section', 'chat-task-draft-clarification');
            clarificationSection.append(make('strong', '', '需要补充信息'));
            const list = make('ul');
            (clarification.items || []).forEach(item => list.append(make('li', '', item)));
            clarificationSection.append(list);
            plan.append(clarificationSection);
        }
    }

    function statusCopy(draft) {
        const statuses = {
            needs_clarification: '请补充任务目标后重新生成计划；此状态不能启动执行。',
            ready_for_review: '计划仅供审阅，尚未调用模型、检索或工具。确认后才会创建 Agent Run。',
            approved: '计划已由你确认。现在可以创建受控 Agent Run。',
            starting: '正在创建受控 Agent Run，请勿重复操作。',
            run_created: 'Agent Run 已创建；可在运行区查看进度、审批与最终结果。',
            expired: '草案已过期，请重新创建以获取新的计划与策略快照。',
            cancelled: '草案已取消。'
        };
        return statuses[draft?.status] || '任务草案状态未知。';
    }

    function render(draft) {
        activeDraft = draft || activeDraft;
        if (!activeDraft) return;
        if (document.activeElement !== titleInput) titleInput.value = activeDraft.title || '';
        if (document.activeElement !== goalInput) goalInput.value = activeDraft.goal || '';
        status.textContent = statusCopy(activeDraft);
        status.className = `chat-task-draft-status status-${activeDraft.status || 'unknown'}`;
        const editable = ['needs_clarification', 'ready_for_review'].includes(activeDraft.status);
        const canStart = activeDraft.status === 'ready_for_review' || activeDraft.status === 'approved';
        titleInput.disabled = !editable || busy;
        goalInput.disabled = !editable || busy;
        saveButton.disabled = !editable || busy;
        startButton.disabled = !canStart || busy;
        startButton.textContent = activeDraft.status === 'ready_for_review' ? '确认计划并开始执行' : (activeDraft.status === 'approved' ? '开始执行' : '暂不可执行');
        openRunButton.hidden = !activeDraft.runId;
        renderPlan(activeDraft);
    }

    function setBusy(value) {
        busy = Boolean(value);
        if (modal) modal.setAttribute('aria-busy', busy ? 'true' : 'false');
        render(activeDraft);
    }

    function open(draft, options = {}) {
        if (!modal) return;
        activeDraft = draft;
        opener = options.opener || document.activeElement;
        onRunCreated = typeof options.onRunCreated === 'function' ? options.onRunCreated : null;
        modal.classList.remove('hidden');
        modal.removeAttribute('hidden');
        render(draft);
        window.setTimeout(() => goalInput?.focus(), 0);
    }

    function close() {
        if (!modal || busy) return;
        modal.classList.add('hidden');
        modal.setAttribute('hidden', '');
        const focusTarget = opener;
        opener = null;
        if (focusTarget && document.contains(focusTarget) && typeof focusTarget.focus === 'function') focusTarget.focus();
    }

    async function createAndOpen(payload, options = {}) {
        setBusy(true);
        try {
            // 关闭审阅弹窗不应丢失可编辑计划；当相同文本再次触发时，
            // 重新打开其最新的有效草案，避免静默创建重复草案。
            const existing = await request(`/agents/task-drafts?sessionId=${encodeURIComponent(payload.sessionId || '')}`);
            const reusable = (Array.isArray(existing) ? existing : []).find(item => (
                item.goal === payload.goal && ['needs_clarification', 'ready_for_review', 'approved'].includes(item.status)
            ));
            if (reusable) {
                open(reusable, options);
                return reusable;
            }
            const draft = await request('/agents/task-drafts', { method: 'POST', body: JSON.stringify(payload) });
            open(draft, options);
            return draft;
        } finally {
            setBusy(false);
        }
    }

    async function save() {
        if (!activeDraft || busy) return;
        setBusy(true);
        try {
            const draft = await request(`/agents/task-drafts/${encodeURIComponent(activeDraft.id)}`, {
                method: 'PATCH',
                body: JSON.stringify({ revision: activeDraft.revision, title: titleInput.value, goal: goalInput.value })
            });
            render(draft);
            showToastSafe('任务计划已重新生成，请再次审阅。', 'success');
        } catch (error) {
            showToastSafe(error.message || '任务计划更新失败。', 'error');
        } finally {
            setBusy(false);
        }
    }

    async function approveAndStart() {
        if (!activeDraft || busy) return;
        if (activeDraft.status === 'needs_clarification') {
            showToastSafe('请补充任务信息并重新生成计划。', 'warning');
            return;
        }
        setBusy(true);
        try {
            let draft = activeDraft;
            if (draft.status === 'ready_for_review') {
                draft = await request(`/agents/task-drafts/${encodeURIComponent(draft.id)}/approve`, {
                    method: 'POST',
                    body: JSON.stringify({ revision: draft.revision, planDigest: draft.planDigest })
                });
                render(draft);
            }
            draft = await request(`/agents/task-drafts/${encodeURIComponent(draft.id)}/start`, {
                method: 'POST',
                body: JSON.stringify({ revision: draft.revision, planDigest: draft.planDigest })
            });
            render(draft);
            onRunCreated?.(draft);
            showToastSafe('受控 Agent Run 已创建。', 'success');
        } catch (error) {
            showToastSafe(error.message || '启动任务失败。', 'error');
        } finally {
            setBusy(false);
        }
    }

    closeButton?.addEventListener('click', close);
    dismissButton?.addEventListener('click', close);
    modal?.addEventListener('click', event => { if (event.target === modal) close(); });
    modal?.addEventListener('keydown', event => { if (event.key === 'Escape') { event.preventDefault(); close(); } });
    saveButton?.addEventListener('click', save);
    startButton?.addEventListener('click', approveAndStart);
    openRunButton?.addEventListener('click', async () => {
        if (!activeDraft?.runId) return;
        close();
        if (typeof window.Pivot?.legacy?.openAgentRun === 'function') await window.Pivot.legacy.openAgentRun(activeDraft.runId);
    });

    window.Pivot.exposeModule('chat.taskDrafts', { createAndOpen, open, close, render });
}());
