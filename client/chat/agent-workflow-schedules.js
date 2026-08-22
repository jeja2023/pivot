// 已发布工作流的计划任务管理。
/* eslint-disable no-undef */
let agentWorkflowSchedulesCache = [];
let agentWorkflowSchedulesLoadSequence = 0;
const agentWorkflowScheduleActionLocks = new Set();
let agentWorkflowScheduleEditorOpener = null;

function parseAgentWorkflowScheduleConfig(schedule) {
    const value = schedule?.run_config;
    if (value && typeof value === 'object') return value;
    try {
        return JSON.parse(value || '{}');
    } catch (e) {
        return {};
    }
}

function agentWorkflowScheduleMatches(schedule, workflowId) {
    const config = parseAgentWorkflowScheduleConfig(schedule);
    return String(config.workflowId || config.workflow_id || '') === String(workflowId || '')
        && String(config.workflowVersion || config.workflow_version || '') === 'published';
}

function agentWorkflowScheduleFrequencyText(schedule) {
    if (schedule?.frequency === 'interval') {
        const minutes = Math.max(5, Number(schedule.interval_minutes) || 60);
        return minutes % 60 === 0 ? `每隔 ${minutes / 60} 小时` : `每隔 ${minutes} 分钟`;
    }
    if (schedule?.frequency === 'weekly') {
        const weekdays = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
        return `每周${weekdays[Number(schedule.day_of_week || 0)] || '周一'} ${schedule.time_of_day || '09:00'}`;
    }
    if (schedule?.frequency === 'daily') return `每天 ${schedule?.time_of_day || '09:00'}`;
    if (schedule?.frequency === 'cron') return `Cron · ${schedule.cron_expression || '-'}`;
    return '手动运行';
}

function ensureAgentWorkflowScheduleModal() {
    let modal = document.getElementById('agent-workflow-schedule-modal');
    if (modal) return modal;
    modal = document.createElement('div');
    modal.id = 'agent-workflow-schedule-modal';
    modal.className = 'modal-overlay hidden';
    modal.style.zIndex = '1940';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-hidden', 'true');
    modal.setAttribute('aria-labelledby', 'agent-workflow-schedule-title');
    PivotSafeHtml.setHtml(modal, `
        <div class="modal agent-workflow-schedule-modal" role="document">
            <div class="agent-config-modal-head">
                <div>
                    <h3 id="agent-workflow-schedule-title">工作流计划任务</h3>
                    <span id="agent-workflow-schedule-subtitle"></span>
                </div>
                <button id="agent-workflow-schedule-close" class="btn-secondary" type="button">关闭</button>
            </div>
            <div class="agent-workflow-schedule-body">
                <form id="agent-workflow-schedule-form" class="agent-workflow-schedule-form">
                    <label class="agent-workflow-create-field agent-workflow-schedule-name">
                        <span>计划名称</span>
                        <input id="agent-workflow-schedule-name" class="form-input" maxlength="100" placeholder="例如：每日经营简报">
                    </label>
                    <label class="agent-workflow-create-field">
                        <span>执行周期</span>
                        <select id="agent-workflow-schedule-frequency" class="form-input">
                            <option value="interval">按间隔</option>
                            <option value="daily">每天</option>
                            <option value="weekly">每周</option>
                            <option value="cron">Cron（高级）</option>
                        </select>
                    </label>
                    <label id="agent-workflow-schedule-interval-field" class="agent-workflow-create-field hidden">
                        <span>执行间隔</span>
                        <span class="agent-schedule-interval-control">
                            <input id="agent-workflow-schedule-interval-value" class="form-input" type="number" min="1" max="1440" value="1">
                            <select id="agent-workflow-schedule-interval-unit" class="form-input">
                                <option value="1">分钟</option>
                                <option value="60" selected>小时</option>
                            </select>
                        </span>
                    </label>
                    <label class="agent-workflow-create-field">
                        <span>执行时间</span>
                        <input id="agent-workflow-schedule-time" class="form-input" type="time" value="09:00">
                    </label>
                    <label id="agent-workflow-schedule-weekday-field" class="agent-workflow-create-field hidden">
                        <span>星期</span>
                        <select id="agent-workflow-schedule-weekday" class="form-input">
                            <option value="1">周一</option>
                            <option value="2">周二</option>
                            <option value="3">周三</option>
                            <option value="4">周四</option>
                            <option value="5">周五</option>
                            <option value="6">周六</option>
                            <option value="0">周日</option>
                        </select>
                    </label>
                    <label id="agent-workflow-schedule-cron-field" class="agent-workflow-create-field hidden">
                        <span>Cron 表达式</span>
                        <input id="agent-workflow-schedule-cron" class="form-input" maxlength="120" placeholder="例如 */30 * * * *">
                    </label>
                    <div class="agent-workflow-schedule-form-meta">
                        <span id="agent-workflow-schedule-input-summary">使用发布版运行</span>
                        <strong id="agent-workflow-schedule-form-status" aria-live="polite"></strong>
                    </div>
                    <button id="agent-workflow-schedule-create" class="btn-primary" type="submit">创建计划</button>
                </form>
                <div class="agent-workflow-schedule-list-head">
                    <strong>当前工作流计划</strong>
                    <button id="agent-workflow-schedule-refresh" class="btn-secondary" type="button">刷新</button>
                </div>
                <div id="agent-workflow-schedule-list" class="agent-workflow-schedule-list"></div>
            </div>
        </div>
    `);
    document.body.appendChild(modal);
    modal.addEventListener('click', event => {
        if (event.target.closest('#agent-workflow-schedule-close')) {
            setAgentWorkflowScheduleModalVisibility(false);
        }
    });
    modal.querySelector('#agent-workflow-schedule-frequency')?.addEventListener('change', syncAgentWorkflowScheduleFrequencyUi);
    modal.querySelector('#agent-workflow-schedule-refresh')?.addEventListener('click', () => loadAgentWorkflowSchedules());
    modal.querySelector('#agent-workflow-schedule-form')?.addEventListener('submit', event => {
        event.preventDefault();
        createAgentWorkflowSchedule();
    });
    return modal;
}

