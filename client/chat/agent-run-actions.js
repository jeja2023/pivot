// Agent 运行操作 Agent run actions
// Split from agent-runs-list.js.
// Agent run payload assembly and mutating actions.
/* eslint-disable no-undef */
function getSelectedAgentToolAllowlist() {
    const checked = [...document.querySelectorAll('[data-agent-tool-allow]:checked')].map(input => input.dataset.agentToolAllow);
    if (!checked.length) return ['__none__'];
    if (checked.length === agentToolsCache.length) return [];
    return checked;
}

function getAgentContextConfig() {
    return {
        mode: document.getElementById('agent-context-mode')?.value || 'auto',
        notes: document.getElementById('agent-context-notes')?.value || ''
    };
}

function getAgentRunPayload(goalOverride = '') {
    const allowMcp = document.getElementById('agent-allow-mcp')?.checked !== false;
    const rawRunMode = document.getElementById('agent-run-mode')?.value || 'standard';
    const runMode = ['standard', 'deep', 'audit'].includes(rawRunMode) ? rawRunMode : 'standard';
    const typedGoal = goalOverride || document.getElementById('agent-goal-input')?.value.trim();
    const payload = {
        goal: typedGoal,
        modelId: document.getElementById('agent-model-select')?.value,
        maxSteps: document.getElementById('agent-max-steps')?.value || 10,
        runMode,
        toolPolicy: allowMcp ? 'all' : 'builtin_only',
        approvalPolicy: document.getElementById('agent-approval-policy')?.value || 'safe_mcp_auto',
        modelRouter: document.getElementById('agent-model-router')?.value || 'fixed',
        maxTokenBudget: document.getElementById('agent-token-budget')?.value || 0,
        retryLimit: document.getElementById('agent-retry-limit')?.value || 1,
        toolAllowlist: getSelectedAgentToolAllowlist(),
        contextConfig: getAgentContextConfig(),
        sessionId: window.currentSessionId || null
    };
    return payload;
}

