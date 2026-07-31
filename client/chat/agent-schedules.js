// Agent 计划任务
// 拆自 agents.js。
/* eslint-disable no-undef */
async function loadAgentSchedules() {
    const list = document.getElementById('agent-schedule-list');
    if (!list) return;
    const res = await apiFetch(`${API_BASE}/agents/schedules`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || '计划队列加载失败');
    agentSchedulesCache = data.data || [];
    PivotSafeHtml.setHtml(list, agentSchedulesCache.length ? agentSchedulesCache.slice(0, 5).map(schedule => `
        <div class="agent-ops-item">
            <strong>${agentEscape(schedule.name)}</strong>
            <span>${agentEscape(schedule.frequency === 'daily' ? '每天' : schedule.frequency === 'weekly' ? '每周' : '手动')} · 下次 ${agentEscape(schedule.next_run_at || '-')}</span>
            <div class="agent-ops-actions">
                <button type="button" class="btn-secondary" data-agent-schedule-run="${agentEscape(schedule.id)}">运行</button>
                <button type="button" class="btn-danger-outline" data-agent-schedule-delete="${agentEscape(schedule.id)}">删除</button>
            </div>
        </div>
    `).join('') : '<div class="empty-state agent-empty-state compact">暂无计划</div>');
    list.querySelectorAll('[data-agent-schedule-run]').forEach(btn => {
        btn.addEventListener('click', () => runAgentSchedule(btn.dataset.agentScheduleRun));
    });
    list.querySelectorAll('[data-agent-schedule-delete]').forEach(btn => {
        btn.addEventListener('click', () => deleteAgentSchedule(btn.dataset.agentScheduleDelete));
    });
}

async function runAgentSchedule(scheduleId) {
    const res = await apiFetch(`${API_BASE}/agents/schedules/${encodeURIComponent(scheduleId)}/run`, { method: 'POST' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return showToast(data.error || '计划运行失败', 'error');
    showToast('计划任务已入队', 'success');
    await loadAgentRuns(1);
    await window.openAgentRun(data.run.id);
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
