/* 智枢前端主程序 */

// --- 输入框自适应 ---
const userInput = document.getElementById('user-input');
const CHAT_MCP_TOOL_ALLOWLIST_KEY = 'pivot_chat_mcp_tool_allowlist';
const CHAT_MCP_TOOL_MODE_KEY = 'pivot_chat_mcp_tool_mode';
let chatMcpToolsCache = [];

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
    document.addEventListener('click', event => {
        if (!event.target.closest('#chat-tools-menu')) setChatToolsMenuOpen(false);
    });
    document.addEventListener('keydown', event => {
        if (event.key === 'Escape') setChatToolsMenuOpen(false);
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
            await window.handleRagCollectionScopeChange?.('chat');
            window.updateChatToolReadiness?.({ silent: true });
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
}
initChatToolsMenu();
document.addEventListener('DOMContentLoaded', initChatToolsMenu);
window.Pivot.exposeModule('chat.inputMenu', {
    getMcpToolAllowlist: getChatMcpToolAllowlist,
    setOpen: setChatToolsMenuOpen
});
window.resizeUserInput = () => {
    if (!userInput) return;
    userInput.style.height = 'auto';
    const sh = userInput.scrollHeight;
    if (sh > 56) {
        userInput.style.height = `${Math.min(sh, 180)}px`;
    } else {
        userInput.style.height = '56px';
    }
};
userInput?.addEventListener('input', resizeUserInput);
userInput && (userInput.onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); } });

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
    if (button.id === 'chat-rag-enabled') return 'rag';
    if (button.id === 'chat-mcp-enabled') return 'mcp';
    if (button.querySelector?.('#chat-rag-enabled')) return 'rag';
    if (button.querySelector?.('#chat-mcp-enabled')) return 'mcp';
    return '';
}

function syncChatRagScopeControls() {
    const ragButton = document.getElementById('chat-rag-enabled') || document.querySelector('[data-chat-tool-toggle="rag"]');
    const pressed = ragButton?.getAttribute('aria-pressed');
    const enabled = Boolean(ragButton) && (
        pressed === 'true'
        || (pressed !== 'false' && (
            ragButton.dataset.enabled === 'true'
            || ragButton.classList.contains('is-active')
            || ragButton.checked === true
        ))
    );
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
    if (refreshReadiness && typeof window.updateChatToolReadiness === 'function') window.updateChatToolReadiness({ silent: true });
}

function syncChatToolToggles() {
    document.querySelectorAll('[data-chat-tool-toggle], #chat-rag-enabled, #chat-mcp-enabled').forEach(button => {
        const tool = getChatToolName(button);
        const storageKey = CHAT_TOOL_TOGGLE_STORAGE[tool];
        setChatToolToggleState(button, storageKey ? localStorage.getItem(storageKey) === 'true' : button.dataset.enabled === 'true', { refreshReadiness: false });
    });
    syncChatRagScopeControls();
    if (typeof window.updateChatToolReadiness === 'function') window.updateChatToolReadiness({ silent: true });
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
    const option = select.selectedOptions?.[0];
    return String(option?.textContent || '')
        .replace(/\s*\(\d+\)\s*$/, '')
        .trim();
}

function getChatRagScopeLabel() {
    const labels = [
        getSelectedOptionCleanLabel(document.getElementById('chat-rag-collection-scope')),
        getSelectedOptionCleanLabel(document.getElementById('chat-rag-tag-scope'))
    ].filter(Boolean);
    return labels.join(' / ');
}

