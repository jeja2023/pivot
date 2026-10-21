'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const { createSpeechSettings } = require('../server/services/speech-recognition/settings');
const { validateSpeechSettings } = require('../server/services/speech-recognition/settings-validation');
const { testSpeechSettings } = require('../server/services/speech-recognition/settings-test');
const { registerSpeechSettingsRoutes } = require('../server/routes/speech-settings');
const { createSpeechService } = require('../server/services/speech-recognition/service');
const { readTypedEnv } = require('../server/config/env-registry');

const previousEncryption = process.env.DATA_ENCRYPTION_KEY;
test.before(() => { process.env.DATA_ENCRYPTION_KEY = 'speech-settings-test-only-encryption-32-characters'; });
test.after(() => { if (previousEncryption === undefined) delete process.env.DATA_ENCRYPTION_KEY; else process.env.DATA_ENCRYPTION_KEY = previousEncryption; });

function fixture(env = {}) {
    const rows = new Map(); let writes = 0;
    const settings = createSpeechSettings({ readEnv: name => readTypedEnv(name, env), getValue: key => rows.get(key),
        async setValue(key, value) { writes++; rows.set(key, value); } });
    return { settings, rows, writes: () => writes };
}

test('语音页面配置加密持久化并优先于环境，公开响应不包含密钥或未授权服务地址', async () => {
    const app = fixture({ PIVOT_VOICE_PROVIDER: 'gateway', PIVOT_VOICE_ENDPOINT: 'http://127.0.0.1:8000/transcribe', PIVOT_VOICE_API_KEY: 'env-private-key' });
    assert.equal(app.settings.effective().source, 'environment');
    const saved = await app.settings.save({ revision: 'environment', provider: 'embedded', hotwords: '智枢,刑法', cpuThreads: 6 }, { userId: 7 });
    assert.equal(saved.source, 'settings'); assert.equal(saved.hasApiKey, true); assert.equal(saved.apiKey, undefined);
    assert.equal(app.settings.read('PIVOT_VOICE_PROVIDER'), 'embedded'); assert.equal(app.settings.read('PIVOT_EMBEDDED_VOICE_CPU_THREADS'), 6);
    const raw = [...app.rows.values()][0]; assert.match(raw, /^enc:v2:/); assert.ok(!raw.includes('env-private-key'));
    assert.ok(!raw.includes('http://127.0.0.1'));
    const publicValue = app.settings.publicConfig();
    assert.equal(publicValue.endpoint, '********'); assert.equal(publicValue.hotwords, undefined); assert.equal(publicValue.canManage, false);
    assert.ok(!JSON.stringify(saved).includes('env-private-key'));
});

test('空白密钥保留，清除需明确选择，更换服务地址不复用旧密钥', async () => {
    const app = fixture({ PIVOT_VOICE_PROVIDER: 'gateway', PIVOT_VOICE_ENDPOINT: 'http://127.0.0.1:8000/transcribe', PIVOT_VOICE_API_KEY: 'old-secret' });
    let saved = await app.settings.save({ revision: 'environment', apiKey: '' });
    assert.equal(app.settings.effective().apiKey, 'old-secret');
    await assert.rejects(app.settings.save({ revision: saved.revision, endpoint: 'http://127.0.0.1:8001/transcribe', apiKey: '' }), /新密钥/);
    saved = await app.settings.save({ revision: saved.revision, endpoint: 'http://127.0.0.1:8001/transcribe', apiKey: 'new-secret' });
    assert.equal(app.settings.effective().apiKey, 'new-secret');
    await app.settings.save({ revision: saved.revision, clearApiKey: true, apiKey: '' });
    assert.equal(app.settings.effective().apiKey, '');
    assert.equal(app.settings.publicConfig().hasApiKey, false);
});

