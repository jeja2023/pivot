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

    const SVG_NS = 'http://www.w3.org/2000/svg';

    function createSvgIcon(name, size = 14) {
        const svg = document.createElementNS(SVG_NS, 'svg');
        svg.setAttribute('viewBox', '0 0 24 24');
        svg.setAttribute('width', String(size));
        svg.setAttribute('height', String(size));
        svg.setAttribute('fill', 'none');
        svg.setAttribute('stroke', 'currentColor');
        svg.setAttribute('stroke-width', '2');
        svg.setAttribute('stroke-linecap', 'round');
        svg.setAttribute('stroke-linejoin', 'round');
        svg.setAttribute('aria-hidden', 'true');
        svg.setAttribute('focusable', 'false');

        if (name === 'target') {
            const c1 = document.createElementNS(SVG_NS, 'circle');
            c1.setAttribute('cx', '12');
            c1.setAttribute('cy', '12');
            c1.setAttribute('r', '10');
            const c2 = document.createElementNS(SVG_NS, 'circle');
            c2.setAttribute('cx', '12');
            c2.setAttribute('cy', '12');
            c2.setAttribute('r', '6');
            const c3 = document.createElementNS(SVG_NS, 'circle');
            c3.setAttribute('cx', '12');
            c3.setAttribute('cy', '12');
            c3.setAttribute('r', '2');
            svg.append(c1, c2, c3);
        } else if (name === 'lock') {
            const rect = document.createElementNS(SVG_NS, 'rect');
            rect.setAttribute('x', '3');
            rect.setAttribute('y', '11');
            rect.setAttribute('width', '18');
            rect.setAttribute('height', '11');
            rect.setAttribute('rx', '2');
            rect.setAttribute('ry', '2');
            const path = document.createElementNS(SVG_NS, 'path');
            path.setAttribute('d', 'M7 11V7a5 5 0 0 1 10 0v4');
            svg.append(rect, path);
        }
        return svg;
    }

    function make(tag, className, value) {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (value !== undefined && value !== null) node.textContent = String(value);
        return node;
    }

    function renderPolicyBadges(policy = {}) {
        const container = make('div', 'chat-task-draft-policy-grid');
        const items = [];
        if (policy.maxSteps) items.push({ label: '步数上限', value: `最多 ${policy.maxSteps} 步` });
        if (policy.maxTokenBudget) items.push({ label: 'Token 预算', value: `${Number(policy.maxTokenBudget).toLocaleString('zh-CN')}` });
        if (policy.timeoutMs) items.push({ label: '执行超时', value: `${Math.round(Number(policy.timeoutMs) / 60000)} 分钟` });
        if (policy.toolPolicy) items.push({ label: '工具策略', value: policy.toolPolicy === 'builtin_only' ? '仅内置能力' : policy.toolPolicy });
        if (!items.length) items.push({ label: '运行模式', value: '受控执行' });
        items.forEach(it => {
            const card = make('div', 'chat-task-draft-policy-card');
            const lbl = make('span', 'chat-task-draft-policy-label', it.label);
            const val = make('strong', 'chat-task-draft-policy-value', it.value);
            card.append(lbl, val);
            container.append(card);
        });
        return container;
    }

    function renderPlan(draft) {
        clearChildren(plan);
        const data = draft?.plan || {};
        const risk = data.risk || {};
        const clarification = data.clarification || {};

        // 1. 计划概览与交付物描述
        const overview = make('section', 'chat-task-draft-summary');
        const meta = make('div', 'chat-task-draft-meta');
        const deliveryWrap = make('div', 'chat-task-draft-delivery-wrap');
        const deliveryIcon = make('span', 'chat-task-draft-delivery-icon');
        deliveryIcon.append(createSvgIcon('target', 14));
        const deliveryDesc = make('p', 'chat-task-draft-delivery', data.delivery?.description || '在当前会话交付可追溯的结果、依据与未完成项。');
        deliveryWrap.append(deliveryIcon, deliveryDesc);

        const tags = make('div', 'chat-task-draft-tags');
        const riskBadge = make('span', `chat-task-draft-risk risk-${risk.level || 'low'}`, `风险：${risk.level === 'high' ? '高' : risk.level === 'medium' ? '中' : '低'}`);
        const revisionBadge = make('span', 'chat-task-draft-revision', `计划修订 ${draft.revision || 1}`);
        tags.append(riskBadge, revisionBadge);

        meta.append(deliveryWrap, tags);
        overview.append(meta);
        plan.append(overview);

        // 2. 计划步骤
        const stepsSection = make('section', 'chat-task-draft-section');
        const stepsHead = make('div', 'chat-task-draft-section-head');
        stepsHead.append(make('h4', '', '计划步骤'));
        const stepList = Array.isArray(data.steps) ? data.steps : [];
        if (stepList.length) {
            stepsHead.append(make('span', 'chat-task-draft-badge-count', `共 ${stepList.length} 步`));
        }
        stepsSection.append(stepsHead);

        const steps = make('ol', 'chat-task-draft-steps');
        stepList.forEach((step, idx) => {
            const item = make('li', 'chat-task-draft-step-item');
            const seq = make('span', 'chat-task-draft-step-seq', String(idx + 1));
            const content = make('div', 'chat-task-draft-step-content');
            const title = make('strong', 'chat-task-draft-step-title', step.title || '未命名步骤');
            const note = make('span', `chat-task-draft-step-badge ${step.approval ? 'requires-approval' : 'read-only'}`, step.approval ? '执行前需人工审批' : '只读或受控执行');
            content.append(title, note);
            item.append(seq, content);
            steps.append(item);
        });
        stepsSection.append(steps);
        plan.append(stepsSection);

        // 3. 执行边界与资源配额
        const policySection = make('section', 'chat-task-draft-section');
        const policyHead = make('div', 'chat-task-draft-section-head');
        policyHead.append(make('h4', '', '执行边界与资源限制'));
        policySection.append(policyHead);
        policySection.append(renderPolicyBadges(data.budget || draft.policySnapshot || {}));

        const resourceNoteWrap = make('div', 'chat-task-draft-resource-note-wrap');
        const shieldIcon = make('span', 'chat-task-draft-resource-icon');
        shieldIcon.append(createSvgIcon('lock', 14));
        const resourceNote = make('p', 'chat-task-draft-resource-note', data.resources?.externalTools || '初始受控运行仅允许内置能力；外部工具需在后续策略升级与审批后启用。');
        resourceNoteWrap.append(shieldIcon, resourceNote);
        policySection.append(resourceNoteWrap);
        plan.append(policySection);

        // 4. 补充信息（如需）
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

    let startingInFlight = false;

    function render(draft) {
        activeDraft = draft || activeDraft;
        if (!activeDraft) return;
        if (document.activeElement !== titleInput) titleInput.value = activeDraft.title || '';
        if (document.activeElement !== goalInput) goalInput.value = activeDraft.goal || '';
        status.textContent = statusCopy(activeDraft);
        status.className = `chat-task-draft-status status-${activeDraft.status || 'unknown'}`;
        const editable = ['needs_clarification', 'ready_for_review'].includes(activeDraft.status);
        const canStart = (activeDraft.status === 'ready_for_review' || activeDraft.status === 'approved') && !startingInFlight;
        titleInput.disabled = !editable || busy || startingInFlight;
        goalInput.disabled = !editable || busy || startingInFlight;
        saveButton.disabled = !editable || busy || startingInFlight;
        startButton.disabled = !canStart || busy || startingInFlight;
        if (startingInFlight) {
            startButton.textContent = '正在启动任务...';
        } else {
            startButton.textContent = activeDraft.status === 'ready_for_review' ? '确认计划并开始执行' : (activeDraft.status === 'approved' ? '开始执行' : '暂不可执行');
        }
        openRunButton.hidden = !activeDraft.runId;
        renderPlan(activeDraft);
    }

    function setBusy(value) {
        busy = Boolean(value);
        if (modal) modal.setAttribute('aria-busy', (busy || startingInFlight) ? 'true' : 'false');
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

    function close(force = false) {
        if (!modal || ((busy || startingInFlight) && !force)) return;
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
        if (!activeDraft || busy || startingInFlight) return;
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
        if (!activeDraft || busy || startingInFlight) return;
        if (activeDraft.status === 'needs_clarification') {
            showToastSafe('请补充任务信息并重新生成计划。', 'warning');
            return;
        }
        startingInFlight = true;
        setBusy(true);
        try {
            let draft = activeDraft;
            if (draft.status === 'ready_for_review') {
                draft = await request(`/agents/task-drafts/${encodeURIComponent(draft.id)}/approve`, {
                    method: 'POST',
                    body: JSON.stringify({ revision: draft.revision, planDigest: draft.planDigest })
                });
                activeDraft = draft;
            }
            draft = await request(`/agents/task-drafts/${encodeURIComponent(draft.id)}/start`, {
                method: 'POST',
                body: JSON.stringify({ revision: draft.revision, planDigest: draft.planDigest })
            });
            activeDraft = draft;
            render(draft);
            onRunCreated?.(draft);
            showToastSafe('受控 Agent Run 已创建并开始执行。', 'success');
            close(true);
        } catch (error) {
            showToastSafe(error.message || '启动任务失败。', 'error');
            render(activeDraft);
        } finally {
            startingInFlight = false;
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
