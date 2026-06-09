/* 智枢前端主程序 Main Entry */
/* exported handleUnauthorized */
function handleUnauthorized() {
    localStorage.removeItem('pivot_token');
    if (typeof setCsrfToken === 'function') setCsrfToken('');
    if (window.showAuth) window.showAuth();
}

// --- 输入框自适应 ---
const userInput = document.getElementById('user-input');
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
        label: '工具箱',
        ready: '已打开，可按需调用。',
        checking: '检查中',
        empty: '暂无可用工具',
        loading: '检查中',
        error: '状态异常',
        offline: '状态未确认',
        action: '打开工具箱'
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

function setChatToolToggleState(button, enabled, { refreshReadiness = true } = {}) {
    if (!button) return;
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
    if (refreshReadiness && typeof window.updateChatToolReadiness === 'function') window.updateChatToolReadiness({ silent: true });
}

function syncChatToolToggles() {
    document.querySelectorAll('[data-chat-tool-toggle], #chat-rag-enabled, #chat-mcp-enabled').forEach(button => {
        const tool = getChatToolName(button);
        const storageKey = CHAT_TOOL_TOGGLE_STORAGE[tool];
        setChatToolToggleState(button, storageKey ? localStorage.getItem(storageKey) === 'true' : button.dataset.enabled === 'true', { refreshReadiness: false });
    });
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
    status.innerHTML = '';
    status.classList.toggle('hidden', items.length === 0);
    status.classList.toggle('has-warning', items.some(item => item.tone === 'warning'));
    status.classList.toggle('has-error', items.some(item => item.tone === 'error'));
    items.forEach(item => status.appendChild(buildChatToolStatusItem(item)));
}

async function fetchChatToolReadiness(tool) {
    if (tool === 'rag') {
        const res = await apiFetch(`${API_BASE}/rag/summary`);
        if (!res.ok) throw new Error('知识库状态获取失败');
        const summary = await res.json();
        const ready = Number(summary.ready || 0);
        const processing = Number(summary.processing || 0);
        const error = Number(summary.error || 0);
        if (ready > 0) return { tone: 'ready', text: `${ready} 份资料可用` };
        if (processing > 0) return { tone: 'warning', text: CHAT_TOOL_STATUS_COPY.rag.loading, action: true };
        if (error > 0) return { tone: 'error', text: CHAT_TOOL_STATUS_COPY.rag.error, action: true };
        return { tone: 'warning', text: CHAT_TOOL_STATUS_COPY.rag.empty, action: true };
    }

    if (tool === 'mcp') {
        const res = await apiFetch(`${API_BASE}/mcp/tools`);
        if (!res.ok) throw new Error('工具箱状态获取失败');
        const data = await res.json();
        const count = Array.isArray(data.tools) ? data.tools.length : 0;
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
window.setChatToolToggleState = setChatToolToggleState;
window.syncChatToolToggles = syncChatToolToggles;
window.updateChatToolReadiness = updateChatToolReadiness;
updateChatToolReadiness({ silent: true });

const MAIN_WORKSPACE_STORAGE_KEY = 'pivot_active_workspace';
const SETTINGS_TAB_STORAGE_KEY = 'pivot_settings_tab';
const ACTIVE_CHAT_SESSION_STORAGE_KEY = 'pivot_active_chat_session';
const PRINT_WORKSPACE_SESSION_KEY = 'pivot_print_session';
const RESTORABLE_WORKSPACES = new Set(['chat', 'agent', 'agent-dag', 'knowledge', 'mcp', 'manual', 'settings', 'print']);

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
    const target = ['chat', 'agent', 'agent-dag', 'knowledge', 'mcp', 'manual', 'print', 'settings'].includes(view) ? view : 'chat';
    const chatContainer = document.querySelector('.chat-container');
    const isFullWorkspace = target !== 'chat';
    const viewMap = {
        chat: 'chat-workspace-view',
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
        document.getElementById(id)?.classList.toggle('hidden', key !== target);
    });
    document.querySelectorAll('.sidebar-tool-btn[data-workspace-view]').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.workspaceView === target);
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
    const layoutWidth = Math.max(baseWidth, availableWidth);
    const scale = Math.min(1, availableWidth / baseWidth);
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

window.restoreMainWorkspaceAfterLogin = async function() {
    const view = window.getStoredMainWorkspace?.() || 'chat';
    if (view === 'settings' && window.openAdminPanel) return window.openAdminPanel({ restore: true });
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
