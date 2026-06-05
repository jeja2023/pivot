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

function setChatToolToggleState(button, enabled) {
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
}

function syncChatToolToggles() {
    document.querySelectorAll('[data-chat-tool-toggle], #chat-rag-enabled, #chat-mcp-enabled').forEach(button => {
        const tool = getChatToolName(button);
        const storageKey = CHAT_TOOL_TOGGLE_STORAGE[tool];
        setChatToolToggleState(button, storageKey ? localStorage.getItem(storageKey) === 'true' : button.dataset.enabled === 'true');
    });
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
window.setChatToolToggleState = setChatToolToggleState;
window.syncChatToolToggles = syncChatToolToggles;

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
