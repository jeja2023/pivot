// --- 数据引擎模块 Engine ---
let currentAbortController = null;
let pendingAttachments = [];
const MAX_PENDING_ATTACHMENTS = 5;
window.MAX_PENDING_ATTACHMENTS = MAX_PENDING_ATTACHMENTS;

const escapeChatStatusHtml = (value) => String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const STREAM_RENDER_INTERVAL_MS = 80;

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
        existingThoughtContent.innerHTML = renderMarkdown(content.replace(/^<thought>/, ''));
        if (existingThoughtContent.closest('.thought-block')?.classList.contains('is-open')) {
            const inner = existingThoughtContent.closest('.thought-content-inner');
            inner.scrollTop = inner.scrollHeight;
        }
    } else {
        const thoughtState = rememberThoughtStateBeforeRender(textBody);
        textBody.innerHTML = renderAiMessage(content, true, thoughtState.openStates);
        restoreThoughtStateAfterRender(textBody, thoughtState);
    }
    window.renderPivotCharts?.(textBody);

    const elapsed = (Date.now() - startTime) / 1000;
    const tps = firstTokenTime ? (tokenCount / ((Date.now() - firstTokenTime) / 1000)).toFixed(1) : 0;
    statsEl.innerHTML = `
        <span class="stat-item">${ICONS.time}${elapsed.toFixed(1)}s</span>
        <span class="stat-item">${ICONS.token}${tokenCount} Tokens</span>
        <span class="stat-item">${ICONS.speed}${tps} t/s</span>
    `;
}

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
    const title = '允许调用 MCP 工具';
    const message = 'MCP 可能访问已保存的外部服务、数据库结构或数据库查询结果。数据库工具会继续受只读限制保护；确认后本浏览器会话内不再重复提醒。';
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
    currentSessionId = id;
    window.markActiveSessionInList?.(id);
    if (title) document.getElementById('current-title').innerText = title;
    
    const res = await apiFetch(API_BASE + `/sessions/${id}`);
    const data = await res.json();
    if (!res.ok) return;
    
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
            tokenCount: m.token_count
        }));
    window.scrollMessagesToBottom?.();
    if (options.refreshSidebar && window.loadSessions) window.loadSessions();
}

