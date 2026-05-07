/* HTTP 工具模块 HTTP Utilities */

const asyncHandler = (fn) => (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
};

const getClientIp = (req) => {
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '';
    return ip.replace(/^.*:ffff:/, '');
};

const normalizePage = (value, fallback = 1) => Math.max(parseInt(value, 10) || fallback, 1);

const normalizeLimit = (value, fallback = 10, max = 100) => Math.min(Math.max(parseInt(value, 10) || fallback, 1), max);

module.exports = {
    asyncHandler,
    getClientIp,
    normalizePage,
    normalizeLimit
};