window.createAgentRun = async function() {
    const payload = getAgentRunPayload();
    const frequency = document.getElementById('agent-schedule-frequency')?.value || 'manual';
    if (!payload.goal) return showToast('请先填写任务目标', 'error');
    if (!payload.modelId) return showToast('请选择模型', 'error');
    if (payload._invalid) return;
    const preflight = await preflightAgentPayload(payload);
    if (preflight.status === 'blocked') return showToast('任务预检未通过，请先处理阻断项', 'error');
    if (frequency !== 'manual') {
        const schedulePayload = { ...payload };
        const scheduleRes = await apiFetch(`${API_BASE}/agents/schedules`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                ...schedulePayload,
                name: payload.goal.slice(0, 40),
                frequency,
                timeOfDay: document.getElementById('agent-schedule-time')?.value || '09:00',
                dayOfWeek: document.getElementById('agent-schedule-weekday')?.value || 1
            })
        });
        const scheduleData = await scheduleRes.json().catch(() => ({}));
        if (!scheduleRes.ok) return showToast(scheduleData.error || '计划创建失败', 'error');
        showToast('计划任务已创建', 'success');
        await loadAgentSchedules();
        return;
    }
    const res = await apiFetch(`${API_BASE}/agents/runs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (!res.ok) return showToast(data.error || '任务创建失败', 'error');
    showToast('自由任务已入队', 'success');
    document.getElementById('agent-goal-input').value = '';
    await Promise.all([loadAgentRuns(1), loadAgentSchedules(), loadAgentNotifications()]);
    await window.openAgentRun(data.run.id);
};

window.approveAgentRun = async function(runId, approve = true) {
    const res = await apiFetch(`${API_BASE}/agents/runs/${encodeURIComponent(runId)}/approval`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ approve })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return showToast(data.error || '审批处理失败', 'error');
    showToast(approve ? '已批准工具调用，任务继续排队' : '已拒绝工具调用', 'success');
    await loadAgentRuns();
    await window.openAgentRun(runId);
};

window.cancelAgentRun = function(runId) {
    showConfirm('停止自由任务', '确定停止这个正在执行的自由任务吗？', async () => {
        const res = await apiFetch(`${API_BASE}/agents/runs/${encodeURIComponent(runId)}/cancel`, { method: 'POST' });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) return showToast(data.error || '停止失败', 'error');
        showToast('自由任务已停止', 'success');
        await loadAgentRuns();
        const stillExists = agentRunsCache.some(run => run.id === runId);
        if (stillExists) await window.openAgentRun(runId);
    });
};

window.cancelAgentWorkflowPreviewRun = function(runId) {
    showConfirm('停止预览运行', '确定停止这次工作流预览运行吗？', async () => {
        const res = await apiFetch(`${API_BASE}/agents/runs/${encodeURIComponent(runId)}/cancel`, { method: 'POST' });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) return showToast(data.error || '停止失败', 'error');
        showToast('预览运行已停止', 'success');
        await window.openAgentRun(runId, { workflowPreview: true });
    });
};

window.rerunAgentRun = async function(runId) {
    const res = await apiFetch(`${API_BASE}/agents/runs/${encodeURIComponent(runId)}/rerun`, { method: 'POST' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return showToast(data.error || '重新运行失败', 'error');
    showToast('已创建新的自由任务', 'success');
    await loadAgentRuns(1);
    await window.openAgentRun(data.run.id);
};

window.resumeAgentRun = async function(runId) {
    const res = await apiFetch(`${API_BASE}/agents/runs/${encodeURIComponent(runId)}/resume`, { method: 'POST' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return showToast(data.error || '断点续跑失败', 'error');
    showToast('已从上次执行位置创建续跑任务', 'success');
    await loadAgentRuns(1);
    await window.openAgentRun(data.run.id);
};

window.createWorkflowDraftFromAgentRun = async function(runId) {
    try {
        const res = await apiFetch(`${API_BASE}/agents/runs/${encodeURIComponent(runId)}/workflow-draft`, { method: 'POST' });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || '生成工作流草稿失败');
        pendingAgentWorkflowDraft = data.draft || null;
        showToast('已生成工作流草稿，请在编排页检查后保存或发布。', 'success');
        closeAgentRunDetailModal();
        await window.openAgentDagWorkbench?.({ draft: pendingAgentWorkflowDraft });
    } catch (e) {
        showToast(e.message || '生成工作流草稿失败', 'error');
    }
};

window.rerunAgentDagNode = async function(runId, nodeId = '') {
    const res = await apiFetch(`${API_BASE}/agents/runs/${encodeURIComponent(runId)}/dag/rerun`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nodeId })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return showToast(data.error || '节点重跑失败', 'error');
    showToast('已创建节点重跑任务', 'success');
    await loadAgentRuns(1);
    await window.openAgentRun(data.run.id);
};

window.deleteAgentRun = function(runId) {
    showConfirm('移除任务记录', '确定从任务列表移除这条任务记录吗？记录会保留给 admin 权限层级审计。', async () => {
        const res = await apiFetch(`${API_BASE}/agents/runs/${encodeURIComponent(runId)}`, { method: 'DELETE' });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) return showToast(data.error || '移除记录失败', 'error');
        showToast('任务记录已移除', 'success');
        closeAgentRunDetailModal();
        await loadAgentRuns();
    });
};

window.showAgentRunAudit = async function() {
    if (!isSuperAdminUser()) {
        showToast('仅 admin 权限层级可查看任务删除审计', 'error');
        return;
    }
    try {
        const res = await apiFetch(`${API_BASE}/agents/runs/deleted/audit?limit=100`);
        const data = await res.json().catch(() => ({}));
        if (!res.ok || data.error) throw new Error(data.error || '删除审计加载失败');
        const modal = ensureAgentAuditModal();
        const body = modal.querySelector('#agent-audit-body');
        if (body) body.innerHTML = renderAgentAuditRows(data.data || []);
        modal.classList.remove('hidden');
    } catch (e) {
        showToast(e.message || '删除审计加载失败', 'error');
    }
};
