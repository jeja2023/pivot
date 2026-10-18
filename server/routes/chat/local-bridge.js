'use strict';

function normalizeChatLocalBridgeDebug(payload) {
    if (!payload || typeof payload !== 'object') return null;
    const grants = payload.grants && typeof payload.grants === 'object' ? payload.grants : {};
    return {
        page: String(payload.page || '').slice(0, 40),
        status: String(payload.status || '').slice(0, 80),
        reason: String(payload.reason || '').slice(0, 300),
        hasDesktopBridge: payload.hasDesktopBridge === true,
        hasStatusBridge: payload.hasStatusBridge === true,
        hasExecuteBridge: payload.hasExecuteBridge === true,
        statusAvailable: payload.statusAvailable === true,
        mode: String(payload.mode || '').slice(0, 40),
        deviceName: String(payload.deviceName || '').slice(0, 120),
        toolCount: Number.isFinite(Number(payload.toolCount)) ? Number(payload.toolCount) : null,
        originCount: Number.isFinite(Number(payload.originCount)) ? Number(payload.originCount) : null,
        grants: {
            local_database: grants.local_database === true,
            local_report_dir: grants.local_report_dir === true,
            local_browser: grants.local_browser === true,
            local_browser_origin_count: Number.isFinite(Number(grants.local_browser_origin_count)) ? Number(grants.local_browser_origin_count) : 0
        }
    };
}

function registerChatRequestLocalBridge(req) {
    req.localMcpBridgeDebug = normalizeChatLocalBridgeDebug(req.body?.localMcpBridgeDebug);
    // 网页自报的设备和授权不参与注册或路由。
    return null;
}

module.exports = { normalizeChatLocalBridgeDebug, registerChatRequestLocalBridge };
