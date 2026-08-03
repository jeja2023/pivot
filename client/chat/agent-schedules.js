// Agent 计划任务
// 拆自 agents.js。
/* eslint-disable no-undef */
async function loadAgentSchedules() {
    const automationList = document.getElementById('automation-schedule-assets-list');
    if (!automationList) return;
    const res = await apiFetch(`${API_BASE}/agents/schedules`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || '计划队列加载失败');
    agentSchedulesCache = data.data || [];
    window.Pivot.moduleApi('agent.automation').renderAssetCenter?.();
}

let activeAgentScheduleEditorId = '';
let activeAgentScheduleEditorConfig = {};

function parseAgentScheduleConfig(schedule) {
    const value = schedule?.run_config;
    if (value && typeof value === 'object') return { ...value };
    try {
        return JSON.parse(value || '{}');
    } catch (e) {
        return {};
    }
}

function setAgentScheduleEditorStatus(message = '', state = '') {
    const target = document.getElementById('agent-schedule-editor-status');
    if (!target) return;
    target.textContent = message;
    target.className = state;
}

function replaceAgentScheduleOptions(select, items, placeholder) {
    if (!select) return;
    const options = [new Option(placeholder, '')];
    items.forEach(item => options.push(new Option(item.label, String(item.value))));
    select.replaceChildren(...options);
}

function syncAgentScheduleEditorUi() {
    const source = document.getElementById('agent-schedule-editor-source')?.value || 'free';
    const frequency = document.getElementById('agent-schedule-editor-frequency')?.value || 'daily';
    document.getElementById('agent-schedule-editor-goal-field')?.classList.toggle('hidden', source !== 'free');
    document.getElementById('agent-schedule-editor-model-field')?.classList.toggle('hidden', source !== 'free');
    document.getElementById('agent-schedule-editor-workflow-field')?.classList.toggle('hidden', source !== 'workflow');
    document.getElementById('agent-schedule-editor-time-field')?.classList.toggle('hidden', frequency === 'manual');
    document.getElementById('agent-schedule-editor-weekday-field')?.classList.toggle('hidden', frequency !== 'weekly');
    const hint = document.getElementById('agent-schedule-editor-source-hint');
    if (hint) hint.textContent = source === 'workflow' ? '按工作流发布版运行' : '由 AI 根据目标自主规划执行';
}

