// --- 数据引擎模块 Engine (完整功能版) ---
let currentAbortController = null;
let pendingAttachments = [];
const MAX_PENDING_ATTACHMENTS = 5;
window.MAX_PENDING_ATTACHMENTS = MAX_PENDING_ATTACHMENTS;

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

window.selectSession = async function(id, title) {
    currentSessionId = id;
    if (title) document.getElementById('current-title').innerText = title;
    
    const res = await apiFetch(API_BASE + `/sessions/${id}`);
    const data = await res.json();
    if (!res.ok) return;
    
    const session = data.session;
    const messages = data.messages;
    
    if (session && session.title) document.getElementById('current-title').innerText = session.title;
    
    document.getElementById('message-container').innerHTML = '';
    messages
        .filter(m => m.role === 'user' || m.role === 'assistant')
        .forEach(m => appendMessage(m.role, m.content, m.id, {
            costTime: m.cost_time,
            tps: m.tokens_per_sec,
            tokenCount: m.token_count
        }));
    if (window.loadSessions) window.loadSessions();
}

window.sendMessage = async function(isRegenerate = false) {
    const userVisibleContent = document.getElementById('user-input').value.trim();
    let content = userVisibleContent;
    let displayContent = userVisibleContent;
    const modelId = document.getElementById('model-selector').value;
    
    if (!content && pendingAttachments.length === 0 && !isRegenerate) return;

    if (pendingAttachments.length > 0) {
        const attachmentLinks = pendingAttachments.map(a => a.markdown).join('\n');
        content = (content ? content + '\n\n' : '') + attachmentLinks;
        displayContent = (displayContent ? displayContent + '\n\n' : '') + attachmentLinks;
        const docTexts = pendingAttachments.filter(a => a.extractedText).map(a => `\n\n---\n【参考文档: ${a.name}】\n${a.extractedText}\n---`).join('');
        if (docTexts) content += docTexts;
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
        appendMessage('user', displayContent);
    }
    const aiMsgEl = appendMessage('assistant', '...');
    let fullAiContent = '';
    let tokenCount = 0;
    let startTime = Date.now();
    let firstTokenTime = null;

    document.getElementById('send-btn').classList.add('hidden');
    document.getElementById('stop-btn').classList.remove('hidden');
    currentAbortController = new AbortController();

    try {
        const response = await apiFetch(API_BASE + '/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Accept': 'text/event-stream' },
            body: JSON.stringify({ sessionId: currentSessionId, content, displayContent: stripInternalReferenceText(displayContent || content), modelId, regenerate: isRegenerate }),
            signal: currentAbortController.signal
        });

        if (!response.ok) throw new Error(`服务器拒绝 (${response.status})`);

        const responseType = response.headers.get('content-type') || '';
        if (responseType.includes('application/json')) {
            const data = await response.json();
            fullAiContent = data.content || data.error || '';
            const textBody = aiMsgEl.querySelector('.text-body');
            if (textBody) textBody.innerHTML = renderAiMessage(fullAiContent, false);
            if (window.loadSessions) window.loadSessions();
            return;
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let sseBuffer = '';
        const textBody = aiMsgEl.querySelector('.text-body');
        const statsEl = aiMsgEl.querySelector('.message-stats') || document.createElement('div');
        statsEl.className = 'message-stats';
        if (!aiMsgEl.querySelector('.message-stats')) aiMsgEl.appendChild(statsEl);

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            sseBuffer += decoder.decode(value, { stream: true });
            const lines = sseBuffer.split('\n');
            sseBuffer = lines.pop() || '';
            for (const line of lines) {
                const cleanLine = line.trim();
                if (cleanLine.startsWith('data: ')) {
                    if (cleanLine === 'data: [DONE]') break;
                    try {
                        const data = JSON.parse(cleanLine.replace(/^data:\s*/, ''));
                        if (data.error) throw new Error(data.detail || data.error);
                        if (data.content) {
                            if (!firstTokenTime) firstTokenTime = Date.now();
                            fullAiContent += data.content;
                            const chineseChars = (fullAiContent.match(/[\u4e00-\u9fa5]/g) || []).length;
                            tokenCount = Math.ceil(chineseChars * 2 + (fullAiContent.length - chineseChars) * 0.5);
                            
                            const hasOpenThought = fullAiContent.includes('<thought>') && !fullAiContent.includes('</thought>');
                            const existingThoughtContent = textBody.querySelector('.thought-block.thinking .thought-content');
                            
                            if (hasOpenThought && existingThoughtContent) {
                                existingThoughtContent.innerHTML = renderMarkdown(fullAiContent.replace(/^<thought>/, ''));
                                if (existingThoughtContent.closest('.thought-block')?.classList.contains('is-open')) {
                                    const inner = existingThoughtContent.closest('.thought-content-inner');
                                    inner.scrollTop = inner.scrollHeight;
                                }
                            } else {
                                const thoughtState = rememberThoughtStateBeforeRender(textBody);
                                textBody.innerHTML = renderAiMessage(fullAiContent, true, thoughtState.openStates);
                                restoreThoughtStateAfterRender(textBody, thoughtState);
                            }
                            
                            const elapsed = (Date.now() - startTime) / 1000;
                            const tps = firstTokenTime ? (tokenCount / ((Date.now() - firstTokenTime) / 1000)).toFixed(1) : 0;
                            statsEl.innerHTML = `
                                <span class="stat-item">${ICONS.time}${elapsed.toFixed(1)}s</span>
                                <span class="stat-item">${ICONS.token}${tokenCount} Tokens</span>
                                <span class="stat-item">${ICONS.speed}${tps} t/s</span>
                            `;
                        }
                    } catch (e) {}
                }
            }
            const container = document.getElementById('message-container');
            if (container.scrollHeight - container.scrollTop - container.clientHeight < 120) container.scrollTop = container.scrollHeight;
        }

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
            selectSession(currentSessionId);
        }, 1500);
    } catch (e) {
        if (e.name === 'AbortError') {
            fullAiContent += '\n\n[已由用户中断生成]';
            textBody.innerHTML = renderAiMessage(fullAiContent);
        } else {
            textBody.innerHTML = `<div class="error-detail">${e.message}</div>`;
        }
    } finally {
        document.getElementById('stop-btn').classList.add('hidden');
        document.getElementById('send-btn').classList.remove('hidden');
        currentAbortController = null;
    }
}

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
    } catch (e) { showToast('保存失败', 'error'); }
};
