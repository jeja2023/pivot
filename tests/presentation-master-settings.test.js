'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const { createSettings, validate, normalizeEndpoint } = require('../server/services/presentations/master/settings');
const { registerPresentationMasterSettingsRoutes, testConnection } = require('../server/routes/presentation-master-settings');

const token = 'a'.repeat(64), changed = 'b'.repeat(64);
const encryption = process.env.DATA_ENCRYPTION_KEY;
test.before(() => { process.env.DATA_ENCRYPTION_KEY = 'ppt-master-settings-test-encryption-key-32'; });
test.after(() => { if (encryption === undefined) delete process.env.DATA_ENCRYPTION_KEY; else process.env.DATA_ENCRYPTION_KEY = encryption; });
function fixture(values = {}, options = {}) {
    let stored = null; let writes = 0;
    const settings = createSettings({ readValue: async () => stored, readEnv: () => ({ enabled: true, endpoint: 'http://127.0.0.1:8502', token, ...values }),
        replace: async (_key, previous, next) => { if (stored !== previous) return { conflict: true }; writes++; stored = next; return { saved: true }; }, ...options });
    return { settings, raw: () => stored, writes: () => writes, corrupt: () => stored = 'invalid encrypted setting' };
}

test('PPT服务配置整体加密，公开响应不包含密钥，非最高管理员不获得地址', async () => {
    const app = fixture();
    const saved = await app.settings.save({ revision: 'environment', token: changed }, { userId: 7 });
    assert.match(app.raw(), /^enc:v2:/); assert.ok(!app.raw().includes(changed)); assert.ok(!app.raw().includes('127.0.0.1'));
    assert.equal(saved.source, 'settings'); assert.equal(saved.hasToken, true); assert.equal(saved.token, undefined);
    assert.equal((await app.settings.effective()).token, changed);
    const publicValue = await app.settings.publicConfig(); assert.equal(publicValue.canManage, false); assert.equal(publicValue.endpoint, '********');
    assert.ok(!JSON.stringify(publicValue).includes(changed));
});

test('空白保留密钥；更换地址必须提供新密钥，测试草稿不更改保存配置', async () => {
    const app = fixture();
    let saved = await app.settings.save({ revision: 'environment', token: '' });
    assert.equal((await app.settings.effective()).token, token);
    await assert.rejects(() => app.settings.save({ revision: saved.revision, endpoint: 'http://127.0.0.1:8503', token: '' }), /新服务的密钥/);
    let received;
    const prepared = await testConnection({ revision: saved.revision, endpoint: 'http://127.0.0.1:8503', token: changed }, { settings: app.settings,
        request: async settings => { received = settings; return { status: 'ready', serviceProtocol: 1, version: '6.8.0', revision: 'upstream', runtimeId: 'sha256:' + 'c'.repeat(64), capabilities: ['files', 'operations', 'cancel', 'native', 'templates'] }; } });
    assert.equal(prepared.success, true); assert.equal(received.token, changed); assert.equal(app.writes(), 1);
    assert.equal((await app.settings.effective()).endpoint, 'http://127.0.0.1:8502');
    saved = await app.settings.save({ revision: saved.revision, endpoint: 'http://127.0.0.1:8503', token: changed });
    const cleared = await app.settings.save({ revision: saved.revision, enabled: false, clearToken: true });
    assert.equal(cleared.enabled, false); assert.equal(cleared.hasToken, false);
});

test('拒绝非法URL、敏感目标、密钥格式及无效字段，不能同时替换和清除', async () => {
    const previous = await fixture().settings.effective();
    for (const patch of [{ endpoint: 'http://169.254.169.254', token: changed }, { endpoint: 'file:///etc/passwd' }, { endpoint: 'http://user:secret@127.0.0.1' }, { endpoint: 'http://127.0.0.1/?token=bad' },
        { endpoint: 'http://127.0.0.1/v1' }, { endpoint: 3 }, { endpoint: '' }, { enabled: 'true' }, { token: 'short' }, { token: 'contains\nnewline' }, { token: changed, clearToken: true }, { command: 'arbitrary' }]) await assert.rejects(() => validate(patch, previous));
    assert.equal(normalizeEndpoint('http://127.0.0.1:8502/'), 'http://127.0.0.1:8502');
});

