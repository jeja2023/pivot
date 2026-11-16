'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHelperRuntime, endpoint } = require('../desktop/helper/runtime');

function fixture(approve = async () => true) {
    const requests = [], confirmations = [];
    const runtime = createHelperRuntime({ approve: async value => { confirmations.push(value); return approve(value); },
        request: async (url, options) => {
            requests.push({ url, options });
            const input = JSON.parse(options.body);
            const action = new URL(url).pathname.split('/').at(-1);
            const value = action === 'offer' ? { id: 'pair', nonce: 'nonce', account: '合成账号', username: 'fixture' }
                : action === 'exchange' ? { token: 'fixture-token', deviceId: input.deviceId, account: '合成账号' }
                    : action === 'challenge' ? { nonce: 'challenge' } : { status: 'idle' };
            return { ok: true, json: async () => value };
        } });
    return { runtime, requests, confirmations };
}

test('远程 HTTP 地址只在显式兼容路径接受，地址校验仍拒绝凭据和非根路径', () => {
    assert.throws(() => endpoint('http://pivot.example:9006'));
    assert.equal(endpoint('http://pivot.example:9006/', { allowRemoteHttp: true }), 'http://pivot.example:9006');
    for (const address of ['http://127.0.0.1:9006', 'http://localhost:9006', 'http://[::1]:9006', 'https://pivot.example']) {
        assert.equal(endpoint(address + '/'), address);
    }
    for (const address of ['file:///test', 'ftp://pivot.example', 'http://user:pass@pivot.example', 'http://pivot.example/api', 'http://pivot.example/?token=secret', 'http://pivot.example/#fragment']) {
        assert.throws(() => endpoint(address, { allowRemoteHttp: true }), address);
    }
});

test('拒绝 HTTP 确认时不发送配对码、不创建连接，也不覆盖已有账号', async () => {
    const { runtime, requests, confirmations } = fixture(async value => value.kind !== 'http_transport');
    try {
        await runtime.pair('https://pivot.example', 'old-code');
        const oldDevice = runtime.status().deviceId;
        const before = requests.length;
        await assert.rejects(runtime.pair('http://pivot.example:9006', 'new-code'), /已取消 HTTP 直连/);
        assert.equal(requests.length, before);
        assert.equal(runtime.status().deviceId, oldDevice);
        assert.equal(runtime.status().insecureTransport, false);
        assert.equal(confirmations.at(-1).kind, 'http_transport');
        assert.equal(confirmations.at(-1).message, '服务地址：http://pivot.example:9006');
        assert.match(confirmations.at(-1).detail, /窃听或篡改/);
    } finally { await runtime.disconnect(false); }
});

test('HTTP 确认先于网络和账号确认，后续请求固定原始 Origin 且禁止重定向', async () => {
    const { runtime, requests, confirmations } = fixture(async value => {
        if (value.kind === 'http_transport') assert.equal(requests.length, 0);
        return true;
    });
    try {
        await runtime.pair('http://pivot.example:9006/', 'code');
        assert.deepEqual(confirmations.map(value => value.title), ['确认 HTTP 直连', '确认助手配对']);
        assert.equal(runtime.status().insecureTransport, true);
        assert.equal(runtime.snapshot().connection.httpConsentOrigin, 'http://pivot.example:9006');
        assert.ok(requests.every(item => item.url.startsWith('http://pivot.example:9006/api/mcp/helper/') && item.options.redirect === 'error'));
        await runtime.disconnect(false);
        assert.equal(runtime.status().insecureTransport, false);
        assert.equal(runtime.snapshot(), null);
    } finally { await runtime.disconnect(false); }
});

test('恢复 HTTP 连接必须保留精确 Origin 确认，不能用于另一主机、端口或协议降级', async () => {
    const first = fixture();
    await first.runtime.pair('http://pivot.example:9006', 'code');
    const saved = first.runtime.snapshot();
    await first.runtime.disconnect(false);
    for (const patch of [{ httpConsentOrigin: undefined }, { server: 'http://other.example:9006' }, { server: 'http://pivot.example:9007' }]) {
        const { runtime, requests } = fixture();
        assert.throws(() => runtime.restore({ connection: { ...saved.connection, ...patch } }), /重新配对/);
        assert.equal(requests.length, 0);
        assert.equal(runtime.status().paired, false);
    }
    const restored = fixture();
    try {
        restored.runtime.restore(saved);
        assert.equal(restored.runtime.status().insecureTransport, true);
        assert.equal(restored.confirmations.length, 0);
    } finally { await restored.runtime.disconnect(false); }
    const secure = fixture();
    await secure.runtime.pair('https://pivot.example', 'secure-code');
    const secureSnapshot = secure.runtime.snapshot();
    await secure.runtime.disconnect(false);
    assert.throws(() => secure.runtime.restore({ connection: { ...secureSnapshot.connection, server: 'http://pivot.example' } }), /重新配对/);
});

test('HTTPS 与本机 HTTP 配对保持兼容，不要求远程 HTTP 确认', async () => {
    for (const server of ['https://pivot.example', 'http://127.0.0.1:9006']) {
        const { runtime, confirmations } = fixture();
        try {
            await runtime.pair(server, 'code');
            assert.deepEqual(confirmations.map(value => value.title), ['确认助手配对']);
            assert.equal(runtime.status().insecureTransport, false);
        } finally { await runtime.disconnect(false); }
    }
});
