'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { createDesktopVoiceRecognition, installDesktopVoiceRecognition } = require('../desktop/voice-recognition');

function fixture() {
    const children = [];
    const spawnProcess = (executable, args, options) => {
        const child = new EventEmitter();
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        child.stdin = new EventEmitter();
        child.stdin.write = value => { child.command = value; };
        child.killed = false;
        child.kill = () => { if (!child.killed) { child.killed = true; setImmediate(() => child.emit('close')); } };
        child.send = event => child.stdout.emit('data', Buffer.from(`${JSON.stringify(event)}\n`));
        children.push({ child, executable, args, options });
        if (options.env.PIVOT_NATIVE_VOICE_MODE === 'probe') setImmediate(() => child.send({ type: 'capabilities', languages: ['zh-CN'] }));
        return child;
    };
    return { broker: createDesktopVoiceRecognition({ spawnProcess, platform: 'win32', readScript: () => '测试脚本，不包含调用方输入' }), children };
}

test('桌面识别安全启动专用隐藏进程，只接受语言与请求标识，并正确收发和停止', async () => {
    const { broker, children } = fixture();
    assert.deepEqual((await broker.capabilities()).languages, ['zh-CN']);
    const events = [];
    const starting = broker.start(7, { id: 'speech-test-123', language: 'zh-CN' }, event => events.push(event));
    await new Promise(resolve => setImmediate(resolve));
    const { child, args, options } = children[1];
    assert.equal(options.windowsHide, true);
    assert.equal(options.shell, undefined);
    assert.ok(args.includes('-EncodedCommand'));
    assert.equal(args.includes('zh-CN'), false);
    child.send({ type: 'started' });
    assert.equal((await starting).provider, 'windows_system_speech');
    child.send({ type: 'result', text: '测试语音' });
    assert.equal(events.at(-1).text, '测试语音');
    assert.equal(broker.stop(9, 'speech-test-123'), false);
    assert.equal(child.killed, false);
    assert.equal(broker.stop(7, 'wrong-id'), false);
    assert.equal(broker.stop(7, 'speech-test-123'), true);
    assert.equal(child.killed, true);
    assert.equal(events.at(-1).type, 'ended');
    await assert.rejects(broker.start(7, { id: 'speech-invalid-123', language: 'zh-CN;calc' }, () => {}));
});

test('桌面收尾只接受所属页面与匹配请求，返回最后识别结果后正常结束', async () => {
    const { broker, children } = fixture();
    await broker.capabilities();
    const events = [];
    const starting = broker.start(7, { id: 'speech-finish-123', language: 'zh-CN' }, event => events.push(event));
    await new Promise(resolve => setImmediate(resolve));
    const child = children[1].child;
    child.send({ type: 'started' });
    await starting;
    assert.equal(broker.finish(8, 'speech-finish-123'), false);
    assert.equal(broker.finish(7, 'wrong-id'), false);
    assert.equal(broker.finish(7, 'speech-finish-123'), true);
    assert.equal(child.command, 'finish\n');
    assert.equal(child.killed, false);
    child.send({ type: 'result', text: '停止前的完整尾句' });
    child.send({ type: 'ended' });
    assert.deepEqual(events.map(event => event.type), ['started', 'result', 'ended']);
    assert.equal(events[1].text, '停止前的完整尾句');
    child.emit('close', 0);
    assert.equal(events.length, 3, '正常结束不再误报识别失败');
});

test('探测期间取消启动不会在探测完成后重新打开设备', async () => {
    const { broker, children } = fixture();
    const starting = broker.start(7, { id: 'speech-cancel-123', language: 'zh-CN' }, () => {});
    const rejected = assert.rejects(starting, error => error.code === 'native-voice-stopped');
    broker.stop(7, 'speech-cancel-123');
    await rejected;
    assert.equal(children.length, 1);
});

test('桌面启动设备失败返回可操作原因，未开始时不误报识别已启动', async () => {
    const { broker, children } = fixture();
    await broker.capabilities();
    const events = [];
    const starting = broker.start(7, { id: 'speech-fail-123', language: 'zh-CN' }, event => events.push(event));
    const rejected = assert.rejects(starting, error => error.code === 'audio-capture' && /麦克风/.test(error.message));
    await new Promise(resolve => setImmediate(resolve));
    children[1].child.send({ type: 'error', code: 'audio-capture' });
    await rejected;
    assert.deepEqual(events, []);
    assert.equal(children[1].child.killed, true);
});

test('原生语音 IPC 严格要求授权，其他页面不能探测、启动或停止', async () => {
    const handlers = new Map();
    let calls = 0;
    installDesktopVoiceRecognition({ ipcMain: { handle: (name, fn) => handlers.set(name, fn) },
        authorize() { throw Error('已拒绝'); }, send() {},
        broker: { capabilities() { calls++; }, start() { calls++; }, stop() { calls++; }, finish() { calls++; } } });
    for (const handler of handlers.values()) await assert.rejects(handler({ sender: { id: 1 } }, {}), /已拒绝/);
    assert.equal(calls, 0);
});

