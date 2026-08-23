// --- 数据引擎模块 Engine ---
let currentAbortController = null;
// 正在执行的发送任务；新消息发出时先中断它，再串行接管，避免两次发送并发
let activeSendTask = null;
let latestSendEpoch = 0;
let chatLocalMcpBridgeDebug = null;
let chatLocalMcpHeartbeatStarted = false;
const chatAgentStreamingTargets = new Map();

function getChatLocalMcpDeviceId() {
    const key = 'pivot_local_execution_device_id';
    try {
        const existing = localStorage.getItem(key);
        if (existing) return existing;
        const next = globalThis.crypto?.randomUUID?.() || `desktop-${Date.now()}-${Math.random().toString(16).slice(2)}`;
        localStorage.setItem(key, next);
        return next;
    } catch (_err) {
        return `desktop-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    }
}

function normalizeChatLocalMcpBridgePayload(status, deviceId = '') {
    if (!status?.available) return null;
    const grants = status.grants && typeof status.grants === 'object' ? status.grants : {};
    return {
        deviceId: deviceId || status.deviceId || getChatLocalMcpDeviceId(),
        deviceName: status.deviceName || '我的电脑',
        provider: status.provider || 'desktop',
        mode: status.mode || 'remote',
        grants
    };
}

function summarizeChatLocalMcpGrants(grants = {}) {
    return {
        local_database: grants.local_database?.authorized === true,
        local_report_dir: grants.local_report_dir?.authorized === true
    };
}

function updateChatLocalMcpBridgeDebug(state = {}) {
    const next = {
        page: 'chat',
        checkedAt: new Date().toISOString(),
        ...state
    };
    chatLocalMcpBridgeDebug = next;
    return next;
}

function getChatLocalMcpBridgeDebugSnapshot() {
    return chatLocalMcpBridgeDebug || updateChatLocalMcpBridgeDebug({
        status: 'not_checked',
        reason: '聊天页尚未检查桌面端本机执行器。'
    });
}

function inspectChatLocalMcpDesktopBridge() {
    const desktop = window.pivotDesktop;
    const hasDesktopBridge = Boolean(desktop);
    const hasStatusBridge = typeof desktop?.getLocalAuthorizationStatus === 'function';
    const hasExecuteBridge = typeof desktop?.executeLocalMcpTool === 'function';
    let reason = '';
    if (!hasDesktopBridge) {
        reason = '聊天页没有检测到桌面端桥 window.pivotDesktop；请确认当前页面在桌面客户端中打开，而不是普通浏览器。';
    } else if (!hasStatusBridge) {
        reason = '当前桌面客户端缺少本机授权状态接口；请重新打包或安装包含本机授权中心的新版本。';
    } else if (!hasExecuteBridge) {
        reason = '当前桌面客户端缺少本机只读执行接口；请重新打包或安装包含本机执行器的新版本。';
    }
    return {
        hasDesktopBridge,
        hasStatusBridge,
        hasExecuteBridge,
        ready: hasDesktopBridge && hasStatusBridge && hasExecuteBridge,
        reason
    };
}

async function registerChatLocalMcpBridgeDirectly() {
    const bridgeState = inspectChatLocalMcpDesktopBridge();
    if (!bridgeState.ready) {
        updateChatLocalMcpBridgeDebug({ status: 'bridge_unavailable', ...bridgeState });
        return null;
    }
    const desktop = window.pivotDesktop;
    const status = await desktop.getLocalAuthorizationStatus();
    const grants = summarizeChatLocalMcpGrants(status?.grants || {});
    const payload = normalizeChatLocalMcpBridgePayload(status, getChatLocalMcpDeviceId());
    if (!payload) {
        updateChatLocalMcpBridgeDebug({
            status: 'authorization_unavailable',
            ...bridgeState,
            statusAvailable: status?.available === true,
            mode: status?.mode || '',
            grants,
            reason: status?.available
                ? '聊天页已检测到桌面端，但没有可同步的本机授权。'
                : '桌面端本机授权状态不可用。'
        });
        return null;
    }
    const response = await apiFetch(`${API_BASE}/mcp/local-device/heartbeat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    });
    if (!response.ok) {
        const message = await response.text() || '本机工具库同步失败。';
        updateChatLocalMcpBridgeDebug({ status: 'heartbeat_failed', ...bridgeState, grants, reason: message.slice(0, 300) });
        throw new Error(message);
    }
    const data = await response.json().catch(() => ({}));
    updateChatLocalMcpBridgeDebug({
        status: 'heartbeat_ok',
        ...bridgeState,
        statusAvailable: true,
        mode: payload.mode,
        deviceName: payload.deviceName,
        grants,
        toolCount: Array.isArray(data.tools) ? data.tools.length : 0,
        reason: '桌面端本机执行器已同步。'
    });
    return payload;
}

