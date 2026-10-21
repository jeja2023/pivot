// --- 对话会话引擎模块 ---
let sessionSelectionSequence = 0;
const reattachedChatAgents = new Map();

const CHAT_AGENT_TERMINAL_STATUSES = new Set(['completed', 'completed_with_errors', 'partial', 'error', 'failed', 'cancelled', 'deleted']);

function chatAgentStatusText(status) {
    const value = String(status || '').toLowerCase();
    if (value === 'approval_required' || value === 'waiting_approval' || value === 'awaiting_approval') return '连续 Agent 等待审批';
    if (value === 'awaiting_commit') return '连续 Agent 等待提交';
    if (['executing', 'observing', 'replanning', 'running'].includes(value)) return '连续 Agent 正在执行任务';
    if (value === 'queued') return '连续 Agent 正在排队';
    if (value === 'verifying') return '连续 Agent 正在核验答案和资料来源';
    if (value === 'needs_input') return '连续 Agent 等待补充信息，请补充要求后继续';
    return '连续 Agent 正在规划任务';
}

function updateReattachedAgentMessage(entry, status, message = '') {
    const tasks = window.Pivot.moduleApi('chat.tasks');
    if (typeof tasks.attach === 'function') {
        tasks.attach(entry.element, entry.runId, { sessionId: entry.sessionId, status, title: entry.title });
        return;
    }
    const textBody = entry?.element?.querySelector?.('.text-body');
    if (!textBody) return;
    const detail = message || chatAgentStatusText(status);
    PivotSafeHtml.setHtml(textBody, `<div class="queue-detail">${escapeChatStatusHtml(detail)}</div>`);
    window.Pivot.legacy.attachChatAgentControls?.(entry.element, entry.runId, status);
}

async function trackReattachedChatAgent(runId, sessionId, entry) {
    const tasks = window.Pivot.moduleApi('chat.tasks');
    if (typeof tasks.attach === 'function') {
        tasks.attach(entry.element, runId, { sessionId, status: entry.status || '' });
        return;
    }
    const isCurrent = () => reattachedChatAgents.get(runId) === entry
        && entry.selectionSequence === sessionSelectionSequence
        && String(currentSessionId || '') === String(sessionId)
        && document.body.contains(entry.element);
    let failures = 0;
    for (let attempt = 0; attempt < 43200; attempt += 1) {
        if (!isCurrent()) return;
        try {
            const response = await apiFetch(`${API_BASE}/agents/runs/${encodeURIComponent(runId)}`);
            if (!isCurrent()) return;
            if ([403, 404].includes(response.status)) {
                reattachedChatAgents.delete(runId);
                window.Pivot.legacy.unregisterChatAgentStreamingTarget?.(runId, entry.element);
                updateReattachedAgentMessage(entry, 'deleted', '任务已删除或当前账号无权访问，请刷新任务列表。');
                return;
            }
            if (!response.ok) throw new Error(`Agent 任务查询失败（${response.status}）`);
            const detail = await response.json();
            if (!isCurrent()) return;
            failures = 0;
            const run = detail?.run || detail?.data?.run || detail?.data || detail;
            const status = String(run?.status || '').toLowerCase();
            if (status === 'needs_input') {
                entry.status = status;
                window.Pivot.legacy.unregisterChatAgentStreamingTarget?.(runId, entry.element);
                if (String(currentSessionId || '') === String(sessionId)) {
                    const textBody = entry.element?.querySelector('.text-body');
                    if (textBody) PivotSafeHtml.setHtml(textBody, renderAiMessage(window.Pivot.legacy.chatAgentResultText?.(run) || run.final_answer || chatAgentStatusText(status), false));
                    const startedAt = Date.parse(String(run.started_at || run.created_at || ''));
                    const updatedAt = Date.parse(String(run.updated_at || run.last_heartbeat_at || ''));
                    window.Pivot.moduleApi('chat.streaming')?.renderAgentTaskStats?.(entry.element?.querySelector('.message-stats'), {
                        modelName: run.model_name || '',
                        costTime: Number.isFinite(startedAt) && Number.isFinite(updatedAt) ? Math.max((updatedAt - startedAt) / 1000, 0) : 0,
                        inputTokens: run.input_tokens, outputTokens: run.output_tokens, totalTokens: run.total_tokens, status
                    });
                    window.Pivot.legacy.attachChatAgentControls?.(entry.element, runId, status);
                }
                return;
            }
            if (CHAT_AGENT_TERMINAL_STATUSES.has(status)) {
                reattachedChatAgents.delete(String(runId));
                window.Pivot.legacy.unregisterChatAgentStreamingTarget?.(runId, entry.element);
                if (String(currentSessionId || '') === String(sessionId)) {
                    await selectSession(sessionId);
                } else {
                    window.Pivot.legacy.loadSessions?.();
                }
                return;
            }
            if (String(currentSessionId || '') === String(sessionId)) {
                const progressText = window.Pivot.legacy.chatAgentProgressText?.(detail, status) || chatAgentStatusText(status);
                updateReattachedAgentMessage(entry, status, progressText);
            }
        } catch (_error) {
            if (!isCurrent()) return;
            failures += 1;
            if (String(currentSessionId || '') === String(sessionId)) updateReattachedAgentMessage(entry, 'running', '暂时无法确认任务最新状态，正在重新连接');
        }
        await new Promise(resolve => setTimeout(resolve, Math.min(1200 * 2 ** Math.min(failures, 4), 15000)));
    }
    if (isCurrent()) reattachedChatAgents.delete(runId);
}

