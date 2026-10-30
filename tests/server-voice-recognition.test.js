'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { EventEmitter } = require('node:events');
const express = require('express');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { createLocalSpeechService, validateAudio } = require('../server/services/speech-recognition');
const { registerVoiceRecognitionRoutes } = require('../server/routes/chat/voice-recognition');

function audioInput() {
    let api;
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../client/chat/voice-audio.js'), 'utf8'), {
        window: { Pivot: { exposeModule(_name, value) { api = value; } } }, btoa: value => Buffer.from(value, 'binary').toString('base64')
    });
    return { language: 'zh-CN', audioBase64: api.encodeWave([new Float32Array(4800).fill(0.2)], 48000) };
}
function fixture({ hold = false, enabled = true, platform = 'win32', noise = '', duplicate = false } = {}) {
    const children = [];
    const service = createLocalSpeechService({ enabled: () => enabled, platform, loadScript: async () => '固定系统识别脚本',
        spawnProcess(executable, args, options) {
            const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stdout.setEncoding = () => {};
            child.stderr = new EventEmitter(); child.stdin = new EventEmitter(); child.killed = false;
            child.kill = () => { child.killed = true; setImmediate(() => child.emit('close', 1)); };
            child.finish = result => {
                const output = `${platform === 'win32' ? 'PIVOT_SPEECH_RESULT:' : ''}${JSON.stringify(result)}\n`;
                child.stdout.emit('data', output + (duplicate ? output : '') + noise);
                child.emit('close', 0);
            };
            child.stdin.end = value => {
                child.input = value;
                if (options.env.PIVOT_SERVER_SPEECH_MODE === 'probe') setImmediate(() => child.finish({ languages: ['zh-CN'] }));
                else if (!hold) setImmediate(() => child.finish({ text: '识别结果' }));
            };
            children.push({ child, executable, args, options });
            return child;
        }
    });
    return { service, children };
}

test('Windows 识别协议能区分诊断输出，并拒绝多个结果', async () => {
    const { service } = fixture({ noise: '诊断输出\n' });
    assert.equal((await service.transcribe({ id: 1 }, audioInput())).text, '识别结果');
    const ambiguous = fixture({ duplicate: true }).service;
    assert.equal((await ambiguous.capabilities()).available, false);
});

test('浏览器录音规范化为短 WAV，服务拒绝伪装、超长及不支持的编码', () => {
    const input = audioInput();
    assert.equal(validateAudio(input).audio.readUInt32LE(24), 16000);
    for (const value of [{ ...input, language: 'zh-CN;cmd' }, { ...input, audioBase64: 'not-audio' },
        { ...input, audioBase64: Buffer.alloc(640046).toString('base64') }]) assert.throws(() => validateAudio(value));
    const wrong = Buffer.from(input.audioBase64, 'base64'); wrong.writeUInt16LE(2, 22);
    assert.throws(() => validateAudio({ ...input, audioBase64: wrong.toString('base64') }), error => error.code === 'VOICE_WAVE_INVALID');
});

test('服务器识别通过 stdin 内存传递音频，不写录音文件且不把音频放入命令参数', async () => {
    const { service, children } = fixture();
    const result = await service.transcribe({ id: 1 }, audioInput());
    assert.equal(result.text, '识别结果');
    assert.equal(result.audioRetention, 'none');
    const worker = children[1];
    assert.equal(worker.options.windowsHide, true);
    assert.equal(worker.options.shell, undefined);
    assert.ok(worker.args.includes('-EncodedCommand'));
    assert.equal(worker.args.some(value => value.includes('RIFF')), false);
    assert.equal(JSON.parse(worker.child.input).language, 'zh-CN');
    assert.equal(worker.options.stdio[0], 'pipe');
    const source = fs.readFileSync(path.join(__dirname, '../server/services/speech-recognition/windows-worker.ps1'), 'utf8');
    assert.match(source, /MemoryStream/); assert.match(source, /SetInputToWaveStream/);
    assert.doesNotMatch(source, /SetInputToDefaultAudioDevice|WriteAllBytes|Out-File|WebRequest|HttpClient/);
});

