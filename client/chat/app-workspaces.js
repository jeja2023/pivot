/* 智枢前端主程序 */

// --- 输入框自适应 ---
const userInput = document.getElementById('user-input');
const CHAT_MCP_TOOL_ALLOWLIST_KEY = 'pivot_chat_mcp_tool_allowlist';
const CHAT_MCP_TOOL_MODE_KEY = 'pivot_chat_mcp_tool_mode';
const CHAT_MODE_KEY = 'pivot_chat_mode';
let chatMcpToolsCache = [];
let chatAgentExecutionEnabled = true;

function getChatMode() {
    try {
        return localStorage.getItem(CHAT_MODE_KEY) === 'agent' && chatAgentExecutionEnabled ? 'agent' : 'normal';
    } catch (_error) { return 'normal'; }
}

function applyChatModeState(mode = getChatMode()) {
    const normalized = mode === 'agent' && chatAgentExecutionEnabled ? 'agent' : 'normal';
    document.querySelectorAll('[data-chat-mode-option]').forEach(option => {
        const selected = option.dataset.chatModeOption === normalized;
        option.setAttribute('aria-selected', selected ? 'true' : 'false');
        option.disabled = option.dataset.chatModeOption === 'agent' && !chatAgentExecutionEnabled;
        option.classList.toggle('is-active', selected);
    });
    const label = document.getElementById('chat-mode-label');
    if (label) label.textContent = normalized === 'agent' ? 'Agent' : '普通';
    const option = document.getElementById('chat-agent-mode-option');
    const hint = document.getElementById('chat-agent-mode-hint');
    option?.classList.toggle('is-disabled', !chatAgentExecutionEnabled);
    if (hint) hint.textContent = chatAgentExecutionEnabled ? '连续规划、工具调用和后台恢复' : '管理员已暂时关闭此模式';
    return normalized;
}

function setChatMode(mode) {
    const normalized = mode === 'agent' && chatAgentExecutionEnabled ? 'agent' : 'normal';
    try { localStorage.setItem(CHAT_MODE_KEY, normalized); } catch (_error) {}
    applyChatModeState(normalized);
    setChatModePanelOpen(false);
    return normalized;
}

function setChatModePanelOpen(open) {
    const trigger = document.getElementById('chat-mode-trigger');
    const panel = document.getElementById('chat-mode-panel');
    if (!trigger || !panel) return;
    panel.hidden = !open;
    trigger.setAttribute('aria-expanded', open ? 'true' : 'false');
    document.getElementById('chat-mode-selector')?.classList.toggle('is-open', open);
}

async function loadChatModeCapabilities() {
    try {
        const response = await apiFetch(`${API_BASE}/chat/capabilities`, { cache: 'no-store' });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error || '聊天模式状态读取失败');
        chatAgentExecutionEnabled = data.agentExecutionEnabled !== false;
    } catch (_error) {
        chatAgentExecutionEnabled = true;
    }
    applyChatModeState();
    return chatAgentExecutionEnabled;
}

function setChatToolsMenuOpen(open) {
    const trigger = document.getElementById('chat-tools-menu-btn');
    const panel = document.getElementById('chat-tools-menu-panel');
    if (!trigger || !panel) return;
    panel.hidden = !open;
    trigger.setAttribute('aria-expanded', open ? 'true' : 'false');
    document.querySelector('.chat-tools-menu')?.classList.toggle('is-open', open);
    if (!open) {
        document.querySelectorAll('#chat-tools-menu-panel .chat-tool-subpanel').forEach(subpanel => { subpanel.hidden = true; });
        document.querySelectorAll('#chat-tools-menu-panel [aria-expanded="true"]').forEach(button => button.setAttribute('aria-expanded', 'false'));
    }
}

function readChatMcpToolAllowlist() {
    try {
        const stored = localStorage.getItem(CHAT_MCP_TOOL_ALLOWLIST_KEY);
        if (stored === null) return null;
        const parsed = JSON.parse(stored);
        return Array.isArray(parsed) ? [...new Set(parsed.map(value => String(value || '').trim()).filter(Boolean))] : null;
    } catch (e) {
        return null;
    }
}

function getChatMcpToolMode() {
    const storedMode = localStorage.getItem(CHAT_MCP_TOOL_MODE_KEY);
    if (storedMode === 'auto' || storedMode === 'manual') return storedMode;
    return readChatMcpToolAllowlist() === null ? 'auto' : 'manual';
}

function getChatMcpToolAllowlist() {
    if (getChatMcpToolMode() === 'auto') return null;
    return readChatMcpToolAllowlist() || [];
}

function setChatMcpToolMode(mode) {
    const normalizedMode = mode === 'manual' ? 'manual' : 'auto';
    try {
        localStorage.setItem(CHAT_MCP_TOOL_MODE_KEY, normalizedMode);
        if (normalizedMode === 'manual' && readChatMcpToolAllowlist() === null) {
            localStorage.setItem(CHAT_MCP_TOOL_ALLOWLIST_KEY, '[]');
        }
    } catch (e) {}
    renderChatMcpToolFilter();
}

function setChatMcpToolAllowlist(allowlist) {
    try {
        if (allowlist === null) {
            localStorage.removeItem(CHAT_MCP_TOOL_ALLOWLIST_KEY);
            localStorage.setItem(CHAT_MCP_TOOL_MODE_KEY, 'auto');
        } else {
            localStorage.setItem(CHAT_MCP_TOOL_ALLOWLIST_KEY, JSON.stringify(allowlist));
            localStorage.setItem(CHAT_MCP_TOOL_MODE_KEY, 'manual');
        }
    } catch (e) {}
    renderChatMcpToolFilter();
}

function chatMcpToolFullName(tool = {}) {
    return String(tool.fullName || tool.full_name || tool.name || '').trim();
}

function chatMcpToolLabel(tool = {}) {
    const title = String(tool.title || '').trim();
    if (title) return title;
    const name = String(tool.name || chatMcpToolFullName(tool) || '工具');
    return name.split('.').pop().replace(/[_-]+/g, ' ');
}