async function attachChatAgentRunsForSession(sessionId) {
    const safeSessionId = String(sessionId || '').trim();
    if (!safeSessionId) return;
    const selectionSequence = sessionSelectionSequence;
    try {
        const response = await apiFetch(`${API_BASE}/agents/runs/chat-active?sessionId=${encodeURIComponent(safeSessionId)}`);
        if (!response.ok) return;
        const data = await response.json().catch(() => ({}));
        const runs = Array.isArray(data.runs) ? data.runs : [];
        if (!runs.length || String(currentSessionId || '') !== safeSessionId || selectionSequence !== sessionSelectionSequence) return;
        const virtualizer = window.Pivot?.modules?.['chat.messageVirtualizer'];
        if (virtualizer?.isActive?.()) virtualizer.prepareForLiveAppend?.();
        for (const run of runs) {
            const runId = String(run?.id || '').trim();
            if (!runId) continue;
            const existing = reattachedChatAgents.get(runId);
            if (existing?.tracking && existing.selectionSequence === selectionSequence && document.body.contains(existing.element)) continue;
            const previousElement = [...document.querySelectorAll('[data-chat-agent-run-id]')]
                .find(element => element.dataset.chatAgentRunId === runId);
            if (previousElement?.dataset.chatAgentTracking === 'active') continue;
            const element = previousElement || appendMessage('assistant', chatAgentStatusText(run.status), null, {
                createdAt: run.created_at,
                modelName: run.model_name || ''
            });
            const entry = { sessionId: safeSessionId, element, runId, title: run.title || '', tracking: true, selectionSequence };
            reattachedChatAgents.set(runId, entry);
            updateReattachedAgentMessage(entry, run.status);
            window.Pivot.legacy.registerChatAgentStreamingTarget?.(runId, element, safeSessionId);
            trackReattachedChatAgent(runId, safeSessionId, entry).catch(() => {}).finally(() => { entry.tracking = false; });
        }
    } catch (_error) {
        // 状态恢复是增强通道；接口暂时不可用时不影响历史消息正常展示。
    }
}

function detachReattachedChatAgents() {
    window.Pivot.moduleApi('chat.tasks').detachAll?.();
    for (const [runId, entry] of reattachedChatAgents) {
        window.Pivot.legacy.unregisterChatAgentStreamingTarget?.(runId, entry.element);
    }
    reattachedChatAgents.clear();
}

async function createSession(title) {
    try {
        const res = await apiFetch(API_BASE + '/sessions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ title })
        });
        if (!res.ok) {
            const errBody = await res.json().catch(() => ({}));
            showToast(errBody.error || '创建会话失败', 'error');
            return null;
        }
        const session = await res.json();
        if (!session.id) {
            showToast(session.error || '创建会话失败', 'error');
            return null;
        }
        return session;
    } catch (e) {
        console.error('创建会话失败', e);
        showToast('创建会话失败，请稍后重试', 'error');
        return null;
    }
}

function clearActiveChatSession() {
    window.Pivot.moduleApi('chat.realtimeVoice')?.stopRealtimeVoice?.();
    window.Pivot.moduleApi('chat.memoryActions')?.stopChatVoiceInput?.();
    sessionSelectionSequence += 1;
    detachReattachedChatAgents();
    currentSessionId = null;
    window.Pivot.legacy.persistActiveChatSession?.('');
    window.Pivot.legacy.markActiveSessionInList?.('');
    window.Pivot?.moduleApi?.('chat.attachments')?.clearPendingAttachments?.();
    window.Pivot?.moduleApi?.('chat.messageVirtualizer')?.stop?.();
    document.getElementById('current-title')?.replaceChildren(document.createTextNode('请选择或新建对话'));
    window.Pivot?.legacy.PivotSafeHtml?.setHtml?.(document.getElementById('message-container'), '');
    window.Pivot?.moduleApi?.('chat.ui')?.updateContextUsage?.(null);
}