test('同用户并发被限制，取消请求终止本地识别进程并释放容量', async () => {
    const { service, children } = fixture({ hold: true });
    const controller = new AbortController();
    await service.capabilities();
    const first = service.transcribe({ id: 1 }, audioInput(), { signal: controller.signal });
    const aborted = assert.rejects(first, error => error.code === 'VOICE_ABORTED');
    await new Promise(resolve => setImmediate(resolve));
    await assert.rejects(service.transcribe({ id: 1 }, audioInput()), error => error.code === 'VOICE_BUSY');
    controller.abort(); await aborted;
    assert.equal(children[1].child.killed, true);
    const next = service.transcribe({ id: 1 }, audioInput());
    await new Promise(resolve => setImmediate(resolve));
    children[2].child.finish({ text: '恢复' });
    assert.equal((await next).text, '恢复');
});

test('关闭识别时不探测引擎，Linux 使用离线 Python 模型而非 Windows 专属路径', async () => {
    for (const config of [{ enabled: false }]) {
        const { service, children } = fixture(config);
        assert.equal((await service.capabilities()).available, false);
        await assert.rejects(service.transcribe({ id: 1 }, audioInput()), error => error.code === 'VOICE_ENGINE_UNAVAILABLE');
        assert.equal(children.length, 0);
    }
    const linux = fixture({ platform: 'linux' });
    assert.equal((await linux.service.capabilities()).provider, 'server_vosk');
    assert.equal((await linux.service.transcribe({ id: 1 }, audioInput())).text, '识别结果');
    assert.match(linux.children[1].args[1], /vosk-worker\.py$/);
    assert.equal(linux.children[1].args.includes('-EncodedCommand'), false);
    await assert.rejects(fixture().service.transcribe(null, audioInput()), error => error.statusCode === 401);
});