function updateChatMcpToolSummary() {
    const summary = document.getElementById('chat-mcp-tool-summary');
    const menuCopy = document.querySelector('#chat-mcp-enabled .chat-tool-menu-copy small');
    const allowlist = getChatMcpToolAllowlist();
    const total = chatMcpToolsCache.length;
    const text = allowlist === null
        ? (total ? `${total} 个工具可用，模型按需选择` : '模型将按需选择可用工具')
        : (total ? `已选择 ${allowlist.length} / ${total} 个工具` : `已选择 ${allowlist.length} 个工具`);
    if (summary) summary.textContent = text;
    if (menuCopy) menuCopy.textContent = allowlist === null ? '模型自动按需选择' : `手动限制为 ${allowlist.length} 个工具`;
}

function renderChatMcpToolFilter() {
    const list = document.getElementById('chat-mcp-tool-list');
    const allToggle = document.getElementById('chat-mcp-all-tools');
    if (!list || !allToggle) return;
    const mode = getChatMcpToolMode();
    const allowlist = getChatMcpToolAllowlist();
    const selected = Array.isArray(allowlist) ? allowlist : [];
    const query = String(document.getElementById('chat-mcp-tool-search')?.value || '').trim().toLowerCase();
    const allNames = chatMcpToolsCache.map(chatMcpToolFullName).filter(Boolean);
    allToggle.checked = allNames.length > 0 && allNames.every(name => selected.includes(name));
    allToggle.indeterminate = selected.length > 0 && !allToggle.checked;
    const autoOption = document.getElementById('chat-mcp-mode-auto');
    const manualOption = document.getElementById('chat-mcp-mode-manual');
    const manualControls = document.getElementById('chat-mcp-manual-controls');
    if (autoOption) autoOption.checked = mode === 'auto';
    if (manualOption) manualOption.checked = mode === 'manual';
    if (manualControls) manualControls.hidden = mode !== 'manual';
    PivotSafeHtml.setHtml(list, '');
    const tools = chatMcpToolsCache.filter(tool => {
        if (!query) return true;
        return [chatMcpToolLabel(tool), tool.name, tool.serverName, tool.description]
            .some(value => String(value || '').toLowerCase().includes(query));
    });
    if (!tools.length) {
        const empty = document.createElement('div');
        empty.className = 'chat-tool-subpanel-hint';
        empty.textContent = chatMcpToolsCache.length ? '没有匹配的工具' : '暂无可用工具';
        list.appendChild(empty);
    }
    tools.forEach(tool => {
        const fullName = chatMcpToolFullName(tool);
        const row = document.createElement('label');
        row.className = 'chat-mcp-tool-row';
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.value = fullName;
        checkbox.checked = selected.includes(fullName);
        const copy = document.createElement('span');
        const title = document.createElement('strong');
        title.textContent = chatMcpToolLabel(tool);
        const meta = document.createElement('small');
        meta.textContent = String(tool.serverName || tool.description || fullName);
        copy.append(title, meta);
        row.append(checkbox, copy);
        list.appendChild(row);
    });
    updateChatMcpToolSummary();
    positionChatToolSubpanel(document.getElementById('chat-mcp-subpanel'));
}

function filterChatRagCollectionOptions() {
    const select = document.getElementById('chat-rag-collection-scope');
    const query = String(document.getElementById('chat-rag-scope-search')?.value || '').trim().toLowerCase();
    if (!select) return;
    [...select.options].forEach(option => {
        option.hidden = Boolean(query) && Boolean(option.value) && !String(option.textContent || '').toLowerCase().includes(query);
    });
}

async function loadChatMcpToolFilter() {
    const list = document.getElementById('chat-mcp-tool-list');
    if (list) list.textContent = '正在加载工具...';
    try {
        const res = await apiFetch(API_BASE + '/mcp/tools');
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || '工具列表加载失败');
        chatMcpToolsCache = Array.isArray(data.tools) ? data.tools : [];
        renderChatMcpToolFilter();
    } catch (error) {
        if (list) list.textContent = error.message || '工具列表加载失败';
    }
}

function positionChatToolSubpanel(target) {
    if (!target || target.hidden) return;
    target.style.removeProperty('top');
    if (window.matchMedia?.('(max-width: 720px)').matches) return;
    const entry = target.closest('.chat-tool-entry');
    if (!entry) return;
    const viewportHeight = Math.max(document.documentElement?.clientHeight || 0, window.innerHeight || 0);
    if (!viewportHeight) return;
    const viewportMargin = 12;
    const entryRect = entry.getBoundingClientRect();
    const panelRect = target.getBoundingClientRect();
    const viewportTop = Math.max(viewportMargin, Math.min(entryRect.top, viewportHeight - viewportMargin - panelRect.height));
    target.style.top = `${viewportTop - entryRect.top}px`;
}