async function selectSession(id, title, options = {}) {
    const selectionSequence = ++sessionSelectionSequence;
    detachReattachedChatAgents();
    const requestedSessionId = String(id || '');
    const isCurrentSelection = () => (
        selectionSequence === sessionSelectionSequence
        && String(currentSessionId || '') === requestedSessionId
    );
    window.Pivot.moduleApi('workspaces.navigation').showMainWorkspace?.('chat');
    if (String(currentSessionId || '') !== requestedSessionId) {
        window.Pivot.moduleApi('chat.realtimeVoice')?.stopRealtimeVoice?.();
        window.Pivot.moduleApi('chat.memoryActions')?.stopChatVoiceInput?.();
        clearPendingAttachments('已清空未发送附件，避免发送到错误会话');
    }
    currentSessionId = id;
    window.Pivot.legacy.persistActiveChatSession?.(id);
    window.Pivot.legacy.markActiveSessionInList?.(id);
    if (title) document.getElementById('current-title').innerText = title;

    let data = null;
    try {
        const res = await apiFetch(API_BASE + `/sessions/${id}?messageLimit=60`);
        // 会话切换是异步的；旧请求晚返回时不能覆盖用户刚选中的会话。
        if (!isCurrentSelection()) return;
        if (!res.ok) {
            if (options.restore || res.status === 404) {
                currentSessionId = null;
                window.Pivot.legacy.persistActiveChatSession?.('');
                const titleEl = document.getElementById('current-title');
                if (titleEl) titleEl.innerText = '请选择或新建对话';
                const msgEl = document.getElementById('message-container');
                if (msgEl) PivotSafeHtml.setHtml(msgEl, '');
                if (!options.restore) showToast('会话不存在或已被删除', 'warning');
                return;
            }
            showToast('加载会话失败，请稍后重试', 'error');
            return;
        }
        data = await res.json();
    } catch (e) {
        console.error('加载会话失败', e);
        if (!isCurrentSelection()) return;
        if (options.restore) {
            currentSessionId = null;
            window.Pivot.legacy.persistActiveChatSession?.('');
            const titleEl = document.getElementById('current-title');
            if (titleEl) titleEl.innerText = '请选择或新建对话';
            return;
        }
        showToast('加载会话失败，请稍后重试', 'error');
        return;
    }

    if (!isCurrentSelection()) return;

    const session = data.session;
    const messages = data.messages;
    if (window.Pivot.legacy.updateContextUsage) window.Pivot.legacy.updateContextUsage(data.contextMeta || null);

    if (session && session.title) document.getElementById('current-title').innerText = session.title;

    const messageVirtualizer = window.Pivot?.modules?.['chat.messageVirtualizer'];
    if (messageVirtualizer) {
        messageVirtualizer.start({ sessionId: id, records: messages, page: data.page });
        if (options.refreshSidebar) window.Pivot.moduleApi('chat.sidebar').loadSessions?.();
        attachChatAgentRunsForSession(id);
        return;
    }

    const container = document.getElementById('message-container');
    PivotSafeHtml.setHtml(container, '');
    // 先把全部消息构建到 fragment 中并一次性追加，再渲染图表和滚动，
    // 避免会话切换时出现 O(n) 次回流。
    const fragment = document.createDocumentFragment();
    const assistantContentNodes = [];
    messages
        .filter(m => m.role === 'user' || m.role === 'assistant')
        .forEach(m => {
            const contentEl = appendMessage(m.role, m.content, m.id, {
                createdAt: m.created_at,
                costTime: m.cost_time,
                tps: m.tokens_per_sec,
                tokenCount: m.token_count,
                modelName: m.model_name || m.model_api_name || '',
                agentRunId: m.agent_run_id || '',
                routeMetadata: m.route_metadata || null
            }, { target: fragment, deferRender: true });
            if (m.role === 'assistant' && contentEl) assistantContentNodes.push(contentEl);
        });
    container.appendChild(fragment);
    assistantContentNodes.forEach(node => window.Pivot.legacy.renderPivotCharts?.(node));
    window.Pivot.legacy.scrollMessagesToBottom?.({ duration: 2400 });
    setTimeout(() => window.Pivot.legacy.scrollMessagesToBottom?.({ duration: 900 }), 320);
    if (options.refreshSidebar) window.Pivot.moduleApi('chat.sidebar').loadSessions?.();
    attachChatAgentRunsForSession(id);
}


window.Pivot.exposeModule('chat.sessions', {
    clearActiveChatSession,
    createSession,
    selectSession,
    attachChatAgentRunsForSession
}, ['clearActiveChatSession', 'createSession', 'selectSession', 'attachChatAgentRunsForSession']);

window.Pivot.legacy.clearActiveChatSession = clearActiveChatSession;