function ensureAgentScheduleEditorModal() {
    let modal = document.getElementById('agent-schedule-editor-modal');
    if (modal) return modal;
    modal = document.createElement('div');
    modal.id = 'agent-schedule-editor-modal';
    modal.className = 'modal-overlay hidden';
    modal.style.zIndex = '1950';
    PivotSafeHtml.setHtml(modal, `
        <div class="modal agent-schedule-editor-modal">
            <div class="agent-config-modal-head">
                <div>
                    <h3 id="agent-schedule-editor-title">新建计划</h3>
                    <span id="agent-schedule-editor-source-hint"></span>
                </div>
                <button id="agent-schedule-editor-close" class="btn-secondary" type="button">关闭</button>
            </div>
            <form id="agent-schedule-editor-form" class="agent-schedule-editor-form">
                <div class="modal-form-grid modal-form-grid--3">
                    <label class="modal-form-field">
                        <span>计划来源</span>
                        <select id="agent-schedule-editor-source" class="form-input">
                            <option value="free">自主任务</option>
                            <option value="workflow">已发布工作流</option>
                        </select>
                    </label>
                    <label class="modal-form-field modal-form-field--span-2">
                        <span>计划名称</span>
                        <input id="agent-schedule-editor-name" class="form-input" maxlength="100" autocomplete="off">
                    </label>
                    <label id="agent-schedule-editor-goal-field" class="modal-form-field modal-form-field--span-2">
                        <span>任务目标</span>
                        <textarea id="agent-schedule-editor-goal" class="form-input" rows="4" maxlength="10000"></textarea>
                    </label>
                    <label id="agent-schedule-editor-model-field" class="modal-form-field">
                        <span>模型</span>
                        <select id="agent-schedule-editor-model" class="form-input"></select>
                    </label>
                    <label id="agent-schedule-editor-workflow-field" class="modal-form-field modal-form-field--wide hidden">
                        <span>工作流</span>
                        <select id="agent-schedule-editor-workflow" class="form-input"></select>
                    </label>
                    <label class="modal-form-field">
                        <span>执行周期</span>
                        <select id="agent-schedule-editor-frequency" class="form-input">
                            <option value="manual">手动</option>
                            <option value="daily">每天</option>
                            <option value="weekly">每周</option>
                        </select>
                    </label>
                    <label id="agent-schedule-editor-time-field" class="modal-form-field">
                        <span>执行时间</span>
                        <input id="agent-schedule-editor-time" class="form-input" type="time" value="09:00">
                    </label>
                    <label id="agent-schedule-editor-weekday-field" class="modal-form-field hidden">
                        <span>星期</span>
                        <select id="agent-schedule-editor-weekday" class="form-input">
                            <option value="1">周一</option><option value="2">周二</option><option value="3">周三</option>
                            <option value="4">周四</option><option value="5">周五</option><option value="6">周六</option><option value="0">周日</option>
                        </select>
                    </label>
                    <label class="modal-form-check modal-form-field--wide">
                        <input id="agent-schedule-editor-active" type="checkbox" checked>
                        <span>启用计划</span>
                    </label>
                </div>
                <div class="agent-schedule-editor-footer">
                    <strong id="agent-schedule-editor-status" aria-live="polite"></strong>
                    <div>
                        <button id="agent-schedule-editor-cancel" class="btn-secondary" type="button">取消</button>
                        <button id="agent-schedule-editor-submit" class="btn-primary" type="submit">保存计划</button>
                    </div>
                </div>
            </form>
        </div>
    `);
    document.body.appendChild(modal);
    const close = () => modal.classList.add('hidden');
    modal.addEventListener('click', event => {
        if (event.target === modal || event.target.closest('#agent-schedule-editor-close, #agent-schedule-editor-cancel')) close();
    });
    modal.querySelector('#agent-schedule-editor-source')?.addEventListener('change', syncAgentScheduleEditorUi);
    modal.querySelector('#agent-schedule-editor-frequency')?.addEventListener('change', syncAgentScheduleEditorUi);
    modal.querySelector('#agent-schedule-editor-form')?.addEventListener('submit', event => {
        event.preventDefault();
        saveAgentScheduleEditor();
    });
    return modal;
}

function openAgentScheduleEditor(scheduleId = '', options = {}) {
    const schedule = agentSchedulesCache.find(item => String(item.id) === String(scheduleId)) || null;
    const draft = options.draft && typeof options.draft === 'object' ? { ...options.draft } : {};
    const config = schedule ? parseAgentScheduleConfig(schedule) : draft;
    const workflowId = config.workflowId || config.workflow_id || options.workflowId || '';
    const source = workflowId ? 'workflow' : 'free';
    const modal = ensureAgentScheduleEditorModal();
    activeAgentScheduleEditorId = schedule ? String(schedule.id) : '';
    activeAgentScheduleEditorConfig = { ...config };

    replaceAgentScheduleOptions(
        document.getElementById('agent-schedule-editor-model'),
        (window._cachedAgentModels || []).map(model => ({ value: model.id, label: model.name || model.title || `模型 ${model.id}` })),
        '选择模型'
    );
    replaceAgentScheduleOptions(
        document.getElementById('agent-schedule-editor-workflow'),
        agentWorkflowsCache.filter(workflow => Number(workflow.published_version || 0) > 0)
            .map(workflow => ({ value: workflow.id, label: `${workflow.name || '未命名工作流'} · 发布 v${workflow.published_version}` })),
        '选择已发布工作流'
    );

    const title = document.getElementById('agent-schedule-editor-title');
    const sourceSelect = document.getElementById('agent-schedule-editor-source');
    if (title) title.textContent = schedule ? '编辑计划' : '新建计划';
    if (sourceSelect) {
        sourceSelect.value = source;
        sourceSelect.disabled = Boolean(schedule);
    }
    const goal = String(schedule?.goal || draft.goal || '');
    const name = String(schedule?.name || options.name || `${goal.slice(0, 32)}计划`).trim();
    document.getElementById('agent-schedule-editor-name').value = name.slice(0, 100);
    document.getElementById('agent-schedule-editor-goal').value = goal;
    document.getElementById('agent-schedule-editor-model').value = String(schedule?.model_id || draft.modelId || draft.model_id || '');
    document.getElementById('agent-schedule-editor-workflow').value = String(workflowId || '');
    document.getElementById('agent-schedule-editor-frequency').value = schedule?.frequency || options.frequency || 'daily';
    document.getElementById('agent-schedule-editor-time').value = schedule?.time_of_day || options.timeOfDay || '09:00';
    document.getElementById('agent-schedule-editor-weekday').value = String(schedule?.day_of_week ?? options.dayOfWeek ?? 1);
    document.getElementById('agent-schedule-editor-active').checked = schedule?.status !== 'paused';
    setAgentScheduleEditorStatus();
    syncAgentScheduleEditorUi();
    modal.classList.remove('hidden');
    document.getElementById('agent-schedule-editor-name')?.focus();
}

