// --- 对话会话引擎模块 ---
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
