'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const http = require('node:http');
const { readTypedEnv } = require('../server/config/env-registry');
const { createSpeechService } = require('../server/services/speech-recognition/service');
const { providerRequestOptions, normalizeProviderResult, normalizeHotwords, transcribeWithProvider } = require('../server/services/speech-recognition/provider');

function audio(silent = false) {
    const bytes = Buffer.alloc(44 + 16000);
    bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8); bytes.writeUInt32LE(16, 16);
    bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22); bytes.writeUInt32LE(16000, 24); bytes.writeUInt32LE(32000, 28);
    bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write('data', 36); bytes.writeUInt32LE(16000, 40);
    for (let i = 0; i < 8000; i++) bytes.writeInt16LE(silent ? 0 : Math.round(Math.sin(i * 0.11) * 3000), 44 + i * 2);
    return { language: 'zh-CN', audioBase64: bytes.toString('base64') };
}
function read(env) { return name => readTypedEnv(name, env); }

test('语音内网策略拒绝公网、凭据 URL 和元数据地址，仅管理员配置可确定服务目标', async () => {
    for (const value of ['https://user:password@example.com/path', 'file:///tmp/audio', 'http://169.254.169.254/latest']) {
        await assert.rejects(() => providerRequestOptions(value, false));
    }
    await assert.rejects(() => providerRequestOptions('https://example.com/transcribe', false, { lookup: async () => [{ address: '93.184.216.34' }] }), error => error.code === 'VOICE_EXTERNAL_DISABLED');
    const options = await providerRequestOptions('http://127.0.0.1:8000/transcribe', false);
    assert.equal(options.internal, true); options.httpAgent.destroy(); options.httpsAgent.destroy();
    const pinned = await providerRequestOptions('http://speech.example:8000/transcribe', false, { lookup: async () => [{ address: '10.20.30.40', family: 4 }] });
    const address = await new Promise((resolve, reject) => pinned.httpAgent.options.lookup('speech.example', {}, (error, value) => error ? reject(error) : resolve(value)));
    assert.equal(address, '10.20.30.40'); pinned.httpAgent.destroy(); pinned.httpsAgent.destroy();
});

test('网关、兼容音频上传和 Qwen 协议经真实 HTTP 请求返回统一结果且密钥不回传', async () => {
    const requests = [];
    const server = http.createServer((req, res) => {
        const chunks = [];
        req.on('data', part => chunks.push(part)); req.on('end', () => {
            requests.push({ headers: req.headers, body: Buffer.concat(chunks).toString() });
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify(req.url === '/qwen' ? { choices: [{ message: { content: 'language Chinese<asr_text>本公司规章制度。' } }] } : { text: '本公司规章制度。', confidence: 0.5 }));
        });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
        for (const kind of ['gateway', 'openai', 'qwen']) {
            const result = await transcribeWithProvider({ audio: Buffer.from(audio().audioBase64, 'base64'), language: 'zh-CN', config: {
                endpoint: `http://127.0.0.1:${server.address().port}/${kind}`, kind, allowExternal: false,
                apiKey: 'private-key', model: 'test-asr', timeoutMs: 3000, hotwords: ['智枢'], minConfidence: 0.65
            } });
            assert.equal(result.text, '本公司规章制度。');
            assert.equal(result.thirdPartyForwarding, false);
            assert.equal(result.requiresReview, kind !== 'qwen');
            assert.equal(requests.at(-1).headers.authorization, 'Bearer private-key');
            assert.match(requests.at(-1).body, /智枢/);
            if (kind === 'openai') {
                assert.match(requests.at(-1).headers['content-type'], /multipart\/form-data/);
                assert.match(requests.at(-1).body, /RIFF/);
            }
        }
    } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('无语音不调用模型，容量在取消和故障后释放；配置主服务故障不回退系统识别', async () => {
    let calls = 0; let finish;
    const env = { PIVOT_VOICE_PROVIDER: 'gateway', PIVOT_VOICE_ENDPOINT: 'http://speech/transcribe' };
    const service = createSpeechService({ read: read(env), localService: { transcribe() { throw new Error('不得回退'); } },
        transcribeProvider: ({ signal }) => { calls++; return new Promise((resolve, reject) => { finish = resolve; signal.addEventListener('abort', () => reject(Object.assign(new Error('取消'), { code: 'VOICE_ABORTED' }))); }); } });
    assert.equal((await service.transcribe({ id: 1 }, audio(true))).noSpeech, true);
    assert.equal(calls, 0);
    const controller = new AbortController();
    const first = service.transcribe({ id: 1 }, audio(), { signal: controller.signal });
    await assert.rejects(service.transcribe({ id: 1 }, audio()), error => error.code === 'VOICE_BUSY');
    const rejected = assert.rejects(first, error => error.code === 'VOICE_ABORTED'); controller.abort(); await rejected;
    const next = service.transcribe({ id: 1 }, audio()); finish({ text: '恢复', confidence: null });
    assert.equal((await next).text, '恢复'); assert.equal(calls, 2);
});

test('协议异常、未知置信度、无语音及热词长度有明确边界', () => {
    assert.equal(normalizeProviderResult({ text: '结果' }, 'gateway', 0.65).confidence, null);
    assert.equal(normalizeProviderResult({ text: '噪声虚构文字', noSpeech: true }, 'gateway', 0.65).text, '');
    assert.throws(() => normalizeProviderResult({ text: 'a'.repeat(5000) }, 'gateway', 0.65));
    assert.deepEqual(normalizeHotwords('智枢,智枢\n刑法，' + '字'.repeat(41)), ['智枢', '刑法']);
});

test('健康检查报告实际加载状态，未配置与禁用不会冒充服务就绪', async () => {
    const env = { PIVOT_VOICE_PROVIDER: 'gateway', PIVOT_VOICE_ENDPOINT: 'http://speech/transcribe', PIVOT_VOICE_STREAM_ENDPOINT: 'ws://speech/stream' };
    let probes = 0;
    const service = createSpeechService({ read: read(env), checkEndpoint: async () => ({ internal: true }), probe: async () => { probes++; return { streaming: true }; } });
    assert.equal((await service.capabilities()).streaming, true);
    assert.equal((await service.capabilities()).serverPreferred, true); assert.equal(probes, 1);
    env.PIVOT_SERVER_VOICE_ENABLED = 'false'; assert.equal((await service.capabilities()).available, false);
    env.PIVOT_SERVER_VOICE_ENABLED = 'true'; env.PIVOT_VOICE_ENDPOINT = ''; assert.equal((await service.capabilities()).available, false);
});