async function openChatToolSubpanel(tool) {
    const target = document.getElementById(tool === 'rag' ? 'chat-rag-subpanel' : 'chat-mcp-subpanel');
    const trigger = document.querySelector('[data-chat-tool-config="' + tool + '"]');
    if (!target || !trigger) return;
    const shouldOpen = target.hidden;
    document.querySelectorAll('#chat-tools-menu-panel .chat-tool-subpanel').forEach(panel => { panel.hidden = true; });
    document.querySelectorAll('#chat-tools-menu-panel [aria-expanded="true"]').forEach(button => button.setAttribute('aria-expanded', 'false'));
    target.hidden = !shouldOpen;
    trigger.setAttribute('aria-expanded', shouldOpen ? 'true' : 'false');
    if (!shouldOpen) return;
    positionChatToolSubpanel(target);
    if (tool === 'mcp') await loadChatMcpToolFilter();
    positionChatToolSubpanel(target);
}
function syncChatToolsMenuLabels() {
    document.querySelectorAll('#chat-tools-menu-panel .chat-tool-menu-item').forEach(item => {
        if (item.querySelector('.chat-tool-menu-copy')) return;
        const icon = item.querySelector('.chat-tool-icon, svg');
        if (icon && icon.tagName === 'svg') {
            const wrapper = document.createElement('span');
            wrapper.className = 'chat-tool-menu-icon';
            icon.replaceWith(wrapper);
            wrapper.appendChild(icon);
        }
        const copy = document.createElement('span');
        copy.className = 'chat-tool-menu-copy';
        const strong = document.createElement('strong');
        strong.textContent = item.dataset.menuLabel || (item.id === 'upload-btn' ? '文件和文件夹' : item.id === 'chat-mcp-enabled' ? '工具' : '知识库');
        const small = document.createElement('small');
        small.textContent = item.dataset.menuDescription || item.dataset.tooltip || '';
        copy.append(strong, small);
        item.appendChild(copy);
        if (item.dataset.chatToolToggle) {
            const check = document.createElement('span');
            check.className = 'chat-tool-menu-check';
            check.setAttribute('aria-hidden', 'true');
            item.appendChild(check);
        }
    });
}
function initChatToolsMenu() {
    const trigger = document.getElementById('chat-tools-menu-btn');
    if (!trigger || trigger.dataset.bound === 'true') return;
    trigger.dataset.bound = 'true';
    trigger.addEventListener('click', event => {
        event.preventDefault();
        event.stopPropagation();
        setChatToolsMenuOpen(document.getElementById('chat-tools-menu-panel')?.hidden !== false);
    });
    const modeTrigger = document.getElementById('chat-mode-trigger');
    modeTrigger?.addEventListener('click', event => {
        event.preventDefault();
        event.stopPropagation();
        const open = document.getElementById('chat-mode-panel')?.hidden !== false;
        setChatToolsMenuOpen(false);
        setChatModePanelOpen(open);
        if (open) loadChatModeCapabilities().catch(() => {});
    });
    document.addEventListener('click', event => {
        if (!event.target.closest('#chat-tools-menu')) setChatToolsMenuOpen(false);
        if (!event.target.closest('#chat-mode-selector')) setChatModePanelOpen(false);
    });
    document.addEventListener('keydown', event => {
        if (event.key === 'Escape') {
            setChatToolsMenuOpen(false);
            setChatModePanelOpen(false);
        }
    });
    window.addEventListener('resize', () => {
        document.querySelectorAll('#chat-tools-menu-panel .chat-tool-subpanel:not([hidden])')
            .forEach(positionChatToolSubpanel);
    });
    document.querySelectorAll('[data-chat-tool-config]').forEach(button => {
        button.addEventListener('click', event => {
            event.preventDefault();
            event.stopPropagation();
            openChatToolSubpanel(button.dataset.chatToolConfig);
        });
    });
    document.getElementById('chat-mcp-tool-search')?.addEventListener('input', renderChatMcpToolFilter);
    document.querySelectorAll('input[name="chat-mcp-mode"]').forEach(option => {
        option.addEventListener('change', event => {
            if (event.target.checked) setChatMcpToolMode(event.target.value);
        });
    });
    document.querySelectorAll('[data-chat-mode-option]').forEach(option => {
        option.addEventListener('change', event => {
            if (event.target.dataset.chatModeOption) setChatMode(event.target.dataset.chatModeOption);
        });
        option.addEventListener('click', event => {
            event.preventDefault();
            setChatMode(option.dataset.chatModeOption);
        });
    });
    document.getElementById('chat-mcp-all-tools')?.addEventListener('change', event => {
        const allNames = chatMcpToolsCache.map(chatMcpToolFullName).filter(Boolean);
        setChatMcpToolAllowlist(event.target.checked ? allNames : []);
    });
    document.getElementById('chat-mcp-tool-list')?.addEventListener('change', event => {
        if (!event.target.matches('input[type="checkbox"]')) return;
        const current = getChatMcpToolAllowlist();
        const selected = new Set(Array.isArray(current) ? current : []);
        if (event.target.checked) selected.add(event.target.value);
        else selected.delete(event.target.value);
        setChatMcpToolAllowlist([...selected]);
    });
    document.getElementById('chat-rag-scope-search')?.addEventListener('input', filterChatRagCollectionOptions);
    document.querySelectorAll('[data-chat-tool-reset]').forEach(button => {
        button.addEventListener('click', async event => {
            event.preventDefault();
            const tool = button.dataset.chatToolReset;
            if (tool === 'mcp') {
                setChatMcpToolAllowlist(null);
                return;
            }
            const collection = document.getElementById('chat-rag-collection-scope');
            const tag = document.getElementById('chat-rag-tag-scope');
            const search = document.getElementById('chat-rag-scope-search');
            if (collection) collection.value = '';
            if (tag) tag.value = '';
            if (search) search.value = '';
            filterChatRagCollectionOptions();
            await window.Pivot.legacy.handleRagCollectionScopeChange?.('chat');
            window.Pivot.legacy.updateChatToolReadiness?.({ silent: true });
        });
    });
    document.querySelectorAll('[data-chat-tool-done]').forEach(button => {
        button.addEventListener('click', event => {
            event.preventDefault();
            openChatToolSubpanel(button.dataset.chatToolDone);
        });
    });
    syncChatToolsMenuLabels();
    updateChatMcpToolSummary();
    applyChatModeState();
}
initChatToolsMenu();
document.addEventListener('DOMContentLoaded', initChatToolsMenu);
window.Pivot.exposeModule('chat.inputMenu', {
    getMcpToolAllowlist: getChatMcpToolAllowlist,
    getChatMode,
    setChatMode,
    isAgentExecutionEnabled: () => chatAgentExecutionEnabled,
    setOpen: setChatToolsMenuOpen
});
window.Pivot.legacy.resizeUserInput = () => {
    if (!userInput) return;
    userInput.style.height = 'auto';
    const sh = userInput.scrollHeight;
    if (sh > 56) {
        userInput.style.height = `${Math.min(sh, 180)}px`;
    } else {
        userInput.style.height = '56px';
    }
};
userInput?.addEventListener('input', window.Pivot.legacy.resizeUserInput);
userInput && (userInput.onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); window.Pivot.legacy.sendMessage(); } });

const CHAT_TOOL_TOGGLE_STORAGE = {
    rag: 'pivot_chat_rag_enabled',
    mcp: 'pivot_chat_mcp_enabled'
};

const CHAT_TOOL_STATUS_COPY = {
    rag: {
        label: '知识库',
        ready: '已打开，优先检索资料。',
        checking: '检查中',
        empty: '暂无就绪资料',
        loading: '索引中',
        error: '资料索引失败',
        offline: '状态未确认',
        action: '打开知识库'
    },
    mcp: {
        label: '工具库',
        ready: '已打开，可按需调用。',
        checking: '检查中',
        empty: '暂无可用工具',
        loading: '检查中',
        error: '状态异常',
        offline: '状态未确认',
        action: '打开工具库'
    }
};

function findChatToolToggle(target) {
    let node = target;
    while (node && node !== document) {
        if (node.matches?.('[data-chat-tool-toggle], #chat-rag-enabled, #chat-mcp-enabled, .chat-tool-toggle')) return node;
        node = node.parentElement || node.parentNode;
    }
    return null;
}

