// Agent 运行实时刷新
// 拆自 agent-runs-list.js。
// Agent 自动刷新、实时事件和流式面板。
/* eslint-disable no-undef */
function isAgentUiVisible() {
    const detailOpen = typeof isAgentRunDetailModalOpen === 'function'
        ? isAgentRunDetailModalOpen()
        : isAgentElementVisible('agent-run-detail-modal');
    return Boolean(
        detailOpen
        || isAgentElementVisible('agent-workbench-modal')
        || isAgentElementVisible('agent-dag-workbench-modal')
        || isAgentElementVisible('automation-assets-view')
        || isAgentElementVisible('automation-editor-view')
    );
}

function isAgentElementVisible(id) {
    const element = document.getElementById(id);
    return Boolean(element && !element.classList.contains('hidden'));
}

let agentRealtimePollInFlight = false;
let agentRefreshTimerIntervalMs = 0;

async function refreshAgentVisibleState(payload = {}) {
    if (agentRealtimePollInFlight) return;
    agentRealtimePollInFlight = true;
    try {
        const tasks = [];
        const agentVisible = isAgentElementVisible('agent-workbench-modal')
            || (typeof isAgentRunDetailModalOpen === 'function' && isAgentRunDetailModalOpen());
        const dagVisible = isAgentElementVisible('agent-dag-workbench-modal');
        const configSection = document.getElementById('agent-config-modal')?.dataset.agentConfigSection || '';

        if (agentVisible) {
            if (typeof loadAgentRuns === 'function') tasks.push(loadAgentRuns());
            if (typeof loadAgentRuntimeStatus === 'function') tasks.push(loadAgentRuntimeStatus());
            if (typeof loadAgentMetrics === 'function') tasks.push(loadAgentMetrics());
            if (typeof loadAgentNotifications === 'function') tasks.push(loadAgentNotifications());
            if (configSection === 'templates' && typeof loadAgentTemplates === 'function') tasks.push(loadAgentTemplates());
            if (configSection === 'results') {
                if (typeof loadAgentArtifacts === 'function') tasks.push(loadAgentArtifacts());
                if (typeof loadAgentTools === 'function') tasks.push(loadAgentTools());
            }
        }
        if (dagVisible) {
            if (typeof loadAgentWorkflows === 'function') tasks.push(loadAgentWorkflows());
            if (typeof loadAgentSchedules === 'function') tasks.push(loadAgentSchedules());
            if (isAgentElementVisible('agent-workflow-schedule-modal') && typeof loadAgentWorkflowSchedules === 'function') tasks.push(loadAgentWorkflowSchedules());
        }
        if (configSection === 'evaluations' && typeof loadAgentEvaluationSuites === 'function') {
            tasks.push(loadAgentEvaluationSuites({ keepDetail: true, silent: true }));
        }
        await Promise.allSettled(tasks);

        const runId = payload.run?.id || payload.notification?.run_id || '';
        if (activeAgentRunId && typeof isAgentRunDetailModalOpen === 'function' && isAgentRunDetailModalOpen() && (!runId || runId === activeAgentRunId)) {
            try {
                await window.Pivot.legacy.openAgentRun(activeAgentRunId, { silent: true });
            } catch (e) {}
        }
    } finally {
        agentRealtimePollInFlight = false;
    }
}

function updateAgentAutoRefresh() {
    const modalOpen = isAgentUiVisible();
    if (!currentUser) {
        if (agentRefreshTimer) clearInterval(agentRefreshTimer);
        agentRefreshTimer = null;
        agentRefreshTimerIntervalMs = 0;
        return;
    }
    const intervalMs = agentRealtimeConnected ? 5000 : 2500;
    if (agentRefreshTimer && (!modalOpen || agentRefreshTimerIntervalMs !== intervalMs)) {
        clearInterval(agentRefreshTimer);
        agentRefreshTimer = null;
        agentRefreshTimerIntervalMs = 0;
    }
    // SSE 是低延迟通道，但轮询仍作为兜底，覆盖任务、工作流、计划和评测面板。
    if (!agentRefreshTimer && modalOpen) {
        agentRefreshTimerIntervalMs = intervalMs;
        agentRefreshTimer = setInterval(async () => {
            await refreshAgentVisibleState();
        }, intervalMs);
    }
}

function scheduleAgentRealtimeRefresh(payload = {}) {
    clearTimeout(agentRealtimeRefreshTimer);
    agentRealtimeRefreshTimer = setTimeout(async () => {
        await refreshAgentVisibleState(payload);
    }, 300);
}

