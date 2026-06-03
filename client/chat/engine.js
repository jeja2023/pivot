// --- 数据引擎模块 Engine ---
let currentAbortController = null;
let pendingAttachments = [];
const MAX_PENDING_ATTACHMENTS = 5;
window.MAX_PENDING_ATTACHMENTS = MAX_PENDING_ATTACHMENTS;
window.pendingAttachments = pendingAttachments;

function syncPendingAttachmentsGlobal() {
    window.pendingAttachments = pendingAttachments;
}

function isChatImageAttachment(item = {}) {
    const type = String(item.type || '').toLowerCase();
    const nameOrUrl = String(item.name || item.url || '').split(/[?#]/)[0];
    return type.startsWith('image/') || /\.(png|jpe?g|gif|webp|bmp|avif)$/i.test(nameOrUrl);
}

function escapeAttachmentMarkdownLabel(value) {
    return String(value || '附件').replace(/\s+/g, ' ').replace(/[\\[\]]/g, '\\$&').trim() || '附件';
}

function buildAttachmentMarkdown(name, url, isImage) {
    const label = escapeAttachmentMarkdownLabel(name);
    return isImage ? `![${label}](${url})` : `[附件: ${label}](${url})`;
}

function getUploadSessionIdFromUrl(url = '') {
    const cleanUrl = String(url || '').split(/[?#]/)[0];
    let decoded = cleanUrl;
    try {
        decoded = decodeURIComponent(cleanUrl);
    } catch (e) {
        return '';
    }
    const parts = decoded.split('/');
    return parts[1] === 'uploads' ? parts[3] || '' : '';
}

function attachmentBelongsToSession(attachment, sessionId) {
    const expected = String(sessionId || '');
    if (!expected) return true;
    const explicitSession = String(attachment?.sessionId || '');
    if (explicitSession) return explicitSession === expected;
    const urlSession = getUploadSessionIdFromUrl(attachment?.url);
    return !urlSession || urlSession === expected;
}

function clearPendingAttachments(message = '') {
    if (pendingAttachments.length === 0) return;
    pendingAttachments = [];
    syncPendingAttachmentsGlobal();
    renderAttachmentPreviews?.();
    if (message) showToast(message, 'info');
}

window.isChatImageAttachment = isChatImageAttachment;
window.syncPendingAttachmentsGlobal = syncPendingAttachmentsGlobal;

const escapeChatStatusHtml = (value) => {
    if (window.PivotSafeHtml) return window.PivotSafeHtml.escapeHtml(value);
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
};

const STREAM_RENDER_INTERVAL_MS = 80;
const STREAM_LOCAL_REPLAY_INTERVAL_MS = 24;
const STREAM_LOCAL_REPLAY_MAX_WAIT_MS = 3200;
const STREAM_LOCAL_REPLAY_TARGET_CHARS = 48;
const STREAM_LOCAL_REPLAY_MAX_CHARS = 160;
// 内容越长，每帧 marked.parse 成本越高；按累计长度阶梯式放大间隔，降低长回答时的重排开销
const resolveStreamInterval = (contentLength) => {
    if (window.Pivot && typeof window.Pivot.chooseStreamInterval === 'function') {
        return window.Pivot.chooseStreamInterval(contentLength);
    }
    return STREAM_RENDER_INTERVAL_MS;
};

function estimateStreamingTokenCount(content) {
    const text = String(content || '');
    const chineseChars = (text.match(/[\u4e00-\u9fa5]/g) || []).length;
    return Math.ceil(chineseChars * 2 + (text.length - chineseChars) * 0.5);
}

function splitAssistantStreamDelta(delta) {
    const text = String(delta || '');
    if (!text) return [];
    if (text.length <= STREAM_LOCAL_REPLAY_MAX_CHARS || /<\/?thought>?/i.test(text)) return [text];

    const chunks = [];
    let current = '';
    for (const char of Array.from(text)) {
        current += char;
        const softBreak = current.length >= STREAM_LOCAL_REPLAY_TARGET_CHARS && /[\s,.;:!?，。；：！？、）)\]\n]/u.test(char);
        const hardBreak = current.length >= STREAM_LOCAL_REPLAY_MAX_CHARS;
        if (softBreak || hardBreak) {
            chunks.push(current);
            current = '';
        }
    }
    if (current) chunks.push(current);
    return chunks;
}

function createBrowserSseParser({ onData, onDone } = {}) {
    let buffer = '';
    let done = false;

    const flushEvent = (rawEvent) => {
        const dataLines = rawEvent
            .split(/\r?\n/)
            .map(line => line.trimEnd())
            .filter(line => line.startsWith('data:'))
            .map(line => line.replace(/^data:\s?/, ''));
        if (dataLines.length === 0) return;

        const payload = dataLines.join('\n');
        if (payload === '[DONE]') {
            done = true;
            if (typeof onDone === 'function') onDone();
            return;
        }
        if (typeof onData === 'function') onData(payload);
    };

    const write = (text) => {
        if (done) return;
        buffer += String(text || '').replace(/\r\n/g, '\n');
        let boundary = buffer.indexOf('\n\n');
        while (boundary !== -1) {
            const rawEvent = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            flushEvent(rawEvent);
            if (done) return;
            boundary = buffer.indexOf('\n\n');
        }
    };

    const end = () => {
        if (!done && buffer.trim()) {
            flushEvent(buffer);
        }
        buffer = '';
    };

    return { write, end, isDone: () => done };
}

function renderStreamingAssistantContent(textBody, statsEl, content, tokenCount, startTime, firstTokenTime) {
    if (!textBody) return;
    const hasOpenThought = content.includes('<thought>') && !content.includes('</thought>');
    const existingThoughtContent = textBody.querySelector('.thought-block.thinking .thought-content');

    if (hasOpenThought && existingThoughtContent) {
        existingThoughtContent.innerHTML = renderMarkdown(content.replace(/^<thought>/, ''), { deferPivotCharts: true });
        if (existingThoughtContent.closest('.thought-block')?.classList.contains('is-open')) {
            const inner = existingThoughtContent.closest('.thought-content-inner');
            inner.scrollTop = inner.scrollHeight;
        }
    } else {
        const thoughtState = rememberThoughtStateBeforeRender(textBody);
        textBody.innerHTML = renderAiMessage(content, true, thoughtState.openStates);
        restoreThoughtStateAfterRender(textBody, thoughtState);
    }

    const elapsed = (Date.now() - startTime) / 1000;
    const tps = firstTokenTime ? (tokenCount / ((Date.now() - firstTokenTime) / 1000)).toFixed(1) : 0;
    const modelName = String(statsEl?.dataset?.modelName || '').trim();
    const modelHtml = modelName
        ? `<span class="stat-item stat-model" title="模型：${escapeAttrValue(modelName)}">${ICONS.model}${escapeChatStatusHtml(modelName)}</span>`
        : '';
    statsEl.innerHTML = `
        ${modelHtml}
        <span class="stat-item">${ICONS.time}${elapsed.toFixed(1)}s</span>
        <span class="stat-item">${ICONS.token}${tokenCount} Tokens</span>
        <span class="stat-item">${ICONS.speed}${tps} t/s</span>
    `;
}

function renderFinalAssistantStats(statsEl, { modelName = '', costTime = 0, tokenCount = 0, tps = 0 } = {}) {
    if (!statsEl) return;
    const normalizedModelName = String(modelName || statsEl.dataset.modelName || '').trim();
    if (normalizedModelName) statsEl.dataset.modelName = normalizedModelName;
    const currentModelName = String(statsEl.dataset.modelName || '').trim();
    const modelHtml = currentModelName
        ? `<span class="stat-item stat-model" title="模型：${escapeAttrValue(currentModelName)}">${ICONS.model}${escapeChatStatusHtml(currentModelName)}</span>`
        : '';
    const safeCostTime = Number.isFinite(Number(costTime)) ? Number(costTime) : 0;
    const safeTokenCount = Number.isFinite(Number(tokenCount)) ? Math.max(0, Math.round(Number(tokenCount))) : 0;
    const safeTps = Number.isFinite(Number(tps)) ? Number(tps) : 0;
    statsEl.innerHTML = `
        ${modelHtml}
        <span class="stat-item">${ICONS.time}${safeCostTime.toFixed(1)}s</span>
        <span class="stat-item">${ICONS.token}${safeTokenCount} Tokens</span>
        <span class="stat-item">${ICONS.speed}${safeTps.toFixed(1)} t/s</span>
    `;
    const footerEl = statsEl.closest('.message-footer');
    footerEl?.classList.remove('hidden');
    footerEl?.classList.remove('hover-time-only');
}

function isMessageContainerNearBottom(threshold = 160) {
    const container = document.getElementById('message-container');
    if (!container) return false;
    return container.scrollHeight - container.scrollTop - container.clientHeight < threshold;
}

function keepMessageContainerPinnedToBottom(wasNearBottom) {
    if (!wasNearBottom) return;
    window.scrollMessagesToBottom?.();
}

function keepLatestCodeBlockPinned(root, wasNearBottom) {
    if (!wasNearBottom || !root) return;
    const codeBlocks = root.querySelectorAll('.code-block pre');
    const latest = codeBlocks[codeBlocks.length - 1];
    if (latest) latest.scrollTop = latest.scrollHeight;
}

function isMessageContentInDocument(messageContent) {
    return Boolean(messageContent && document.body.contains(messageContent));
}

window.refreshCurrentContextUsage = async function(sessionId = currentSessionId) {
    if (!sessionId || !window.updateContextUsage) return null;
    try {
        const res = await apiFetch(`${API_BASE}/sessions/${encodeURIComponent(sessionId)}/context`);
        const data = await res.json().catch(() => ({}));
        if (res.ok) {
            window.updateContextUsage(data.contextMeta || null);
            return data.contextMeta || null;
        }
    } catch (e) {
        console.warn('刷新上下文用量失败', e);
    }
    return null;
};

function createUploadProgress(label) {
    const area = document.getElementById('attachment-preview');
    if (!area) return { update() {}, close() {} };
    area.classList.remove('hidden');

    const card = document.createElement('div');
    card.className = 'upload-progress-card';
    card.innerHTML = `
        <div class="upload-progress-ring" style="--progress:0">
            <span>0%</span>
        </div>
        <div class="upload-progress-name">${escapeChatStatusHtml(label)}</div>
    `;
    area.prepend(card);

    return {
        update(percent) {
            const clamped = Math.max(0, Math.min(100, Math.round(percent)));
            card.querySelector('.upload-progress-ring')?.style.setProperty('--progress', clamped);
            const text = card.querySelector('.upload-progress-ring span');
            if (text) text.textContent = `${clamped}%`;
        },
        close() {
            card.remove();
            if (pendingAttachments.length === 0) renderAttachmentPreviews();
        }
    };
}

async function readChatErrorMessage(response) {
    const fallback = `服务器拒绝 (${response.status})`;
    const responseType = response.headers.get('content-type') || '';
    try {
        if (responseType.includes('application/json')) {
            const data = await response.json();
            const message = data.error?.message || data.error || data.message;
            return message ? String(message) : fallback;
        }
        const text = await response.text();
        return text ? text.slice(0, 300) : fallback;
    } catch (e) {
        return fallback;
    }
}

function confirmChatMcpUse() {
    const title = '允许调用能力库工具';
    const message = '能力库工具可能访问已保存的外部服务、数据库结构或数据库查询结果。数据库工具会继续受只读限制保护；确认后本浏览器会话内不再重复提醒。';
    return new Promise(resolve => {
        if (typeof window.showConfirm !== 'function') return resolve(window.confirm(message));
        window.showConfirm(title, message, () => resolve(true));
        const cancelBtn = document.getElementById('modal-confirm-cancel');
        const overlay = document.getElementById('confirm-container');
        const settleCancel = () => resolve(false);
        cancelBtn?.addEventListener('click', settleCancel, { once: true });
        overlay?.addEventListener('click', (event) => {
            if (event.target === overlay) settleCancel();
        }, { once: true });
    });
}

const CHAT_MCP_CONSENT_KEY = 'pivot_chat_mcp_consent_session';

function hasChatMcpConsent() {
    try {
        return sessionStorage.getItem(CHAT_MCP_CONSENT_KEY) === 'true';
    } catch (e) {
        return false;
    }
}

function rememberChatMcpConsent() {
    try {
        sessionStorage.setItem(CHAT_MCP_CONSENT_KEY, 'true');
    } catch (e) {
        // 忽略浏览器存储限制，当前这次确认仍然有效。
    }
}

async function ensureChatMcpConsent() {
    if (hasChatMcpConsent()) return true;
    const confirmed = await confirmChatMcpUse();
    if (confirmed) rememberChatMcpConsent();
    return confirmed;
}

window.confirmChatMcpUse = confirmChatMcpUse;
window.hasChatMcpConsent = hasChatMcpConsent;
window.ensureChatMcpConsent = ensureChatMcpConsent;

function isChatToolEnabled(id, storageKey) {
    const button = document.getElementById(id);
    const wrapper = button?.closest?.('.chat-tool-toggle');
    const stateNode = wrapper || button;
    if (button?.dataset.enabled === 'true' || stateNode?.dataset.enabled === 'true') return true;
    if (button?.dataset.enabled === 'false' || stateNode?.dataset.enabled === 'false') return false;
    if (button?.getAttribute('aria-pressed') === 'true' || stateNode?.getAttribute('aria-pressed') === 'true') return true;
    if (button?.getAttribute('aria-pressed') === 'false' || stateNode?.getAttribute('aria-pressed') === 'false') return false;
    if (typeof button?.checked === 'boolean') return button.checked;
    return localStorage.getItem(storageKey) === 'true';
}

function shouldAutoEnableMcpForPrompt(value = '') {
    const text = String(value || '').toLowerCase();
    if (!text.trim()) return false;
    const hasDataSource = /数据库|数据表|表中|表里|table[_a-z0-9]*|select\s|from\s+\w+|group\s+by|order\s+by|db\.|sql/i.test(text);
    const hasDataAction = /查询|统计|分组|汇总|数量|计数|分布|排行|排名|count|sum|avg|group|字段|列|column/i.test(text);
    const hasVisualAction = /图表|柱状图|折线图|饼图|面积图|可视化|画图|绘图|chart|plot|graph/i.test(text);
    return hasDataSource && (hasDataAction || hasVisualAction);
}

function activateChatMcpToggle() {
    const button = document.getElementById('chat-mcp-enabled');
    window.setChatToolToggleState?.(button, true);
    try {
        localStorage.setItem('pivot_chat_mcp_enabled', 'true');
    } catch (e) {
        // 忽略浏览器存储限制，本轮请求仍会携带启用状态。
    }
}

window.shouldAutoEnableMcpForPrompt = shouldAutoEnableMcpForPrompt;
window.activateChatMcpToggle = activateChatMcpToggle;

window.createSession = async function(title) {
    const res = await apiFetch(API_BASE + '/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title })
    });
    const session = await res.json();
    if (!res.ok || !session.id) {
        showToast(session.error || '创建会话失败', 'error');
        return null;
    }
    return session;
}

window.selectSession = async function(id, title, options = {}) {
    window.showMainWorkspace?.('chat');
    if (String(currentSessionId || '') !== String(id || '')) {
        clearPendingAttachments('已清空未发送附件，避免发送到错误会话');
    }
    currentSessionId = id;
    window.persistActiveChatSession?.(id);
    window.markActiveSessionInList?.(id);
    if (title) document.getElementById('current-title').innerText = title;
    
    const res = await apiFetch(API_BASE + `/sessions/${id}`);
    const data = await res.json();
    if (!res.ok) {
        if (options.restore) {
            currentSessionId = null;
            window.persistActiveChatSession?.('');
        }
        return;
    }
    
    const session = data.session;
    const messages = data.messages;
    if (window.updateContextUsage) window.updateContextUsage(data.contextMeta || null);
    
    if (session && session.title) document.getElementById('current-title').innerText = session.title;
    
    document.getElementById('message-container').innerHTML = '';
    messages
        .filter(m => m.role === 'user' || m.role === 'assistant')
        .forEach(m => appendMessage(m.role, m.content, m.id, {
            createdAt: m.created_at,
            costTime: m.cost_time,
            tps: m.tokens_per_sec,
            tokenCount: m.token_count,
            modelName: m.model_name || m.model_api_name || ''
        }));
    window.scrollMessagesToBottom?.();
    if (options.refreshSidebar && window.loadSessions) window.loadSessions();
}

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
        showToast?.('已为本轮启用能力库工具', 'info');
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

        const reader = response.body.getReader();
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
                    updateAssistantStatus(data.message || '正在处理能力库工具');
                    if (data.status === 'error') showToast(data.message || '能力库工具调用失败', 'warning');
                    return;
                }
                if (data.type === 'chart') {
                    return;
                }
                if (data.type === 'rag') {
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
        await apiFetch(API_BASE + '/chat/stats', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sessionId: requestSessionId, costTime: finalElapsed, tps: finalTps })
        });
        await window.refreshCurrentContextUsage?.(requestSessionId);

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
        document.getElementById('stop-btn').classList.add('hidden');
        document.getElementById('send-btn').classList.remove('hidden');
        currentAbortController = null;
    }
}