test('浏览器中文包不可用时，客户端自动走 Windows 中文识别并规范错误语言标识', async () => {
    const modules = new Map();
    let browserCalls = 0;
    const starts = [];
    let listener;
    const context = { isSecureContext: false, navigator: { language: 'en-US' }, document: { documentElement: { lang: 'h-CN' }, readyState: 'complete', getElementById: () => null },
        setTimeout, clearTimeout, SpeechRecognition: class { constructor() { browserCalls++; throw Error('不应触发'); } },
        pivotDesktop: { getVoiceRecognitionStatus: async () => ({ available: true, languages: ['zh-CN'] }),
            onVoiceRecognitionEvent(fn) { listener = fn; return () => { listener = null; }; },
            async startVoiceRecognition(input) { starts.push(input); listener({ id: input.id, type: 'started' }); return { success: true }; },
            async stopVoiceRecognition() {} },
        Pivot: { exposeModule: (name, value) => modules.set(name, value), moduleApi: name => modules.get(name) } };
    context.window = context;
    for (const name of ['desktop-voice-recognition.js', 'voice-platform.js']) vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../client/chat', name), 'utf8'), context);
    const api = modules.get('chat.voicePlatform');
    const recognition = await api.prepareRecognition();
    assert.equal(recognition.lang, 'zh-CN');
    assert.equal(recognition.usesDesktopInput, true);
    assert.equal(browserCalls, 0);
    let text = '';
    recognition.onresult = event => { text = event.results[0][0].transcript; };
    recognition.start();
    listener({ id: starts[0].id, type: 'result', text: '你好世界' });
    assert.equal(text, '你好世界');
    assert.equal(listener, null, '单次输入结束后解除事件监听');
});

test('非 Windows 客户端没有原生引擎时继续检查浏览器能力，不会跳过安全检查', async () => {
    let api;
    const context = { isSecureContext: false, navigator: {}, document: { documentElement: { lang: 'zh-CN' }, readyState: 'complete', getElementById: () => null },
        Pivot: { exposeModule: (_name, value) => { api = value; },
            moduleApi: () => ({ supported: () => true, prepare: async () => null }) } };
    context.window = context;
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../client/chat/voice-platform.js'), 'utf8'), context);
    await assert.rejects(api.prepareRecognition(), error => /HTTPS/.test(error.voiceMessage));
});

test('旧桌面客户端访问 HTTP 时提示更新原生组件，浏览器安全限制保持有效', async () => {
    let api;
    const context = { isSecureContext: false, pivotDesktop: { getStatus() {} }, navigator: {},
        document: { documentElement: { lang: 'zh-CN' }, readyState: 'complete', getElementById: () => null },
        Pivot: { exposeModule: (_name, value) => { api = value; }, moduleApi: () => null } };
    context.window = context;
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../client/chat/voice-platform.js'), 'utf8'), context);
    assert.match(api.availability(), /更新并重启 Pivot 客户端/);
    await assert.rejects(api.prepareRecognition(), error => /仅更新服务器页面/.test(error.voiceMessage));
    delete context.pivotDesktop;
    assert.match(api.availability(), /HTTPS/);
});

test('桌面桥存在但安装包未注册语音 IPC 时提示更新，不误报网页证书问题', async () => {
    const modules = new Map();
    const context = { isSecureContext: false, navigator: {},
        document: { documentElement: { lang: 'zh-CN' }, readyState: 'complete', getElementById: () => null },
        pivotDesktop: { getVoiceRecognitionStatus: async () => { throw Error('No handler registered'); },
            startVoiceRecognition() {}, stopVoiceRecognition() {}, onVoiceRecognitionEvent() {} },
        Pivot: { exposeModule: (name, api) => modules.set(name, api), moduleApi: name => modules.get(name) } };
    context.window = context;
    for (const name of ['desktop-voice-recognition.js', 'voice-platform.js']) vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../client/chat', name), 'utf8'), context);
    await assert.rejects(modules.get('chat.voicePlatform').prepareRecognition(), error => /原生语音通道未就绪/.test(error.voiceMessage));
});

test('桌面适配器点击完成时保留事件监听直到尾句返回，旧收尾响应不取消新识别', async () => {
    const modules = new Map();
    let listener;
    let finishResult;
    let lastId;
    const context = { pivotDesktop: {
        getVoiceRecognitionStatus: async () => ({ available: true, languages: ['zh-CN'] }),
        onVoiceRecognitionEvent(fn) { listener = fn; return () => { listener = null; }; },
        async startVoiceRecognition(input) { lastId = input.id; listener({ id: lastId, type: 'started' }); return { success: true }; },
        async stopVoiceRecognition() {},
        finishVoiceRecognition() { return new Promise(resolve => { finishResult = resolve; }); }
    }, Pivot: { exposeModule: (name, value) => modules.set(name, value) } };
    context.window = context;
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../client/chat/desktop-voice-recognition.js'), 'utf8'), context);
    const recognition = await modules.get('chat.desktopVoiceRecognition').prepare('zh-CN');
    let text = '';
    recognition.onresult = event => { text = event.results.at(-1)[0].transcript; };
    recognition.start();
    recognition.stop();
    listener({ id: lastId, type: 'result', text: '完整尾句' });
    assert.equal(text, '完整尾句');
    assert.equal(typeof listener, 'function');
    listener({ id: lastId, type: 'ended' });
    assert.equal(listener, null);
    recognition.start();
    finishResult(false);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(typeof listener, 'function', '旧收尾响应不会关闭新一轮监听');
    recognition.abort();
});