async function syncChatLocalMcpBridgeBeforeSend() {
    try {
        if (!window.syncMcpLocalExecutionBridge && window.Pivot?.loadScriptOnce) {
            await window.Pivot.loadScriptOnce('/chat/mcp-workbench-local-auth.js');
        }
        const result = await window.syncMcpLocalExecutionBridge?.({ force: true });
        const payload = normalizeChatLocalMcpBridgePayload(result?.status, result?.device?.deviceId);
        if (payload) return payload;
        return await registerChatLocalMcpBridgeDirectly();
    } catch (error) {
        console.debug?.('[pivot] 本机工具库同步失败，继续发送消息', error?.message || error);
        try {
            return await registerChatLocalMcpBridgeDirectly();
        } catch (fallbackError) {
            console.debug?.('[pivot] 本机工具库直接同步失败', fallbackError?.message || fallbackError);
        }
    }
    return null;
}

function startChatLocalMcpBridgeHeartbeat() {
    if (chatLocalMcpHeartbeatStarted) return;
    chatLocalMcpHeartbeatStarted = true;
    const bridgeState = inspectChatLocalMcpDesktopBridge();
    if (!bridgeState.ready) return;
    const tick = () => {
        if (!inspectChatLocalMcpDesktopBridge().ready) return;
        return registerChatLocalMcpBridgeDirectly().catch(error => {
            console.debug?.('[pivot] 聊天页本机执行器心跳等待中', error?.message || error);
        });
    };
    setTimeout(tick, 2000);
    setInterval(tick, 60000);
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', startChatLocalMcpBridgeHeartbeat, { once: true });
} else {
    startChatLocalMcpBridgeHeartbeat();
}
function hasSendableChatPayload() {
    const inputEl = document.getElementById('user-input');
    const text = String(inputEl?.value || '').trim();
    return Boolean(text) || pendingAttachments.length > 0;
}