function getChatToolName(button) {
    if (!button) return '';
    if (button.dataset?.chatToolToggle) return button.dataset.chatToolToggle;
    if (button.id === 'chat-rag-enabled' || button.querySelector?.('#chat-rag-enabled')) return 'rag';
    if (button.id === 'chat-mcp-enabled' || button.querySelector?.('#chat-mcp-enabled')) return 'mcp';
    return '';
}

function syncChatRagScopeControls() {
    const ragButton = document.getElementById('chat-rag-enabled') || document.querySelector('[data-chat-tool-toggle="rag"]');
    const pressed = ragButton?.getAttribute('aria-pressed');
    const enabled = Boolean(ragButton) && (pressed === 'true' || (pressed !== 'false' && (ragButton.dataset.enabled === 'true' || ragButton.classList.contains('is-active') || ragButton.checked === true)));
    document.body?.classList.toggle('chat-rag-scope-open', enabled);
    document.querySelectorAll('#chat-rag-collection-scope, #chat-rag-tag-scope').forEach(select => {
        select.classList.remove('hidden');
        select.disabled = false;
        select.setAttribute('aria-hidden', 'false');
    });
}

function setChatToolToggleState(button, enabled, { refreshReadiness = true } = {}) {
    if (!button) return;
    const tool = getChatToolName(button);
    const target = button.matches?.('.chat-tool-toggle') ? button : button.closest?.('.chat-tool-toggle') || button;
    const nestedInput = target.querySelector?.('input[type="checkbox"][id^="chat-"]');
    if ('checked' in button) button.checked = enabled;
    if (target !== button && 'checked' in target) target.checked = enabled;
    if (nestedInput) nestedInput.checked = enabled;
    target.dataset.enabled = enabled ? 'true' : 'false';
    target.setAttribute('aria-pressed', enabled ? 'true' : 'false');
    target.classList.toggle('is-active', enabled);
    button.dataset.enabled = enabled ? 'true' : 'false';
    button.setAttribute('aria-pressed', enabled ? 'true' : 'false');
    button.classList.toggle('is-active', enabled);
    if (tool === 'rag') syncChatRagScopeControls();
    if (refreshReadiness && typeof window.Pivot.legacy.updateChatToolReadiness === 'function') window.Pivot.legacy.updateChatToolReadiness({ silent: true });
}

function syncChatToolToggles() {
    document.querySelectorAll('[data-chat-tool-toggle], #chat-rag-enabled, #chat-mcp-enabled').forEach(button => {
        const tool = getChatToolName(button);
        const storageKey = CHAT_TOOL_TOGGLE_STORAGE[tool];
        setChatToolToggleState(button, storageKey ? localStorage.getItem(storageKey) === 'true' : button.dataset.enabled === 'true', { refreshReadiness: false });
    });
    syncChatRagScopeControls();
    if (typeof window.Pivot.legacy.updateChatToolReadiness === 'function') window.Pivot.legacy.updateChatToolReadiness({ silent: true });
}

function getEnabledChatTools() {
    return Object.keys(CHAT_TOOL_TOGGLE_STORAGE).filter(tool => {
        const button = document.querySelector(`[data-chat-tool-toggle="${tool}"]`);
        return button?.dataset.enabled === 'true' || button?.getAttribute('aria-pressed') === 'true' || button?.checked === true;
    });
}

function buildChatToolStatusItem({ tool, tone, text, action }) {
    const item = document.createElement('span');
    item.className = `chat-tool-status-item is-${tone || 'ready'}`;
    const label = document.createElement('strong');
    label.textContent = CHAT_TOOL_STATUS_COPY[tool]?.label || tool;
    const message = document.createElement('span');
    message.textContent = text;
    message.title = text;
    item.append(label, message);
    if (action) {
        const button = document.createElement('button');
        button.type = 'button';
        button.dataset.chatToolStatusAction = tool;
        button.textContent = CHAT_TOOL_STATUS_COPY[tool]?.action || '打开';
        item.appendChild(button);
    }
    return item;
}

function renderChatToolStatus(items = []) {
    const status = document.getElementById('chat-tool-status');
    if (!status) return;
    const ragStatus = document.getElementById('chat-rag-readiness');
    const ragItem = items.find(item => item.tool === 'rag');
    if (ragStatus) {
        ragStatus.className = `chat-tool-subpanel-status is-${ragItem?.tone || 'muted'}`;
        ragStatus.textContent = ragItem?.text || '启用知识库后可查看可用资料';
    }
    const visibleItems = items.filter(item => !['rag', 'mcp'].includes(item.tool));
    PivotSafeHtml.setHtml(status, '');
    status.classList.toggle('hidden', visibleItems.length === 0);
    status.classList.toggle('has-warning', visibleItems.some(item => item.tone === 'warning'));
    status.classList.toggle('has-error', visibleItems.some(item => item.tone === 'error'));
    visibleItems.forEach(item => status.appendChild(buildChatToolStatusItem(item)));
}

function getSelectedOptionCleanLabel(select) {
    if (!select || !select.value) return '';
    return String(select.selectedOptions?.[0]?.textContent || '').replace(/\s*\(\d+\)\s*$/, '').trim();
}

function getChatRagScopeLabel() {
    return [
        getSelectedOptionCleanLabel(document.getElementById('chat-rag-collection-scope')),
        getSelectedOptionCleanLabel(document.getElementById('chat-rag-tag-scope'))
    ].filter(Boolean).join(' / ');
}

function buildChatRagSummaryUrl() {
    const scope = window.Pivot.legacy.getRagScopeSelection?.('chat') || {};
    const params = new URLSearchParams();
    if (scope.collectionId) params.set('collectionId', String(scope.collectionId));
    const tag = Array.isArray(scope.tagNames) ? scope.tagNames[0] : '';
    if (tag) params.set('tag', tag);
    const query = params.toString();
    return `${API_BASE}/rag/summary${query ? `?${query}` : ''}`;
}

function formatChatRagReadinessText(count) {
    const prefix = getChatRagScopeLabel();
    const text = `${count} \u4efd\u8d44\u6599\u53ef\u7528`;
    return prefix ? `${prefix}\uff1a${text}` : text;
}