function buildChatRagSummaryUrl() {
    const scope = window.getRagScopeSelection?.('chat') || {};
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
        const confirmed = await (window.ensureChatMcpConsent?.() || Promise.resolve(true));
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
    if (tool === 'rag') window.openKnowledgeWorkbench?.();
    if (tool === 'mcp') window.openMcpWorkbench?.();
});
document.addEventListener('change', async (event) => {
    if (event.target?.id === 'chat-rag-collection-scope') {
        if (typeof window.handleRagCollectionScopeChange === 'function') {
            await window.handleRagCollectionScopeChange('chat');
        } else {
            window.updateChatToolReadiness?.({ silent: true });
        }
        return;
    }
    if (event.target?.id !== 'chat-rag-tag-scope') return;
    window.updateChatToolReadiness?.({ silent: true });
});
window.setChatToolToggleState = setChatToolToggleState;
window.syncChatToolToggles = syncChatToolToggles;
window.syncChatRagScopeControls = syncChatRagScopeControls;
window.updateChatToolReadiness = updateChatToolReadiness;
updateChatToolReadiness({ silent: true });

const MAIN_WORKSPACE_STORAGE_KEY = 'pivot_active_workspace';
const SETTINGS_TAB_STORAGE_KEY = 'pivot_settings_tab';
const ACTIVE_CHAT_SESSION_STORAGE_KEY = 'pivot_active_chat_session';
const PRINT_WORKSPACE_SESSION_KEY = 'pivot_print_session';
const RESTORABLE_WORKSPACES = new Set(['chat', 'apps', 'agent', 'agent-dag', 'knowledge', 'mcp', 'manual', 'settings', 'print']);

const WORKSPACE_SCRIPT_GROUPS = {
    apps: [
        '/chat/apps-workbench-core.js',
        '/chat/apps-workbench-editor.js',
        '/chat/apps-workbench-proofread.js',
        '/chat/apps-workbench-ai.js',
        '/chat/apps-workbench-rewrite.js',
        '/chat/apps-workbench-export.js',
        '/chat/apps-workbench-rag.js',
        '/chat/apps-workbench-regulations.js',
        '/chat/apps-workbench-ocr.js',
        '/chat/apps-workbench-pdf-tools.js'
    ],
    agent: [
        '/chat/dag-core.js',
        '/chat/dag-render.js',
        '/chat/dag-node-presets.js',
        '/chat/dag-interaction.js',
        '/chat/dag-toolbar-tools.js',
        '/chat/dag-toolbar-db.js',
        '/chat/dag-toolbar.js',
        '/chat/dag-toolbar-field-overrides.js',
        '/chat/dag-toolbar-fields.js',
        '/chat/dag-wizard-db.js',
        '/chat/dag-query-builder.js',
        '/chat/dag-wizard-input.js',
        '/chat/dag-wizard-fields.js',
        '/chat/dag-wizard-stats.js',
        '/chat/dag-wizard.js',
        '/chat/dag-inspector.js',
        '/chat/agent-dag-node-library.js',
        '/chat/agents-dag-editor.js',
        '/chat/agents.js',
        '/chat/agent-run-renderers.js',
        '/chat/agent-run-utils.js',
        '/chat/agent-run-tool-labels.js',
        '/chat/agent-run-step-renderers.js',
        '/chat/agent-run-visuals.js',
        '/chat/agent-run-loaders.js',
        '/chat/agent-run-detail.js',
        '/chat/agent-harness.js',
        '/chat/agent-run-realtime.js',
        '/chat/agent-run-actions.js',
        '/chat/agent-runs-list.js',
        '/chat/agent-workflow-library.js',
        '/chat/agent-automation-resources.js',
        '/chat/agent-workflow-versions.js',
        '/chat/agent-workflow-editor.js',
        '/chat/agent-workflow-core.js',
        '/chat/agent-workflow-runners.js',
        '/chat/agent-workflows.js',
        '/chat/agent-templates.js',
        '/chat/agent-schedules.js',
        '/chat/agent-workflow-schedules.js',
        '/chat/agent-artifacts.js',
        '/chat/agent-evaluations.js'
    ],
    knowledge: [
        '/chat/rag-graph-layout.js',
        '/chat/rag-graph-render.js',
        '/chat/rag-graph-ui.js',
        '/chat/rag.js',
        '/chat/rag-graph-controller.js'
    ],
    mcp: [
        '/chat/tool-policy.js',
        '/chat/mcp-workbench-common.js',
        '/chat/mcp-workbench-local-auth.js',
        '/chat/mcp-workbench-form.js',
        '/chat/mcp-workbench-main.js'
    ]
};

