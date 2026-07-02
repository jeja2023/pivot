// --- 对话会话引擎模块 ---
window.createSession = async function(title) {
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

window.selectSession = async function(id, title, options = {}) {
    window.showMainWorkspace?.('chat');
    if (String(currentSessionId || '') !== String(id || '')) {
        clearPendingAttachments('已清空未发送附件，避免发送到错误会话');
    }
    currentSessionId = id;
    window.persistActiveChatSession?.(id);
    window.markActiveSessionInList?.(id);
    if (title) document.getElementById('current-title').innerText = title;

    let data = null;
    try {
        const res = await apiFetch(API_BASE + `/sessions/${id}`);
        if (!res.ok) {
            if (options.restore) {
                currentSessionId = null;
                window.persistActiveChatSession?.('');
            }
            showToast('加载会话失败，请稍后重试', 'error');
            return;
        }
        data = await res.json();
    } catch (e) {
        console.error('加载会话失败', e);
        if (options.restore) {
            currentSessionId = null;
            window.persistActiveChatSession?.('');
        }
        showToast('加载会话失败，请稍后重试', 'error');
        return;
    }

    const session = data.session;
    const messages = data.messages;
    if (window.updateContextUsage) window.updateContextUsage(data.contextMeta || null);

    if (session && session.title) document.getElementById('current-title').innerText = session.title;

    const container = document.getElementById('message-container');
    container.innerHTML = '';
    // Build all messages into a fragment, append once, then render charts + scroll
    // once at the end to avoid O(n) reflows during session switch.
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
                modelName: m.model_name || m.model_api_name || ''
            }, { target: fragment, deferRender: true });
            if (m.role === 'assistant' && contentEl) assistantContentNodes.push(contentEl);
        });
    container.appendChild(fragment);
    assistantContentNodes.forEach(node => window.renderPivotCharts?.(node));
    window.scrollMessagesToBottom?.({ duration: 1200 });
    if (options.refreshSidebar && window.loadSessions) window.loadSessions();
}
