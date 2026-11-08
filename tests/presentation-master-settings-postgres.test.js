'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const { queryOne, execute, transaction } = require('../server/db/client');
const repository = require('../server/repositories/presentation-master-settings');
const { createSettings, pptMasterSettings } = require('../server/services/presentations/master/settings');
const runtime = require('../server/services/presentations/master/runtime');
const client = require('../server/services/presentations/master/service-client');
const store = require('../server/services/tool-tasks');
const master = require('../server/repositories/presentation-master-tasks');
const options = { skip: !process.env.DATABASE_URL, timeout: 60000 };
const KEY = 'ppt_master_secret_config';

test('真实数据库并发保存只接受一个修订，保存内容是密文且有操作者', options, async () => {
    const key = 'ppt-master-cas-test-' + crypto.randomUUID(), user = await queryOne('SELECT * FROM users ORDER BY id LIMIT 1');
    const settings = () => createSettings({ readValue: async () => (await queryOne('SELECT value FROM app_settings WHERE key=?', [key]))?.value ?? null,
        replace: (_key, previous, next, userId) => repository.replace(key, previous, next, userId), readEnv: () => ({ enabled: false, endpoint: '', token: '' }) });
    try {
        const results = await Promise.allSettled([settings().save({ revision: 'environment', endpoint: 'http://127.0.0.1:8502', token: 'a'.repeat(64), enabled: true }, { userId: user.id }),
            settings().save({ revision: 'environment', endpoint: 'http://127.0.0.1:8503', token: 'b'.repeat(64), enabled: true }, { userId: user.id })]);
        assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
        assert.equal(results.find(result => result.status === 'rejected').reason.code, 'PPT_MASTER_SETTINGS_CONFLICT');
        const row = await queryOne('SELECT * FROM app_settings WHERE key=?', [key]); assert.match(row.value, /^enc:v2:/); assert.equal(Number(row.updated_by), Number(user.id));
        const fresh = await settings().effective(); assert.equal(fresh.enabled, true); assert.ok(!row.value.includes(fresh.token));
    } finally { await execute('DELETE FROM app_settings WHERE key=?', [key]); }
});

test('未提交制作任务与连接切换使用同一锁，活动任务不能被页面配置切断', options, async () => {
    const key = 'ppt-master-active-test-' + crypto.randomUUID(), user = await queryOne('SELECT * FROM users ORDER BY id LIMIT 1');
    let entered, release;
    const inside = new Promise(resolve => entered = resolve), waiting = new Promise(resolve => release = resolve);
    const pending = master.admit(user, async executor => { entered(); await waiting; return store.createToolTaskStore({ queryOne: executor.queryOne, execute: executor.execute }).create({ user, toolName: 'presentation.master' }); });
    await inside;
    const writing = repository.replace(key, null, 'new-config', user.id); release(); const task = await pending;
    try {
        assert.equal((await writing).busy, true); assert.equal(await queryOne('SELECT * FROM app_settings WHERE key=?', [key]), null);
        await store.requestCancel(task.id, user); assert.equal((await repository.replace(key, null, 'new-config', user.id)).saved, true);
    } finally { await execute('DELETE FROM tool_tasks WHERE id=?', [task.id]); await execute('DELETE FROM app_settings WHERE key=?', [key]); }
});

test('页面保存立即成为实际调用连接，停用和刷新生效，环境配置不覆盖页面设置', options, async () => {
    const previous = await queryOne('SELECT * FROM app_settings WHERE key=?', [KEY]), envUrl = process.env.PIVOT_PPT_MASTER_SERVICE_URL, envToken = process.env.PIVOT_PPT_MASTER_SERVICE_TOKEN;
    const user = await queryOne('SELECT * FROM users ORDER BY id LIMIT 1'), requests = [];
    const token = 'c'.repeat(64), runtimeId = 'sha256:' + 'd'.repeat(64);
    const server = http.createServer((req, res) => {
        requests.push(req.headers.authorization);
        if (req.headers.authorization !== 'Bearer ' + token) { res.writeHead(401); return res.end(JSON.stringify({ error: { code: 'PPT_SERVICE_UNAUTHORIZED' } })); }
        res.setHeader('Content-Type', 'application/json');
        if (req.url === '/v1/info') return res.end(JSON.stringify({ status: 'ready', serviceProtocol: 1, runtimeId, revision: 'server-commit', version: 'service-test', capabilities: ['files', 'operations', 'cancel', 'native', 'templates'] }));
        const chunks = []; req.on('data', chunk => chunks.push(chunk)); req.on('end', () => res.end(JSON.stringify(req.url.includes('/operations/') ? { ok: true, serviceProtocol: 1, runtimeId, result: { files: [] } } : { runtimeId })));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
        await execute('DELETE FROM app_settings WHERE key=?', [KEY]);
        process.env.PIVOT_PPT_MASTER_SERVICE_URL = 'http://127.0.0.1:1'; process.env.PIVOT_PPT_MASTER_SERVICE_TOKEN = 'e'.repeat(64);
        const endpoint = 'http://127.0.0.1:' + server.address().port;
        let saved = await pptMasterSettings.save({ revision: 'environment', endpoint, token, enabled: true }, { userId: user.id }); client.reset();
        const availability = await runtime.availability(); assert.equal(availability.enabled, true); assert.equal(availability.version, 'service-test');
        assert.deepEqual(await runtime.execute(user, 'tooltask_' + crypto.randomBytes(24).toString('base64url'), { action: 'list' }), { files: [] });
        assert.ok(requests.every(value => value === 'Bearer ' + token)); assert.ok(!JSON.stringify(saved).includes(token));
        const identity = await runtime.identity(); assert.match(identity, /^service:/);
        saved = await pptMasterSettings.save({ revision: saved.revision, enabled: false }, { userId: user.id }); client.reset();
        assert.equal((await runtime.availability()).enabled, false); assert.equal(await runtime.identity(), '');
        const newInstance = createSettings(); assert.equal((await newInstance.effective()).enabled, false);
        await assert.rejects(() => runtime.execute(user, 'tooltask_' + crypto.randomBytes(24).toString('base64url'), { action: 'list' }), /停用/);
        assert.equal((await newInstance.effective()).endpoint, endpoint);
    } finally {
        server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
        await transaction(async executor => { await executor.execute('DELETE FROM app_settings WHERE key=?', [KEY]); if (previous) await executor.execute('INSERT INTO app_settings(key,value,updated_at,updated_by) VALUES(?,?,?,?)', [KEY, previous.value, previous.updated_at, previous.updated_by]); });
        for (const [key, value] of [['PIVOT_PPT_MASTER_SERVICE_URL', envUrl], ['PIVOT_PPT_MASTER_SERVICE_TOKEN', envToken]]) if (value === undefined) delete process.env[key]; else process.env[key] = value;
        client.reset();
    }
});
