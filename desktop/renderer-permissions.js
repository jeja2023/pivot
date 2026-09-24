function isTrustedMicrophoneRequest(webContents, permission, details, isTrustedRenderer) {
    if (permission !== 'media' || typeof isTrustedRenderer !== 'function') return false;
    const mediaTypes = Array.isArray(details?.mediaTypes) ? details.mediaTypes : [];
    if (mediaTypes.length === 0 || mediaTypes.some(type => type !== 'audio')) return false;
    const requestingUrl = details?.securityOrigin || details?.requestingUrl || webContents?.getURL?.() || '';
    return isTrustedRenderer(requestingUrl) === true;
}

// 默认拒绝系统权限；仅允许受信任的主渲染页按用户操作申请纯音频输入。
function installRendererPermissionPolicy(targetSession, { isTrustedRenderer = () => false } = {}) {
    if (!targetSession) return;
    targetSession.setPermissionRequestHandler?.((webContents, permission, callback, details) => {
        callback(isTrustedMicrophoneRequest(webContents, permission, details, isTrustedRenderer));
    });
    // 先拒绝持久化的预授权，让每一次媒体访问都进入上面的请求处理器。
    targetSession.setPermissionCheckHandler?.(() => false);
}

module.exports = { installRendererPermissionPolicy, isTrustedMicrophoneRequest };