async function fetchChatToolReadiness(tool) {
    if (tool === 'rag') {
        const res = await apiFetch(buildChatRagSummaryUrl());
        if (!res.ok) throw new Error('知识库状态获取失败');
        const summary = await res.json();
        const ready = Number(summary.readyEnabled ?? summary.ready ?? 0);
        const processing = Number(summary.processing || 0);
        const error = Number(summary.error || 0);
        if (ready > 0) return { tone: 'ready', text: formatChatRagReadinessText(ready) };
        if (processing > 0) return { tone: 'warning', text: CHAT_TOOL_STATUS_COPY.rag.loading, action: true };
        if (error > 0) return { tone: 'error', text: CHAT_TOOL_STATUS_COPY.rag.error, action: true };
        return { tone: 'warning', text: CHAT_TOOL_STATUS_COPY.rag.empty, action: true };
    }

    if (tool === 'mcp') {
        const res = await apiFetch(`${API_BASE}/mcp/tools`);
        if (!res.ok) throw new Error('工具库状态获取失败');
        const data = await res.json();
        chatMcpToolsCache = Array.isArray(data.tools) ? data.tools : [];
        const count = chatMcpToolsCache.length;
        renderChatMcpToolFilter();
        if (count > 0) return { tone: 'ready', text: `${count} 个工具可用` };
        return { tone: 'warning', text: CHAT_TOOL_STATUS_COPY.mcp.empty, action: true };
    }

    return null;
}

let chatToolReadinessRequestId = 0;

async function updateChatToolReadiness({ silent = false } = {}) {
    const enabledTools = getEnabledChatTools();
    if (!enabledTools.length) {
        renderChatToolStatus([]);
        return;
    }

    const requestId = ++chatToolReadinessRequestId;
    if (!silent) {
        renderChatToolStatus(enabledTools.map(tool => ({
            tool,
            tone: 'ready',
            text: CHAT_TOOL_STATUS_COPY[tool]?.checking || '正在检查状态。'
        })));
    }

    const readiness = await Promise.all(enabledTools.map(async tool => {
        try {
            const item = await fetchChatToolReadiness(tool);
            return { tool, ...item };
        } catch (e) {
            return {
                tool,
                tone: 'warning',
                text: CHAT_TOOL_STATUS_COPY[tool]?.offline || '状态暂时无法确认。',
                action: true
            };
        }
    }));

    if (requestId === chatToolReadinessRequestId) renderChatToolStatus(readiness);
}

async function toggleChatTool(button) {
    const tool = getChatToolName(button);
    const storageKey = CHAT_TOOL_TOGGLE_STORAGE[tool];
    const enabled = button.dataset.enabled !== 'true' && button.getAttribute('aria-pressed') !== 'true' && button.checked !== true;
    button.dataset.lastToggleAt = String(Date.now());
    if (tool === 'mcp' && enabled) {
        const confirmed = await (window.Pivot.legacy.ensureChatMcpConsent?.() || Promise.resolve(true));
        if (!confirmed) {
            setChatToolToggleState(button, false);
            if (storageKey) localStorage.setItem(storageKey, 'false');
            return;
        }
    }
    setChatToolToggleState(button, enabled);
    if (storageKey) localStorage.setItem(storageKey, enabled ? 'true' : 'false');
    await updateChatToolReadiness();
}

async function handleChatToolToggleEvent(event) {
    const button = findChatToolToggle(event.target);
    if (!button || button.disabled) return;
    if (event.type === 'click' && Date.now() - Number(button.dataset.lastToggleAt || 0) < 450) {
        event.preventDefault();
        event.stopPropagation();
        return;
    }
    event.preventDefault();
    event.stopPropagation();
    await toggleChatTool(button);
}

syncChatToolToggles();
document.addEventListener('DOMContentLoaded', syncChatToolToggles);
window.addEventListener('pageshow', syncChatToolToggles);
document.addEventListener('pointerdown', handleChatToolToggleEvent, true);
document.addEventListener('click', handleChatToolToggleEvent, true);
document.addEventListener('click', (event) => {
    const action = event.target.closest('[data-chat-tool-status-action]');
    if (!action) return;
    event.preventDefault();
    const tool = action.dataset.chatToolStatusAction;
    if (tool === 'rag') window.Pivot.moduleApi('workspaces.navigation').openKnowledgeWorkbench?.();
    if (tool === 'mcp') window.Pivot.moduleApi('workspaces.navigation').openMcpWorkbench?.();
});
document.addEventListener('change', async (event) => {
    if (event.target?.id === 'chat-rag-collection-scope') {
        if (typeof window.Pivot.legacy.handleRagCollectionScopeChange === 'function') {
            await window.Pivot.legacy.handleRagCollectionScopeChange('chat');
        } else {
            window.Pivot.legacy.updateChatToolReadiness?.({ silent: true });
        }
        return;
    }
    if (event.target?.id !== 'chat-rag-tag-scope') return;
    window.Pivot.legacy.updateChatToolReadiness?.({ silent: true });
});
window.Pivot.legacy.setChatToolToggleState = setChatToolToggleState;
window.Pivot.legacy.syncChatToolToggles = syncChatToolToggles;
window.Pivot.legacy.syncChatRagScopeControls = syncChatRagScopeControls;
window.Pivot.legacy.updateChatToolReadiness = updateChatToolReadiness;
updateChatToolReadiness({ silent: true });

const MAIN_WORKSPACE_STORAGE_KEY = 'pivot_active_workspace';
const RETURN_WORKSPACE_STORAGE_KEY = 'pivot_return_workspace';
const SETTINGS_TAB_STORAGE_KEY = 'pivot_settings_tab';
const ACTIVE_CHAT_SESSION_STORAGE_KEY = 'pivot_active_chat_session';
const PRINT_WORKSPACE_SESSION_KEY = 'pivot_print_session';
const RESTORABLE_WORKSPACES = new Set(['personal', 'chat', 'apps', 'agent', 'agent-dag', 'knowledge', 'mcp', 'manual', 'settings', 'print']);