test('语音配置阻止地址越权、协议冲突、脚本路径注入和无效参数', async () => {
    const app = fixture({ PIVOT_VOICE_PROVIDER: 'embedded' });
    const previous = app.settings.effective();
    const patches = [
        { provider: 'unknown' }, { cpuThreads: 17 }, { timeoutMs: 2 }, { enabled: 'true' },
        { hotwords: '字'.repeat(41) }, { hotwords: Array(101).fill('词').join(',') },
        { PIVOT_EMBEDDED_VOICE_WORKER: '/tmp/untrusted.py' },
        { provider: 'gateway', endpoint: 'http://169.254.169.254/transcribe' },
        { provider: 'gateway', endpoint: 'https://8.8.8.8/transcribe' },
        { provider: 'gateway', endpoint: 'http://user:secret@127.0.0.1/transcribe' },
        { provider: 'gateway', endpoint: 'http://127.0.0.1/transcribe?api_key=secret' },
        { provider: 'gateway', endpoint: 'http://127.0.0.1/transcribe', streamEndpoint: 'ws://127.0.0.1:8001/stream' },
        { provider: 'openai', endpoint: 'http://127.0.0.1/v1/audio/transcriptions', model: '' }
    ];
    for (const patch of patches) await assert.rejects(validateSpeechSettings(patch, previous), undefined, JSON.stringify(patch));
    assert.equal(app.writes(), 0);
});

test('并发保存有修订冲突保护，损坏配置重复读取保持失败关闭', async () => {
    const app = fixture({ PIVOT_VOICE_PROVIDER: 'embedded' });
    const results = await Promise.allSettled([app.settings.save({ revision: 'environment', cpuThreads: 2 }), app.settings.save({ revision: 'environment', cpuThreads: 8 })]);
    assert.equal(results.filter(value => value.status === 'fulfilled').length, 1);
    assert.equal(results.find(value => value.status === 'rejected').reason.code, 'VOICE_SETTINGS_CONFLICT');
    const key = [...app.rows.keys()][0]; app.rows.set(key, 'invalid encrypted configuration');
    for (let i = 0; i < 2; i++) assert.throws(() => app.settings.read('PIVOT_VOICE_PROVIDER'), error => error.code === 'VOICE_SETTINGS_UNREADABLE');
    assert.equal(app.settings.publicConfig().provider, 'unavailable');
    assert.equal(app.settings.publicConfig().configured, false);
});

test('加密密钥缺失或持久化失败时不切换当前运行配置', async () => {
    const noEncryption = createSpeechSettings({ getValue: () => '', canEncrypt: () => false, readEnv: name => readTypedEnv(name, {}),
        setValue: async () => { throw new Error('Unexpected write'); } });
    await assert.rejects(noEncryption.save({ revision: 'environment', provider: 'embedded' }), error => error.code === 'VOICE_SETTINGS_ENCRYPTION_REQUIRED');
    assert.equal(noEncryption.effective().source, 'environment');
    const unavailable = createSpeechSettings({ getValue: () => '', readEnv: name => readTypedEnv(name, {}),
        setValue: async () => { throw new Error('Database unavailable'); } });
    await assert.rejects(unavailable.save({ revision: 'environment', provider: 'embedded' }));
    assert.equal(unavailable.effective().provider, 'local');
});

test('测试未保存语音网关和兼容 API 不更改配置，连接错误不回传上游正文', async () => {
    const app = fixture({ PIVOT_VOICE_PROVIDER: 'embedded' });
    const gateway = { provider: 'gateway', endpoint: 'http://127.0.0.1:8000/transcribe', streamEndpoint: 'ws://127.0.0.1:8000/stream', apiKey: 'draft-secret' };
    let received;
    const success = await testSpeechSettings(gateway, { settings: app.settings, probe: async config => { received = config; return { streaming: true }; } });
    assert.equal(success.success, true); assert.equal(success.streaming, true); assert.equal(received.apiKey, 'draft-secret');
    const failed = await testSpeechSettings(gateway, { settings: app.settings, probe: async () => { throw new Error('upstream private draft-secret'); } });
    assert.equal(failed.success, false); assert.ok(!JSON.stringify(failed).includes('draft-secret'));
    const api = await testSpeechSettings({ provider: 'openai', endpoint: 'http://127.0.0.1/audio', model: 'test-model' }, {
        settings: app.settings, transcribe: async request => { assert.equal(request.audio.toString('ascii', 0, 4), 'RIFF'); return { text: '', noSpeech: true }; } });
    assert.equal(api.success, true); assert.equal(app.writes(), 0); assert.equal(app.settings.effective().provider, 'embedded');
});