document.getElementById('file-input').addEventListener('change', async (e) => {
    const modelId = document.getElementById('model-selector').value;
    const model = (window._cachedModels || []).find(m => String(m.id) === String(modelId));
    if (!model || Number(model.supports_vision || 0) !== 1) {
        showToast('当前选中的模型不具备视觉或文档分析能力，无法上传附件', 'error');
        e.target.value = '';
        return;
    }

    const files = Array.from(e.target.files || []);
    if (files.length === 0) return;
    const maxAttachments = window.MAX_PENDING_ATTACHMENTS || 5;
    if (pendingAttachments.length >= maxAttachments) {
        showToast(`最多只能上传 ${maxAttachments} 个附件`, 'error');
        e.target.value = '';
        return;
    }
    if (!currentSessionId) {
        const s = await createSession('新对话');
        if (!s) return;
        currentSessionId = s.id;
        document.getElementById('current-title').innerText = s.title;
        window.loadSessions();
    }
    const batchSessionId = String(currentSessionId || '');
    const uploadChatFile = async (file, uploadSessionId, password = '', onProgress = null) => {
        const fd = new FormData();
        fd.append('file', file);
        if (password) fd.append('password', password);
        return new Promise((resolve, reject) => {
            const xhr = new XMLHttpRequest();
            xhr.open('POST', `${API_BASE}/upload?sessionId=${encodeURIComponent(uploadSessionId)}`);
            Object.entries(authHeaders()).forEach(([key, value]) => xhr.setRequestHeader(key, value));
            xhr.upload.onprogress = (event) => {
                if (event.lengthComputable && typeof onProgress === 'function') {
                    onProgress((event.loaded / event.total) * 100);
                }
            };
            xhr.onload = () => {
                let data = {};
                try {
                    data = JSON.parse(xhr.responseText || '{}');
                } catch (e) {
                    data = { error: xhr.responseText || 'Upload failed' };
                }
                if (xhr.status >= 200 && xhr.status < 300) {
                    resolve(data);
                    return;
                }
                const err = new Error(data.error || `Upload failed (${xhr.status})`);
                err.data = data;
                reject(err);
            };
            xhr.onerror = () => reject(new Error('上传连接失败'));
            xhr.send(fd);
        });
    };
    try {
        let uploadedCount = 0;
        let skippedCount = 0;
        let sessionSwitchedDuringUpload = false;
        showToast(files.length > 1 ? `正在上传 ${files.length} 个文件...` : '正在上传...', 'info');
        for (const file of files) {
            const uploadSessionId = batchSessionId;
            if (String(currentSessionId || '') !== uploadSessionId) {
                skippedCount += 1;
                sessionSwitchedDuringUpload = true;
                continue;
            }
            if (pendingAttachments.length >= maxAttachments) {
                skippedCount += 1;
                continue;
            }
            const selectedIsImage = isChatImageAttachment(file);
            const hasPendingImage = pendingAttachments.some(item => isChatImageAttachment(item));
            if (selectedIsImage && hasPendingImage) {
                skippedCount += 1;
                continue;
            }

            let data;
            const progress = createUploadProgress(file.name);
            try {
                data = await uploadChatFile(file, uploadSessionId, '', percent => progress.update(percent));
            } catch (uploadErr) {
                if (uploadErr.data?.passwordRequired) {
                    progress.close();
                    const password = await window.showInputPrompt({
                        title: '文档密码',
                        message: `文档 ${file.name} 已加密，请输入文档密码。`,
                        type: 'password',
                        placeholder: '文档密码',
                        autocomplete: 'off',
                        trim: false
                    });
                    if (!password) {
                        skippedCount += 1;
                        continue;
                    }
                    const retryProgress = createUploadProgress(file.name);
                    data = await uploadChatFile(file, uploadSessionId, password, percent => retryProgress.update(percent));
                    retryProgress.close();
                } else {
                    progress.close();
                    throw uploadErr;
                }
            }
            progress.close();

            if (data.url) {
                if (String(currentSessionId || '') !== uploadSessionId || String(data.sessionId || uploadSessionId) !== uploadSessionId) {
                    skippedCount += 1;
                    sessionSwitchedDuringUpload = true;
                    continue;
                }
                const attachmentType = data.type || (selectedIsImage ? 'image/jpeg' : file.type);
                pendingAttachments.push({
                    name: data.name,
                    url: data.url,
                    type: attachmentType,
                    sessionId: data.sessionId || uploadSessionId,
                    extractedText: data.extractedText,
                    markdown: buildAttachmentMarkdown(data.name, data.url, isChatImageAttachment({ name: data.name, url: data.url, type: attachmentType }))
                });
                uploadedCount += 1;
                (data.visionAttachments || []).forEach(item => {
                    if (pendingAttachments.length >= maxAttachments) return;
                    if (pendingAttachments.some(entry => isChatImageAttachment(entry))) return;
                    pendingAttachments.push({
                        name: item.name,
                        url: item.url,
                        type: item.type || 'image/png',
                        sessionId: item.sessionId || data.sessionId || currentSessionId,
                        extractedText: '',
                        markdown: item.markdown || buildAttachmentMarkdown(item.name, item.url, true)
                    });
                });
                syncPendingAttachmentsGlobal();
                renderAttachmentPreviews();
            }
        }
        if (sessionSwitchedDuringUpload) showToast('会话已切换，刚上传的附件不会加入当前输入框', 'info');
        if (uploadedCount > 0) showToast(skippedCount > 0 ? `已上传 ${uploadedCount} 个，跳过 ${skippedCount} 个` : '上传成功');
        else if (skippedCount > 0) showToast('没有可上传的文件：最多 5 个附件，且图片每次仅 1 张', 'error');
    } catch (e) { showToast(e.message || '上传失败', 'error'); }
    e.target.value = '';
});

window.removeAttachment = (index) => {
    pendingAttachments.splice(index, 1);
    syncPendingAttachmentsGlobal();
    renderAttachmentPreviews();
};

window.saveMyDefaultModel = async (modelId = undefined, btn = null) => {
    const targetModelId = (modelId === undefined) ? document.getElementById('model-selector')?.value : modelId;
    if (btn) {
        btn.innerText = targetModelId ? '取消默认' : '设为默认';
        btn.style.borderColor = targetModelId ? 'var(--danger)' : 'var(--primary)';
        btn.style.color = targetModelId ? 'var(--danger)' : 'var(--primary)';
    }
    if (targetModelId === undefined) return;
    try {
        const res = await apiFetch(`${API_BASE}/settings/default-model`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ default_model_id: targetModelId }) });
        if (res.ok) {
            showToast(targetModelId ? '已设为默认模型' : '已取消默认设置');
            const selector = document.getElementById('model-selector');
            if (selector) selector.value = targetModelId;
        }
    } catch (e) { showToast('设置失败', 'error'); }
};
