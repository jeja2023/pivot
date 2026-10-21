'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { createEmbeddedSpeech } = require('../server/services/speech-recognition/embedded');
const { createSpeechService } = require('../server/services/speech-recognition/service');
const { readTypedEnv } = require('../server/config/env-registry');

function fixture({ startupMs = 2000 } = {}) {
    const env = { PIVOT_VOICE_PROVIDER: 'embedded' };
    const spawned = [];
    const read = name => name === 'PIVOT_EMBEDDED_VOICE_STARTUP_MS' ? startupMs : readTypedEnv(name, env);
    const spawnProcess = (binary, args, options) => {
        const child = new EventEmitter();
        child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.exitCode = null;
        child.signals = [];
        child.kill = signal => { child.signals.push(signal); globalThis.queueMicrotask(() => { child.exitCode = 0; child.emit('close', 0); }); return true; };
        spawned.push({ binary, args, options, child });
        return child;
    };
    const embedded = createEmbeddedSpeech({ read, spawnProcess, cooldownMs: 0, stopTimeoutMs: 50 });
    return { embedded, spawned, env, read,
        ready(port = 18001) { spawned.at(-1).child.stdout.write('model loading\nPIVOT_SPEECH_READY ' + JSON.stringify({ port, streaming: true }) + '\n'); } };
}

test('内置 CPU 模型并发预热只启动一个进程，动态端口和随机凭据仅供内部使用', async () => {
    const app = fixture();
    try {
        const first = app.embedded.ensureReady(); const second = app.embedded.ensureReady();
        assert.equal(app.spawned.length, 1); assert.equal(app.embedded.status().state, 'starting');
        app.ready();
        const connections = await Promise.all([first, second]);
        assert.deepEqual(connections[0], connections[1]);
        assert.equal(connections[0].endpoint, 'http://127.0.0.1:18001/transcribe');
        assert.equal(connections[0].streamEndpoint, 'ws://127.0.0.1:18001/stream');
        assert.equal(app.spawned[0].options.env.SPEECH_API_KEY, connections[0].apiKey);
        assert.equal(app.spawned[0].options.env.SPEECH_DEVICE, 'cpu');
        assert.equal(app.spawned[0].options.env.CUDA_VISIBLE_DEVICES, '');
        assert.equal(app.spawned[0].options.env.OMP_NUM_THREADS, '4');
        assert.equal(JSON.stringify(app.embedded.status()).includes(connections[0].apiKey), false);
    } finally { await app.embedded.stop(); }
    assert.equal(app.spawned[0].child.stdin.writableEnded, true);
    assert.equal(app.embedded.status().state, 'stopped');
    await assert.rejects(app.embedded.ensureReady(), error => error.code === 'VOICE_EMBEDDED_UNAVAILABLE');
});

test('取消一个等待者不终止其他用户的模型加载，退出后重新探测会启动新进程', async () => {
    const app = fixture();
    try {
        const controller = new AbortController();
        const cancelled = app.embedded.ensureReady({ signal: controller.signal });
        const remaining = app.embedded.ensureReady();
        const rejected = assert.rejects(cancelled, error => error.code === 'VOICE_ABORTED');
        controller.abort(); await rejected;
        assert.deepEqual(app.spawned[0].child.signals, []);
        app.ready(); const old = await remaining;
        app.spawned[0].child.exitCode = 1; app.spawned[0].child.emit('close', 1);
        const restarted = app.embedded.ensureReady(); app.ready(18002);
        const next = await restarted;
        assert.equal(app.spawned.length, 2); assert.notEqual(next.apiKey, old.apiKey);
        assert.equal(next.endpoint, 'http://127.0.0.1:18002/transcribe');
    } finally { await app.embedded.stop(); }
});

test('模型加载超时或无效端口会结束子进程，禁用及远程 API 模式不会启动模型', async () => {
    const app = fixture({ startupMs: 20 });
    await assert.rejects(app.embedded.ensureReady(), error => error.code === 'VOICE_EMBEDDED_UNAVAILABLE');
    assert.deepEqual(app.spawned[0].child.signals, ['SIGKILL']);
    await app.embedded.stop();
    const invalid = fixture(); const pending = invalid.embedded.ensureReady(); invalid.ready(0);
    await assert.rejects(pending); await invalid.embedded.stop();
    for (const mode of ['disabled', 'gateway', 'openai', 'qwen']) {
        const external = fixture();
        if (mode === 'disabled') external.env.PIVOT_SERVER_VOICE_ENABLED = 'false';
        else external.env.PIVOT_VOICE_PROVIDER = mode;
        await assert.rejects(external.embedded.ensureReady());
        assert.equal(external.spawned.length, 0);
        await external.embedded.stop();
    }
});

