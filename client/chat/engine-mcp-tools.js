// 聊天 MCP 授权确认与工具自动启用辅助函数 Chat MCP consent and automatic tool activation helpers
function confirmChatMcpUse() {
    const title = '允许调用工具箱工具';
    const message = '工具箱工具可能访问已保存的外部服务、数据库结构或数据库查询结果。数据库工具会继续受只读限制保护；确认后本浏览器会话内不再重复提醒。';
    return new Promise(resolve => {
        if (typeof window.showConfirm !== 'function') return resolve(window.confirm(message));
        const cancelBtn = document.getElementById('modal-confirm-cancel');
        const overlay = document.getElementById('confirm-container');
        let settled = false;
        // 确认弹层是常驻节点，复用于多次授权。{once:true} 只在监听器触发时移除，
        // 因此“确认”这条路径不会清理取消监听器，会跨多次授权累积。这里用共享 settle
        // 在任一结果（确认 / 取消）都显式移除两个取消监听器。
        const onOverlayClick = (event) => {
            if (event.target === overlay) settle(false);
        };
        const settle = (result) => {
            if (settled) return;
            settled = true;
            cancelBtn?.removeEventListener('click', onCancelClick);
            overlay?.removeEventListener('click', onOverlayClick);
            resolve(result);
        };
        const onCancelClick = () => settle(false);
        window.showConfirm(title, message, () => settle(true));
        cancelBtn?.addEventListener('click', onCancelClick);
        overlay?.addEventListener('click', onOverlayClick);
    });
}

const CHAT_MCP_CONSENT_KEY = 'pivot_chat_mcp_consent_session';

function hasChatMcpConsent() {
    try {
        return sessionStorage.getItem(CHAT_MCP_CONSENT_KEY) === 'true';
    } catch (e) {
        return false;
    }
}

function rememberChatMcpConsent() {
    try {
        sessionStorage.setItem(CHAT_MCP_CONSENT_KEY, 'true');
    } catch (e) {
        // 忽略浏览器存储限制，当前这次确认仍然有效。
    }
}

async function ensureChatMcpConsent() {
    if (hasChatMcpConsent()) return true;
    const confirmed = await confirmChatMcpUse();
    if (confirmed) rememberChatMcpConsent();
    return confirmed;
}

window.confirmChatMcpUse = confirmChatMcpUse;
window.hasChatMcpConsent = hasChatMcpConsent;
window.ensureChatMcpConsent = ensureChatMcpConsent;

function isChatToolEnabled(id, storageKey) {
    const button = document.getElementById(id);
    const wrapper = button?.closest?.('.chat-tool-toggle');
    const stateNode = wrapper || button;
    if (button?.dataset.enabled === 'true' || stateNode?.dataset.enabled === 'true') return true;
    if (button?.dataset.enabled === 'false' || stateNode?.dataset.enabled === 'false') return false;
    if (button?.getAttribute('aria-pressed') === 'true' || stateNode?.getAttribute('aria-pressed') === 'true') return true;
    if (button?.getAttribute('aria-pressed') === 'false' || stateNode?.getAttribute('aria-pressed') === 'false') return false;
    if (typeof button?.checked === 'boolean') return button.checked;
    return localStorage.getItem(storageKey) === 'true';
}

function shouldAutoEnableMcpForPrompt(value = '') {
    const text = String(value || '').toLowerCase();
    if (!text.trim()) return false;
    const hasDataSource = /数据库|数据表|表中|表里|table[_a-z0-9]*|select\s|from\s+\w+|group\s+by|order\s+by|db\.|sql/i.test(text);
    const hasDataAction = /查询|统计|分组|汇总|数量|计数|分布|排行|排名|count|sum|avg|group|字段|列|column/i.test(text);
    const hasVisualAction = /图表|柱状图|折线图|饼图|面积图|可视化|画图|绘图|chart|plot|graph/i.test(text);
    return hasDataSource && (hasDataAction || hasVisualAction);
}

function activateChatMcpToggle() {
    const button = document.getElementById('chat-mcp-enabled');
    window.setChatToolToggleState?.(button, true);
    try {
        localStorage.setItem('pivot_chat_mcp_enabled', 'true');
    } catch (e) {
        // 忽略浏览器存储限制，本轮请求仍会携带启用状态。
    }
}

window.shouldAutoEnableMcpForPrompt = shouldAutoEnableMcpForPrompt;
window.activateChatMcpToggle = activateChatMcpToggle;