test('真实 HTTP 设置路由只允许最高管理员，保存与测试不回显密钥并关闭旧连接', async () => {
    const app = express(); app.use(express.json());
    const values = fixture({ PIVOT_VOICE_PROVIDER: 'embedded' });
    let reset = 0; let restarted = 0; let audits = [];
    registerSpeechSettingsRoutes(app, { settings: values.settings,
        authMiddleware(req, res, next) { req.user = { id: 1, role: req.headers['x-user-role'] || 'user', username: req.headers['x-username'] || 'member' }; next(); },
        service: { capabilities: async () => ({ available: true, provider: values.settings.read('PIVOT_VOICE_PROVIDER') }), reset() { reset++; } },
        embedded: { async reconfigure() { restarted++; }, enabled: () => false }, streaming: { reset() { reset++; } },
        logAction(_req, action, detail) { audits.push({ action, detail }); }, testConnection: async () => ({ success: true, message: '服务可用' }) });
    const server = http.createServer(app); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}/settings/speech`;
    try {
        for (const headers of [{}, { 'x-user-role': 'admin', 'x-username': 'manager' }]) {
            assert.equal((await fetch(base, { headers })).status, 403);
            assert.equal((await fetch(base + '/test', { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: '{}' })).status, 403);
        }
        const headers = { 'x-user-role': 'admin', 'x-username': 'admin', 'Content-Type': 'application/json' };
        const initial = await (await fetch(base, { headers })).json(); assert.equal(initial.config.revision, 'environment');
        const response = await fetch(base, { method: 'PUT', headers, body: JSON.stringify({ revision: 'environment', provider: 'gateway', endpoint: 'http://127.0.0.1:8000/transcribe', apiKey: 'stored-secret' }) });
        assert.equal(response.status, 200); const text = await response.text(); assert.ok(!text.includes('stored-secret')); assert.ok(text.includes('hasApiKey'));
        assert.equal(reset, 2); assert.equal(restarted, 1); assert.ok(!JSON.stringify(audits).includes('stored-secret'));
        const stale = await fetch(base, { method: 'PUT', headers, body: JSON.stringify({ revision: 'environment', provider: 'embedded' }) }); assert.equal(stale.status, 409);
    } finally { await new Promise(resolve => server.close(resolve)); }
});

test('页面切换配置会中止正在执行的 HTTP 转写，旧结果不能回写新服务', async () => {
    let started;
    const running = new Promise(resolve => { started = resolve; });
    const env = { PIVOT_VOICE_PROVIDER: 'gateway', PIVOT_VOICE_ENDPOINT: 'http://127.0.0.1:8000/transcribe' };
    const service = createSpeechService({ read: name => readTypedEnv(name, env), transcribeProvider: request => new Promise((_resolve, reject) => {
        request.signal.addEventListener('abort', () => reject(Object.assign(new Error('cancelled'), { code: 'VOICE_ABORTED' })), { once: true }); started();
    }) });
    const wav = Buffer.alloc(44 + 16000);
    wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16);
    wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(16000, 24); wav.writeUInt32LE(32000, 28);
    wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(16000, 40);
    for (let i = 0; i < 8000; i++) wav.writeInt16LE(Math.round(Math.sin(i * 0.11) * 3000), 44 + i * 2);
    const request = service.transcribe({ id: 222 }, { language: 'zh-CN', audioBase64: wav.toString('base64') });
    const rejected = assert.rejects(request, error => error.code === 'VOICE_ABORTED');
    await running; service.reset(); await rejected;
});
