// --- 对话会话引擎模块 ---
let sessionSelectionSequence = 0;

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

async function selectSession(id, title, options = {}) {
    const selectionSequence = ++sessionSelectionSequence;
    const requestedSessionId = String(id || '');
    const isCurrentSelection = () => (
        selectionSequence === sessionSelectionSequence
        && String(currentSessionId || '') === requestedSessionId
    );
    window.showMainWorkspace?.('chat');
    if (String(currentSessionId || '') !== requestedSessionId) {
        clearPendingAttachments('已清空未发送附件，避免发送到错误会话');
    }
    currentSessionId = id;
    window.persistActiveChatSession?.(id);
    window.markActiveSessionInList?.(id);
    if (title) document.getElementById('current-title').innerText = title;

    let data = null;
    try {
        const res = await apiFetch(API_BASE + `/sessions/${id}?messageLimit=60`);
        // 会话切换是异步的；旧请求晚返回时不能覆盖用户刚选中的会话。
        if (!isCurrentSelection()) return;
        if (!res.ok) {
            if (options.restore || res.status === 404) {
                currentSessionId = null;
                window.persistActiveChatSession?.('');
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
            window.persistActiveChatSession?.('');
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
    if (window.updateContextUsage) window.updateContextUsage(data.contextMeta || null);

    if (session && session.title) document.getElementById('current-title').innerText = session.title;

    const messageVirtualizer = window.Pivot?.modules?.['chat.messageVirtualizer'];
    if (messageVirtualizer) {
        messageVirtualizer.start({ sessionId: id, records: messages, page: data.page });
        if (options.refreshSidebar) window.Pivot.moduleApi('chat.sidebar').loadSessions?.();
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
                modelName: m.model_name || m.model_api_name || ''
            }, { target: fragment, deferRender: true });
            if (m.role === 'assistant' && contentEl) assistantContentNodes.push(contentEl);
        });
    container.appendChild(fragment);
    assistantContentNodes.forEach(node => window.renderPivotCharts?.(node));
    window.scrollMessagesToBottom?.({ duration: 2400 });
    setTimeout(() => window.scrollMessagesToBottom?.({ duration: 900 }), 320);
    if (options.refreshSidebar) window.Pivot.moduleApi('chat.sidebar').loadSessions?.();
}


window.Pivot.exposeModule('chat.sessions', {
    createSession,
    selectSession
}, ['createSession', 'selectSession']);
