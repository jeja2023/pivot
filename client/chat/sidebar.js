// --- 侧边栏模块 Sidebar (完整功能版) ---
let sidebarState = { page: 1, limit: 20, cursor: '', hasMore: true, isLoading: false, archived: false };
const sessionMenuData = new Map();
const selectedSessionIds = new Set();
let sessionBatchMode = false;

function ensureSessionTagTools() {
    const controls = document.querySelector('.sidebar-ctrls');
    if (!controls) return;
    if (!document.getElementById('session-batch-toggle')) {
        const toggle = document.createElement('button');
        toggle.type = 'button';
        toggle.id = 'session-batch-toggle';
        toggle.className = 'session-batch-toggle';
        toggle.dataset.sessionBatchToggle = '1';
        toggle.textContent = '批量';
        controls.appendChild(toggle);
    }
    if (document.getElementById('session-tag-tools')) return;
    const tools = document.createElement('div');
    tools.id = 'session-tag-tools';
    tools.className = 'session-tag-tools';
    tools.innerHTML = `
        <div id="session-tag-summary" class="session-tag-summary hidden"></div>
        <div id="session-batch-tags" class="session-batch-tags hidden">
            <span id="session-batch-count">已选择 0 个</span>
            <button type="button" data-session-batch-action="add">添加标签</button>
            <button type="button" data-session-batch-action="remove">移除标签</button>
            <button type="button" data-session-batch-action="replace">替换标签</button>
            <button type="button" data-session-batch-action="clear">取消选择</button>
            <button type="button" data-session-batch-action="done">完成</button>
        </div>
    `;
    controls.insertAdjacentElement('afterend', tools);
}

async function loadSessionTagSummary() {
    ensureSessionTagTools();
    const target = document.getElementById('session-tag-summary');
    if (!target) return;
    try {
        const res = await apiFetch(`${API_BASE}/sessions/tags/summary?includeArchived=true`);
        if (!res.ok) return;
        const data = await res.json();
        const rows = (data.data || []).slice(0, 12);
        target.classList.toggle('hidden', rows.length === 0);
        target.innerHTML = rows.map(row => `
            <span class="tag-summary-chip" title="${escapeAttrValue(`${row.count} 个会话`)}">
                <button type="button" class="tag-chip-main" data-session-tag-filter="${escapeAttrValue(row.tag)}">#${escapeHtml(row.tag)}<small>${Number(row.count || 0)}</small></button>
                <button type="button" class="tag-chip-action" data-session-tag-rename="${escapeAttrValue(row.tag)}" title="重命名标签">改</button>
                <button type="button" class="tag-chip-action danger" data-session-tag-remove="${escapeAttrValue(row.tag)}" title="删除标签">删</button>
            </span>
        `).join('');
    } catch (e) {
        console.warn('Failed to load tag summary', e);
    }
}

function setSessionBatchMode(enabled) {
    sessionBatchMode = Boolean(enabled);
    if (!sessionBatchMode) selectedSessionIds.clear();
    updateSessionBatchBar();
}

function updateSessionBatchBar() {
    ensureSessionTagTools();
    const bar = document.getElementById('session-batch-tags');
    const count = document.getElementById('session-batch-count');
    const list = document.getElementById('session-list');
    const toggle = document.getElementById('session-batch-toggle');
    if (!bar || !count) return;
    count.textContent = `已选择 ${selectedSessionIds.size} 个`;
    bar.classList.toggle('hidden', !sessionBatchMode);
    list?.classList.toggle('session-batch-mode', sessionBatchMode);
    toggle?.classList.toggle('active', sessionBatchMode);
    if (toggle) toggle.textContent = sessionBatchMode ? '退出' : '批量';
    bar.querySelectorAll('[data-session-batch-action="add"], [data-session-batch-action="remove"], [data-session-batch-action="replace"]').forEach(button => {
        button.disabled = selectedSessionIds.size === 0;
    });
    document.querySelectorAll('[data-session-select-id]').forEach(input => {
        input.checked = selectedSessionIds.has(String(input.dataset.sessionSelectId || ''));
        input.closest('.session-item')?.classList.toggle('selected', input.checked);
    });
}

