// 侧边栏会话列表与菜单操作 Sidebar session list and menu actions（拆自 sidebar.js）
function markActiveSessionInList(id) {
    const activeId = String(id || '');
    document.querySelectorAll('#session-list .session-item').forEach(item => {
        item.classList.toggle('active', String(item.dataset.sessionId || '') === activeId);
    });
};

function getSidebarSearchApi() {
    return window.Pivot?.moduleApi ? window.Pivot.moduleApi('sidebar.search') : {};
}

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

async function loadSessions(append = false) {
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
        if (!append) PivotSafeHtml.setHtml(list, '');

        // 绑定无限滚动监听
        if (!list.dataset.boundLoadMore) {
            list.dataset.boundLoadMore = '1';
            list.addEventListener('scroll', () => {
                if (sidebarState.isLoading || !sidebarState.hasMore) return;
                if (list.scrollTop + list.clientHeight >= list.scrollHeight - 48) {
                    loadSessions(true);
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
            const sessionListTime = window.Pivot.legacy.formatSessionListTime ? window.Pivot.legacy.formatSessionListTime(sessionRawTime) : '';
            const sessionTimeTitle = window.Pivot.legacy.formatChatDateTime ? window.Pivot.legacy.formatChatDateTime(sessionRawTime) : String(sessionRawTime || '');
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
            PivotSafeHtml.setHtml(div, `
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
            `);
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
            toggleSessionMenu(event, session.id, session.title, session.isPinned, session.isArchived, session.tags);
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
        window.Pivot.legacy.selectSession(session.id, session.title);
    }
}
});

document.addEventListener('click', async (event) => {
    if (event.target.closest('#session-search-open')) {
        const isPersonal = document.body?.dataset.activeWorkspace === 'personal';
        getSidebarSearchApi().open?.('', { scope: isPersonal ? 'global' : 'sessions' });
        return;
    }

    if (event.target.closest('#session-search-close') || event.target.id === 'session-search-modal') {
        getSidebarSearchApi().close?.();
        return;
    }

    const globalSearchTab = event.target.closest('[data-global-search-type]');
    if (globalSearchTab) {
        getSidebarSearchApi().setType?.(globalSearchTab.dataset.globalSearchType);
        return;
    }

    if (event.target.closest('#session-search-modal-clear')) {
        const input = document.getElementById('session-search-modal-input');
        if (input) {
            input.value = '';
            input.focus();
        }
        getSidebarSearchApi().refresh?.();
        return;
    }

    if (event.target.closest('[data-global-search-retry]')) {
        getSidebarSearchApi().refresh?.();
        return;
    }

    const taskSearchResult = event.target.closest('[data-global-search-task-id]');
    if (taskSearchResult) {
        const runId = taskSearchResult.dataset.globalSearchTaskId;
        getSidebarSearchApi().close?.();
        await window.Pivot.legacy.openAgentWorkbench?.();
        await window.Pivot.legacy.openAgentRun?.(runId);
        return;
    }

    const workflowSearchResult = event.target.closest('[data-global-search-workflow-id]');
    if (workflowSearchResult) {
        const workflowId = workflowSearchResult.dataset.globalSearchWorkflowId;
        getSidebarSearchApi().close?.();
        await window.Pivot.legacy.openAgentDagWorkbench?.({ workflowId, editor: true });
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
            toggleSessionMenu(event, session.id, session.title, session.isPinned, session.isArchived, session.tags);
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
        getSidebarSearchApi().close?.();
        window.Pivot.legacy.selectSession(searchResult.dataset.sessionSearchId, searchResult.dataset.sessionSearchTitle || '新对话');
        return;
    }

    if (event.target.closest('#session-search-modal-active')) {
        sessionSearchArchived = false;
        event.target.closest('#session-search-modal-active')?.setAttribute('aria-selected', 'true');
        document.getElementById('session-search-modal-archive')?.setAttribute('aria-selected', 'false');
        await getSidebarSearchApi().refresh?.();
        return;
    }

    if (event.target.closest('#session-search-modal-archive')) {
        sessionSearchArchived = true;
        event.target.closest('#session-search-modal-archive')?.setAttribute('aria-selected', 'true');
        document.getElementById('session-search-modal-active')?.setAttribute('aria-selected', 'false');
        await getSidebarSearchApi().refresh?.();
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
        getSidebarSearchApi().open?.(`#${tag}`);
        return;
    }

    const rename = event.target.closest('[data-session-tag-rename]');
    if (rename) {
        const fromTag = rename.dataset.sessionTagRename || '';
        const toTag = await window.Pivot.legacy.showInputPrompt?.({
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
            await loadSessions();
            await loadSessionTagSummary();
            showToast('标签已重命名');
        }
        return;
    }

    const remove = event.target.closest('[data-session-tag-remove]');
    if (remove) {
        const tag = remove.dataset.sessionTagRemove || '';
        window.Pivot.legacy.showConfirm('删除标签', `确定从所有会话中移除标签「${tag}」吗？`, async () => {
            const res = await apiFetch(`${API_BASE}/sessions/tags/remove`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ tag })
            });
            if (res.ok) {
                await loadSessions();
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
    getSidebarSearchApi().scheduleRefresh?.();
});

document.getElementById('session-search-modal-input')?.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') getSidebarSearchApi().close?.();
    if (event.key === 'Enter') getSidebarSearchApi().refresh?.();
});

document.addEventListener('keydown', (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        const isInput = ['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName) && !document.activeElement?.readOnly;
        if (isInput && document.activeElement?.id !== 'session-search-modal-input') return;
        event.preventDefault();
        const isPersonal = document.body?.dataset.activeWorkspace === 'personal';
        getSidebarSearchApi().open?.('', { scope: isPersonal ? 'global' : 'sessions' });
    }
});

const toggleSessionMenu = (e, id, title, isPinned, isArchived, tags) => {
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
    makeItem('打印 / 导出 PDF', '', () => window.Pivot.legacy.printSession?.(id));
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

const CHAT_SIDEBAR_DRAWER_STORAGE_KEY = 'pivot_chat_sidebar_drawer_open';

function readChatSidebarDrawerState() {
    try { return localStorage.getItem(CHAT_SIDEBAR_DRAWER_STORAGE_KEY) === 'true'; } catch (_) { return false; }
}

function setChatSidebarDrawerOpen(open, { persist = true } = {}) {
    const sidebar = document.querySelector('.sidebar');
    if (!sidebar) return false;
    const shouldOpen = Boolean(open) && !window.matchMedia('(max-width: 720px)').matches;
    sidebar.classList.toggle('collapsed', !shouldOpen);
    document.body?.classList.toggle('is-chat-sidebar-drawer-open', shouldOpen);
    if (persist) {
        try { localStorage.setItem(CHAT_SIDEBAR_DRAWER_STORAGE_KEY, shouldOpen ? 'true' : 'false'); } catch (_) {}
    }
    return shouldOpen;
}

const toggleSidebar = () => {
    const sidebar = document.querySelector('.sidebar');
    return setChatSidebarDrawerOpen(sidebar?.classList.contains('collapsed'));
};
const setArchiveFilter = (archived) => {
    sidebarState.archived = archived;
    document.getElementById('session-active-filter')?.classList.toggle('active', !archived);
    document.getElementById('session-archive-filter')?.classList.toggle('active', archived);
    loadSessions();
};

const togglePinSession = async (id, currentPinned) => {
    const res = await apiFetch(`${API_BASE}/sessions/${id}/pin`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ isPinned: !currentPinned }) });
    if (res.ok) { showToast(!currentPinned ? '已置顶' : '已取消置顶'); await loadSessions(); }
};

const toggleArchiveSession = async (id, currentArchived) => {
    const res = await apiFetch(`${API_BASE}/sessions/${id}/archive`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ isArchived: !currentArchived }) });
    if (res.ok) {
        showToast(!currentArchived ? '已归档' : '已恢复');
        if (currentSessionId === id && !sidebarState.archived) {
            currentSessionId = null;
            window.Pivot.legacy.persistActiveChatSession?.('');
            document.getElementById('current-title').innerText = '请选择或新建对话';
            PivotSafeHtml.setHtml(document.getElementById('message-container'), '');
        }
        await loadSessions();
    }
};


window.Pivot.exposeModule('chat.sidebar', {
    markActiveSessionInList,
    loadSessions,
    toggleSessionMenu,
    toggleSidebar,
    setChatSidebarDrawerOpen,
    setArchiveFilter,
    togglePinSession,
    toggleArchiveSession
}, [
    'markActiveSessionInList',
    'loadSessions',
    'toggleSessionMenu',
    'toggleSidebar',
    'setChatSidebarDrawerOpen',
    'setArchiveFilter',
    'togglePinSession',
    'toggleArchiveSession'
]);
