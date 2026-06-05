// 侧边栏搜索与批量工具（拆自 sidebar.js）
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
