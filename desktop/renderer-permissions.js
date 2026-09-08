// 远程页面不应默认获得摄像头、麦克风、定位等系统权限；当前没有对应业务场景。
function installRendererPermissionPolicy(targetSession) {
    if (!targetSession) return;
    targetSession.setPermissionRequestHandler?.((_webContents, _permission, callback) => callback(false));
    targetSession.setPermissionCheckHandler?.(() => false);
}

module.exports = { installRendererPermissionPolicy };
