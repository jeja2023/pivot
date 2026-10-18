// 对话页桌面连接器状态与授权摘要。
let chatLocalMcpBridgeDebug = null;
let chatLocalMcpHeartbeatStarted = false;

function getChatLocalMcpDeviceId() {
    const key = 'pivot_local_execution_device_id';
    try {
        const existing = localStorage.getItem(key);
        if (existing) return existing;
        const next = globalThis.crypto?.randomUUID?.() || `desktop-${Date.now()}-${Math.random().toString(16).slice(2)}`;
        localStorage.setItem(key, next);
        return next;
    } catch (_err) {
        return `desktop-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    }
}

function normalizeChatLocalMcpBridgePayload(status, deviceId = '') {
    if (!status?.available) return null;
    const grants = status.grants && typeof status.grants === 'object' ? status.grants : {};
    return {
        deviceId: deviceId || status.deviceId || getChatLocalMcpDeviceId(),
        deviceName: status.deviceName || '我的电脑',
        provider: status.provider || 'desktop',
        mode: status.mode || 'remote',
        grants
    };
}

function summarizeChatLocalMcpGrants(grants = {}) {
    return {
        local_database: grants.local_database?.authorized === true,
        local_report_dir: grants.local_report_dir?.authorized === true,
        local_browser: grants.local_browser?.authorized === true,
        local_browser_origin_count: Array.isArray(grants.local_browser?.allowedOrigins) ? grants.local_browser.allowedOrigins.length : 0
    };
}

function updateChatLocalMcpBridgeDebug(state = {}) {
    const next = {
        page: 'chat',
        checkedAt: new Date().toISOString(),
        ...state
    };
    chatLocalMcpBridgeDebug = next;
    return next;
}

function getChatLocalMcpBridgeDebugSnapshot() {
    return chatLocalMcpBridgeDebug || updateChatLocalMcpBridgeDebug({
        status: 'not_checked',
        reason: '聊天页尚未检查桌面端本机执行器。'
    });
}

function inspectChatLocalMcpDesktopBridge() {
    const desktop = window.pivotDesktop;
    const hasDesktopBridge = Boolean(desktop);
    const hasStatusBridge = typeof desktop?.getLocalAuthorizationStatus === 'function';
    const hasExecuteBridge = typeof desktop?.executeLocalMcpTool === 'function';
    let reason = '';
    if (!hasDesktopBridge) {
        reason = '聊天页没有检测到桌面端桥 window.pivotDesktop；请确认当前页面在桌面客户端中打开，而不是普通浏览器。';
    } else if (!hasStatusBridge) {
        reason = '当前桌面客户端缺少本机授权状态接口；请重新打包或安装包含本机授权中心的新版本。';
    } else if (!hasExecuteBridge) {
        reason = '当前桌面客户端缺少本机只读执行接口；请重新打包或安装包含本机执行器的新版本。';
    }
    return {
        hasDesktopBridge,
        hasStatusBridge,
        hasExecuteBridge,
        ready: hasDesktopBridge && hasStatusBridge && hasExecuteBridge,
        reason
    };
}

async function registerChatLocalMcpBridgeDirectly() {
    const bridgeState = inspectChatLocalMcpDesktopBridge();
    if (!bridgeState.ready) {
        updateChatLocalMcpBridgeDebug({ status: 'bridge_unavailable', ...bridgeState });
        return null;
    }
    const desktop = window.pivotDesktop;
    const status = await desktop.getLocalAuthorizationStatus();
    const grants = summarizeChatLocalMcpGrants(status?.grants || {});
    const payload = normalizeChatLocalMcpBridgePayload(status, getChatLocalMcpDeviceId());
    if (!payload) {
        updateChatLocalMcpBridgeDebug({
            status: 'authorization_unavailable',
            ...bridgeState,
            statusAvailable: status?.available === true,
            mode: status?.mode || '',
            grants,
            reason: status?.available
                ? '聊天页已检测到桌面端，但没有可同步的本机授权。'
                : '桌面端本机授权状态不可用。'
        });
        return null;
    }
    const response = await apiFetch(`${API_BASE}/mcp/local-device/heartbeat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    });
    if (!response.ok) {
        const message = await response.text() || '本机工具库同步失败。';
        updateChatLocalMcpBridgeDebug({ status: 'heartbeat_failed', ...bridgeState, grants, reason: message.slice(0, 300) });
        throw new Error(message);
    }
    const data = await response.json().catch(() => ({}));
    updateChatLocalMcpBridgeDebug({
        status: 'heartbeat_ok',
        ...bridgeState,
        statusAvailable: true,
        mode: payload.mode,
        deviceName: payload.deviceName,
        grants,
        toolCount: Array.isArray(data.tools) ? data.tools.length : 0,
        reason: '桌面端本机执行器已同步。'
    });
    return payload;
}

async function syncChatLocalMcpBridgeBeforeSend() {
    // v2 桌面连接器在 Electron 主进程独立执行签名心跳与任务轮询；网页不再上报
    // 自报 deviceId 或授权快照，避免旧内存桥接成为身份旁路。
    const desktop = window.pivotDesktop;
    const authorization = typeof desktop?.getLocalAuthorizationStatus === 'function'
        ? await desktop.getLocalAuthorizationStatus().catch(() => null)
        : null;
    const grants = summarizeChatLocalMcpGrants(authorization?.grants || {});
    let sync = null;
    if (typeof desktop?.syncLocalMcpConnector === 'function') {
        try { sync = await desktop.syncLocalMcpConnector(); }
        catch (error) {
            updateChatLocalMcpBridgeDebug({ status: 'persistent_connector_sync_failed', hasDesktopBridge: Boolean(desktop), hasStatusBridge: Boolean(authorization), hasExecuteBridge: false, statusAvailable: Boolean(authorization), grants, reason: String(error.message || '桌面连接器同步失败。').slice(0, 300) });
            return null;
        }
    }
    const status = typeof desktop?.getLocalMcpConnectorStatus === 'function'
        ? await window.pivotDesktop.getLocalMcpConnectorStatus().catch(() => null)
        : null;
    updateChatLocalMcpBridgeDebug({
        status: status?.running ? 'persistent_connector_synced' : 'persistent_connector_unavailable',
        hasDesktopBridge: Boolean(desktop),
        hasStatusBridge: Boolean(authorization),
        hasExecuteBridge: Boolean(status?.running),
        statusAvailable: Boolean(authorization),
        deviceName: status?.identity?.deviceName || '',
        grants,
        originCount: grants.local_browser_origin_count,
        syncStatus: sync?.status || '',
        reason: status?.running ? '桌面连接器已同步当前授权。' : (status?.identity?.reason || '桌面连接器尚未运行。')
    });
    return null;
}

function startChatLocalMcpBridgeHeartbeat() {
    // 兼容函数保留，心跳由主进程持久化连接器负责。
    chatLocalMcpHeartbeatStarted = true;
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', startChatLocalMcpBridgeHeartbeat, { once: true });
} else {
    startChatLocalMcpBridgeHeartbeat();
}
