/** 将本机连接器底层异常转为可展示、且不泄露敏感路径的错误。 */
function normalizeLocalMcpExecutionError(error) {
    const message = String(error?.message || error || '本机执行失败。');
    let friendlyMessage = message;
    let status = Number(error?.status || error?.statusCode || 0) || 500;
    const code = String(error?.code || '').trim();
    if ((code === 'ENOTDIR' || /ENOTDIR/i.test(message)) && /app\.asar/i.test(message)) {
        friendlyMessage = '桌面端本机执行环境目录初始化失败，请重新打包或重启客户端后再试。';
        status = 500;
    } else if (code === 'ENOTDIR' || /ENOTDIR/i.test(message)) {
        friendlyMessage = '本机报表目录中存在无法按目录读取的路径，或当前授权目标不是有效目录；请重新授权一个真实文件夹后再试。';
        status = 400;
    } else if (code === 'ENOENT' || /ENOENT/i.test(message)) {
        friendlyMessage = '本机授权资源不存在或已移动；请重新授权后再试。';
        status = 404;
    } else if (code === 'EACCES' || code === 'EPERM') {
        friendlyMessage = '当前系统权限不足，无法读取本机授权资源。';
        status = 403;
    }
    return {
        message: friendlyMessage,
        status,
        code,
        detail: friendlyMessage === message ? '' : message.slice(0, 1000)
    };
}

module.exports = { normalizeLocalMcpExecutionError };
