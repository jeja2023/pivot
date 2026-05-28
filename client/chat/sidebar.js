// --- 侧边栏模块 Sidebar (完整功能版) ---
let sidebarState = { page: 1, limit: 20, cursor: '', hasMore: true, isLoading: false, archived: false };
const sessionMenuData = new Map();
const selectedSessionIds = new Set();
let sessionBatchMode = false;
let sessionSearchArchived = false;
let sessionSearchTimer = null;

function sessionEscapeHtml(value) {
    if (window.PivotSafeHtml) return window.PivotSafeHtml.escapeHtml(value);
    return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function sessionEscapeAttr(value) {
    if (window.PivotSafeHtml) return window.PivotSafeHtml.escapeAttr(value);
    return sessionEscapeHtml(value).replace(/"/g, '&quot;');
}

function parseSessionSearchValue(value) {
    const raw = String(value || '').trim();
    const tagMatch = raw.match(/#(\S+)/);
    return {
        raw,
        tag: tagMatch ? tagMatch[1] : '',
        keyword: raw.replace(/#\S+/, '').trim()
    };
}

function getSessionSearchEls() {
    return {
        modal: document.getElementById('session-search-modal'),
        input: document.getElementById('session-search-modal-input'),
        results: document.getElementById('session-search-modal-results'),
        status: document.getElementById('session-search-modal-status'),
        activeTab: document.getElementById('session-search-modal-active'),
        archiveTab: document.getElementById('session-search-modal-archive'),
        openButton: document.getElementById('session-search-open')
    };
}

function setSessionSearchStatus(text = '') {
    const status = document.getElementById('session-search-modal-status');
    if (status) status.textContent = text;
}

function renderSessionSearchResults(sessions) {
    const { results } = getSessionSearchEls();
    if (!results) return;
    if (!sessions.length) {
        results.innerHTML = '<div class="session-search-empty">没有找到匹配的会话</div>';
        return;
    }
    results.innerHTML = sessions.map(s => {
        const title = s.title || '新对话';
        const sessionId = String(s.id);
        sessionMenuData.set(sessionId, {
            id: sessionId,
            title,
            isPinned: Number(s.is_pinned || 0),
            isArchived: Number(s.is_archived || 0),
            tags: String(s.tags || '')
        });
        const rawTime = s.updated_at || s.created_at;
        const timeText = window.formatSessionListTime ? window.formatSessionListTime(rawTime) : '';
        const timeTitle = window.formatChatDateTime ? window.formatChatDateTime(rawTime) : String(rawTime || '');
        const tagsHtml = String(s.tags || '').split(',').filter(Boolean).map(tag => `<em>${sessionEscapeHtml(tag)}</em>`).join('');
        const snippet = String(s.snippet || '').replace(/<\/?b>/g, '');
        const metaParts = [
            snippet
        ].filter(Boolean);
        const msgCount = Number(s.msg_count || 0);
        const checked = selectedSessionIds.has(String(s.id)) ? 'checked' : '';
        const selectedClass = checked ? ' selected' : '';
        return `
            <div class="session-search-result${selectedClass}"
                data-session-search-id="${sessionEscapeAttr(sessionId)}"
                data-session-search-title="${sessionEscapeAttr(title)}">
                <label class="session-search-select-box">
                    <input type="checkbox" data-session-select-id="${sessionEscapeAttr(sessionId)}" ${checked} aria-label="选择会话">
                </label>
                <button class="session-search-open-result" type="button">
                    <span>
                    <span class="session-search-title">
                        ${tagsHtml ? `<span class="session-tags-inline">${tagsHtml}</span>` : ''}
                        <span>${sessionEscapeHtml(title)}</span>
                        <small>${sessionEscapeHtml(msgCount ? `${msgCount} 条消息` : '0 条消息')}</small>
                    </span>
                    ${metaParts.length ? `<span class="session-search-meta">${sessionEscapeHtml(metaParts.join(' · '))}</span>` : ''}
                    </span>
                    <span class="session-search-time" title="${sessionEscapeAttr(timeTitle)}">${sessionEscapeHtml(timeText)}</span>
                </button>
                <div class="session-search-more">
                    <button class="more-btn" type="button" data-session-menu-id="${sessionEscapeAttr(sessionId)}" aria-label="会话操作">
                        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="5" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="12" cy="19" r="1.5"/></svg>
                    </button>
                </div>
            </div>
        `;
    }).join('');
}

async function loadSessionSearchResults() {
    const { input, activeTab, archiveTab, results } = getSessionSearchEls();
    if (!results) return;
    const { keyword, tag } = parseSessionSearchValue(input?.value || '');
    activeTab?.classList.toggle('active', !sessionSearchArchived);
    archiveTab?.classList.toggle('active', sessionSearchArchived);
    setSessionSearchStatus('正在搜索...');
    try {
        const params = new URLSearchParams({
            limit: '50',
            keyword,
            tag,
            archived: String(sessionSearchArchived),
            page: '1'
        });
        const listReq = apiFetch(`${API_BASE}/sessions?${params.toString()}`).then(res => res.json());
        const contentReq = keyword
            ? apiFetch(`${API_BASE}/sessions/search/content?keyword=${encodeURIComponent(keyword)}`).then(res => res.json()).catch(() => ({ data: [] }))
            : Promise.resolve({ data: [] });
        const [listData, contentData] = await Promise.all([listReq, contentReq]);
        const merged = new Map();
        (listData.data || []).forEach(item => merged.set(String(item.id), item));
        (contentData.data || [])
            .filter(item => Number(item.is_archived || 0) === (sessionSearchArchived ? 1 : 0))
            .filter(item => !tag || String(item.tags || '').split(',').filter(Boolean).includes(tag))
            .forEach(item => {
                const key = String(item.id);
                merged.set(key, { ...(merged.get(key) || {}), ...item });
            });
        const sessions = Array.from(merged.values()).sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')));
        renderSessionSearchResults(sessions);
        updateSessionBatchBar();
        setSessionSearchStatus(sessions.length ? `共找到 ${sessions.length} 个会话` : '');
    } catch (error) {
        console.error('搜索会话失败:', error);
        results.innerHTML = '<div class="session-search-empty">搜索失败，请稍后重试</div>';
        setSessionSearchStatus('');
    }
}

window.openSessionSearchModal = function(prefill = '') {
    const { modal, input, openButton } = getSessionSearchEls();
    if (!modal) return;
    sessionSearchArchived = Boolean(sidebarState.archived);
    modal.classList.remove('hidden');
    openButton?.classList.add('active');
    if (input) {
        input.value = prefill;
        setTimeout(() => input.focus(), 0);
    }
    updateSessionBatchBar();
    loadSessionSearchResults();
};

window.closeSessionSearchModal = function() {
    const { modal, openButton } = getSessionSearchEls();
    if (sessionBatchMode) setSessionBatchMode(false);
    modal?.classList.add('hidden');
    openButton?.classList.remove('active');
};

function ensureSessionTagTools() {
    const controls = document.querySelector('.session-search-controls') || document.querySelector('.sidebar-ctrls');
    const batchSlot = document.getElementById('session-batch-slot') || controls;
    if (!controls || !batchSlot) return;
    if (!document.getElementById('session-batch-toggle')) {
        const toggle = document.createElement('button');
        toggle.type = 'button';
        toggle.id = 'session-batch-toggle';
        toggle.className = 'session-batch-toggle';
        toggle.dataset.sessionBatchToggle = '1';
        toggle.textContent = '批量';
        batchSlot.appendChild(toggle);
    }
    if (document.getElementById('session-tag-tools')) return;
    const tools = document.createElement('div');
    tools.id = 'session-tag-tools';
    tools.className = 'session-tag-tools';
    tools.innerHTML = `
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
    // 标签汇总不再常驻显示，避免压缩会话列表空间。
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
    const searchResults = document.getElementById('session-search-modal-results');
    const toggle = document.getElementById('session-batch-toggle');
    if (!bar || !count) return;
    count.textContent = `已选择 ${selectedSessionIds.size} 个`;
    bar.classList.toggle('hidden', !sessionBatchMode);
    list?.classList.remove('session-batch-mode');
    searchResults?.classList.toggle('session-batch-mode', sessionBatchMode);
    toggle?.classList.toggle('active', sessionBatchMode);
    if (toggle) toggle.textContent = sessionBatchMode ? '退出' : '批量';
    bar.querySelectorAll('[data-session-batch-action="add"], [data-session-batch-action="remove"], [data-session-batch-action="replace"]').forEach(button => {
        button.disabled = selectedSessionIds.size === 0;
    });
    list?.querySelectorAll('.session-item.selected').forEach(item => item.classList.remove('selected'));
    searchResults?.querySelectorAll('[data-session-select-id]').forEach(input => {
        input.checked = selectedSessionIds.has(String(input.dataset.sessionSelectId || ''));
        input.closest('.session-search-result')?.classList.toggle('selected', input.checked);
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
        const { modal } = getSessionSearchEls();
        if (modal && !modal.classList.contains('hidden')) await loadSessionSearchResults();
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
            archived: String(sidebarState.archived),
            includeTotal: 'false'
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
    if (event.target.closest('#session-search-open')) {
        window.openSessionSearchModal?.();
        return;
    }

    if (event.target.closest('#session-search-close') || event.target.id === 'session-search-modal') {
        window.closeSessionSearchModal?.();
        return;
    }

    const modalSelector = event.target.closest('#session-search-modal [data-session-select-id]');
    if (modalSelector) {
        const id = String(modalSelector.dataset.sessionSelectId || '');
        if (modalSelector.checked) selectedSessionIds.add(id);
        else selectedSessionIds.delete(id);
        updateSessionBatchBar();
        return;
    }

    const searchMenuButton = event.target.closest('#session-search-modal [data-session-menu-id]');
    if (searchMenuButton) {
        event.stopPropagation();
        const session = sessionMenuData.get(String(searchMenuButton.dataset.sessionMenuId));
        if (session) {
            window.toggleSessionMenu(event, session.id, session.title, session.isPinned, session.isArchived, session.tags);
        }
        return;
    }

    const searchResult = event.target.closest('[data-session-search-id]');
    if (searchResult) {
        if (sessionBatchMode) {
            const id = String(searchResult.dataset.sessionSearchId || '');
            if (selectedSessionIds.has(id)) selectedSessionIds.delete(id);
            else selectedSessionIds.add(id);
            updateSessionBatchBar();
            return;
        }
        window.closeSessionSearchModal?.();
        window.selectSession(searchResult.dataset.sessionSearchId, searchResult.dataset.sessionSearchTitle || '新对话');
        return;
    }

    if (event.target.closest('#session-search-modal-active')) {
        sessionSearchArchived = false;
        await loadSessionSearchResults();
        return;
    }

    if (event.target.closest('#session-search-modal-archive')) {
        sessionSearchArchived = true;
        await loadSessionSearchResults();
        return;
    }

    const batchToggle = event.target.closest('[data-session-batch-toggle]');
    if (batchToggle) {
        setSessionBatchMode(!sessionBatchMode);
        return;
    }

    const filter = event.target.closest('[data-session-tag-filter]');
    if (filter) {
        const tag = filter.dataset.sessionTagFilter || '';
        window.openSessionSearchModal?.(`#${tag}`);
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

document.getElementById('session-search-modal-input')?.addEventListener('input', () => {
    clearTimeout(sessionSearchTimer);
    sessionSearchTimer = setTimeout(() => loadSessionSearchResults(), 240);
});

document.getElementById('session-search-modal-input')?.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') window.closeSessionSearchModal?.();
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
    makeItem('打印 / 导出 PDF', '', () => window.printSession?.(id));
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
    document.getElementById('session-active-filter')?.classList.toggle('active', !archived);
    document.getElementById('session-archive-filter')?.classList.toggle('active', archived);
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
            window.persistActiveChatSession?.('');
            document.getElementById('current-title').innerText = '请选择或新建对话';
            document.getElementById('message-container').innerHTML = '';
        }
        await window.loadSessions();
    }
};