async function postChatAgentControl(runId, path, body = {}) {
    const response = await apiFetch(`${API_BASE}/agents/runs/${encodeURIComponent(runId)}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || '连续 Agent 操作失败');
    return data;
}

async function cancelChatAgentRun(runId) {
    if (!runId) return null;
    const result = await postChatAgentControl(runId, '/cancel');
    showToast('已请求停止连续 Agent', 'info');
    return result;
}

function attachChatAgentControls(messageContent, runId, status = '') {
    if (!messageContent || !runId) return;
    const actions = messageContent.querySelector('.message-actions');
    if (!actions) return;
    let controls = messageContent.querySelector('.chat-agent-controls');
    if (!controls) {
        controls = document.createElement('div');
        controls.className = 'chat-agent-controls';
        actions.insertAdjacentElement('beforebegin', controls);
    }
    const normalizedStatus = String(status || '').toLowerCase();
    const isTerminal = ['completed', 'completed_with_errors', 'error', 'failed', 'cancelled', 'deleted'].includes(normalizedStatus);
    const canResume = ['error', 'failed', 'cancelled'].includes(normalizedStatus);
    if (isTerminal && !canResume) {
        controls.remove();
        return;
    }
    while (controls.firstChild) controls.removeChild(controls.firstChild);
    const addButton = (label, className, title, handler) => {
        const key = `${label}:${runId}`;
        const button = document.createElement('button');
        button.type = 'button';
        button.className = className;
        button.textContent = label;
        button.title = title;
        button.setAttribute('aria-label', title);
        button.dataset.chatAgentControl = key;
        button.addEventListener('click', async event => {
            event.preventDefault();
            event.stopPropagation();
            button.disabled = true;
            try { await handler(); } catch (error) { showToast(error.message || '连续 Agent 操作失败', 'error'); }
            finally { button.disabled = false; }
        });
        controls.appendChild(button);
    };
    addButton('详情', 'btn-secondary', '查看连续 Agent 任务详情', () => window.openAgentRun?.(runId));
    if (!isTerminal) addButton('停止', 'btn-danger-outline', '停止连续 Agent 任务', () => cancelChatAgentRun(runId));
    if (['approval_required', 'waiting_approval', 'awaiting_approval'].includes(normalizedStatus)) {
        addButton('批准', 'btn-primary', '批准工具调用并继续任务', () => postChatAgentControl(runId, '/approval', { approve: true }));
        addButton('拒绝', 'btn-danger-outline', '拒绝工具调用并停止任务', () => postChatAgentControl(runId, '/approval', { approve: false }));
    }
    if (canResume) {
        addButton('继续', 'btn-primary', '从上次执行位置继续任务', async () => {
            await postChatAgentControl(runId, '/resume');
            showToast('已创建续跑任务', 'info');
            window.attachChatAgentRunsForSession?.(currentSessionId);
        });
    }
}

function registerChatAgentStreamingTarget(runId, messageContent, sessionId = currentSessionId) {
    const safeRunId = String(runId || '').trim();
    if (!safeRunId || !messageContent) return;
    chatAgentStreamingTargets.set(safeRunId, {
        element: messageContent,
        sessionId: String(sessionId || '')
    });
}

function unregisterChatAgentStreamingTarget(runId) {
    chatAgentStreamingTargets.delete(String(runId || '').trim());
}

function handleChatAgentStreamingEvent(payload = {}) {
    const runId = String(payload.runId || '').trim();
    const target = chatAgentStreamingTargets.get(runId);
    if (!target || String(currentSessionId || '') !== target.sessionId) return;
    const step = Number(payload.step || 0);
    const hasTools = Array.isArray(payload.partialToolCalls) && payload.partialToolCalls.length > 0;
    const status = payload.completed
        ? (hasTools ? `连续 Agent 第 ${step || 1} 步工具调用已完成` : `连续 Agent 第 ${step || 1} 步规划已完成`)
        : (hasTools ? `连续 Agent 正在处理第 ${step || 1} 步工具调用` : `连续 Agent 正在生成第 ${step || 1} 步计划`);
    const textBody = target.element?.querySelector?.('.text-body');
    if (textBody) PivotSafeHtml.setHtml(textBody, `<div class="queue-detail">${escapeChatStatusHtml(status)}</div>`);
}

async function cancelCurrentChatAgent() {
    const runId = currentAbortController?.pivotAgentRunId;
    if (runId) {
        try { await cancelChatAgentRun(runId); } catch (error) { showToast(error.message || '停止连续 Agent 失败', 'error'); }
    }
    currentAbortController?.abort();
}

window.Pivot.exposeModule('chat.agentBridge', {
    attachChatAgentControls,
    cancelCurrentChatAgent,
    registerChatAgentStreamingTarget,
    unregisterChatAgentStreamingTarget,
    handleChatAgentStreamingEvent
}, [
    'attachChatAgentControls',
    'cancelCurrentChatAgent',
    'registerChatAgentStreamingTarget',
    'unregisterChatAgentStreamingTarget',
    'handleChatAgentStreamingEvent'
]);

// 发新消息时先中断上一次生成再串行接管，而不是拦下用户输入
window.sendMessage = async function(isRegenerate = false) {
    const shouldRegenerate = isRegenerate === true;
    // 空输入不应打断正在进行的生成
    if (!shouldRegenerate && !hasSendableChatPayload()) return;

    const sendEpoch = ++latestSendEpoch;
    if (currentAbortController) {
        currentAbortController.pivotSupersededBySend = true;
        currentAbortController.abort();
    }
    const previousTask = activeSendTask;
    if (previousTask) {
        // 等上一次发送走完 catch/finally，确保 currentAbortController 已复位再接管
        try { await previousTask; } catch (_e) { /* 上一次发送的异常已在其内部处理 */ }
    }
    // 等待期间又有更新的发送进来，交给它执行，避免重复发送同一条输入
    if (sendEpoch !== latestSendEpoch) return;

    const task = runSendMessage(shouldRegenerate);
    activeSendTask = task;
    try {
        await task;
    } finally {
        if (activeSendTask === task) activeSendTask = null;
    }
};

async function runSendMessage(shouldRegenerate) {
    const userVisibleContent = document.getElementById('user-input').value.trim();
    let content = userVisibleContent;
    let displayContent = userVisibleContent;
    const modelId = document.getElementById('model-selector').value;
    const model = (window._cachedModels || []).find(m => String(m.id) === String(modelId));
    
    if (pendingAttachments.length > 0) {
        if (!model || Number(model.supports_vision || 0) !== 1) {
            showToast('当前模型不支持附件处理能力（图片、文档等）', 'error');
            return;
        }
    }
    
    if (!content && pendingAttachments.length === 0 && !shouldRegenerate) return;

    if (pendingAttachments.length > 0) {
        const sessionMismatches = pendingAttachments.some(item => item?.kind === 'uploaded' && !attachmentBelongsToSession(item, currentSessionId));
        if (sessionMismatches) {
            clearPendingAttachments('附件属于其他会话，请重新上传后发送');
            return;
        }
    }

    if (!currentSessionId) {
        const draftTitle = userVisibleContent
            ? `${userVisibleContent.slice(0, 15)}...`
            : (pendingAttachments.find(item => item?.file)?.name || '新对话');
        const data = await createSession(draftTitle);
        if (data && data.id) {
            currentSessionId = data.id;
            if (window.loadSessions) window.loadSessions();
            document.getElementById('current-title').innerText = data.title;
        } else return;
    }

    if (pendingAttachments.length > 0) {
        const uploadSessionId = String(currentSessionId || '').trim() || null;
        try {
            const uploadResult = await window.preparePendingAttachmentsForSend?.(uploadSessionId);
            if (uploadResult?.aborted) return;
            if (uploadResult?.skippedCount > 0) showToast(`有 ${uploadResult.skippedCount} 个附件超出数量上限，已跳过`, 'warning');
        } catch (e) {
            showToast(e.message || '附件上传失败', 'error');
            return;
        }
        const attachmentLinks = pendingAttachments.map(a => a.markdown).join('\n');
        content = (content ? content + '\n\n' : '') + attachmentLinks;
        displayContent = (displayContent ? displayContent + '\n\n' : '') + attachmentLinks;
        const docTexts = pendingAttachments
            .filter(a => a.extractedText)
            .map(a => '\n\n---\n【参考文档: ' + a.name + '】\n' + a.extractedText + '\n---')
            .join('');
        if (docTexts) content += docTexts;
    }
    const sentAttachments = pendingAttachments.map(item => ({ ...item }));

    const ragEnabled = isChatToolEnabled('chat-rag-enabled', 'pivot_chat_rag_enabled');
    let mcpEnabled = isChatToolEnabled('chat-mcp-enabled', 'pivot_chat_mcp_enabled');
    let mcpConfirmed = false;
    let localMcpBridge = null;
    let localMcpBridgeDebug = null;
    if (mcpEnabled) {
        mcpConfirmed = mcpConfirmed || await ensureChatMcpConsent();
        if (!mcpConfirmed) return;
        localMcpBridge = await syncChatLocalMcpBridgeBeforeSend();
        localMcpBridgeDebug = getChatLocalMcpBridgeDebugSnapshot();
    }

    document.getElementById('user-input').value = '';
    if (window.resizeUserInput) window.resizeUserInput();
    pendingAttachments = [];
    syncPendingAttachmentsGlobal();
    renderAttachmentPreviews();

    const requestSessionId = String(currentSessionId);
    const isViewingRequestSession = () => String(currentSessionId || '') === requestSessionId;
    const isRequestMessageVisible = () => isViewingRequestSession() && document.body.contains(aiMsgEl);
    const assistantModelName = model?.name || model?.model_name || '';

    window.Pivot?.modules?.['chat.messageVirtualizer']?.prepareForLiveAppend?.();

    let userMsgEl = null;
    if (!shouldRegenerate) {
        userMsgEl = appendMessage('user', displayContent, null, { createdAt: new Date(), attachments: sentAttachments });
    }
    const aiMsgEl = appendMessage('assistant', '...', null, { createdAt: new Date(), modelName: assistantModelName });
    const textBody = aiMsgEl.querySelector('.text-body');
    const updateAssistantStatus = (message, type = 'queue') => {
        if (!textBody) return;
        const cls = type === 'error' ? 'error-detail' : 'queue-detail';
        PivotSafeHtml.setHtml(textBody, `<div class="${cls}">${escapeChatStatusHtml(message)}</div>`);
    };
    let fullAiContent = '';
    let tokenCount = 0;
    let startTime = Date.now();
    let hasShownQueueToast = false;
    let renderTimer = null;
    let localReplayTimer = null;
    let pendingStreamChunks = [];
    let reader = null;
    let hasServerFinalStats = false;
    let agentRunId = '';
    let agentTrackingPromise = null;

    const getElapsedSeconds = () => Math.max((Date.now() - startTime) / 1000, 0.001);
    const getAverageTps = (count = tokenCount) => {
        const safeCount = Number.isFinite(Number(count)) ? Number(count) : 0;
        const elapsed = getElapsedSeconds();
        return safeCount > 0 && elapsed > 0 ? safeCount / elapsed : 0;
    };

    document.getElementById('send-btn').classList.add('hidden');
    document.getElementById('stop-btn').classList.remove('hidden');
    const myController = new AbortController();
    currentAbortController = myController;

    try {
        const response = await apiFetch(API_BASE + '/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Accept': 'text/event-stream' },
            body: JSON.stringify({
                sessionId: requestSessionId,
                content,
                displayContent: stripInternalReferenceText(displayContent || content),
                modelId,
                regenerate: shouldRegenerate,
                ragEnabled,
                ragScope: window.getRagScopeSelection?.('chat') || {},
                mcpEnabled,
                mcpConfirmed,
                mcpToolAllowlist: window.Pivot.modules['chat.inputMenu']?.getMcpToolAllowlist?.() ?? null,
                localMcpBridge,
                localMcpBridgeDebug
            }),
            signal: currentAbortController.signal
        });

        if (!response.ok) throw new Error(await readChatErrorMessage(response));

        const responseType = response.headers.get('content-type') || '';
        if (responseType.includes('application/json')) {
            const data = await response.json();
            fullAiContent = data.content || data.error || '';
            if (textBody && isRequestMessageVisible()) PivotSafeHtml.setHtml(textBody, renderAiMessage(fullAiContent, false));
            if (isViewingRequestSession()) window.scrollMessagesToBottom?.();
            if (window.loadSessions) window.loadSessions();
            return;
        }

        reader = response.body.getReader();
        const decoder = new TextDecoder();
        const statsEl = aiMsgEl.querySelector('.message-stats') || document.createElement('div');
        statsEl.className = 'message-stats';
        if (!aiMsgEl.querySelector('.message-stats')) {
            const footerEl = aiMsgEl.querySelector('.message-footer');
            if (footerEl) {
                footerEl.classList.remove('hidden');
                footerEl.classList.remove('hover-time-only');
                footerEl.insertBefore(statsEl, footerEl.querySelector('.message-meta'));
            } else {
                aiMsgEl.insertBefore(statsEl, aiMsgEl.querySelector('.message-actions'));
            }
        }
        let renderPending = false;
        const scheduleStreamRender = () => {
            if (renderPending) return;
            renderPending = true;
            const wasNearBottom = isViewingRequestSession() && isMessageContainerNearBottom();
            const interval = resolveStreamInterval((fullAiContent || '').length);
            renderTimer = setTimeout(() => {
                renderPending = false;
                renderTimer = null;
                renderStreamingAssistantContent(textBody, statsEl, fullAiContent, tokenCount, startTime);
                keepLatestCodeBlockPinned(textBody, wasNearBottom);
                keepMessageContainerPinnedToBottom(wasNearBottom);
            }, interval);
        };
        const flushStreamRender = () => {
            const wasNearBottom = isViewingRequestSession() && isMessageContainerNearBottom(260);
            if (renderTimer) clearTimeout(renderTimer);
            renderPending = false;
            renderTimer = null;
            renderStreamingAssistantContent(textBody, statsEl, fullAiContent, tokenCount, startTime);
            keepLatestCodeBlockPinned(textBody, wasNearBottom);
            keepMessageContainerPinnedToBottom(wasNearBottom);
        };
        let hasRenderedFirstStreamContent = false;
        const appendStreamContent = (content) => {
            if (!content) return;
            fullAiContent += content;
            tokenCount = estimateStreamingTokenCount(fullAiContent);
            if (!hasRenderedFirstStreamContent) {
                hasRenderedFirstStreamContent = true;
                flushStreamRender();
                return;
            }
            scheduleStreamRender();
        };
        const runLocalReplayTick = () => {
            localReplayTimer = null;
            if (!pendingStreamChunks.length) return;
            const burstSize = pendingStreamChunks.length > 120 ? 6
                : pendingStreamChunks.length > 60 ? 4
                    : pendingStreamChunks.length > 20 ? 2
                        : 1;
            for (let i = 0; i < burstSize && pendingStreamChunks.length; i += 1) {
                appendStreamContent(pendingStreamChunks.shift());
            }
            if (pendingStreamChunks.length) {
                localReplayTimer = setTimeout(runLocalReplayTick, STREAM_LOCAL_REPLAY_INTERVAL_MS);
            }
        };
        const enqueueStreamContent = (content) => {
            const chunks = splitAssistantStreamDelta(content);
            if (!chunks.length) return;
            pendingStreamChunks.push(...chunks);
            if (!localReplayTimer) {
                localReplayTimer = setTimeout(runLocalReplayTick, hasRenderedFirstStreamContent ? STREAM_LOCAL_REPLAY_INTERVAL_MS : 0);
            }
        };
        const waitForLocalReplay = () => new Promise(resolve => {
            const startedAt = Date.now();
            const settle = () => {
                if (!pendingStreamChunks.length && !localReplayTimer) {
                    resolve();
                    return;
                }
                if (Date.now() - startedAt >= STREAM_LOCAL_REPLAY_MAX_WAIT_MS) {
                    if (localReplayTimer) clearTimeout(localReplayTimer);
                    localReplayTimer = null;
                    while (pendingStreamChunks.length) appendStreamContent(pendingStreamChunks.shift());
                    resolve();
                    return;
                }
                setTimeout(settle, 40);
            };
            settle();
        });
        let hasRenderedPersistedAssistantContent = false;
        const renderPersistedAssistantContent = (content) => {
            if (typeof content !== 'string' || !content) return;
            if (localReplayTimer) clearTimeout(localReplayTimer);
            if (renderTimer) clearTimeout(renderTimer);
            pendingStreamChunks = [];
            localReplayTimer = null;
            renderTimer = null;
            fullAiContent = content;
            tokenCount = estimateStreamingTokenCount(fullAiContent);
            hasRenderedPersistedAssistantContent = true;
            if (textBody && isRequestMessageVisible()) {
                // 替换 DOM 前释放节点下的 ECharts 实例和监听器。
                window.teardownPivotCharts?.(textBody);
                PivotSafeHtml.setHtml(textBody, renderAiMessage(fullAiContent, false));
                window.renderPivotCharts?.(textBody);
            }
        };
        const trackChatAgentRun = async (runId) => {
            const terminalStatuses = new Set(['completed', 'completed_with_errors', 'error', 'failed', 'cancelled', 'deleted']);
            for (let attempt = 0; attempt < 43200; attempt += 1) {
                try {
                    const response = await apiFetch(`${API_BASE}/agents/runs/${encodeURIComponent(runId)}`);
                    if (!response.ok) throw new Error(`Agent 任务查询失败（${response.status}）`);
                    const detail = await response.json();
                    const run = detail?.run || detail?.data?.run || detail?.data || detail;
                    const status = String(run?.status || '').toLowerCase();
                    if (terminalStatuses.has(status)) {
                        const metadata = typeof run?.metadata === 'string'
                            ? (() => { try { return JSON.parse(run.metadata); } catch (_) { return {}; } })()
                            : (run?.metadata || {});
                        const bridge = metadata?.chatBridge || {};
                        const answer = String(run?.final_answer
                            || (run?.error_message ? `任务执行失败：${run.error_message}` : '任务未生成可用结果。')).trim();
                        if (answer) renderPersistedAssistantContent(answer);
                        if (bridge.messageId) window.setMessageActionId?.(aiMsgEl, bridge.messageId);
                        unregisterChatAgentStreamingTarget(runId);
                        attachChatAgentControls(aiMsgEl, runId, status);
                        if (isViewingRequestSession()) {
                            const elapsed = Math.max((Date.now() - startTime) / 1000, 0.001);
                            renderFinalAssistantStats(statsEl, {
                                modelName: run?.model_name || assistantModelName,
                                costTime: elapsed,
                                tokenCount: estimateStreamingTokenCount(answer),
                                tps: answer ? estimateStreamingTokenCount(answer) / elapsed : 0
                            });
                            window.refreshCurrentContextUsage?.(requestSessionId);
                            window.scrollMessagesToBottom?.();
                        } else {
                            showToast('原会话的 Agent 任务已完成，可切回查看。', 'info');
                        }
                        if (window.loadSessions) window.loadSessions();
                        return;
                    }
                    if (isViewingRequestSession()) {
                        const statusText = status === 'approval_required' || status === 'waiting_approval'
                            ? '连续 Agent 等待审批'
                            : status === 'executing' || status === 'observing' || status === 'replanning'
                                ? '连续 Agent 正在执行任务'
                                : '连续 Agent 正在规划任务';
                        updateAssistantStatus(statusText);
                        attachChatAgentControls(aiMsgEl, runId, status);
                    }
                } catch (error) {
                    if (isViewingRequestSession()) updateAssistantStatus('连续 Agent 仍在后台运行，暂时无法读取最新状态');
                }
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
        };
        const sseParser = createBrowserSseParser({
            onData(payload) {
                let data = null;
                try {
                    data = JSON.parse(payload);
                } catch (e) {
                    console.warn('忽略格式异常的 SSE 事件', e);
                    return;
                }
                if (data.type === 'agent_handoff') {
                    agentRunId = String(data.runId || '').trim();
                    myController.pivotAgentRunId = agentRunId;
                    registerChatAgentStreamingTarget(agentRunId, aiMsgEl, requestSessionId);
                    updateAssistantStatus(data.message || '已切换为连续 Agent，任务会在后台继续执行。');
                    attachChatAgentControls(aiMsgEl, agentRunId, data.status || 'queued');
                    if (agentRunId && !agentTrackingPromise) {
                        agentTrackingPromise = trackChatAgentRun(agentRunId).catch(error => {
                            if (isViewingRequestSession()) updateAssistantStatus(error.message || '连续 Agent 状态跟踪失败', 'error');
                        });
                    }
                    return;
                }
                if (data.type === 'queue') {
                    updateAssistantStatus(data.message || '正在排队，请稍候');
                    if (!hasShownQueueToast && data.status !== 'ready') {
                        showToast(data.message || '请求已进入排队', 'info');
                        hasShownQueueToast = true;
                    }
                    return;
                }
                if (data.type === 'mcp') {
                    window.renderAssistantTraceEvent?.(aiMsgEl, data);
                    updateAssistantStatus(data.message || '正在处理工具库工具');
                    if (data.status === 'error') showToast(data.message || '工具库工具调用失败', 'warning');
                    return;
                }
                if (data.type === 'chart') {
                    return;
                }
                if (data.type === 'rag') {
                    window.renderAssistantTraceEvent?.(aiMsgEl, data);
                    updateAssistantStatus(data.message || '正在检索知识库');
                    if (data.status === 'hit') showToast(data.message || '知识库已命中', 'info');
                    if (data.status === 'empty') showToast(data.message || '知识库未命中', 'warning');
                    return;
                }
                if (data.type === 'context_budget') {
                    updateAssistantStatus(data.message || '本次请求内容较长，已自动裁剪上下文后继续生成。');
                    if (data.status === 'trimmed') showToast(data.message || '已自动裁剪较早上下文后继续生成', 'info');
                    return;
                }
                if (data.type === 'message_saved') {
                    if (data.role === 'user') {
                        window.setMessageActionId?.(userMsgEl, data.messageId);
                        window.refreshCurrentContextUsage?.(requestSessionId);
                    }
                    if (data.role === 'assistant') {
                        window.setMessageActionId?.(aiMsgEl, data.messageId);
                        window.setMessageModelName?.(aiMsgEl, data.modelName || data.model_name || '');
                        renderPersistedAssistantContent(data.content);
                        if (data.tokenCount !== undefined || data.costTime !== undefined || data.tps !== undefined) {
                            hasServerFinalStats = data.costTime !== undefined && data.tps !== undefined;
                            renderFinalAssistantStats(statsEl, {
                                modelName: data.modelName || data.model_name || assistantModelName,
                                costTime: data.costTime ?? getElapsedSeconds(),
                                tokenCount: data.tokenCount ?? tokenCount,
                                tps: data.tps ?? getAverageTps()
                            });
                        }
                        window.refreshCurrentContextUsage?.(requestSessionId);
                    }
                    return;
                }
                if (data.error) {
                    if (data.messageId) window.setMessageActionId?.(aiMsgEl, data.messageId);
                    if (data.content) {
                        fullAiContent = data.content;
                        tokenCount = estimateStreamingTokenCount(fullAiContent);
                        if (textBody && isRequestMessageVisible()) PivotSafeHtml.setHtml(textBody, renderAiMessage(fullAiContent, false));
                    }
                    const elapsed = getElapsedSeconds();
                    const finalTokenCount = data.tokenCount ?? (data.content ? estimateStreamingTokenCount(data.content) : tokenCount);
                    const finalTps = getAverageTps(finalTokenCount);
                    renderFinalAssistantStats(statsEl, {
                        modelName: data.modelName || data.model_name || assistantModelName,
                        costTime: elapsed,
                        tokenCount: finalTokenCount,
                        tps: finalTps
                    });
                    if (data.messageId) {
                        apiFetch(API_BASE + '/chat/stats', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ sessionId: requestSessionId, costTime: elapsed, tps: finalTps })
                        }).catch(() => {});
                    }
                    const err = new Error(data.detail || data.error);
                    err.persistedContent = data.content || '';
                    err.messageId = data.messageId || null;
                    err.tokenCount = finalTokenCount;
                    err.costTime = elapsed;
                    err.tps = finalTps;
                    throw err;
                }
                if (data.messageId) window.setMessageActionId?.(aiMsgEl, data.messageId);
                if (data.content) {
                    enqueueStreamContent(data.content);
                }
            }
        });

        while (!sseParser.isDone()) {
            const { done, value } = await reader.read();
            if (done) {
                sseParser.write(decoder.decode());
                sseParser.end();
                break;
            }
            sseParser.write(decoder.decode(value, { stream: true }));
            if (isViewingRequestSession()) {
                const container = document.getElementById('message-container');
                if (container.scrollHeight - container.scrollTop - container.clientHeight < 120) container.scrollTop = container.scrollHeight;
            }
        }
        await waitForLocalReplay();
        if (agentRunId) {
            if (isViewingRequestSession()) updateAssistantStatus('连续 Agent 已接管，任务会在后台继续执行');
            return;
        }
        if (!hasRenderedPersistedAssistantContent) flushStreamRender();
        if (isViewingRequestSession()) window.scrollMessagesToBottom?.();

        const finalElapsed = getElapsedSeconds();
        const finalTps = getAverageTps();
        // 成功后的收尾记录失败时不应显示为聊天错误。
        try {
            if (!hasServerFinalStats) {
                await apiFetch(API_BASE + '/chat/stats', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ sessionId: requestSessionId, costTime: finalElapsed, tps: finalTps })
                });
            }
            await window.refreshCurrentContextUsage?.(requestSessionId);
        } catch (statsError) {
            console.warn('更新会话统计失败', statsError);
        }

        if (isViewingRequestSession() && (!isMessageContentInDocument(aiMsgEl) || (!shouldRegenerate && !isMessageContentInDocument(userMsgEl)))) {
            await selectSession(requestSessionId);
        } else if (!isViewingRequestSession()) {
            showToast('原会话的回答已生成完成，可切回查看。', 'info');
        }
        
        // 延迟刷新侧边栏，等待后台标题生成完成
        setTimeout(() => {
            if (window.loadSessions) window.loadSessions();
        }, 1500);
    } catch (e) {
        if (localReplayTimer) clearTimeout(localReplayTimer);
        if (renderTimer) clearTimeout(renderTimer);
        const remainingStreamContent = pendingStreamChunks.join('');
        pendingStreamChunks = [];
        localReplayTimer = null;
        renderTimer = null;
        if (e.name === 'AbortError') {
            if (remainingStreamContent) {
                fullAiContent += remainingStreamContent;
                tokenCount = estimateStreamingTokenCount(fullAiContent);
            }
            // 被新消息打断时不追加提示文字，干净截断即可
            if (!myController.pivotSupersededBySend) {
                fullAiContent += '\n\n[已由用户中断生成]';
            }
            if (textBody && isRequestMessageVisible()) PivotSafeHtml.setHtml(textBody, renderAiMessage(fullAiContent, true));
            if (isViewingRequestSession()) window.scrollMessagesToBottom?.();
        } else {
            if (e.messageId) window.setMessageActionId?.(aiMsgEl, e.messageId);
            if (e.persistedContent) {
                fullAiContent = e.persistedContent;
                if (textBody && isRequestMessageVisible()) PivotSafeHtml.setHtml(textBody, renderAiMessage(fullAiContent, false));
            } else if (isRequestMessageVisible()) {
                updateAssistantStatus(e.message, 'error');
            }
            if (isViewingRequestSession()) window.scrollMessagesToBottom?.();
            showToast(e.message, 'error');
        }
    } finally {
        if (reader) {
            try { await reader.cancel(); } catch (_e) { /* reader already closed */ }
            try { reader.releaseLock(); } catch (_e) { /* lock already released */ }
            reader = null;
        }
        document.getElementById('stop-btn').classList.add('hidden');
        document.getElementById('send-btn').classList.remove('hidden');
        currentAbortController = null;
    }
}
