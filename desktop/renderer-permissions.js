function isTrustedMicrophoneRequest(webContents, permission, details, isTrustedRenderer) {
    if (typeof isTrustedRenderer !== 'function') return false;
    const requestingUrl = details?.securityOrigin || details?.requestingUrl || webContents?.getURL?.() || '';
    if (!isTrustedRenderer(requestingUrl)) return false;
    if (permission === 'clipboard-sanitized-write' || permission === 'clipboard-read') return true;
    if (permission === 'media') {
        const mediaTypes = Array.isArray(details?.mediaTypes) ? details.mediaTypes : [];
        if (mediaTypes.length === 0 || mediaTypes.some(type => type !== 'audio')) return false;
        return true;
    }
    return false;
}

// 默认拒绝未知系统权限；允许受信任的主渲染页按需申请音频输入与剪贴板写权限。
function installRendererPermissionPolicy(targetSession, { isTrustedRenderer = () => false } = {}) {
    if (!targetSession) return;
    targetSession.setPermissionRequestHandler?.((webContents, permission, callback, details) => {
        callback(isTrustedMicrophoneRequest(webContents, permission, details, isTrustedRenderer));
    });
    // 允许受信任渲染页的剪贴板写操作快速判定通过，其余进默认检查
    targetSession.setPermissionCheckHandler?.((webContents, permission, requestingOrigin, details) => {
        const targetUrl = requestingOrigin || details?.securityOrigin || webContents?.getURL?.() || '';
        if (typeof isTrustedRenderer === 'function' && isTrustedRenderer(targetUrl)) {
            if (permission === 'clipboard-sanitized-write') return true;
        }
        return false;
    });
}

module.exports = { installRendererPermissionPolicy, isTrustedMicrophoneRequest };
