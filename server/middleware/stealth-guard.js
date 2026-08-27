const { verifyStealthRequest } = require('../services/stealth-service');

/**
 * 客户端独占隐身模式门禁中间件
 * 当系统开启隐身模式后，任何未携带有效官方客户端签名的请求直接被物理掐断 TCP 连接（Socket Destroy），
 * 不返回任何 HTTP 响应头或状态码，让外部探测工具与普通浏览器显示 ERR_EMPTY_RESPONSE / 连接重置，彻底隐身。
 */
function stealthAccessGuard(req, res, next) {
    if (verifyStealthRequest(req)) {
        return next();
    }

    // 隐身模式下拒绝未授权探测：立即掐断底层 Socket 连接，零特征响应
    if (req.socket && !req.socket.destroyed) {
        req.socket.destroy();
    } else if (res.socket && !res.socket.destroyed) {
        res.socket.destroy();
    }
}

module.exports = { stealthAccessGuard };