function handleAgentRealtimeEvent(event) {
    const payload = JSON.parse(event.data || '{}');
    if (payload.type === 'agent.notification' && payload.notification?.status === 'unread') {
        showToast(agentNotificationTitle(payload.notification) || '收到新的智能体通知', 'info');
    }
    scheduleAgentRealtimeRefresh(payload);
}

window.Pivot.legacy.initAgentRealtime = function() {
    if (agentRealtimeSource || !window.EventSource || !currentUser) return;
    agentRealtimeSource = new EventSource(`${API_BASE}/events`, { withCredentials: true });
    agentRealtimeSource.addEventListener('connected', () => {
        agentRealtimeConnected = true;
        updateAgentAutoRefresh();
    });
    agentRealtimeSource.addEventListener('agent.run', handleAgentRealtimeEvent);
    agentRealtimeSource.addEventListener('agent.notification', handleAgentRealtimeEvent);
    agentRealtimeSource.addEventListener('agent.streaming', handleAgentStreamingEvent);
    agentRealtimeSource.onerror = () => {
        agentRealtimeConnected = false;
        updateAgentAutoRefresh();
    };
    updateAgentAutoRefresh();
};

function handleAgentStreamingEvent(event) {
    let payload;
    try { payload = JSON.parse(event.data || '{}'); } catch (e) { return; }
    if (!payload || !payload.runId) return;
    window.Pivot.legacy.handleChatAgentStreamingEvent?.(payload);
    // 只为当前打开的任务渲染，避免后台任务覆盖前台 UI
    if (activeAgentRunId !== payload.runId) return;
    renderAgentStreamingPanel(payload);
}

function renderAgentStreamingPanel(payload) {
    const container = document.getElementById('agent-run-detail');
    if (!container) return;
    let panel = container.querySelector('.agent-streaming-panel');
    if (!panel) {
        panel = document.createElement('section');
        panel.className = 'agent-streaming-panel';
        container.insertBefore(panel, container.firstChild || null);
    }
    const step = Number(payload.step) || 0;
    const finishReasonLabels = {
        stop: '已完成',
        tool_calls: '正在调用工具',
        length: '达到输出上限',
        content_filter: '内容安全拦截'
    };
    const finish = payload.finishReason
        ? agentEscape(finishReasonLabels[payload.finishReason] || payload.finishReason)
        : '—';
    const completed = Boolean(payload.completed);
    const content = String(payload.content || '');
    const partial = Array.isArray(payload.partialToolCalls) ? payload.partialToolCalls : [];
    const toolHtml = partial.length === 0
        ? '<div class="agent-streaming-empty">尚未发现工具调用增量</div>'
        : partial.map((call, idx) => {
            const name = agentEscape(agentToolTitle(call.name || `工具#${idx + 1}`));
            const argsLen = String(call.argumentsRaw || '').length;
            const preview = agentEscape(String(call.argumentsRaw || '').slice(0, 240));
            return `
                <div class="agent-streaming-tool">
                    <div class="agent-streaming-tool-head"><strong>${name}</strong><span>参数 ${argsLen} 个字符</span></div>
                    <pre class="agent-streaming-tool-args">${preview}${argsLen > 240 ? '…' : ''}</pre>
                </div>
            `;
        }).join('');
    PivotSafeHtml.setHtml(panel, `
        <header class="agent-streaming-head">
            <strong>流式生成（实验）</strong>
            <span>第 ${step} 步 · ${finish}${completed ? ' · 已完成' : ''}</span>
        </header>
        <div class="agent-streaming-body">
            <div class="agent-streaming-content">${agentEscape(content) || '<em>等待首段内容…</em>'}</div>
            <div class="agent-streaming-tools">${toolHtml}</div>
        </div>
    `);
    // 任务终态时延迟收起面板：5s 后淡出，避免长期占据视野
    if (completed && payload.finishReason && payload.finishReason !== 'tool_calls') {
        setTimeout(() => panel?.classList.add('is-fading'), 5000);
    } else {
        panel.classList.remove('is-fading');
    }
}

window.Pivot.legacy.closeAgentRealtime = function() {
    if (agentRealtimeRefreshTimer) clearTimeout(agentRealtimeRefreshTimer);
    agentRealtimeRefreshTimer = null;
    if (agentRefreshTimer) clearInterval(agentRefreshTimer);
    agentRefreshTimer = null;
    agentRefreshTimerIntervalMs = 0;
    agentRealtimeConnected = false;
    if (agentRealtimeSource) {
        agentRealtimeSource.close();
        agentRealtimeSource = null;
    }
    updateAgentAutoRefresh();
};