function agentScheduleEditorPayload() {
    const source = document.getElementById('agent-schedule-editor-source')?.value || 'free';
    const workflowId = document.getElementById('agent-schedule-editor-workflow')?.value || '';
    const workflow = agentWorkflowsCache.find(item => String(item.id) === String(workflowId));
    const base = { ...activeAgentScheduleEditorConfig };
    const payload = {
        ...base,
        name: document.getElementById('agent-schedule-editor-name')?.value.trim() || '',
        goal: source === 'workflow'
            ? String(base.goal || `执行工作流：${workflow?.name || ''}`).trim()
            : document.getElementById('agent-schedule-editor-goal')?.value.trim() || '',
        modelId: source === 'workflow' ? null : (document.getElementById('agent-schedule-editor-model')?.value || ''),
        frequency: document.getElementById('agent-schedule-editor-frequency')?.value || 'daily',
        timeOfDay: document.getElementById('agent-schedule-editor-time')?.value || '09:00',
        dayOfWeek: document.getElementById('agent-schedule-editor-weekday')?.value || 1,
        status: document.getElementById('agent-schedule-editor-active')?.checked === false ? 'paused' : 'active',
        maxSteps: base.maxSteps || base.max_steps || (source === 'workflow' ? 20 : 10),
        runMode: source === 'workflow' ? 'dag' : (['standard', 'deep', 'audit'].includes(base.runMode) ? base.runMode : 'standard'),
        toolPolicy: base.toolPolicy || base.tool_policy || 'all',
        toolAllowlist: base.toolAllowlist || base.tool_allowlist || [],
        approvalPolicy: base.approvalPolicy || base.approval_policy || 'safe_mcp_auto',
        retryLimit: base.retryLimit ?? base.retry_limit ?? 1,
        maxTokenBudget: base.maxTokenBudget ?? base.max_token_budget ?? 0,
        contextConfig: base.contextConfig || base.context_config || { mode: 'auto', notes: '' },
        workflowId: source === 'workflow' ? workflowId : null,
        workflowVersion: source === 'workflow' ? 'published' : null,
        dagInputs: source === 'workflow' ? (base.dagInputs || base.dag_inputs || {}) : {}
    };
    return { payload, source, workflow };
}

