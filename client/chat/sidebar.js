// --- 侧边栏模块 Sidebar (完整功能版) ---
let sidebarState = { page: 1, limit: 20, cursor: '', hasMore: true, isLoading: false, archived: false };
const sessionMenuData = new Map();

window.markActiveSessionInList = function(id) {
    const activeId = String(id || '');
    document.querySelectorAll('#session-list .session-item').forEach(item => {
        item.classList.toggle('active', String(item.dataset.sessionId || '') === activeId);
    });
};

function updateSessionListStatus(text = '') {
    const list = document.getElementById('session-list');
    if (!list) return;
    let status = document.getElementById('session-list-status');
    if (!status) {
        status = document.createElement('div');
        status.id = 'session-list-status';
        status.className = 'session-list-status';
    }
    list.appendChild(status);
    status.textContent = text;
    status.classList.toggle('hidden', !text);
}

window.loadSessions = async function(append = false) {
    if (sidebarState.isLoading) return;
    
    const searchVal = document.getElementById('session-search-input')?.value || '';
    const tagMatch = searchVal.match(/#(\S+)/);
    const tag = tagMatch ? tagMatch[1] : '';
    const keyword = searchVal.replace(/#\S+/, '').trim();
    
    if (!append) {
        sidebarState.page = 1;
        sidebarState.cursor = '';
        sidebarState.hasMore = true;
    }
    if (!sidebarState.hasMore) return;
    
    sidebarState.isLoading = true;
    updateSessionListStatus(append ? '加载中...' : '');
    try {
        const params = new URLSearchParams({
            limit: sidebarState.limit,
            keyword,
            tag,
            archived: String(sidebarState.archived)
        });
        if (append && sidebarState.cursor) params.set('cursor', sidebarState.cursor);
        else params.set('page', sidebarState.page);
        const res = await apiFetch(`${API_BASE}/sessions?${params.toString()}`);
        
        const result = await res.json();
        const sessions = result.data || [];
        const hasMore = result.hasMore || false;
        
        const list = document.getElementById('session-list');
        if (!append) list.innerHTML = '';
        
        // 绑定无限滚动监听
        if (!list.dataset.boundLoadMore) {
            list.dataset.boundLoadMore = '1';
            list.addEventListener('scroll', () => {
                if (sidebarState.isLoading || !sidebarState.hasMore) return;
                if (list.scrollTop + list.clientHeight >= list.scrollHeight - 48) {
                    window.loadSessions(true);
                }
            }, { passive: true });
        }
        
        sessions.forEach(s => {
            const title = s.title || '新对话';
            const safeHTMLTitle = title.replace(/</g, "&lt;").replace(/>/g, "&gt;");
            const tagsHtml = String(s.tags || '').split(',').filter(Boolean).map(t => `<em>${escapeHtml(t)}</em>`).join('');
            const archiveBadge = s.is_archived ? '<span class="session-badge">已归档</span>' : '';
            const pinnedBadge = s.is_pinned ? '<span class="session-badge pinned-badge">置顶</span>' : '';
            const sessionRawTime = s.updated_at || s.created_at;
            const sessionListTime = window.formatSessionListTime ? window.formatSessionListTime(sessionRawTime) : '';
            const sessionTimeTitle = window.formatChatDateTime ? window.formatChatDateTime(sessionRawTime) : String(sessionRawTime || '');
            const msgCount = Number(s.msg_count || 0);
            const sessionInfoTitle = escapeAttrValue([safeHTMLTitle, sessionTimeTitle, msgCount ? `${msgCount} 条消息` : ''].filter(Boolean).join(' · '));
            
            const div = document.createElement('div');
            div.className = `session-item ${s.id === currentSessionId ? 'active' : ''} ${s.is_pinned ? 'pinned' : ''}`;
            div.dataset.sessionId = String(s.id);
            sessionMenuData.set(String(s.id), {
                id: String(s.id),
                title,
                isPinned: Number(s.is_pinned || 0),
                isArchived: Number(s.is_archived || 0),
                tags: String(s.tags || '')
            });
            div.innerHTML = `
                <div class="session-main" title="${sessionInfoTitle}">
                    <div class="session-title-row">
                        <span class="session-title-text">
                            ${pinnedBadge}${archiveBadge}${tagsHtml ? `<span class="session-tags-inline">${tagsHtml}</span>` : ''}
                            <span class="session-title-content">${safeHTMLTitle}</span>
                        </span>
                    </div>
                </div>
                <div class="session-side">
                    <span class="session-list-time" title="${escapeAttrValue(sessionTimeTitle)}">${escapeHtml(sessionListTime)}</span>
                    <div class="session-more">
                    <button class="more-btn" data-session-menu-id="${escapeAttrValue(String(s.id))}">
                        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="5" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="12" cy="19" r="1.5"/></svg>
                    </button>
                    </div>
                </div>
            `;
            div.onclick = () => selectSession(s.id, title);
            list.appendChild(div);
        });
        
        sidebarState.hasMore = hasMore;
        sidebarState.cursor = result.nextCursor || '';
        sidebarState.page++;
        updateSessionListStatus(hasMore ? '' : (sessions.length ? '已加载全部' : '暂无会话'));
    } catch (e) { console.error('加载会话失败:', e); }
    finally { sidebarState.isLoading = false; }
};

document.getElementById('session-list')?.addEventListener('click', (event) => {
    const button = event.target.closest('[data-session-menu-id]');
    if (!button) return;
    const session = sessionMenuData.get(String(button.dataset.sessionMenuId));
    if (!session) return;
    window.toggleSessionMenu(event, session.id, session.title, session.isPinned, session.isArchived, session.tags);
});

window.toggleSessionMenu = (e, id, title, isPinned, isArchived, tags) => {
    e.stopPropagation();
    document.querySelector('.session-dropdown')?.remove();
    const menu = document.createElement('div');
    menu.className = 'session-dropdown';
    const makeItem = (label, className, handler) => {
        const item = document.createElement('div');
        item.className = className ? `menu-item ${className}` : 'menu-item';
        item.textContent = label;
        item.addEventListener('click', (event) => {
            event.stopPropagation();
            menu.remove();
            handler();
        });
        menu.appendChild(item);
    };
    makeItem(isPinned ? '取消置顶' : '置顶对话', '', () => togglePinSession(id, isPinned));
    makeItem('重命名', '', () => renameSession(id, title));
    makeItem('编辑标签', '', () => editSessionTags(id, tags));
    makeItem(isArchived ? '恢复对话' : '归档对话', '', () => toggleArchiveSession(id, isArchived));
    makeItem('导出为 Markdown', '', () => exportSession(id));
    makeItem('删除', 'danger', () => deleteSession(id));
    document.body.appendChild(menu);
    const rect = e.currentTarget.getBoundingClientRect();
    menu.style.top = `${rect.bottom + 5}px`; menu.style.left = `${rect.right - 120}px`;
    const close = () => { menu.remove(); document.removeEventListener('click', close); };
    setTimeout(() => document.addEventListener('click', close), 0);
};

window.toggleSidebar = () => document.querySelector('.sidebar').classList.toggle('collapsed');
window.setArchiveFilter = (archived) => { 
    sidebarState.archived = archived; 
    document.getElementById('session-active-filter').classList.toggle('active', !archived);
    document.getElementById('session-archive-filter').classList.toggle('active', archived);
    window.loadSessions(); 
};

window.togglePinSession = async (id, currentPinned) => {
    const res = await apiFetch(`${API_BASE}/sessions/${id}/pin`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ isPinned: !currentPinned }) });
    if (res.ok) { showToast(!currentPinned ? '已置顶' : '已取消置顶'); await window.loadSessions(); }
};

window.toggleArchiveSession = async (id, currentArchived) => {
    const res = await apiFetch(`${API_BASE}/sessions/${id}/archive`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ isArchived: !currentArchived }) });
    if (res.ok) {
        showToast(!currentArchived ? '已归档' : '已恢复');
        if (currentSessionId === id && !sidebarState.archived) {
            currentSessionId = null;
            document.getElementById('current-title').innerText = '请选择或新建对话';
            document.getElementById('message-container').innerHTML = '';
        }
        await window.loadSessions();
    }
};