const workspaceLoadPromises = {};

async function ensureWorkspaceScripts(name) {
    if (!WORKSPACE_SCRIPT_GROUPS[name]) return;
    if (!workspaceLoadPromises[name]) {
        workspaceLoadPromises[name] = window.Pivot?.loadScripts
            ? window.Pivot.loadScripts(WORKSPACE_SCRIPT_GROUPS[name])
            : Promise.reject(new Error(`无法加载 ${name} 工作区脚本`));
    }
    return workspaceLoadPromises[name];
}

window.ensureWorkspaceScripts = ensureWorkspaceScripts;

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
    try {
        sessionStorage.removeItem(key);
    } catch (e) {
        // 浏览器禁用 sessionStorage 时仅退回默认入口。
    }
}

window.getStoredMainWorkspace = function() {
    const view = getStoredSessionValue(MAIN_WORKSPACE_STORAGE_KEY);
    return RESTORABLE_WORKSPACES.has(view) ? view : 'chat';
};

window.persistSettingsTab = function(tab) {
    if (!tab) return;
    setStoredSessionValue(SETTINGS_TAB_STORAGE_KEY, tab);
};

window.getStoredSettingsTab = function() {
    return getStoredSessionValue(SETTINGS_TAB_STORAGE_KEY);
};

window.persistActiveChatSession = function(sessionId) {
    if (!sessionId) return removeStoredSessionValue(ACTIVE_CHAT_SESSION_STORAGE_KEY);
    setStoredSessionValue(ACTIVE_CHAT_SESSION_STORAGE_KEY, String(sessionId));
};

window.getStoredActiveChatSession = function() {
    return getStoredSessionValue(ACTIVE_CHAT_SESSION_STORAGE_KEY);
};

window.persistPrintWorkspaceSession = function(sessionId) {
    if (!sessionId) return removeStoredSessionValue(PRINT_WORKSPACE_SESSION_KEY);
    setStoredSessionValue(PRINT_WORKSPACE_SESSION_KEY, String(sessionId));
};

window.getStoredPrintWorkspaceSession = function() {
    return getStoredSessionValue(PRINT_WORKSPACE_SESSION_KEY);
};