function setAgentWorkflowScheduleModalVisibility(isOpen) {
    const modal = document.getElementById('agent-workflow-schedule-modal');
    if (!modal) return;
    modal.classList.toggle('hidden', !isOpen);
    modal.setAttribute('aria-hidden', isOpen ? 'false' : 'true');
    if (isOpen) {
        document.getElementById('agent-workflow-schedule-name')?.focus();
    } else if (agentWorkflowScheduleEditorOpener?.isConnected) {
        agentWorkflowScheduleEditorOpener.focus();
        agentWorkflowScheduleEditorOpener = null;
    }
}

function syncAgentWorkflowScheduleFrequencyUi() {
    const frequency = document.getElementById('agent-workflow-schedule-frequency')?.value || 'daily';
    document.getElementById('agent-workflow-schedule-weekday-field')?.classList.toggle('hidden', frequency !== 'weekly');
    document.getElementById('agent-workflow-schedule-time')?.closest('label')?.classList.toggle('hidden', !['daily', 'weekly'].includes(frequency));
    document.getElementById('agent-workflow-schedule-interval-field')?.classList.toggle('hidden', frequency !== 'interval');
    document.getElementById('agent-workflow-schedule-cron-field')?.classList.toggle('hidden', frequency !== 'cron');
}

function setAgentWorkflowScheduleFormStatus(message = '', state = '') {
    const target = document.getElementById('agent-workflow-schedule-form-status');
    if (!target) return;
    target.textContent = message;
    target.className = state;
}

function renderAgentWorkflowSchedules() {
    const list = document.getElementById('agent-workflow-schedule-list');
    if (!list) return;
    if (!agentWorkflowSchedulesCache.length) {
        PivotSafeHtml.setHtml(list, '<div class="empty-state agent-empty-state">暂无计划任务</div>');
        return;
    }
    PivotSafeHtml.setHtml(list, agentWorkflowSchedulesCache.map(schedule => {
        const config = parseAgentWorkflowScheduleConfig(schedule);
        const inputCount = Object.keys(config.dagInputs || config.dag_inputs || {}).length;
        const paused = schedule.status === 'paused';
        return `
            <div class="agent-workflow-schedule-item ${paused ? 'is-paused' : ''}">
                <div class="agent-workflow-schedule-item-main">
                    <strong>${agentEscape(schedule.name || '未命名计划')}</strong>
                    <span>${agentEscape(agentWorkflowScheduleFrequencyText(schedule))} · ${paused ? '已暂停' : `下次 ${schedule.next_run_at || '-'}`}</span>
                    <small>发布版 · ${inputCount ? `${inputCount} 个输入变量` : '无额外输入'}${schedule.last_run_at ? ` · 上次 ${schedule.last_run_at}` : ''}</small>
                </div>
                <div class="agent-workflow-schedule-item-actions">
                    <button class="btn-secondary" type="button" data-agent-workflow-schedule-run="${agentEscapeAttr(schedule.id)}">立即运行</button>
                    <button class="btn-secondary" type="button" data-agent-workflow-schedule-toggle="${agentEscapeAttr(schedule.id)}">${paused ? '启用' : '暂停'}</button>
                    <button class="btn-danger-outline" type="button" data-agent-workflow-schedule-delete="${agentEscapeAttr(schedule.id)}">删除</button>
                </div>
            </div>
        `;
    }).join(''));
    list.querySelectorAll('[data-agent-workflow-schedule-run]').forEach(button => {
        button.addEventListener('click', () => runAgentSchedule(button.dataset.agentWorkflowScheduleRun));
    });
    list.querySelectorAll('[data-agent-workflow-schedule-toggle]').forEach(button => {
        button.addEventListener('click', () => toggleAgentWorkflowSchedule(button.dataset.agentWorkflowScheduleToggle));
    });
    list.querySelectorAll('[data-agent-workflow-schedule-delete]').forEach(button => {
        button.addEventListener('click', () => deleteAgentWorkflowSchedule(button.dataset.agentWorkflowScheduleDelete));
    });
}

