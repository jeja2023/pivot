'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const client = require('../server/services/presentations/master/service-client');
const runtime = require('../server/services/presentations/master/runtime');

async function fake(handler) {
    const server = http.createServer(handler);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    return { server, env: { PIVOT_PPT_MASTER_SERVICE_URL: 'http://127.0.0.1:' + server.address().port, PIVOT_PPT_MASTER_SERVICE_TOKEN: 'a'.repeat(64) }, close: () => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }) };
}
const json = (res, value, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
const health = { status: 'ready', serviceProtocol: 1, version: 'service-upgrade', revision: 'new-upstream-commit', contentDigest: 'b'.repeat(64), runtimeId: 'sha256:' + 'c'.repeat(64), capabilities: ['files', 'operations', 'cancel', 'native', 'templates'], offlineNativeProtocol: 1 };

test('独立服务使用稳定接口与当前运行身份，升级上游不要求Pivot修改固定提交', async () => {
    const requests = [], token = 'a'.repeat(64);
    const fixture = await fake((req, res) => {
        assert.equal(req.headers.authorization, 'Bearer ' + token); requests.push(req.url);
        if (req.url === '/v1/info') return json(res, health);
        if (/\/v1\/jobs\/[a-f0-9]{64}$/.test(req.url)) return json(res, { runtimeId: health.runtimeId });
        const chunks = []; req.on('data', chunk => chunks.push(chunk)); req.on('end', () => { const body = JSON.parse(Buffer.concat(chunks)); assert.equal(body.runtimeId, health.runtimeId); json(res, { ok: true, serviceProtocol: 1, runtimeId: health.runtimeId, result: { text: '服务已执行' } }); });
    });
    try {
        const info = await client.info({ force: true, env: fixture.env }); assert.equal(info.revision, 'new-upstream-commit');
        const output = await client.execute({ id: 1 }, 'tooltask_' + 'x'.repeat(32), { action: 'list' }, { env: fixture.env });
        assert.equal(output.result.text, '服务已执行'); assert.ok(requests.some(value => /operations\/[a-f0-9]{32}$/.test(value)));
    } finally { await fixture.close(); }
});

test('用户停止会发送服务取消请求，取消后迟到响应不进入文稿', async () => {
    let entered, cancelled;
    const started = new Promise(resolve => entered = resolve), stopped = new Promise(resolve => cancelled = resolve);
    const fixture = await fake((req, res) => {
        if (req.url === '/v1/info') return json(res, health);
        if (req.url.endsWith('/cancel')) { cancelled(); return json(res, { cancelled: true }); }
        if (req.url.includes('/operations/')) { entered(); return; }
        json(res, { runtimeId: health.runtimeId });
    });
    try {
        const controller = new AbortController(), result = client.execute({ id: 2 }, 'tooltask_' + 'y'.repeat(32), { action: 'run' }, { env: fixture.env, signal: controller.signal }).catch(error => error);
        await started; controller.abort(new Error('用户已取消')); assert.match((await result).message, /用户已取消/); await stopped;
    } finally { await fixture.close(); }
});

test('传输文件核对摘要、限制大小，并拒绝不兼容协议与重定向', async () => {
    const fixture = await fake((req, res) => {
        if (req.url === '/v1/info') return json(res, health);
        if (req.url.includes('/outputs/')) { res.writeHead(200, { 'X-Content-SHA256': crypto.createHash('sha256').update('wrong').digest('hex') }); return res.end('actual'); }
        if (req.url === '/redirect') { res.writeHead(302, { Location: 'http://example.invalid' }); return res.end(); }
        json(res, { runtimeId: health.runtimeId });
    });
    try {
        await assert.rejects(() => client.file({ id: 3 }, 'tooltask_' + 'z'.repeat(32), 'outputs', 'presentation.pptx', 100, fixture.env), { code: 'PPT_SERVICE_FILE_CHANGED' });
        await assert.rejects(() => client.file({ id: 3 }, 'tooltask_' + 'z'.repeat(32), 'outputs', 'presentation.pptx', 2, fixture.env), { code: 'PPT_SERVICE_RESPONSE_TOO_LARGE' });
        assert.throws(() => client.compatible({ ...health, serviceProtocol: 2 }), { code: 'PPT_SERVICE_PROTOCOL_MISMATCH' });
        await assert.rejects(() => client.request(client.config(fixture.env), '/redirect'), { code: 'PPT_SERVICE_UNAVAILABLE' });
    } finally { await fixture.close(); }
});

test('服务停机返回标准功能可继续使用，未配置时不依赖Docker或服务', async () => {
    const fixture = await fake((_req, res) => json(res, health)), previous = { url: process.env.PIVOT_PPT_MASTER_SERVICE_URL, token: process.env.PIVOT_PPT_MASTER_SERVICE_TOKEN };
    await fixture.close();
    try {
        process.env.PIVOT_PPT_MASTER_SERVICE_URL = fixture.env.PIVOT_PPT_MASTER_SERVICE_URL; process.env.PIVOT_PPT_MASTER_SERVICE_TOKEN = fixture.env.PIVOT_PPT_MASTER_SERVICE_TOKEN;
        const result = await runtime.availability(); assert.equal(result.enabled, false); assert.match(result.message, /标准PPT创建、编辑和导出继续可用/);
        assert.throws(() => client.config({ ...fixture.env, PIVOT_PPT_MASTER_SERVICE_URL: 'http://user:password@host/' }));
        assert.throws(() => client.config({ ...fixture.env, PIVOT_PPT_MASTER_SERVICE_TOKEN: '' }));
    } finally {
        for (const [key, value] of [['PIVOT_PPT_MASTER_SERVICE_URL', previous.url], ['PIVOT_PPT_MASTER_SERVICE_TOKEN', previous.token]]) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
});
