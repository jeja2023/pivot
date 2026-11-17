// @ts-check
'use strict';

const { isTrustedProxyIp } = require('../http');

/** 只接收无凭据的网络来源。 @param {unknown} value */
function origin(value) {
    try {
        const parsed = new URL(String(value || ''));
        return ['http:', 'https:'].includes(parsed.protocol) && !parsed.username && !parsed.password ? parsed.origin : '';
    } catch (_) { return ''; }
}

/**
 * 浏览器认证写请求必须来自当前服务；代理头只有登记的代理可提供。
 * 无来源头的原生客户端继续可用，但跨站表单及不透明来源不能借此放行。
 * @param {{headers?: Record<string, any>, socket?: {remoteAddress?: string, encrypted?: boolean}, connection?: {remoteAddress?: string}}} req 请求来源
 * @param {NodeJS.ProcessEnv} env 部署配置
 */
function allowsAuthRequestOrigin(req, env = process.env) {
    const headers = req.headers || {};
    const source = headers.origin;
    const site = String(headers['sec-fetch-site'] || '').toLowerCase();
    if (source === undefined) return !['cross-site', 'same-site'].includes(site);
    const expected = new Set();
    const direct = origin(`${req.socket?.encrypted ? 'https' : 'http'}://${headers.host || ''}`);
    if (direct) expected.add(direct);
    const published = origin(env.PUBLIC_URL);
    if (published) expected.add(published);
    for (const configured of String(env.CORS_ORIGIN || '').split(',')) {
        const allowed = origin(configured.trim());
        if (allowed) expected.add(allowed);
    }
    if (isTrustedProxyIp(req.socket?.remoteAddress || req.connection?.remoteAddress || '')) {
        const host = String(headers['x-forwarded-host'] || headers.host || '').split(',')[0].trim();
        const protocol = String(headers['x-forwarded-proto'] || '').split(',')[0].trim();
        const forwarded = origin(`${protocol}://${host}`);
        if (forwarded) expected.add(forwarded);
    }
    const incoming = origin(source);
    return Boolean(incoming && expected.has(incoming));
}

module.exports = { allowsAuthRequestOrigin };