async function saveAgentScheduleEditor() {
    const { payload, source, workflow } = agentScheduleEditorPayload();
    if (!payload.name) return setAgentScheduleEditorStatus('请填写计划名称', 'error');
    if (source === 'free' && payload.goal.length < 4) return setAgentScheduleEditorStatus('请填写明确的任务目标', 'error');
    if (source === 'free' && !payload.modelId) return setAgentScheduleEditorStatus('请选择模型', 'error');
    if (source === 'workflow' && !workflow) return setAgentScheduleEditorStatus('请选择已发布工作流', 'error');
    const submit = document.getElementById('agent-schedule-editor-submit');
    submit?.setAttribute('disabled', 'disabled');
    setAgentScheduleEditorStatus('正在校验...', 'running');
    try {
        const preflight = await preflightAgentPayload(payload);
        if (preflight.status === 'blocked') throw new Error('计划预检未通过，请检查任务或工作流配置');
        const url = activeAgentScheduleEditorId
            ? `${API_BASE}/agents/schedules/${encodeURIComponent(activeAgentScheduleEditorId)}`
            : `${API_BASE}/agents/schedules`;
        const res = await apiFetch(url, {
            method: activeAgentScheduleEditorId ? 'PUT' : 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || '计划保存失败');
        showToast(activeAgentScheduleEditorId ? '计划已更新' : '计划已创建', 'success');
        document.getElementById('agent-schedule-editor-modal')?.classList.add('hidden');
        await loadAgentSchedules();
    } catch (e) {
        setAgentScheduleEditorStatus(e.message || '计划保存失败', 'error');
    } finally {
        submit?.removeAttribute('disabled');
    }
}

async function runAgentSchedule(scheduleId) {
    const res = await apiFetch(`${API_BASE}/agents/schedules/${encodeURIComponent(scheduleId)}/run`, { method: 'POST' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return showToast(data.error || '计划运行失败', 'error');
    showToast('计划任务已入队', 'success');
    await window.openAgentWorkbench?.();
    await window.openAgentRun(data.run.id);
}

async function toggleAgentSchedule(scheduleId) {
    const schedule = agentSchedulesCache.find(item => String(item.id) === String(scheduleId));
    if (!schedule) return;
    const config = parseAgentScheduleConfig(schedule);
    const status = schedule.status === 'paused' ? 'active' : 'paused';
    const res = await apiFetch(`${API_BASE}/agents/schedules/${encodeURIComponent(scheduleId)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            ...config,
            name: schedule.name,
            goal: schedule.goal,
            modelId: schedule.model_id,
            templateId: schedule.template_id,
            frequency: schedule.frequency,
            timeOfDay: schedule.time_of_day,
            dayOfWeek: schedule.day_of_week,
            status
        })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return showToast(data.error || '计划状态更新失败', 'error');
    showToast(status === 'paused' ? '计划已暂停' : '计划已启用', 'success');
    await loadAgentSchedules();
}

async function openAgentScheduleRuns(scheduleId) {
    const schedule = agentSchedulesCache.find(item => String(item.id) === String(scheduleId));
    if (!schedule) return;
    await window.openAgentWorkbench?.({ query: schedule.name || '', runType: 'scheduled' });
}

function deleteAgentSchedule(scheduleId) {
    showConfirm('删除计划任务', '确定删除这个计划吗？已产生的任务记录不会受影响。', async () => {
        const res = await apiFetch(`${API_BASE}/agents/schedules/${encodeURIComponent(scheduleId)}`, { method: 'DELETE' });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) return showToast(data.error || '删除计划失败', 'error');
        showToast('计划已删除', 'success');
        await loadAgentSchedules();
    });
}

async function loadAgentNotifications() {
    const list = document.getElementById('agent-notification-list');
    if (!list) return;
    const res = await apiFetch(`${API_BASE}/agents/notifications?limit=8`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || '通知加载失败');
    const items = data.data || [];
    PivotSafeHtml.setHtml(list, items.length ? items.slice(0, 5).map(item => `
        <button type="button" class="agent-ops-item ${item.status === 'unread' ? 'unread' : ''}" data-agent-notification-id="${agentEscape(item.id)}" data-agent-notification-run="${agentEscape(item.run_id || '')}">
            <strong>${agentEscape(agentNotificationTitle(item))}</strong>
            <span>${agentEscape(agentNotificationBody(item))}</span>
        </button>
    `).join('') : '<div class="empty-state agent-empty-state compact">暂无通知</div>');
    list.querySelectorAll('[data-agent-notification-id]').forEach(btn => {
        btn.addEventListener('click', async () => {
            await apiFetch(`${API_BASE}/agents/notifications/${encodeURIComponent(btn.dataset.agentNotificationId)}/read`, { method: 'POST' });
            if (btn.dataset.agentNotificationRun) await window.openAgentRun(btn.dataset.agentNotificationRun);
            await loadAgentNotifications();
        });
    });
}

window.Pivot.exposeModule('agent.schedules', {
    openEditor: openAgentScheduleEditor,
    openRuns: openAgentScheduleRuns,
    toggle: toggleAgentSchedule
});
