// 侧边栏搜索与批量工具（拆自 sidebar.js）
// --- 侧边栏模块 Sidebar (完整功能版) ---
let sidebarState = { page: 1, limit: 20, cursor: '', hasMore: true, isLoading: false, archived: false };
const sessionMenuData = new Map();
const selectedSessionIds = new Set();
let sessionBatchMode = false;
let sessionSearchArchived = false;
let globalSearchType = 'sessions';
let globalSearchRequestId = 0;
// 共享全局：搜索框输入防抖计时器，由后加载的 sidebar.js 使用（两文件共享全局作用域，勿删）
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
        sessionScope: document.getElementById('session-search-scope'),
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
        PivotSafeHtml.setHtml(results, '<div class="session-search-empty">没有找到匹配的会话</div>');
        return;
    }
    PivotSafeHtml.setHtml(results, sessions.map(s => {
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
    }).join(''));
}

async function loadSessionOnlySearchResults() {
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
        PivotSafeHtml.setHtml(results, '<div class="session-search-empty">搜索失败，请稍后重试</div>');
        setSessionSearchStatus('');
    }
}

function globalSearchStatusLabel(status) {
    return {
        awaiting_approval: '等待审批',
        queued: '排队中',
        running: '运行中',
        approval_required: '待审批',
        completed: '已完成',
        error: '失败',
        cancelled: '已停止'
    }[status] || String(status || '未知');
}

function globalSearchTime(value) {
    if (!value) return '';
    if (typeof window.formatChatDateTime === 'function') return window.formatChatDateTime(value);
    return String(value);
}

function renderGlobalTaskResults(tasks) {
    const { results } = getSessionSearchEls();
    if (!results) return;
    if (!tasks.length) {
        PivotSafeHtml.setHtml(results, '<div class="session-search-empty">没有找到匹配的任务</div>');
        return;
    }
    PivotSafeHtml.setHtml(results, tasks.map(task => {
        const title = String(task.title || task.goal || '未命名任务');
        const taskType = task.run_mode === 'dag' ? '工作流任务' : '自主任务';
        const model = task.model_name || '未指定模型';
        return `
            <button class="global-search-result" type="button" data-global-search-task-id="${sessionEscapeAttr(task.id)}">
                <span class="global-search-result-main">
                    <span class="global-search-result-title">${sessionEscapeHtml(title)}</span>
                    <span class="global-search-result-meta">${sessionEscapeHtml(taskType)} · ${sessionEscapeHtml(model)} · ${sessionEscapeHtml(globalSearchStatusLabel(task.status))}</span>
                </span>
                <span class="global-search-result-side">${sessionEscapeHtml(globalSearchTime(task.updated_at || task.created_at))}</span>
            </button>
        `;
    }).join(''));
}

function renderGlobalWorkflowResults(workflows) {
    const { results } = getSessionSearchEls();
    if (!results) return;
    if (!workflows.length) {
        PivotSafeHtml.setHtml(results, '<div class="session-search-empty">没有找到匹配的工作流</div>');
        return;
    }
    PivotSafeHtml.setHtml(results, workflows.map(workflow => {
        const nodes = Array.isArray(workflow?.dag_spec?.nodes) ? workflow.dag_spec.nodes.length : Number(workflow.node_count || 0);
        const publishedVersion = Number(workflow.published_version || 0);
        return `
            <button class="global-search-result" type="button" data-global-search-workflow-id="${sessionEscapeAttr(workflow.id)}">
                <span class="global-search-result-main">
                    <span class="global-search-result-title">${sessionEscapeHtml(workflow.name || '未命名工作流')}</span>
                    <span class="global-search-result-meta">v${Number(workflow.current_version || 1)} · ${nodes} 个节点 · ${publishedVersion ? `已发布 v${publishedVersion}` : '未发布'}</span>
                </span>
                <span class="global-search-result-side">${sessionEscapeHtml(globalSearchTime(workflow.updated_at || workflow.created_at))}</span>
            </button>
        `;
    }).join(''));
}