window.showMainWorkspace = function(view = 'chat') {
    const target = ['chat', 'apps', 'agent', 'agent-dag', 'knowledge', 'mcp', 'manual', 'print', 'settings'].includes(view) ? view : 'chat';
    if (document.body?.dataset.activeWorkspace === 'apps' && target !== 'apps') {
        window.PivotDataAnalysis?.resetAiWorkspace?.();
    }
    const chatContainer = document.querySelector('.chat-container');
    const isFullWorkspace = target !== 'chat';
    const viewMap = {
        chat: 'chat-workspace-view',
        apps: 'apps-workbench-modal',
        agent: 'agent-workbench-modal',
        'agent-dag': 'agent-dag-workbench-modal',
        knowledge: 'knowledge-workbench-modal',
        mcp: 'mcp-workbench-modal',
        manual: 'manual-workbench-modal',
        print: 'print-workbench-modal',
        settings: 'admin-container'
    };
    if (isFullWorkspace && chatContainer) {
        const targetPanel = document.getElementById(viewMap[target]);
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
    if (RESTORABLE_WORKSPACES.has(target)) setStoredSessionValue(MAIN_WORKSPACE_STORAGE_KEY, target);
    if (target === 'manual') window.ensureManualFrameLoaded?.();
    if (target !== 'agent' && target !== 'agent-dag') window.updateAgentAutoRefresh?.();
    if (target === 'settings') window.scheduleSettingsWorkspaceScale?.();
    return target;
};

let settingsWorkspaceScaleObserver = null;
let settingsWorkspaceScaleRaf = 0;

window.scheduleSettingsWorkspaceScale = function() {
    if (settingsWorkspaceScaleRaf) window.cancelAnimationFrame(settingsWorkspaceScaleRaf);
    settingsWorkspaceScaleRaf = window.requestAnimationFrame(() => {
        settingsWorkspaceScaleRaf = 0;
        window.updateSettingsWorkspaceScale?.();
    });
};

window.updateSettingsWorkspaceScale = function() {
    const stage = document.getElementById('settings-scale-stage');
    const canvas = document.getElementById('settings-scale-canvas');
    const content = document.querySelector('.settings-workspace-view .admin-content');
    if (!stage || !canvas || !content) return;
    if (window.ResizeObserver && !settingsWorkspaceScaleObserver) {
        settingsWorkspaceScaleObserver = new window.ResizeObserver(() => {
            if (document.body?.dataset.activeWorkspace === 'settings') {
                window.scheduleSettingsWorkspaceScale?.();
            }
        });
        settingsWorkspaceScaleObserver.observe(canvas);
    }
    const baseWidth = 1540;
    const contentStyle = window.getComputedStyle(content);
    const horizontalPadding = (parseFloat(contentStyle.paddingLeft) || 0) + (parseFloat(contentStyle.paddingRight) || 0);
    const verticalPadding = (parseFloat(contentStyle.paddingTop) || 0) + (parseFloat(contentStyle.paddingBottom) || 0);
    const availableWidth = Math.max(1, content.clientWidth - horizontalPadding - 2);
    const availableHeight = Math.max(1, content.clientHeight - verticalPadding - 2);
    // Narrow settings panes use their real width so controls remain readable.
    // Wide tables keep their own horizontal scroll instead of shrinking the
    // entire page to an unusable thumbnail.
    const useResponsiveCanvas = availableWidth < 1100;
    const layoutWidth = useResponsiveCanvas ? availableWidth : Math.max(baseWidth, availableWidth);
    const scale = useResponsiveCanvas ? 1 : Math.min(1, availableWidth / baseWidth);
    const stageWidth = Math.max(1, Math.ceil(layoutWidth * scale));
    const isMonitorTabActive = content.classList.contains('is-monitor-tab-active');
    stage.style.removeProperty('--settings-stage-height');
    canvas.style.setProperty('--settings-canvas-width', `${layoutWidth}px`);
    canvas.style.setProperty('--settings-scale', String(Number(scale.toFixed(4))));
    stage.style.setProperty('--settings-stage-width', `${stageWidth}px`);
    if (isMonitorTabActive) {
        const canvasHeight = Math.max(1, Math.ceil(availableHeight / scale));
        canvas.style.setProperty('--settings-canvas-height', `${canvasHeight}px`);
        stage.style.setProperty('--settings-stage-height', `${availableHeight}px`);
        return;
    }
    canvas.style.removeProperty('--settings-canvas-height');
    window.requestAnimationFrame(() => {
        const measuredHeight = Math.ceil(canvas.scrollHeight * scale);
        const scaledHeight = measuredHeight > availableHeight + 2 ? measuredHeight : availableHeight;
        stage.style.setProperty('--settings-stage-height', `${scaledHeight}px`);
    });
};

window.addEventListener('resize', () => {
    if (document.body?.dataset.activeWorkspace === 'settings') {
        window.scheduleSettingsWorkspaceScale?.();
    }
});

function createLazyWorkspaceEntrypoint(group, functionName) {
    const loadedImplementation = typeof window[functionName] === 'function' ? window[functionName] : null;
    const lazyEntrypoint = async (...args) => {
        await ensureWorkspaceScripts(group);
        const entrypoint = window[functionName];
        const implementation = entrypoint === lazyEntrypoint ? loadedImplementation : entrypoint;
        if (typeof implementation !== 'function') {
            throw new Error(`${group} 工作区入口未就绪`);
        }
        return implementation(...args);
    };
    return lazyEntrypoint;
}

const openAppsWorkbenchEntrypoint = createLazyWorkspaceEntrypoint('apps', 'openAppsWorkbench');
window.openAppsWorkbench = openAppsWorkbenchEntrypoint;
window.openAgentWorkbench = createLazyWorkspaceEntrypoint('agent', 'openAgentWorkbench');
window.openAgentDagWorkbench = createLazyWorkspaceEntrypoint('agent', 'openAgentDagWorkbench');
window.openKnowledgeWorkbench = createLazyWorkspaceEntrypoint('knowledge', 'openKnowledgeWorkbench');
window.openMcpWorkbench = createLazyWorkspaceEntrypoint('mcp', 'openMcpWorkbench');
window.Pivot?.exposeModule?.('workspaces.apps', {
    openAppsWorkbench: openAppsWorkbenchEntrypoint
});

window.closeAgentWorkbench = () => {
    if (document.body?.dataset.activeWorkspace === 'agent') window.showMainWorkspace?.('chat');
};
window.closeKnowledgeWorkbench = () => {
    if (document.body?.dataset.activeWorkspace === 'knowledge') window.showMainWorkspace?.('chat');
};
window.closeMcpWorkbench = () => {
    if (document.body?.dataset.activeWorkspace === 'mcp') window.showMainWorkspace?.('chat');
};

window.restoreMainWorkspaceAfterLogin = async function() {
    const view = window.getStoredMainWorkspace?.() || 'chat';
    if (view === 'settings' && window.openAdminPanel) return window.openAdminPanel({ restore: true });
    if (view === 'apps' && window.openAppsWorkbench) return window.openAppsWorkbench();
    if (view === 'knowledge' && window.openKnowledgeWorkbench) return window.openKnowledgeWorkbench();
    if (view === 'mcp' && window.openMcpWorkbench) return window.openMcpWorkbench();
    if (view === 'agent-dag' && window.openAgentDagWorkbench) return window.openAgentDagWorkbench();
    if (view === 'agent' && window.openAgentWorkbench) return window.openAgentWorkbench();
    if (view === 'manual') return window.showMainWorkspace?.('manual');
    if (view === 'print' && window.openPrintWorkbench) {
        const sessionId = window.getStoredPrintWorkspaceSession?.() || window.getStoredActiveChatSession?.();
        if (sessionId) return window.openPrintWorkbench(sessionId);
    }
    if (view === 'chat') {
        const sessionId = window.getStoredActiveChatSession?.();
        if (sessionId && window.selectSession) return window.selectSession(sessionId, undefined, { restore: true });
    }
    return window.showMainWorkspace?.('chat');
};

window.ensureManualFrameLoaded = () => {
    const frame = document.getElementById('manual-frame');
    if (!frame || frame.getAttribute('src')) return;
    frame.setAttribute('src', frame.dataset.src || '/manual?embed=1');
};

window.openManualWorkbench = () => window.showMainWorkspace?.('manual');
window.closeManualWorkbench = () => window.showMainWorkspace?.('chat');

// 会话打印 / 导出 PDF 工作区：在主工作区内通过 iframe 加载嵌入视图
window.openPrintWorkbench = (sessionId) => {
    if (!sessionId) return;
    window.persistPrintWorkspaceSession?.(sessionId);
    const frame = document.getElementById('print-frame');
    if (frame) {
        const nextSrc = `${API_BASE}/sessions/${encodeURIComponent(sessionId)}/print?embed=1`;
        if (frame.getAttribute('src') !== nextSrc) frame.setAttribute('src', nextSrc);
    }
    window.showMainWorkspace?.('print');
};
window.closePrintWorkbench = () => window.showMainWorkspace?.('chat');

// --- 全局确认弹窗 ---