const WORKSPACE_SCRIPT_GROUPS = {
    apps: [
        '/chat/apps-model-selector.js', '/chat/apps-workbench-core.js', '/chat/apps-workbench-editor.js',
        '/chat/apps-workbench-proofread.js', '/chat/apps-workbench-ai.js', '/chat/apps-workbench-rewrite.js',
        '/chat/apps-workbench-export.js', '/chat/apps-workbench-rag.js', '/chat/apps-workbench-regulations.js',
        '/chat/apps-workbench-ocr.js', '/chat/apps-workbench-pdf-tools.js'
    ],
    agent: [
        '/chat/dag-core.js', '/chat/dag-render.js', '/chat/dag-node-presets.js', '/chat/dag-interaction.js',
        '/chat/dag-toolbar-tools.js', '/chat/dag-toolbar-db.js', '/chat/dag-toolbar.js', '/chat/dag-toolbar-field-overrides.js',
        '/chat/dag-toolbar-fields.js', '/chat/dag-wizard-db.js', '/chat/dag-query-builder.js', '/chat/dag-wizard-input.js',
        '/chat/dag-wizard-fields.js', '/chat/dag-wizard-stats.js', '/chat/dag-wizard.js', '/chat/dag-variable-picker.js', '/chat/dag-timeline-waterfall.js', '/chat/dag-governance.js', '/chat/dag-inspector.js',
        '/chat/agent-dag-node-library.js', '/chat/agents-dag-editor.js', '/chat/agents.js', '/chat/agent-run-renderers.js',
        '/chat/agent-run-utils.js', '/chat/agent-run-tool-labels.js', '/chat/agent-run-embed-renderers.js', '/chat/agent-run-step-renderers.js', '/chat/agent-run-visuals.js',
        '/chat/agent-run-loaders.js', '/chat/agent-run-detail.js', '/chat/agent-runtime-packs-console.js', '/chat/agent-harness.js',
        '/chat/agent-skill-management.js', '/chat/agent-run-realtime.js', '/chat/agent-run-actions.js', '/chat/agent-runs-list.js',
        '/chat/agent-workflow-library.js', '/chat/agent-automation-resources.js', '/chat/agent-workflow-versions.js',
        '/chat/agent-workflow-editor.js', '/chat/agent-workflow-core.js', '/chat/agent-workflow-runners.js', '/chat/agent-workflows.js',
        '/chat/agent-templates.js', '/chat/agent-schedules.js', '/chat/agent-workflow-schedules.js', '/chat/agent-artifacts.js',
        '/chat/agent-evaluations.js'
    ],
    knowledge: [
        '/chat/rag-graph-layout.js', '/chat/rag-graph-render.js', '/chat/rag-graph-ui.js',
        '/chat/rag.js', '/chat/rag-graph-controller.js'
    ],
    mcp: [
        '/chat/tool-policy.js', '/chat/mcp-workbench-common.js', '/chat/mcp-workbench-local-auth.js',
        '/chat/mcp-workbench-credentials.js', '/chat/agent-automation-resources.js',
        '/chat/mcp-workbench-form.js', '/chat/mcp-workbench-actions.js', '/chat/mcp-workbench-main.js'
    ]
};

// 工作流编排器复用 Agent 脚本，但 DOM 根节点独立。此前只加载 agent 模板后
// 就切换到 agent-dag，导致原面板隐藏而目标面板不存在，页面呈现为空白。
const WORKSPACE_MARKUP_DEPENDENCIES = Object.freeze({
    'agent-dag': ['agent', 'agent-dag']
});
const WORKSPACE_SCRIPT_GROUP_ALIASES = Object.freeze({
    'agent-dag': 'agent'
});
const LAZY_WORKSPACE_OPENERS = Object.freeze({
    apps: 'openAppsWorkbench',
    agent: 'openAgentWorkbench',
    'agent-dag': 'openAgentDagWorkbench',
    knowledge: 'openKnowledgeWorkbench',
    mcp: 'openMcpWorkbench',
    settings: 'openAdminPanel'
});
const WORKSPACE_PANEL_IDS = Object.freeze({
    personal: 'personal-workbench-modal',
    chat: 'chat-workspace-view',
    apps: 'apps-workbench-modal',
    agent: 'agent-workbench-modal',
    'agent-dag': 'agent-dag-workbench-modal',
    knowledge: 'knowledge-workbench-modal',
    mcp: 'mcp-workbench-modal',
    manual: 'manual-workbench-modal',
    print: 'print-workbench-modal',
    settings: 'admin-container'
});
const AUTOMATION_WORKSPACES = Object.freeze(['agent', 'agent-dag']);
function showWorkspaceWithStyleGate(...args) {
    return (window.Pivot.moduleApi?.('workspaces.styleLoader')?.showWorkspaceWithStyleGate || showMainWorkspace)(...args);
}
function prewarmAutomationWorkspaces(...args) {
    return window.Pivot.moduleApi?.('workspaces.styleLoader')?.prewarmAutomationWorkspaces?.(...args);
}

const workspaceLoadPromises = {};

async function ensureWorkspaceScripts(name) {
    const ensureMarkup = window.Pivot.moduleApi?.('workspaces.templateLoader')?.ensureWorkspaceMarkup;
    if (typeof ensureMarkup !== 'function') throw new Error('工作区模板加载器尚未就绪');
    // 样式资源不可成为功能入口的单点阻塞：首帧只给它一个短暂就绪窗口，
    // 代理、缓存或升级短暂不一致时仍会按时挂载模板与交互脚本。
    const styleLoader = window.Pivot.moduleApi?.('workspaces.styleLoader');
    let stylesReady = Promise.resolve(false);
    if (typeof styleLoader?.waitForWorkspaceStyles === 'function') {
        stylesReady = styleLoader.waitForWorkspaceStyles(name).then(loaded => {
            if (!loaded) console.warn(`工作区 ${name} 样式未在首帧窗口内就绪，已继续挂载功能入口。`);
            return loaded;
        });
    } else if (typeof styleLoader?.ensureWorkspaceStyles === 'function') {
        stylesReady = styleLoader.ensureWorkspaceStyles(name).then(() => true).catch(error => {
            console.warn(`工作区 ${name} 样式加载失败，已保持功能可用：`, error);
            return false;
        });
    } else {
        console.warn(`工作区 ${name} 样式加载器未就绪，已继续挂载功能入口。`);
    }
    const markupNames = WORKSPACE_MARKUP_DEPENDENCIES[name] || [name];
    for (const markupName of markupNames) await ensureMarkup(markupName);
    const scriptGroup = WORKSPACE_SCRIPT_GROUP_ALIASES[name] || name;
    if (!WORKSPACE_SCRIPT_GROUPS[scriptGroup]) return;
    if (!workspaceLoadPromises[scriptGroup]) {
        workspaceLoadPromises[scriptGroup] = (window.Pivot?.loadScripts
            ? window.Pivot.loadScripts(WORKSPACE_SCRIPT_GROUPS[scriptGroup])
            : Promise.reject(new Error(`无法加载 ${name} 工作区脚本`)))
            .catch(error => {
                delete workspaceLoadPromises[scriptGroup];
                throw error;
            });
    }
    await workspaceLoadPromises[scriptGroup];
    await stylesReady;
}

