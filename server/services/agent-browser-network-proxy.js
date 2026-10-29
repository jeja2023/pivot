'use strict';
// 浏览器进程的统一出站代理：覆盖页面和 Worker 发起的 TCP 请求，并固定经过校验的 DNS 结果。
const http = require('node:http');
const net = require('node:net');
const { assertSafeOutboundHost, createSafeLookup, isLoopbackHost } = require('../security');
const { normalizeNetworkPolicy, validateNetworkPolicyUrl } = require('./agent-network-policy');

async function startBrowserNetworkProxy(rawPolicy) {
    const policy = normalizeNetworkPolicy(rawPolicy);
    const origins = policy.allowed_origins.length
        ? [...policy.allowed_origins, ...(policy.allow_redirect ? policy.allowed_redirect_origins : [])]
        : [];
    const proxyPolicy = { ...policy, allowed_origins: origins };
    const active = new Set();
    const lookups = new Map();
    function targetForAuthority(authority) {
        for (const item of origins) {
            let url;
            try { url = new URL(item); } catch (_) { continue; }
            if (!['http:', 'https:'].includes(url.protocol)) continue;
            const expected = `${url.hostname}:${url.port || (url.protocol === 'https:' ? '443' : '80')}`.toLowerCase();
            if (expected === String(authority).toLowerCase()) {
                try { return validateNetworkPolicyUrl(url.href, proxyPolicy, { requireAllowlist: true }); } catch (_) {}
            }
        }
        throw new Error('目标不在授权站点范围内。');
    }
    function isExplicitlyAllowed(url) {
        return policy.allowed_origins.some(item => { try { return new URL(item).origin === url.origin; } catch (_) { return false; } });
    }
    function hostname(url) { return url.hostname.replace(/^\[|\]$/g, ''); }
    async function verifyHost(url) {
        await assertSafeOutboundHost(hostname(url), { blockPrivate: policy.block_private_ranges && !isExplicitlyAllowed(url), failClosedDns: true });
    }
    function lookupFor(url) {
        const host = hostname(url);
        if (!lookups.has(host)) {
            const explicitlyAllowed = isExplicitlyAllowed(url);
            const allowLoopback = process.env.ALLOW_SENSITIVE_OUTBOUND_URLS === 'true' && !policy.block_loopback && isLoopbackHost(host);
            lookups.set(host, createSafeLookup({ blockPrivate: policy.block_private_ranges && !explicitlyAllowed, allowExplicitLoopback: allowLoopback }));
        }
        return lookups.get(host);
    }
    const proxy = http.createServer(async (request, response) => {
        request.on('error', () => {});
        response.on('error', () => {});
        let url;
        try { url = validateNetworkPolicyUrl(request.url, proxyPolicy, { requireAllowlist: true }); }
        catch (_) { response.writeHead(403); response.end(); return; }
        if (url.protocol !== 'http:') { response.writeHead(403); response.end(); return; }
        try { await verifyHost(url); } catch (_) { response.writeHead(403); response.end(); return; }
        if (request.destroyed || response.destroyed) return;
        const headers = { ...request.headers };
        delete headers['proxy-authorization']; delete headers['proxy-connection'];
        const upstream = http.request({ hostname: hostname(url), port: url.port || 80, method: request.method, path: `${url.pathname}${url.search}`, headers, lookup: lookupFor(url), agent: false }, result => {
            result.on('error', () => response.destroy());
            response.writeHead(result.statusCode || 502, result.headers); result.pipe(response);
        });
        upstream.on('error', () => { if (!response.headersSent) response.writeHead(502); response.end(); });
        request.on('aborted', () => upstream.destroy());
        request.on('error', () => upstream.destroy());
        response.on('error', () => upstream.destroy());
        request.pipe(upstream);
    });
    proxy.on('connect', async (request, socket, head) => {
        socket.on('error', () => {});
        let url;
        try { url = targetForAuthority(request.url); } catch (_) { socket.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return; }
        try { await verifyHost(url); } catch (_) { socket.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return; }
        if (socket.destroyed) return;
        const upstream = net.connect({ host: hostname(url), port: Number(url.port || (url.protocol === 'https:' ? 443 : 80)), lookup: lookupFor(url) });
        active.add(upstream); active.add(socket);
        upstream.once('connect', () => { socket.write('HTTP/1.1 200 Connection Established\r\n\r\n'); if (head.length) upstream.write(head); upstream.pipe(socket); socket.pipe(upstream); });
        upstream.on('error', () => socket.destroy());
        socket.on('error', () => upstream.destroy());
        upstream.once('close', () => { active.delete(upstream); socket.destroy(); });
        socket.once('close', () => { active.delete(socket); upstream.destroy(); });
    });
    await new Promise((resolve, reject) => { proxy.once('error', reject); proxy.listen(0, '127.0.0.1', resolve); });
    return {
        server: `http://127.0.0.1:${proxy.address().port}`,
        close() { active.forEach(socket => socket.destroy()); proxy.closeAllConnections(); proxy.close(); }
    };
}
module.exports = { startBrowserNetworkProxy };