test('真实 HTTP 语音接口要求登录、禁缓存、返回文本并清理请求录音，不调用第三方', async () => {
    const app = express(); app.use(express.json());
    let body;
    const { service } = fixture();
    registerVoiceRecognitionRoutes(app, { authMiddleware(req, res, next) {
        if (!req.headers['x-test-user']) return res.status(401).json({ error: '需要登录' });
        req.user = { id: 7 }; body = req.body; next();
    }, service });
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    const url = `http://127.0.0.1:${server.address().port}`;
    try {
        assert.equal((await fetch(`${url}/chat/voice-recognition`)).status, 401);
        const cap = await fetch(`${url}/chat/voice-recognition`, { headers: { 'x-test-user': '7' } });
        assert.equal((await cap.json()).thirdPartyForwarding, false);
        const response = await fetch(`${url}/chat/voice-transcriptions`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-test-user': '7' }, body: JSON.stringify(audioInput()) });
        assert.equal(response.headers.get('cache-control'), 'no-store');
        assert.equal((await response.json()).text, '识别结果');
        assert.equal(body.audioBase64, '');
    } finally { await new Promise(resolve => server.close(resolve)); }
});

test('浏览器中文包缺失时选择部署内识别，不再强制依赖 SpeechRecognition', async () => {
    let api;
    const native = { usesServerInput: true, lang: 'zh-CN' };
    const context = { isSecureContext: true, navigator: { mediaDevices: { getUserMedia() {} } }, document: { documentElement: { lang: 'zh-CN' }, readyState: 'complete', getElementById: () => null },
        Pivot: { exposeModule: (_name, value) => { api = value; }, moduleApi(name) {
            return name === 'chat.serverVoiceRecognition' ? { supported: () => true, prepare: async () => native } : undefined;
        } } };
    context.window = context;
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../client/chat/voice-platform.js'), 'utf8'), context);
    assert.equal(api.availability(), '');
    assert.equal(await api.prepareRecognition(), native);
});

test('客户端本地引擎缺失时仍能使用部署内服务器，不要求用户重新选择', async () => {
    let api;
    const server = { usesServerInput: true, lang: 'zh-CN' };
    const context = { document: { documentElement: { lang: 'zh-CN' }, readyState: 'complete', getElementById: () => null },
        Pivot: { exposeModule: (_name, value) => { api = value; }, moduleApi(name) {
            if (name === 'chat.desktopVoiceRecognition') return { supported: () => true, prepare: async () => { throw Error('本机无引擎'); } };
            return name === 'chat.serverVoiceRecognition' ? { supported: () => true, prepare: async () => server } : undefined;
        } } };
    context.window = context;
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../client/chat/voice-platform.js'), 'utf8'), context);
    assert.equal(await api.prepareRecognition(), server);
});

test('真实音频工作线程按块输出单声道 PCM，兼容多通道输入', () => {
    let Processor;
    const packets = [];
    const context = { AudioWorkletProcessor: class { constructor() { this.port = { postMessage: value => packets.push(value) }; } },
        registerProcessor(_name, value) { Processor = value; } };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../client/chat/voice-capture-worklet.js'), 'utf8'), context);
    const processor = new Processor();
    for (let index = 0; index < 16; index++) processor.process([[new Float32Array(128).fill(0.4), new Float32Array(128).fill(0.2)]]);
    assert.equal(packets.length, 1);
    assert.equal(packets[0].length, 2048);
    assert.ok(Math.abs(packets[0][0] - 0.3) < 0.0001);
    for (let index = 0; index < 3; index++) processor.process([[new Float32Array(128).fill(0.2)]]);
    processor.port.onmessage({ data: { type: 'flush' } });
    assert.equal(packets[1].length, 384, '停止时吐出未凑满一块的最后音频');
    assert.equal(packets[2].type, 'flushed');
});

async function clientCapture({ hold = false, drain = false } = {}) {
    const modules = new Map();
    const pending = [];
    const lengths = [];
    let port;
    let stops = 0;
    const context = { isSecureContext: true, navigator: { mediaDevices: { getUserMedia() {} } },
        document: { documentElement: { dataset: {} } }, setTimeout, clearTimeout, AbortController,
        API_BASE: '/api', showToast() {}, AudioContext: class {
            constructor() { this.sampleRate = 16000; this.destination = {}; this.audioWorklet = { addModule: async () => {} }; }
            createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
            createGain() { return { gain: {}, connect() {}, disconnect() {} }; }
            async resume() {} async close() {}
        }, AudioWorkletNode: class {
            constructor() {
                this.port = {}; port = this.port;
                if (drain) this.port.postMessage = () => {
                    port.onmessage({ data: new Float32Array(384).fill(0.004) });
                    port.onmessage({ data: { type: 'flushed' } });
                };
            }
            connect() {} disconnect() {}
        },
        apiFetch: async url => {
            if (url.endsWith('voice-recognition')) return { ok: true, json: async () => ({ available: true, languages: ['zh-CN'] }) };
            if (hold) return new Promise(resolve => pending.push(resolve));
            return { ok: true, json: async () => ({ text: '完整识别结果' }) };
        }, Pivot: { exposeModule: (name, value) => modules.set(name, value), moduleApi: name => modules.get(name) } };
    context.window = context;
    modules.set('chat.voiceAudio', { encodeWave(chunks) { lengths.push(chunks.reduce((sum, chunk) => sum + chunk.length, 0)); return audioInput().audioBase64; } });
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../client/chat/server-voice-recognition.js'), 'utf8'), context);
    const recognition = await modules.get('chat.serverVoiceRecognition').prepare('zh-CN');
    recognition.attachStream({ getTracks: () => [{ stop() { stops++; } }] });
    recognition.start();
    await new Promise(resolve => setImmediate(resolve));
    return { recognition, lengths, pending, send: (length, value) => port.onmessage({ data: new Float32Array(length).fill(value) }),
        get stops() { return stops; } };
}

test('低音量语音和 800ms 自然停顿不被截断，句首预录也保留', async () => {
    const capture = await clientCapture();
    try {
        capture.recognition.continuous = true;
        capture.send(3200, 0);
        capture.send(4000, 0.004);
        capture.send(12800, 0);
        assert.equal(capture.lengths.length, 0, '800ms 内的停顿仍等待后半句');
        capture.send(4000, 0.004);
        capture.send(16000, 0);
        assert.equal(capture.lengths[0], 40000, '低于旧 0.008 阈值的说话仍能完整提交');
        await new Promise(resolve => setImmediate(resolve));
    } finally { capture.recognition.abort(); }
});

test('完成录音时等待工作线程尾包和全部排队转写，不因第一段返回就丢掉第二段', async () => {
    const capture = await clientCapture({ hold: true, drain: true });
    let text = '';
    capture.recognition.onresult = event => { text = event.results.map(item => item[0].transcript).join(''); };
    try {
        capture.send(4000, 0.02);
        capture.send(16000, 0);
        await new Promise(resolve => setImmediate(resolve));
        capture.send(4000, 0.004);
        capture.recognition.stop();
        assert.equal(capture.stops, 1);
        assert.deepEqual(capture.lengths, [20000, 4384]);
        capture.pending[0]({ ok: true, json: async () => ({ text: '第一段' }) });
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(capture.pending.length, 2, '第一段返回后继续处理已收尾的第二段');
        capture.pending[1]({ ok: true, json: async () => ({ text: '第二段尾句' }) });
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(text, '第一段第二段尾句');
    } finally { capture.recognition.abort(); }
});

test('服务器录音适配器停止时立即释放麦克风，取消后迟到文字不会覆盖输入', async () => {
    const modules = new Map();
    let port;
    let stops = 0;
    let resolveResponse;
    let signal;
    const context = { isSecureContext: true, navigator: { mediaDevices: { getUserMedia() {} } },
        document: { documentElement: { dataset: {} } }, setTimeout, clearTimeout, AbortController,
        API_BASE: '/api', showToast() {}, AudioContext: class {
            constructor() { this.sampleRate = 16000; this.destination = {}; this.audioWorklet = { addModule: async () => {} }; }
            createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
            createGain() { return { gain: {}, connect() {}, disconnect() {} }; }
            async resume() {} async close() {}
        }, AudioWorkletNode: class { constructor() { this.port = {}; port = this.port; } connect() {} disconnect() {} },
        apiFetch: async (url, options) => {
            if (url.endsWith('voice-recognition')) return { ok: true, json: async () => ({ available: true, languages: ['zh-CN'] }) };
            signal = options.signal;
            return new Promise(resolve => { resolveResponse = resolve; });
        }, Pivot: { exposeModule: (name, value) => modules.set(name, value), moduleApi: name => modules.get(name) } };
    context.window = context;
    modules.set('chat.voiceAudio', { encodeWave: () => audioInput().audioBase64 });
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../client/chat/server-voice-recognition.js'), 'utf8'), context);
    const recognition = await modules.get('chat.serverVoiceRecognition').prepare('zh-CN');
    recognition.attachStream({ getTracks: () => [{ stop() { stops++; } }] });
    let text = '';
    recognition.onresult = event => { text = event.results[0][0].transcript; };
    recognition.start();
    await new Promise(resolve => setImmediate(resolve));
    port.onmessage({ data: new Float32Array(8000).fill(0.2) });
    recognition.stop();
    assert.equal(stops, 1);
    await new Promise(resolve => setImmediate(resolve));
    recognition.abort();
    assert.equal(signal.aborted, true);
    resolveResponse({ ok: true, json: async () => ({ text: '不应显示的迟到结果' }) });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(text, '');
});