async function loadGlobalTaskSearchResults() {
    const { input, results } = getSessionSearchEls();
    if (!results) return;
    const requestId = ++globalSearchRequestId;
    const query = String(input?.value || '').trim();
    setSessionSearchStatus('正在搜索...');
    try {
        const params = new URLSearchParams({ page: '1', limit: '50' });
        if (query) params.set('query', query);
        const res = await apiFetch(`${API_BASE}/agents/runs?${params.toString()}`);
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || '任务搜索失败');
        if (requestId !== globalSearchRequestId || globalSearchType !== 'tasks') return;
        const tasks = data.data || [];
        renderGlobalTaskResults(tasks);
        setSessionSearchStatus(tasks.length ? `共找到 ${Number(data.total || tasks.length)} 个任务` : '');
    } catch (error) {
        if (requestId !== globalSearchRequestId) return;
        console.error('搜索任务失败:', error);
        PivotSafeHtml.setHtml(results, '<div class="session-search-empty">任务搜索失败，请稍后重试</div>');
        setSessionSearchStatus('');
    }
}

async function loadGlobalWorkflowSearchResults() {
    const { input, results } = getSessionSearchEls();
    if (!results) return;
    const requestId = ++globalSearchRequestId;
    const query = String(input?.value || '').trim().toLowerCase();
    setSessionSearchStatus('正在搜索...');
    try {
        const res = await apiFetch(`${API_BASE}/agents/workflows`);
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || '工作流搜索失败');
        if (requestId !== globalSearchRequestId || globalSearchType !== 'workflows') return;
        const workflows = (data.data || []).filter(workflow => !query || [
            workflow.name,
            workflow.description,
            workflow.current_version,
            workflow.published_version
        ].filter(value => value !== undefined && value !== null).join(' ').toLowerCase().includes(query));
        renderGlobalWorkflowResults(workflows);
        setSessionSearchStatus(workflows.length ? `共找到 ${workflows.length} 个工作流` : '');
    } catch (error) {
        if (requestId !== globalSearchRequestId) return;
        console.error('搜索工作流失败:', error);
        PivotSafeHtml.setHtml(results, '<div class="session-search-empty">工作流搜索失败，请稍后重试</div>');
        setSessionSearchStatus('');
    }
}

function updateGlobalSearchUi() {
    const { input, sessionScope } = getSessionSearchEls();
    document.querySelectorAll('[data-global-search-type]').forEach(button => {
        const isActive = button.dataset.globalSearchType === globalSearchType;
        button.classList.toggle('active', isActive);
        button.setAttribute('aria-selected', isActive ? 'true' : 'false');
    });
    sessionScope?.classList.toggle('hidden', globalSearchType !== 'sessions');
    document.getElementById('session-tag-tools')?.classList.toggle('hidden', globalSearchType !== 'sessions');
    if (input) {
        input.placeholder = {
            sessions: '搜索会话标题、消息内容，或输入 #标签',
            tasks: '搜索任务名称或目标',
            workflows: '搜索工作流名称、说明或版本'
        }[globalSearchType];
    }
}

function setGlobalSearchType(type = 'sessions') {
    globalSearchType = ['sessions', 'tasks', 'workflows'].includes(type) ? type : 'sessions';
    globalSearchRequestId += 1;
    if (globalSearchType !== 'sessions' && sessionBatchMode) setSessionBatchMode(false);
    updateGlobalSearchUi();
    loadSessionSearchResults();
}

window.Pivot.exposeModule('sidebar.search', {
    setType: setGlobalSearchType
});

async function loadSessionSearchResults() {
    updateGlobalSearchUi();
    if (globalSearchType === 'tasks') return loadGlobalTaskSearchResults();
    if (globalSearchType === 'workflows') return loadGlobalWorkflowSearchResults();
    return loadSessionOnlySearchResults();
}

window.openSessionSearchModal = function(prefill = '') {
    const { modal, input, openButton } = getSessionSearchEls();
    if (!modal) return;
    globalSearchType = 'sessions';
    sessionSearchArchived = false;
    globalSearchRequestId += 1;
    modal.classList.remove('hidden');
    openButton?.classList.add('active');
    if (input) {
        input.value = prefill;
        setTimeout(() => input.focus(), 0);
    }
    updateSessionBatchBar();
    updateGlobalSearchUi();
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
    PivotSafeHtml.setHtml(tools, `
        <div id="session-batch-tags" class="session-batch-tags hidden">
            <span id="session-batch-count">已选择 0 个</span>
            <button type="button" data-session-batch-action="add">添加标签</button>
            <button type="button" data-session-batch-action="remove">移除标签</button>
            <button type="button" data-session-batch-action="replace">替换标签</button>
            <button type="button" data-session-batch-action="clear">取消选择</button>
            <button type="button" data-session-batch-action="done">完成</button>
        </div>
    `);
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
