// Agent 运行操作
// 拆自 agent-runs-list.js。
// Agent 运行载荷组装与变更操作。
/* eslint-disable no-undef */
const agentRunActionLocks = new Set();

function createAgentIdempotencyKey() {
    return globalThis.crypto?.randomUUID?.()
        || `agent-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function setAgentRunActionBusy(runId, selectors, busy) {
    const id = String(runId);
    document.querySelectorAll(selectors).forEach(button => {
        const buttonRunId = String(button.dataset.agentCancel || button.dataset.agentApprove || button.dataset.agentReject
            || button.dataset.agentRerun || button.dataset.agentResume || button.dataset.agentDagRerunNode
            || button.dataset.agentCreateWorkflowDraft || button.dataset.agentRunDelete || '');
        const matchesCurrentDag = button.dataset.agentDagRerunNode && String(activeAgentRunId || '') === id;
        if (buttonRunId !== id && !matchesCurrentDag) return;
        button.disabled = busy;
        if (busy) button.setAttribute('aria-busy', 'true');
        else button.removeAttribute('aria-busy');
    });
}

async function runAgentActionOnce(key, runId, selectors, task, fallbackMessage) {
    if (agentRunActionLocks.has(key)) return null;
    agentRunActionLocks.add(key);
    setAgentRunActionBusy(runId, selectors, true);
    try {
        return await task();
    } catch (error) {
        showToast(error.message || fallbackMessage, 'error');
        return null;
    } finally {
        agentRunActionLocks.delete(key);
        setAgentRunActionBusy(runId, selectors, false);
    }
}

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
    const typedTitle = document.getElementById('agent-title-input')?.value.trim() || '';
    const payload = {
        title: typedTitle,
        goal: typedGoal,
        modelId: document.getElementById('agent-model-select')?.value,
        maxSteps: document.getElementById('agent-max-steps')?.value || 0,
        runMode,
        toolPolicy: allowMcp ? 'all' : 'builtin_only',
        approvalPolicy: document.getElementById('agent-approval-policy')?.value || 'safe_mcp_auto',
        modelRouter: document.getElementById('agent-model-router')?.value || 'fixed',
        maxTokenBudget: document.getElementById('agent-token-budget')?.value || 0,
        retryLimit: document.getElementById('agent-retry-limit')?.value || 1,
        toolAllowlist: getSelectedAgentToolAllowlist(),
        contextConfig: getAgentContextConfig(),
        skillId: window.Pivot.legacy.getAgentHarnessSkillId?.() || '',
        sessionId: window.Pivot.legacy.currentSessionId || null
    };
    return payload;
}

window.Pivot.legacy.createAgentRun = async function() {
    const payload = getAgentRunPayload();
    if (!payload.goal) return showToast('请先填写任务目标', 'error');
    if (!payload.modelId) return showToast('请选择模型', 'error');
    if (payload._invalid) return;
    const runBtn = document.getElementById('agent-run-btn');
    if (runBtn) {
        if (runBtn.disabled) return;
        runBtn.disabled = true;
    }
    try {
        const preflight = await preflightAgentPayload(payload);
        if (preflight?.status === 'blocked') {
            const blockerMsg = preflight.blockers?.length ? `任务预检未通过：${preflight.blockers[0]}` : '任务预检未通过，请先处理阻断项';
            return showToast(blockerMsg, 'error');
        }
        const res = await apiFetch(`${API_BASE}/agents/runs`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Idempotency-Key': createAgentIdempotencyKey()
            },
            body: JSON.stringify(payload)
        });
        const data = await res.json();
        if (!res.ok) return showToast(data.error || '任务创建失败', 'error');
        showToast('自主任务已入队', 'success');
        document.getElementById('agent-goal-input').value = '';
        const titleInput = document.getElementById('agent-title-input');
        if (titleInput) titleInput.value = '';
        await Promise.all([loadAgentRuns(1), loadAgentNotifications()]);
        window.Pivot.legacy.setTaskComposerOpen?.(false);
        await window.Pivot.legacy.openAgentRun(data.run.id);
    } catch (e) {
        showToast(e.message || '任务创建失败', 'error');
    } finally {
        if (runBtn) runBtn.disabled = false;
    }
};

async function saveCurrentAgentTaskAsSchedule() {
    const payload = getAgentRunPayload();
    if (!payload.goal) return showToast('请先填写任务目标', 'error');
    if (!payload.modelId) return showToast('请选择模型', 'error');
    if (payload._invalid) return;
    window.Pivot.legacy.setTaskComposerOpen?.(false);
    await window.Pivot.legacy.openAgentDagWorkbench?.({
        tab: 'schedules',
        scheduleDraft: payload
    });
}

window.Pivot.legacy.approveAgentRun = async function(runId, approve = true) {
    await runAgentActionOnce(`approval:${runId}:${approve}`, runId, '[data-agent-approve], [data-agent-reject]', async () => {
        const res = await apiFetch(`${API_BASE}/agents/runs/${encodeURIComponent(runId)}/approval`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ approve })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || '审批处理失败');
        showToast(approve ? '已批准工具调用，任务继续排队' : '已拒绝工具调用', 'success');
        await loadAgentRuns();
        await window.Pivot.legacy.openAgentRun(runId);
    }, '审批处理失败');
};

window.Pivot.legacy.cancelAgentRun = function(runId) {
    window.Pivot.legacy.showConfirm('停止自主任务', '确定停止这个正在执行的自主任务吗？', async () => {
        await runAgentActionOnce(`cancel:${runId}`, runId, '[data-agent-cancel]', async () => {
            const res = await apiFetch(`${API_BASE}/agents/runs/${encodeURIComponent(runId)}/cancel`, { method: 'POST' });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.error || '停止失败');
            showToast('自主任务已停止', 'success');
            await loadAgentRuns();
            const stillExists = agentRunsCache.some(run => run.id === runId);
            if (stillExists) await window.Pivot.legacy.openAgentRun(runId);
        }, '停止失败');
    });
};

window.Pivot.legacy.cancelAgentWorkflowPreviewRun = function(runId) {
    window.Pivot.legacy.showConfirm('停止预览运行', '确定停止这次工作流预览运行吗？', async () => {
        await runAgentActionOnce(`preview-cancel:${runId}`, runId, '[data-agent-cancel]', async () => {
            const res = await apiFetch(`${API_BASE}/agents/runs/${encodeURIComponent(runId)}/cancel`, { method: 'POST' });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.error || '停止失败');
            showToast('预览运行已停止', 'success');
            await window.Pivot.legacy.openAgentRun(runId, { workflowPreview: true });
        }, '停止失败');
    });
};

window.Pivot.legacy.rerunAgentRun = async function(runId) {
    await runAgentActionOnce(`rerun:${runId}`, runId, '[data-agent-rerun]', async () => {
        const res = await apiFetch(`${API_BASE}/agents/runs/${encodeURIComponent(runId)}/rerun`, { method: 'POST' });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || '重新运行失败');
        showToast('已创建新的自主任务', 'success');
        await loadAgentRuns(1);
        await window.Pivot.legacy.openAgentRun(data.run.id);
    }, '重新运行失败');
};

window.Pivot.legacy.resumeAgentRun = async function(runId) {
    await runAgentActionOnce(`resume:${runId}`, runId, '[data-agent-resume]', async () => {
        const res = await apiFetch(`${API_BASE}/agents/runs/${encodeURIComponent(runId)}/resume`, { method: 'POST' });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || '断点续跑失败');
        showToast('已从上次执行位置创建续跑任务', 'success');
        await loadAgentRuns(1);
        await window.Pivot.legacy.openAgentRun(data.run.id);
    }, '断点续跑失败');
};

window.Pivot.legacy.createWorkflowDraftFromAgentRun = async function(runId) {
    try {
        const res = await apiFetch(`${API_BASE}/agents/runs/${encodeURIComponent(runId)}/learn`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'workflow', runNow: true })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || '生成工作流草稿失败');
        const result = data.job?.resultSummary || {};
        if (!result.workflowId) throw new Error('本次任务没有足够的安全步骤可生成工作流草稿。');
        showToast('已生成受控工作流草稿，请预览、评测后再发布。', 'success');
        window.Pivot.legacy.closeAgentRunDetailModal();
        await window.Pivot.legacy.openAgentDagWorkbench?.({ workflowId: result.workflowId, editor: true });
    } catch (e) {
        showToast(e.message || '生成工作流草稿失败', 'error');
    }
};

async function learnFromAgentRun(runId) {
    try {
        const res = await apiFetch(`${API_BASE}/agents/runs/${encodeURIComponent(runId)}/learn`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ runNow: true })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || '学习任务创建失败');
        const result = data.job?.resultSummary || {};
        showToast(result.autoActivated ? '已学习并启用个人经验。' : result.proposalId ? '已生成个人经验，可在“我的智能助手”中确认。' : '已记录本次经验。', 'success');
        window.Pivot?.moduleApi?.('agent.harness')?.loadAgentHarnessManagement?.().catch(() => {});
        return data;
    } catch (error) {
        showToast(error.message || '学习任务创建失败', 'error');
        return null;
    }
}

window.Pivot?.exposeModule?.('agent.runActions', { learnFromAgentRun }, ['learnFromAgentRun']);

window.Pivot.legacy.rerunAgentDagNode = async function(runId, nodeId = '') {
    await runAgentActionOnce(`dag-rerun:${runId}:${nodeId}`, runId, '[data-agent-dag-rerun-node]', async () => {
        const res = await apiFetch(`${API_BASE}/agents/runs/${encodeURIComponent(runId)}/dag/rerun`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ nodeId })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || '节点重跑失败');
        showToast('已创建节点重跑任务', 'success');
        await loadAgentRuns(1);
        await window.Pivot.legacy.openAgentRun(data.run.id);
    }, '节点重跑失败');
};

window.Pivot.legacy.deleteAgentRun = function(runId) {
    window.Pivot.legacy.showConfirm('移除任务记录', '确定从任务列表移除这条任务记录吗？记录会保留给 admin 权限层级审计。', async () => {
        await runAgentActionOnce(`delete:${runId}`, runId, '[data-agent-run-delete]', async () => {
            const res = await apiFetch(`${API_BASE}/agents/runs/${encodeURIComponent(runId)}`, { method: 'DELETE' });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.error || '移除记录失败');
            showToast('任务记录已移除', 'success');
            window.Pivot.legacy.closeAgentRunDetailModal();
            await loadAgentRuns();
        }, '移除记录失败');
    });
};

window.Pivot.legacy.showAgentRunAudit = async function() {
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
        if (body) PivotSafeHtml.setHtml(body, renderAgentAuditRows(data.data || []));
        modal.classList.remove('hidden');
        modal.setAttribute('aria-hidden', 'false');
    } catch (e) {
        showToast(e.message || '删除审计加载失败', 'error');
    }
};