window.Pivot.legacy.ensureWorkspaceScripts = ensureWorkspaceScripts;

function getStoredSessionValue(key) {
    try {
        return sessionStorage.getItem(key) || '';
    } catch (e) {
        return '';
    }
}

function setStoredSessionValue(key, value) {
    try {
        sessionStorage.setItem(key, value);
    } catch (e) {
        // 浏览器禁用 sessionStorage 时仅退回默认入口。
    }
}

function removeStoredSessionValue(key) {
    try { sessionStorage.removeItem(key); } catch (e) {}
}

window.Pivot.legacy.getStoredMainWorkspace = function() {
    const view = getStoredSessionValue(MAIN_WORKSPACE_STORAGE_KEY);
    return RESTORABLE_WORKSPACES.has(view) ? view : 'personal';
};

window.Pivot.legacy.getReturnWorkspace = function() {
    const stored = getStoredSessionValue(RETURN_WORKSPACE_STORAGE_KEY);
    return ['personal', 'chat'].includes(stored) ? stored : 'personal';
};

function returnFromWorkspace(fallback = 'personal') {
    const target = window.Pivot.legacy.getReturnWorkspace?.() || fallback;
    return showMainWorkspace(target);
}

window.Pivot.legacy.persistSettingsTab = function(tab) {
    if (tab) setStoredSessionValue(SETTINGS_TAB_STORAGE_KEY, tab);
};

window.Pivot.legacy.getStoredSettingsTab = function() {
    return getStoredSessionValue(SETTINGS_TAB_STORAGE_KEY);
};

window.Pivot.legacy.persistActiveChatSession = function(sessionId) {
    if (!sessionId) return removeStoredSessionValue(ACTIVE_CHAT_SESSION_STORAGE_KEY);
    setStoredSessionValue(ACTIVE_CHAT_SESSION_STORAGE_KEY, String(sessionId));
};

window.Pivot.legacy.getStoredActiveChatSession = function() {
    return getStoredSessionValue(ACTIVE_CHAT_SESSION_STORAGE_KEY);
};

window.Pivot.legacy.persistPrintWorkspaceSession = function(sessionId) {
    if (!sessionId) return removeStoredSessionValue(PRINT_WORKSPACE_SESSION_KEY);
    setStoredSessionValue(PRINT_WORKSPACE_SESSION_KEY, String(sessionId));
};

window.Pivot.legacy.getStoredPrintWorkspaceSession = function() {
    return getStoredSessionValue(PRINT_WORKSPACE_SESSION_KEY);
};

function showMainWorkspace(view = 'personal') {
    const target = ['personal', 'chat', 'apps', 'agent', 'agent-dag', 'knowledge', 'mcp', 'manual', 'print', 'settings'].includes(view) ? view : 'personal';
    const current = document.body?.dataset.activeWorkspace;
    if (['personal', 'chat'].includes(target)) {
        setStoredSessionValue(RETURN_WORKSPACE_STORAGE_KEY, target);
    } else if (current && ['personal', 'chat'].includes(current)) {
        setStoredSessionValue(RETURN_WORKSPACE_STORAGE_KEY, current);
    }
    if (document.body?.dataset.activeWorkspace === 'apps' && target !== 'apps') {
        window.Pivot.legacy.PivotDataAnalysis?.resetAiWorkspace?.();
    }
    const chatContainer = document.querySelector('.chat-container');
    const isFullWorkspace = target !== 'chat';
    const viewMap = WORKSPACE_PANEL_IDS;
    const targetPanel = document.getElementById(viewMap[target]);
    const lazyOpener = LAZY_WORKSPACE_OPENERS[target];
    if (isFullWorkspace && lazyOpener && !targetPanel) {
        // 不允许先隐藏当前面板再显示一个尚未挂载的目标面板。所有懒加载工作区
        // 必须回到标准入口，由入口完成模板、脚本和数据初始化。
        const openWorkspace = window.Pivot.moduleApi?.('workspaces.navigation')?.[lazyOpener];
        if (typeof openWorkspace === 'function') return openWorkspace(target === 'settings' ? { restore: true } : {});
        console.warn(`工作区 ${target} 尚未挂载，已保留当前页面。`);
        return current || 'personal';
    }
    if (isFullWorkspace && chatContainer) {
        if (targetPanel && targetPanel.parentElement !== chatContainer) {
            chatContainer.appendChild(targetPanel);
        }
    }
    Object.entries(viewMap).forEach(([key, id]) => {
        const panel = document.getElementById(id);
        panel?.classList.toggle('hidden', key !== target);
        if (key === 'apps') panel?.setAttribute('aria-hidden', key === target ? 'false' : 'true');
    });
    document.querySelectorAll('.sidebar-tool-btn[data-workspace-view]').forEach(btn => {
        const view = btn.dataset.workspaceView;
        const isAutomation = view === 'automation' && (target === 'agent' || target === 'agent-dag');
        btn.classList.toggle('active', view === target || isAutomation);
    });
    document.querySelectorAll('.footer-mini-btn[data-workspace-view]').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.workspaceView === target);
    });
    chatContainer?.setAttribute('data-active-workspace', target);
    document.body?.setAttribute('data-active-workspace', target);
    document.body?.classList.toggle('is-main-workspace-full', isFullWorkspace);
    if (target === 'chat' && !window.matchMedia('(max-width: 720px)').matches) {
        const drawerState = window.Pivot.legacy.readChatSidebarDrawerState
            ? window.Pivot.legacy.readChatSidebarDrawerState()
            : true;
        const shouldOpen = current === 'personal' ? (drawerState !== false) : drawerState;
        window.Pivot.legacy.setChatSidebarDrawerOpen?.(shouldOpen, { persist: false });
    }
    if (RESTORABLE_WORKSPACES.has(target)) setStoredSessionValue(MAIN_WORKSPACE_STORAGE_KEY, target);
    if (target === 'manual') window.Pivot.legacy.ensureManualFrameLoaded?.();
    if (target === 'personal') window.Pivot.moduleApi?.('workspaces.personal')?.loadPersonalWorkbench?.({ silent: true });
    if (target !== 'agent' && target !== 'agent-dag') window.Pivot.legacy.updateAgentAutoRefresh?.();
    if (target === 'settings') window.Pivot.legacy.scheduleSettingsWorkspaceScale?.();
    return target;
}

