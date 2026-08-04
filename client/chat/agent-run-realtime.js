// Agent 运行实时刷新
// 拆自 agent-runs-list.js。
// Agent 自动刷新、实时事件和流式面板。
/* eslint-disable no-undef */
function updateAgentAutoRefresh() {
    const modalOpen = !document.getElementById('agent-workbench-modal')?.classList.contains('hidden');
    const hasActiveRun = agentRunsCache.some(run => isAgentRunActive(run.status));
    if (agentRealtimeConnected) {
        if (agentRefreshTimer) {
            clearInterval(agentRefreshTimer);
            agentRefreshTimer = null;
        }
        return;
    }
    if (agentRefreshTimer && (!modalOpen || !hasActiveRun)) {
        clearInterval(agentRefreshTimer);
        agentRefreshTimer = null;
    }
    if (!agentRefreshTimer && modalOpen && hasActiveRun) {
        agentRefreshTimer = setInterval(async () => {
            try {
                await loadAgentRuns();
                await loadAgentRuntimeStatus();
                await loadAgentMetrics();
                if (activeAgentRunId && isAgentRunDetailModalOpen()) await window.openAgentRun(activeAgentRunId);
            } catch (e) {}
        }, 3000);
    }
}

function scheduleAgentRealtimeRefresh(payload = {}) {
    clearTimeout(agentRealtimeRefreshTimer);
    agentRealtimeRefreshTimer = setTimeout(async () => {
        try {
            const modalOpen = !document.getElementById('agent-workbench-modal')?.classList.contains('hidden');
            if (!modalOpen) return;
            await Promise.all([
                loadAgentRuns(),
                loadAgentRuntimeStatus(),
                loadAgentNotifications()
            ]);
            if (payload.type === 'agent.run') await loadAgentMetrics();
            const runId = payload.run?.id || payload.notification?.run_id || '';
            if (activeAgentRunId && isAgentRunDetailModalOpen() && (!runId || runId === activeAgentRunId)) {
                await window.openAgentRun(activeAgentRunId);
            }
        } catch (e) {}
    }, 300);
}

function handleAgentRealtimeEvent(event) {
    const payload = JSON.parse(event.data || '{}');
    if (payload.type === 'agent.notification' && payload.notification?.status === 'unread') {
        showToast(agentNotificationTitle(payload.notification) || '收到新的智能体通知', 'info');
    }
    scheduleAgentRealtimeRefresh(payload);
}

window.initAgentRealtime = function() {
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
};

function handleAgentStreamingEvent(event) {
    let payload;
    try { payload = JSON.parse(event.data || '{}'); } catch (e) { return; }
    if (!payload || !payload.runId) return;
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

window.closeAgentRealtime = function() {
    if (agentRealtimeRefreshTimer) clearTimeout(agentRealtimeRefreshTimer);
    agentRealtimeRefreshTimer = null;
    agentRealtimeConnected = false;
    if (agentRealtimeSource) {
        agentRealtimeSource.close();
        agentRealtimeSource = null;
    }
    updateAgentAutoRefresh();
};