async function loadAgentWorkflowSchedules() {
    const workflow = selectedAgentWorkflow();
    const list = document.getElementById('agent-workflow-schedule-list');
    if (!workflow || !list) return;
    const requestId = ++agentWorkflowSchedulesLoadSequence;
    PivotSafeHtml.setHtml(list, '<div class="empty-state agent-empty-state">正在加载计划...</div>');
    const res = await apiFetch(`${API_BASE}/agents/schedules`, { cache: 'no-store' });
    const data = await res.json().catch(() => ({}));
    if (requestId !== agentWorkflowSchedulesLoadSequence) return false;
    if (!res.ok) {
        PivotSafeHtml.setHtml(list, `<div class="empty-state agent-empty-state">${agentEscape(data.error || '计划加载失败')}</div>`);
        return;
    }
    agentWorkflowSchedulesCache = (data.data || []).filter(schedule => agentWorkflowScheduleMatches(schedule, workflow.id));
    renderAgentWorkflowSchedules();
}

async function openAgentWorkflowSchedules() {
    const workflow = selectedAgentWorkflow();
    if (!workflow) return showToast('请先保存并选择一个工作流', 'warning');
    if (!workflow.can_edit) return showToast('共享工作流不能由接收方管理计划任务', 'warning');
    if (!workflow.published_version) return showToast('请先发布工作流，再创建生产计划', 'warning');
    const modal = ensureAgentWorkflowScheduleModal();
    const subtitle = document.getElementById('agent-workflow-schedule-subtitle');
    const name = document.getElementById('agent-workflow-schedule-name');
    const inputSummary = document.getElementById('agent-workflow-schedule-input-summary');
    const inputs = collectAgentDagInputs();
    if (subtitle) subtitle.textContent = `${workflow.name || '未命名工作流'} · 已发布版本 ${workflow.published_version}`;
    if (name) name.value = `${workflow.name || '工作流'}计划`.slice(0, 100);
    setAgentScheduleIntervalControls('agent-workflow-schedule', 60);
    const frequency = document.getElementById('agent-workflow-schedule-frequency');
    if (frequency) frequency.value = 'daily';
    const cron = document.getElementById('agent-workflow-schedule-cron');
    if (cron) cron.value = '';
    if (inputSummary) inputSummary.textContent = Object.keys(inputs).length
        ? `将当前填写的 ${Object.keys(inputs).length} 个输入变量固定到计划中`
        : '使用发布版运行，无额外输入变量';
    setAgentWorkflowScheduleFormStatus();
    syncAgentWorkflowScheduleFrequencyUi();
    if (!modal.contains(document.activeElement)) agentWorkflowScheduleEditorOpener = document.activeElement;
    setAgentWorkflowScheduleModalVisibility(true);
    await loadAgentWorkflowSchedules();
}