function createLazyWorkspaceEntrypoint(group, functionName) {
    const loadedImplementation = typeof window.Pivot.legacy[functionName] === 'function' ? window.Pivot.legacy[functionName] : null;
    const lazyEntrypoint = async (...args) => {
        await ensureWorkspaceScripts(group);
        const entrypoint = window.Pivot.moduleApi?.('workspaces.implementations')?.[functionName]
            || window.Pivot.legacy[functionName];
        const implementation = entrypoint === lazyEntrypoint ? loadedImplementation : entrypoint;
        if (typeof implementation !== 'function') {
            throw new Error(`${group} 工作区入口未就绪`);
        }
        return implementation(...args);
    };
    return lazyEntrypoint;
}

async function openPersonalWorkbenchEntrypoint(...args) {
    const implementation = window.Pivot.moduleApi?.('workspaces.implementations')?.openPersonalWorkbench;
    if (typeof implementation !== 'function') throw new Error('个人工作台入口未就绪');
    return implementation(...args);
}
const openAppsWorkbenchEntrypoint = createLazyWorkspaceEntrypoint('apps', 'openAppsWorkbench');
const openAgentWorkbenchEntrypoint = createLazyWorkspaceEntrypoint('agent', 'openAgentWorkbench');
const openAgentDagWorkbenchEntrypoint = createLazyWorkspaceEntrypoint('agent-dag', 'openAgentDagWorkbench');
const openKnowledgeWorkbenchEntrypoint = createLazyWorkspaceEntrypoint('knowledge', 'openKnowledgeWorkbench');
const openMcpWorkbenchEntrypoint = createLazyWorkspaceEntrypoint('mcp', 'openMcpWorkbench');
const openAdminPanelEntrypoint = createLazyWorkspaceEntrypoint('settings', 'openAdminPanel');
window.Pivot?.exposeModule?.('workspaces.navigation', {
    showMainWorkspace,
    returnFromWorkspace,
    openPersonalWorkbench: openPersonalWorkbenchEntrypoint,
    openAppsWorkbench: openAppsWorkbenchEntrypoint,
    openAgentWorkbench: openAgentWorkbenchEntrypoint,
    openAgentDagWorkbench: openAgentDagWorkbenchEntrypoint,
    openKnowledgeWorkbench: openKnowledgeWorkbenchEntrypoint,
    openMcpWorkbench: openMcpWorkbenchEntrypoint,
    openAdminPanel: openAdminPanelEntrypoint,
    showWorkspaceWithStyleGate,
    prewarmAutomationWorkspaces,
    openManualWorkbench: () => showMainWorkspace('manual'),
    closeManualWorkbench: () => returnFromWorkspace()
});

const closeWs = ws => () => { if (document.body?.dataset.activeWorkspace === ws) returnFromWorkspace(); };
window.Pivot.legacy.closeAgentWorkbench = closeWs('agent');
window.Pivot.legacy.closeKnowledgeWorkbench = closeWs('knowledge');
window.Pivot.legacy.closeMcpWorkbench = closeWs('mcp');
window.Pivot.legacy.closePersonalWorkbench = () => showMainWorkspace('chat');

window.Pivot.legacy.restoreMainWorkspaceAfterLogin = async function() {
    const view = window.Pivot.legacy.getStoredMainWorkspace?.() || 'personal';
    const openers = { settings: () => openAdminPanelEntrypoint({ restore: true }), personal: () => openPersonalWorkbenchEntrypoint(), apps: () => openAppsWorkbenchEntrypoint(), knowledge: () => openKnowledgeWorkbenchEntrypoint(), mcp: () => openMcpWorkbenchEntrypoint(), 'agent-dag': () => openAgentDagWorkbenchEntrypoint(), agent: () => openAgentWorkbenchEntrypoint(), manual: () => showMainWorkspace('manual') };
    if (openers[view]) return openers[view]();
    if (view === 'print' && window.Pivot.legacy.openPrintWorkbench) {
        const sessionId = window.Pivot.legacy.getStoredPrintWorkspaceSession?.() || window.Pivot.legacy.getStoredActiveChatSession?.();
        if (sessionId) return window.Pivot.legacy.openPrintWorkbench(sessionId);
    }
    if (view === 'chat') {
        const sessionId = window.Pivot.legacy.getStoredActiveChatSession?.();
        if (sessionId && window.Pivot.legacy.selectSession) return window.Pivot.legacy.selectSession(sessionId, undefined, { restore: true });
        return showMainWorkspace('chat');
    }
    return window.Pivot.moduleApi?.('workspaces.implementations')?.openPersonalWorkbench
        ? openPersonalWorkbenchEntrypoint()
        : showMainWorkspace('personal');
};

window.Pivot.legacy.ensureManualFrameLoaded = () => {
    const frame = document.getElementById('manual-frame');
    if (!frame || frame.getAttribute('src')) return;
    frame.setAttribute('src', frame.dataset.src || '/manual?embed=1');
};

window.Pivot.legacy.openManualWorkbench = () => showMainWorkspace('manual');
window.Pivot.legacy.closeManualWorkbench = () => returnFromWorkspace();

// 会话打印 / 导出 PDF 工作区：在主工作区内通过 iframe 加载嵌入视图
window.Pivot.legacy.openPrintWorkbench = (sessionId) => {
    if (!sessionId) return;
    window.Pivot.legacy.persistPrintWorkspaceSession?.(sessionId);
    const frame = document.getElementById('print-frame');
    if (frame) {
        const nextSrc = `${API_BASE}/sessions/${encodeURIComponent(sessionId)}/print?embed=1`;
        if (frame.getAttribute('src') !== nextSrc) frame.setAttribute('src', nextSrc);
    }
    showMainWorkspace('print');
};
window.Pivot.legacy.closePrintWorkbench = () => returnFromWorkspace();