test('缺少 Python 解释器不会触发未处理进程错误，并发关闭仅收口一次', async () => {
    const env = { PIVOT_VOICE_PROVIDER: 'embedded', PIVOT_EMBEDDED_VOICE_PYTHON: 'pivot-test-missing-python-binary' };
    const missing = createEmbeddedSpeech({ read: name => readTypedEnv(name, env) });
    await assert.rejects(missing.ensureReady(), error => error.code === 'VOICE_EMBEDDED_UNAVAILABLE');
    assert.equal(missing.status().code, 'VOICE_EMBEDDED_PYTHON_MISSING');
    await missing.stop();
    const app = fixture();
    const ready = app.embedded.ensureReady(); app.ready(); await ready;
    await Promise.all([app.embedded.stop(), app.embedded.stop()]);
    assert.deepEqual(app.spawned[0].child.signals, ['SIGTERM']);
});

test('工作进程缺少依赖时返回受控具体原因，页面能力提示不再只显示尚未就绪', async () => {
    const app = fixture();
    const pending = app.embedded.ensureReady();
    app.spawned[0].child.stdout.write('PIVOT_SPEECH_ERROR ' + JSON.stringify({ code: 'VOICE_EMBEDDED_DEPENDENCY_MISSING', missing: ['funasr', 'silero_vad', 'private-key-value'] }) + '\n');
    await assert.rejects(pending, /funasr/);
    const diagnostic = app.embedded.status();
    assert.equal(diagnostic.code, 'VOICE_EMBEDDED_DEPENDENCY_MISSING');
    assert.ok(!JSON.stringify(diagnostic).includes('private-key-value'));
    const service = createSpeechService({ read: app.read, embedded: { status: () => diagnostic, ensureReady: async () => { throw new Error(); } } });
    const status = await service.capabilities();
    assert.equal(status.available, false); assert.match(status.reason, /silero_vad/);
    assert.equal(status.reasonCode, 'VOICE_EMBEDDED_DEPENDENCY_MISSING');
    await app.embedded.stop();
});

test('页面切换到远程服务会释放内置进程，切回内置模式可重新加载', async () => {
    const app = fixture();
    const first = app.embedded.ensureReady(); app.ready(); await first;
    app.env.PIVOT_VOICE_PROVIDER = 'gateway';
    await app.embedded.reconfigure();
    assert.equal(app.embedded.enabled(), false);
    await assert.rejects(app.embedded.ensureReady());
    assert.equal(app.spawned.length, 1);
    app.env.PIVOT_VOICE_PROVIDER = 'embedded';
    await app.embedded.reconfigure();
    const second = app.embedded.ensureReady(); app.ready(18003); await second;
    assert.equal(app.spawned.length, 2);
    await app.embedded.stop();
});

test('内置服务报告加载中，健康后经同一网关协议转写且不接受远程地址覆盖', async () => {
    const env = { PIVOT_VOICE_PROVIDER: 'embedded', PIVOT_VOICE_ENDPOINT: 'https://example.com/transcribe', PIVOT_VOICE_API_KEY: 'external-key' };
    let ready = false; let starts = 0; let submitted;
    const embedded = { status: () => ({ state: ready ? 'ready' : 'starting' }),
        async ensureReady() { starts++; return { endpoint: 'http://127.0.0.1:18001/transcribe', streamEndpoint: 'ws://127.0.0.1:18001/stream', apiKey: 'internal-only-key' }; } };
    const service = createSpeechService({ read: name => readTypedEnv(name, env), embedded,
        checkEndpoint: async url => { assert.match(url, /^http:\/\/127\.0\.0\.1:/); return { internal: true }; },
        probe: async () => ({ streaming: true }), transcribeProvider: async value => { submitted = value.config; return { text: '内置识别结果', confidence: null }; } });
    const starting = await service.capabilities();
    assert.equal(starting.available, false); assert.equal(starting.readiness, 'starting');
    ready = true;
    const capability = await service.capabilities();
    assert.equal(capability.available, true); assert.equal(capability.streaming, true); assert.equal(capability.provider, 'embedded');
    assert.equal(JSON.stringify(capability).includes('internal-only-key'), false);
    const bytes = Buffer.alloc(44 + 16000);
    bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8); bytes.writeUInt32LE(16, 16);
    bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22); bytes.writeUInt32LE(16000, 24); bytes.writeUInt32LE(32000, 28);
    bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write('data', 36); bytes.writeUInt32LE(16000, 40);
    for (let i = 0; i < 8000; i++) bytes.writeInt16LE(Math.round(Math.sin(i * 0.11) * 3000), 44 + i * 2);
    const result = await service.transcribe({ id: 401 }, { language: 'zh-CN', audioBase64: bytes.toString('base64') });
    assert.equal(result.provider, 'embedded'); assert.equal(submitted.kind, 'gateway'); assert.equal(submitted.allowExternal, false);
    assert.equal(submitted.apiKey, 'internal-only-key'); assert.ok(starts >= 1);
});