async function createAgentWorkflowSchedule() {
    const lockKey = 'create';
    if (agentWorkflowScheduleActionLocks.has(lockKey)) return;
    const workflow = selectedAgentWorkflow();
    if (!workflow?.can_edit) return showToast('共享工作流不能由接收方管理计划任务', 'warning');
    if (!workflow?.published_version) return showToast('请先发布工作流，再创建生产计划', 'warning');
    const payload = buildAgentWorkflowWorkbenchRunPayload('published', workflow);
    if (payload._invalid) return;
    const name = document.getElementById('agent-workflow-schedule-name')?.value.trim() || '';
    if (!name) return setAgentWorkflowScheduleFormStatus('请填写计划名称', 'error');
    const frequency = document.getElementById('agent-workflow-schedule-frequency')?.value || 'daily';
    const intervalMinutes = agentScheduleIntervalMinutes('agent-workflow-schedule');
    if (frequency === 'interval' && (intervalMinutes < 5 || intervalMinutes > 1440)) {
        return setAgentWorkflowScheduleFormStatus('执行间隔必须在 5 分钟到 24 小时之间', 'error');
    }
    agentWorkflowScheduleActionLocks.add(lockKey);
    const submit = document.getElementById('agent-workflow-schedule-create');
    submit?.setAttribute('disabled', 'disabled');
    setAgentWorkflowScheduleFormStatus('正在检查发布版...', 'running');
    try {
        const preflight = await preflightAgentPayload(payload);
        if (preflight.status === 'blocked') {
            setAgentWorkflowScheduleFormStatus('发布版预检未通过，请先处理阻断项', 'error');
            return;
        }
        const res = await apiFetch(`${API_BASE}/agents/schedules`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                ...payload,
                name,
                frequency,
                timeOfDay: document.getElementById('agent-workflow-schedule-time')?.value || '09:00',
                dayOfWeek: document.getElementById('agent-workflow-schedule-weekday')?.value || 1,
                intervalMinutes,
                cronExpression: document.getElementById('agent-workflow-schedule-cron')?.value.trim() || '',
                workflowVersion: 'published'
            })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || '计划创建失败');
        showToast('工作流计划已创建', 'success');
        setAgentWorkflowScheduleFormStatus('计划已创建', 'success');
        await Promise.all([loadAgentWorkflowSchedules(), loadAgentSchedules()]);
    } catch (e) {
        setAgentWorkflowScheduleFormStatus(e.message || '计划创建失败', 'error');
    } finally {
        agentWorkflowScheduleActionLocks.delete(lockKey);
        submit?.removeAttribute('disabled');
    }
}

function agentWorkflowScheduleUpdatePayload(schedule, status) {
    const config = parseAgentWorkflowScheduleConfig(schedule);
    return {
        name: schedule.name,
        goal: schedule.goal,
        modelId: schedule.model_id,
        templateId: schedule.template_id,
        frequency: schedule.frequency,
        timeOfDay: schedule.time_of_day,
        dayOfWeek: schedule.day_of_week,
        intervalMinutes: schedule.interval_minutes,
        cronExpression: schedule.cron_expression,
        status,
        ...config,
        workflowVersion: 'published'
    };
}

async function toggleAgentWorkflowSchedule(scheduleId) {
    const lockKey = `toggle:${scheduleId}`;
    if (agentWorkflowScheduleActionLocks.has(lockKey)) return;
    agentWorkflowScheduleActionLocks.add(lockKey);
    const buttons = [...document.querySelectorAll('[data-agent-workflow-schedule-toggle]')]
        .filter(button => button.dataset.agentWorkflowScheduleToggle === String(scheduleId));
    buttons.forEach(button => {
        button.disabled = true;
        button.setAttribute('aria-busy', 'true');
    });
    try {
        const schedule = agentWorkflowSchedulesCache.find(item => String(item.id) === String(scheduleId));
        if (!schedule) return;
        const status = schedule.status === 'paused' ? 'active' : 'paused';
        const res = await apiFetch(`${API_BASE}/agents/schedules/${encodeURIComponent(scheduleId)}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(agentWorkflowScheduleUpdatePayload(schedule, status))
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) return showToast(data.error || '计划状态更新失败', 'error');
        showToast(status === 'paused' ? '计划已暂停' : '计划已启用', 'success');
        await Promise.all([loadAgentWorkflowSchedules(), loadAgentSchedules()]);
    } catch (error) {
        showToast(error.message || '计划状态更新失败', 'error');
    } finally {
        agentWorkflowScheduleActionLocks.delete(lockKey);
        buttons.forEach(button => {
            button.disabled = false;
            button.removeAttribute('aria-busy');
        });
    }
}

function deleteAgentWorkflowSchedule(scheduleId) {
    showConfirm('删除工作流计划', '确定删除这个计划吗？已产生的任务记录不会受影响。', async () => {
        const lockKey = `delete:${scheduleId}`;
        if (agentWorkflowScheduleActionLocks.has(lockKey)) return;
        agentWorkflowScheduleActionLocks.add(lockKey);
        try {
            const res = await apiFetch(`${API_BASE}/agents/schedules/${encodeURIComponent(scheduleId)}`, { method: 'DELETE' });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) return showToast(data.error || '计划删除失败', 'error');
            showToast('工作流计划已删除', 'success');
            await Promise.all([loadAgentWorkflowSchedules(), loadAgentSchedules()]);
        } catch (error) {
            showToast(error.message || '计划删除失败', 'error');
        } finally {
            agentWorkflowScheduleActionLocks.delete(lockKey);
        }
    });
}