test('并发写入只有一方成功，配置损坏或缺少加密密钥时不回退旧服务', async () => {
    const app = fixture();
    const results = await Promise.allSettled([app.settings.save({ revision: 'environment', token: changed }), app.settings.save({ revision: 'environment', enabled: false })]);
    assert.equal(results.filter(value => value.status === 'fulfilled').length, 1);
    assert.equal(results.find(value => value.status === 'rejected').reason.code, 'PPT_MASTER_SETTINGS_CONFLICT');
    app.corrupt(); await assert.rejects(() => app.settings.effective(), { code: 'PPT_MASTER_SETTINGS_UNREADABLE' });
    assert.equal((await app.settings.publicConfig()).enabled, false);
    const unavailable = fixture({}, { canEncrypt: () => false });
    await assert.rejects(() => unavailable.settings.save({ revision: 'environment', enabled: false }), { code: 'PPT_MASTER_SETTINGS_ENCRYPTION_REQUIRED' });
    assert.equal(unavailable.writes(), 0);
});

test('连接测试拒绝鉴权及协议错误，不把上游正文或密钥回传给浏览器', async () => {
    const app = fixture(), patch = { revision: 'environment' };
    const failed = await testConnection(patch, { settings: app.settings, request: async () => { throw new Error('上游泄露正文 ' + token); } });
    assert.equal(failed.success, false); assert.ok(!JSON.stringify(failed).includes(token));
    const unauthorized = await testConnection(patch, { settings: app.settings, request: async () => { throw Object.assign(new Error(token), { code: 'PPT_SERVICE_UNAUTHORIZED' }); } });
    assert.equal(unauthorized.state, 'unauthorized');
    const incompatible = await testConnection(patch, { settings: app.settings, request: async () => ({ serviceProtocol: 2 }) }); assert.equal(incompatible.state, 'incompatible');
    assert.equal(app.writes(), 0);
});

test('真实设置HTTP接口只允许admin，保存和日志不回显密钥，旧修订不能覆盖新值', async () => {
    const values = fixture(), app = express(); app.use(express.json()); let reset = 0; const audit = [];
    registerPresentationMasterSettingsRoutes(app, { settings: values.settings, reset: () => reset++, logAction: (_req, action, detail) => audit.push({ action, detail }),
        authMiddleware(req, _res, next) { req.user = { id: 1, role: req.headers['x-role'] || 'user', username: req.headers['x-user'] || 'member' }; next(); }, test: async () => ({ success: true, message: '连接通过' }) });
    const server = http.createServer(app); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = 'http://127.0.0.1:' + server.address().port + '/settings/ppt-master';
    try {
        for (const headers of [{}, { 'x-role': 'admin', 'x-user': 'manager' }]) for (const [method, suffix] of [['GET', ''], ['PUT', ''], ['POST', '/test']]) {
            const response = await fetch(base + suffix, { method, headers: { ...headers, 'Content-Type': 'application/json' }, ...(method === 'GET' ? {} : { body: '{}' }) }); assert.equal(response.status, 403);
        }
        const headers = { 'x-role': 'admin', 'x-user': 'admin', 'Content-Type': 'application/json' };
        const response = await fetch(base, { method: 'PUT', headers, body: JSON.stringify({ revision: 'environment', token: changed }) }); assert.equal(response.status, 200);
        assert.equal(response.headers.get('cache-control'), 'no-store'); const serialized = await response.text(); assert.ok(!serialized.includes(changed)); assert.equal(reset, 1);
        const stale = await fetch(base, { method: 'PUT', headers, body: JSON.stringify({ revision: 'environment', enabled: false }) }); assert.equal(stale.status, 409);
        assert.ok(!JSON.stringify(audit).includes(changed));
    } finally { await new Promise(resolve => server.close(resolve)); }
});
