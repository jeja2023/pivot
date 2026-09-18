// 聊天 MCP 授权确认与工具自动启用辅助函数 Chat MCP consent and automatic tool activation helpers
function confirmChatMcpUse() {
    const title = '允许调用工具库工具';
    const message = '工具库工具可能访问已保存的外部服务、数据库结构或数据库查询结果。数据库工具会继续受只读限制保护；确认后本浏览器会话内不再重复提醒。';
    return new Promise(resolve => {
        if (typeof window.Pivot.legacy.showConfirm !== 'function') return resolve(window.confirm(message));
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
        window.Pivot.legacy.showConfirm(title, message, () => settle(true));
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

window.Pivot.legacy.confirmChatMcpUse = confirmChatMcpUse;
window.Pivot.legacy.hasChatMcpConsent = hasChatMcpConsent;
window.Pivot.legacy.ensureChatMcpConsent = ensureChatMcpConsent;

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