window.sendMessage = async function(isRegenerate = false) {
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
    
    if (!content && pendingAttachments.length === 0 && !isRegenerate) return;

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

    const ragEnabled = isChatToolEnabled('chat-rag-enabled', 'pivot_chat_rag_enabled');
    const mcpEnabled = isChatToolEnabled('chat-mcp-enabled', 'pivot_chat_mcp_enabled');
    let mcpConfirmed = false;
    if (mcpEnabled) {
        mcpConfirmed = await ensureChatMcpConsent();
        if (!mcpConfirmed) return;
    }

    document.getElementById('user-input').value = '';
    if (window.resizeUserInput) window.resizeUserInput();
    pendingAttachments = [];
    renderAttachmentPreviews();

    if (!currentSessionId) {
        const data = await createSession(content.slice(0, 15) + '...');
        if (data && data.id) {
            currentSessionId = data.id;
            if (window.loadSessions) window.loadSessions();
            document.getElementById('current-title').innerText = data.title;
        } else return;
    }

    if (!isRegenerate) {
        appendMessage('user', displayContent, null, { createdAt: new Date() });
    }
    const aiMsgEl = appendMessage('assistant', '...', null, { createdAt: new Date() });
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

    document.getElementById('send-btn').classList.add('hidden');
    document.getElementById('stop-btn').classList.remove('hidden');
    currentAbortController = new AbortController();

    try {
        const response = await apiFetch(API_BASE + '/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Accept': 'text/event-stream' },
            body: JSON.stringify({
                sessionId: currentSessionId,
                content,
                displayContent: stripInternalReferenceText(displayContent || content),
                modelId,
                regenerate: isRegenerate,
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
            if (textBody) textBody.innerHTML = renderAiMessage(fullAiContent, false);
            window.scrollMessagesToBottom?.();
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
        let renderTimer = null;
        let renderPending = false;
        const scheduleStreamRender = () => {
            if (renderPending) return;
            renderPending = true;
            renderTimer = setTimeout(() => {
                renderPending = false;
                renderTimer = null;
                renderStreamingAssistantContent(textBody, statsEl, fullAiContent, tokenCount, startTime, firstTokenTime);
            }, STREAM_RENDER_INTERVAL_MS);
        };
        const flushStreamRender = () => {
            if (renderTimer) clearTimeout(renderTimer);
            renderPending = false;
            renderTimer = null;
            renderStreamingAssistantContent(textBody, statsEl, fullAiContent, tokenCount, startTime, firstTokenTime);
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
                    updateAssistantStatus(data.message || '正在处理 MCP 工具');
                    if (data.status === 'error') showToast(data.message || 'MCP 工具调用失败', 'warning');
                    return;
                }
                if (data.error) throw new Error(data.detail || data.error);
                if (data.content) {
                    if (!firstTokenTime) firstTokenTime = Date.now();
                    fullAiContent += data.content;
                    const chineseChars = (fullAiContent.match(/[\u4e00-\u9fa5]/g) || []).length;
                    tokenCount = Math.ceil(chineseChars * 2 + (fullAiContent.length - chineseChars) * 0.5);
                    scheduleStreamRender();
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
            const container = document.getElementById('message-container');
            if (container.scrollHeight - container.scrollTop - container.clientHeight < 120) container.scrollTop = container.scrollHeight;
        }
        flushStreamRender();
        window.scrollMessagesToBottom?.();

        const finalElapsed = (Date.now() - startTime) / 1000;
        const finalTps = firstTokenTime ? (tokenCount / ((Date.now() - firstTokenTime) / 1000)).toFixed(1) : 0;
        await apiFetch(API_BASE + '/chat/stats', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sessionId: currentSessionId, costTime: finalElapsed, tps: finalTps })
        });
        
        // 延迟刷新侧边栏，等待后台标题生成完成
        setTimeout(() => {
            if (window.loadSessions) window.loadSessions();
        }, 1500);
    } catch (e) {
        if (e.name === 'AbortError') {
            fullAiContent += '\n\n[已由用户中断生成]';
            textBody.innerHTML = renderAiMessage(fullAiContent);
            window.scrollMessagesToBottom?.();
        } else {
            updateAssistantStatus(e.message, 'error');
            window.scrollMessagesToBottom?.();
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
    const uploadChatFile = async (file, password = '', onProgress = null) => {
        const fd = new FormData();
        fd.append('file', file);
        if (password) fd.append('password', password);
        return new Promise((resolve, reject) => {
            const xhr = new XMLHttpRequest();
            xhr.open('POST', `${API_BASE}/upload?sessionId=${encodeURIComponent(currentSessionId)}`);
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
        showToast(files.length > 1 ? `正在上传 ${files.length} 个文件...` : '正在上传...', 'info');
        for (const file of files) {
            if (pendingAttachments.length >= maxAttachments) {
                skippedCount += 1;
                continue;
            }
            const hasPendingImage = pendingAttachments.some(item => String(item.type || '').startsWith('image/'));
            const selectedIsImage = String(file.type || '').startsWith('image/');
            if (selectedIsImage && hasPendingImage) {
                skippedCount += 1;
                continue;
            }

            let data;
            const progress = createUploadProgress(file.name);
            try {
                data = await uploadChatFile(file, '', percent => progress.update(percent));
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
                    data = await uploadChatFile(file, password, percent => retryProgress.update(percent));
                    retryProgress.close();
                } else {
                    progress.close();
                    throw uploadErr;
                }
            }
            progress.close();

            if (data.url) {
                pendingAttachments.push({ name: data.name, url: data.url, type: file.type, extractedText: data.extractedText, markdown: file.type.startsWith('image/') ? `![${data.name}](${data.url})` : `[附件: ${data.name}](${data.url})` });
                uploadedCount += 1;
                (data.visionAttachments || []).forEach(item => {
                    if (pendingAttachments.length >= maxAttachments) return;
                    if (pendingAttachments.some(entry => String(entry.type || '').startsWith('image/'))) return;
                    pendingAttachments.push({ name: item.name, url: item.url, type: 'image/png', extractedText: '', markdown: item.markdown || `![${item.name}](${item.url})` });
                });
                renderAttachmentPreviews();
            }
        }
        if (uploadedCount > 0) showToast(skippedCount > 0 ? `已上传 ${uploadedCount} 个，跳过 ${skippedCount} 个` : '上传成功');
        else if (skippedCount > 0) showToast('没有可上传的文件：最多 5 个附件，且图片每次仅 1 张', 'error');
    } catch (e) { showToast(e.message || '上传失败', 'error'); }
    e.target.value = '';
});

window.removeAttachment = (index) => { pendingAttachments.splice(index, 1); renderAttachmentPreviews(); };

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
