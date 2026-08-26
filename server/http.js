/* HTTP 工具模块 HTTP Utilities */

const net = require('net');

const asyncHandler = (fn) => (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
};

function normalizeIpAddress(value) {
    let ip = String(value || '').trim();
    if (!ip) return '';
    if (ip.startsWith('[')) {
        const end = ip.indexOf(']');
        if (end !== -1) ip = ip.slice(1, end);
    } else if (/^\d{1,3}(?:\.\d{1,3}){3}:\d+$/.test(ip)) {
        ip = ip.replace(/:\d+$/, '');
    }
    ip = ip.replace(/^::ffff:/i, '');
    return ip.toLowerCase();
}

function ipv4ToInt(ip) {
    const parts = String(ip || '').split('.').map(Number);
    if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return null;
    return parts.reduce((total, part) => ((total << 8) + part) >>> 0, 0);
}

function ipv4MatchesCidr(ip, cidr) {
    const [base, prefixText] = String(cidr || '').split('/');
    const prefix = Number.parseInt(prefixText, 10);
    if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) return false;
    const ipInt = ipv4ToInt(ip);
    const baseInt = ipv4ToInt(base);
    if (ipInt === null || baseInt === null) return false;
    const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
    return (ipInt & mask) === (baseInt & mask);
}

function getTrustedProxyRules() {
    return String(process.env.TRUSTED_PROXY_IPS || '')
        .split(',')
        .map(item => item.trim())
        .filter(Boolean);
}

function isTrustedProxyIp(ip) {
    const normalizedIp = normalizeIpAddress(ip);
    if (!normalizedIp) return false;
    return getTrustedProxyRules().some(rule => {
        const normalizedRule = normalizeIpAddress(rule);
        if (normalizedRule === normalizedIp) return true;
        return rule.includes('/') && net.isIP(normalizedIp) === 4 && ipv4MatchesCidr(normalizedIp, rule);
    });
}

function getForwardedClientIp(req) {
    const forwardedFor = String(req.headers?.['x-forwarded-for'] || '');
    const firstForwardedIp = forwardedFor.split(',').map(normalizeIpAddress).find(Boolean);
    return firstForwardedIp || '';
}

const getClientIp = (req) => {
    const remoteIp = normalizeIpAddress(req.socket?.remoteAddress || req.connection?.remoteAddress || '');
    if (isTrustedProxyIp(remoteIp)) {
        return getForwardedClientIp(req) || remoteIp;
    }
    return remoteIp;
};

const normalizePage = (value, fallback = 1) => Math.max(parseInt(value, 10) || fallback, 1);

const normalizeLimit = (value, fallback = 10, max = 100) => Math.min(Math.max(parseInt(value, 10) || fallback, 1), max);

/**
 * 判断请求是否属于接口链路（/api 与 OpenAI 兼容的 /v1）。
 * 接口链路要绕开静态文件探测、并接受悬挂兜底，两处判定必须完全一致，
 * 否则会出现「静态中间件跳过了但兜底没覆盖」这类难查的不一致。
 */
const isApiRequestPath = (requestPath) => {
    const path = String(requestPath || '');
    return path === '/api' || path.startsWith('/api/')
        || path === '/v1' || path.startsWith('/v1/');
};

module.exports = {
    asyncHandler,
    getClientIp,
    isApiRequestPath,
    isTrustedProxyIp,
    normalizeIpAddress,
    normalizePage,
    normalizeLimit
};