async function runBatchTagAction(operation) {
    if (operation === 'done') {
        setSessionBatchMode(false);
        return;
    }
    if (operation === 'clear') {
        selectedSessionIds.clear();
        updateSessionBatchBar();
        return;
    }
    if (selectedSessionIds.size === 0) return;
    const tags = await window.showInputPrompt?.({
        title: operation === 'add' ? '添加标签' : (operation === 'remove' ? '移除标签' : '替换标签'),
        message: '多个标签请用逗号分隔',
        placeholder: '项目A, 紧急'
    });
    if (!tags) return;
    const res = await apiFetch(`${API_BASE}/sessions/tags/batch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionIds: [...selectedSessionIds], operation, tags })
    });
    if (res.ok) {
        selectedSessionIds.clear();
        await window.loadSessions();
        await loadSessionTagSummary();
        setSessionBatchMode(false);
        showToast('标签已更新');
    }
}

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
    ensureSessionTagTools();
    
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
            div.className = `session-item ${s.id === currentSessionId ? 'active' : ''} ${s.is_pinned ? 'pinned' : ''} ${selectedSessionIds.has(String(s.id)) ? 'selected' : ''}`;
            div.dataset.sessionId = String(s.id);
            sessionMenuData.set(String(s.id), {
                id: String(s.id),
                title,
                isPinned: Number(s.is_pinned || 0),
                isArchived: Number(s.is_archived || 0),
                tags: String(s.tags || '')
            });
            const checked = selectedSessionIds.has(String(s.id)) ? 'checked' : '';
            div.innerHTML = `
                <label class="session-select-box">
                    <input type="checkbox" data-session-select-id="${escapeAttrValue(String(s.id))}" ${checked} aria-label="选择会话">
                </label>
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
            list.appendChild(div);
        });
        
        sidebarState.hasMore = hasMore;
        sidebarState.cursor = result.nextCursor || '';
        sidebarState.page++;
        updateSessionBatchBar();
        if (!append) await loadSessionTagSummary();
        updateSessionListStatus(hasMore ? '' : (sessions.length ? '已加载全部' : '暂无会话'));
    } catch (e) { console.error('加载会话失败:', e); }
    finally { sidebarState.isLoading = false; }
};

document.getElementById('session-list')?.addEventListener('click', (event) => {
    const selector = event.target.closest('[data-session-select-id]');
    if (selector) {
        event.stopPropagation();
        const id = String(selector.dataset.sessionSelectId || '');
        if (selector.checked) selectedSessionIds.add(id);
        else selectedSessionIds.delete(id);
        updateSessionBatchBar();
        return;
    }

    const button = event.target.closest('[data-session-menu-id]');
    if (button) {
        event.stopPropagation();
        const session = sessionMenuData.get(String(button.dataset.sessionMenuId));
        if (session) {
            window.toggleSessionMenu(event, session.id, session.title, session.isPinned, session.isArchived, session.tags);
        }
        return;
    }

    const item = event.target.closest('.session-item');
    if (item) {
        const id = item.dataset.sessionId;
        if (sessionBatchMode) {
            if (selectedSessionIds.has(String(id))) selectedSessionIds.delete(String(id));
            else selectedSessionIds.add(String(id));
            updateSessionBatchBar();
            return;
        }
        const session = sessionMenuData.get(String(id));
        if (session) {
            window.selectSession(session.id, session.title);
        }
    }
});

document.addEventListener('click', async (event) => {
    const batchToggle = event.target.closest('[data-session-batch-toggle]');
    if (batchToggle) {
        setSessionBatchMode(!sessionBatchMode);
        return;
    }

    const filter = event.target.closest('[data-session-tag-filter]');
    if (filter) {
        const tag = filter.dataset.sessionTagFilter || '';
        const input = document.getElementById('session-search-input');
        if (input) input.value = `#${tag}`;
        await window.loadSessions();
        return;
    }

    const rename = event.target.closest('[data-session-tag-rename]');
    if (rename) {
        const fromTag = rename.dataset.sessionTagRename || '';
        const toTag = await window.showInputPrompt?.({
            title: '重命名标签',
            message: fromTag,
            value: fromTag,
            placeholder: '新的标签名'
        });
        if (!toTag || toTag === fromTag) return;
        const res = await apiFetch(`${API_BASE}/sessions/tags/rename`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ fromTag, toTag })
        });
        if (res.ok) {
            await window.loadSessions();
            await loadSessionTagSummary();
            showToast('标签已重命名');
        }
        return;
    }

    const remove = event.target.closest('[data-session-tag-remove]');
    if (remove) {
        const tag = remove.dataset.sessionTagRemove || '';
        showConfirm('删除标签', `确定从所有会话中移除标签「${tag}」吗？`, async () => {
            const res = await apiFetch(`${API_BASE}/sessions/tags/remove`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ tag })
            });
            if (res.ok) {
                await window.loadSessions();
                await loadSessionTagSummary();
                showToast('标签已删除');
            }
        });
        return;
    }

    const batch = event.target.closest('[data-session-batch-action]');
    if (batch) {
        await runBatchTagAction(batch.dataset.sessionBatchAction);
    }
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

    // 获取触发按钮的矩形区域
    const button = e.target.closest('[data-session-menu-id]');
    const rect = button ? button.getBoundingClientRect() : e.currentTarget.getBoundingClientRect();
    
    // 计算初始位置
    let top = rect.bottom + 5;
    let left = rect.right - 130; // 菜单宽度约 130px

    // 视口边界检查
    const menuHeight = 240; // 预估高度
    if (top + menuHeight > window.innerHeight) {
        top = rect.top - menuHeight - 5;
        if (top < 0) top = 10;
    }
    if (left < 10) left = 10;

    menu.style.top = `${top}px`;
    menu.style.left = `${left}px`;

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
