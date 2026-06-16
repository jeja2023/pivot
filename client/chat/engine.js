// --- 数据引擎模块 Engine ---
let currentAbortController = null;

window.sendMessage = async function(isRegenerate = false) {
    const shouldRegenerate = isRegenerate === true;
    if (currentAbortController) {
        showToast('当前仍有回答正在生成，请等待完成或先停止生成。', 'warning');
        return;
    }
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
        const sessionMismatches = pendingAttachments.some(item => !attachmentBelongsToSession(item, currentSessionId));
        if (sessionMismatches) {
            clearPendingAttachments('附件属于其他会话，请重新上传后发送');
            return;
        }
    }

    if (pendingAttachments.length > 0) {
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
    if (!mcpEnabled && shouldAutoEnableMcpForPrompt(content)) {
        mcpConfirmed = await ensureChatMcpConsent();
        if (!mcpConfirmed) return;
        mcpEnabled = true;
        activateChatMcpToggle();
        showToast?.('已为本轮启用工具箱工具', 'info');
    }
    if (mcpEnabled) {
        mcpConfirmed = mcpConfirmed || await ensureChatMcpConsent();
        if (!mcpConfirmed) return;
    }

    document.getElementById('user-input').value = '';
    if (window.resizeUserInput) window.resizeUserInput();
    pendingAttachments = [];
    syncPendingAttachmentsGlobal();
    renderAttachmentPreviews();

    if (!currentSessionId) {
        const data = await createSession(content.slice(0, 15) + '...');
        if (data && data.id) {
            currentSessionId = data.id;
            if (window.loadSessions) window.loadSessions();
            document.getElementById('current-title').innerText = data.title;
        } else return;
    }

    const requestSessionId = String(currentSessionId);
    const isViewingRequestSession = () => String(currentSessionId || '') === requestSessionId;
    const isRequestMessageVisible = () => isViewingRequestSession() && document.body.contains(aiMsgEl);
    const assistantModelName = model?.name || model?.model_name || '';

    let userMsgEl = null;
    if (!shouldRegenerate) {
        userMsgEl = appendMessage('user', displayContent, null, { createdAt: new Date(), attachments: sentAttachments });
    }
    const aiMsgEl = appendMessage('assistant', '...', null, { createdAt: new Date(), modelName: assistantModelName });
    const textBody = aiMsgEl.querySelector('.text-body');
    const updateAssistantStatus = (message, type = 'queue') => {
        if (!textBody) return;
        const cls = type === 'error' ? 'error-detail' : 'queue-detail';
        textBody.innerHTML = `<div class="${cls}">${escapeChatStatusHtml(message)}</div>`;
    };
    let fullAiContent = '';
    let tokenCount = 0;
    let startTime = Date.now();
    let firstTokenTime = null;
    let hasShownQueueToast = false;
    let renderTimer = null;
    let localReplayTimer = null;
    let pendingStreamChunks = [];
    let reader = null;

    document.getElementById('send-btn').classList.add('hidden');
    document.getElementById('stop-btn').classList.remove('hidden');
    currentAbortController = new AbortController();

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
                mcpConfirmed
            }),
            signal: currentAbortController.signal
        });

        if (!response.ok) throw new Error(await readChatErrorMessage(response));

        const responseType = response.headers.get('content-type') || '';
        if (responseType.includes('application/json')) {
            const data = await response.json();
            fullAiContent = data.content || data.error || '';
            if (textBody && isRequestMessageVisible()) textBody.innerHTML = renderAiMessage(fullAiContent, false);
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
                renderStreamingAssistantContent(textBody, statsEl, fullAiContent, tokenCount, startTime, firstTokenTime);
                keepLatestCodeBlockPinned(textBody, wasNearBottom);
                keepMessageContainerPinnedToBottom(wasNearBottom);
            }, interval);
        };
        const flushStreamRender = () => {
            const wasNearBottom = isViewingRequestSession() && isMessageContainerNearBottom(260);
            if (renderTimer) clearTimeout(renderTimer);
            renderPending = false;
            renderTimer = null;
            renderStreamingAssistantContent(textBody, statsEl, fullAiContent, tokenCount, startTime, firstTokenTime);
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
                // Dispose any echarts instances/listeners under the node before we replace its DOM.
                window.teardownPivotCharts?.(textBody);
                textBody.innerHTML = renderAiMessage(fullAiContent, false);
                window.renderPivotCharts?.(textBody);
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
                    updateAssistantStatus(data.message || '正在处理工具箱工具');
                    if (data.status === 'error') showToast(data.message || '工具箱工具调用失败', 'warning');
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
                            renderFinalAssistantStats(statsEl, {
                                modelName: data.modelName || data.model_name || assistantModelName,
                                costTime: data.costTime ?? ((Date.now() - startTime) / 1000),
                                tokenCount: data.tokenCount ?? tokenCount,
                                tps: data.tps ?? (firstTokenTime ? tokenCount / ((Date.now() - firstTokenTime) / 1000) : 0)
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
                        if (textBody && isRequestMessageVisible()) textBody.innerHTML = renderAiMessage(fullAiContent, false);
                    }
                    const elapsed = (Date.now() - startTime) / 1000;
                    const finalTokenCount = data.tokenCount ?? (data.content ? estimateStreamingTokenCount(data.content) : tokenCount);
                    const finalTps = elapsed > 0 ? finalTokenCount / elapsed : 0;
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
                    if (!firstTokenTime) {
                        firstTokenTime = Date.now();
                    }
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
        if (!hasRenderedPersistedAssistantContent) flushStreamRender();
        if (isViewingRequestSession()) window.scrollMessagesToBottom?.();

        const finalElapsed = (Date.now() - startTime) / 1000;
        const finalTps = firstTokenTime ? (tokenCount / ((Date.now() - firstTokenTime) / 1000)).toFixed(1) : 0;
        // Post-success bookkeeping must not surface as a chat error if it fails.
        try {
            await apiFetch(API_BASE + '/chat/stats', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ sessionId: requestSessionId, costTime: finalElapsed, tps: finalTps })
            });
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
            fullAiContent += '\n\n[已由用户中断生成]';
            if (textBody && isRequestMessageVisible()) textBody.innerHTML = renderAiMessage(fullAiContent, true);
            if (isViewingRequestSession()) window.scrollMessagesToBottom?.();
        } else {
            if (e.messageId) window.setMessageActionId?.(aiMsgEl, e.messageId);
            if (e.persistedContent) {
                fullAiContent = e.persistedContent;
                if (textBody && isRequestMessageVisible()) textBody.innerHTML = renderAiMessage(fullAiContent, false);
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
