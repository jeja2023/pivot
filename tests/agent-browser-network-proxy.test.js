'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { startBrowserNetworkProxy } = require('../server/services/agent-browser-network-proxy');

function proxyRequest(proxy, target) {
    return new Promise((resolve, reject) => {
        const endpoint = new URL(proxy);
        const request = http.request({ hostname: endpoint.hostname, port: endpoint.port, path: target, method: 'GET' }, response => { response.resume(); response.once('end', () => resolve(response.statusCode)); });
        request.once('error', reject);
        request.end();
    });
}

test('浏览器代理要求明确授权站点，并在未启用测试例外时拒绝回环地址', async () => {
    const previous = process.env.ALLOW_SENSITIVE_OUTBOUND_URLS;
    delete process.env.ALLOW_SENSITIVE_OUTBOUND_URLS;
    const target = 'http://127.0.0.1:34567/';
    let proxy;
    try {
        proxy = await startBrowserNetworkProxy({ allowed_origins: [target], allowed_ports: [34567], block_loopback: false, block_private_ranges: false });
        assert.equal(await proxyRequest(proxy.server, target), 403);
        proxy.close();
        proxy = await startBrowserNetworkProxy({ allowed_origins: [], allowed_redirect_origins: [target], allow_redirect: true, allowed_ports: [34567], block_loopback: false, block_private_ranges: false });
        assert.equal(await proxyRequest(proxy.server, target), 403);
    } finally {
        proxy?.close();
        if (previous === undefined) delete process.env.ALLOW_SENSITIVE_OUTBOUND_URLS; else process.env.ALLOW_SENSITIVE_OUTBOUND_URLS = previous;
    }
});
