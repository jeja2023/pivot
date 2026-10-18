const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'client', 'chat', 'realtime-voice.js'), 'utf8');

function createElement() {
    const attributes = new Map();
    return {
        disabled: false,
        classList: { toggle() {} },
        setAttribute(name, value) { attributes.set(name, String(value)); },
        getAttribute(name) { return attributes.get(name); }
    };
}

function createStream() {
    const track = { stopped: false, stop() { this.stopped = true; } };
    return { stream: { getTracks: () => [track] }, track };
}

function loadRealtimeVoice({ getUserMedia, apiFetchHandler = null }) {
    const modules = new Map();
    const toasts = [];
    const requests = [];
    const elements = { 'chat-realtime-voice': createElement(), 'user-input': { value: '', dispatchEvent() {} } };
    class Recognition {
        constructor() { this.processLocally = true; }
        start() { this.started = true; }
        abort() { this.aborted = true; }
    }
    const context = {
        API_BASE: '/api',
        Event: class Event {},
        SpeechRecognition: Recognition,
        currentSessionId: 'session-1',
        document: { getElementById: id => elements[id] || null },
        navigator: { language: 'zh-CN', mediaDevices: { getUserMedia } },
        showToast: (message, level) => toasts.push({ message, level }),
        apiFetch: async (url, options = {}) => {
            requests.push({ url, options });
            if (apiFetchHandler) return await apiFetchHandler(url, options);
            return {
                ok: true,
                json: async () => ({ voiceSession: { id: 'voice-1' } })
            };
        },
        setTimeout,
        clearTimeout,
        setInterval,
        clearInterval
    };
    context.speechSynthesis = {
        getVoices: () => [{ lang: 'zh-CN', localService: true }],
        cancel() {},
        speak() {}
    };
    context.SpeechSynthesisUtterance = class SpeechSynthesisUtterance {};
    context.addEventListener = () => {};
    context.globalThis = context;
    context.window = context;
    context.Pivot = {
        legacy: {},
        exposeModule(name, api) { modules.set(name, api); },
        moduleApi() { return {}; }
    };
    vm.runInNewContext(source, context, { filename: 'client/chat/realtime-voice.js' });
    return { api: modules.get('chat.realtimeVoice'), elements, requests, toasts };
}

test('实时语音使用默认麦克风，并在采集成功后才创建服务端语音会话', async () => {
    const { stream, track } = createStream();
    const requests = [];
    const voice = loadRealtimeVoice({
        getUserMedia: async constraints => {
            requests.push(constraints);
            return stream;
        }
    });

    try {
        const session = await voice.api.startRealtimeVoice();

        assert.ok(session);
        assert.equal(requests.length, 1);
        assert.equal(requests[0].audio, true);
        assert.equal(voice.requests.filter(item => item.url === '/api/chat/voice-sessions').length, 1);
    } finally {
        voice.api.stopRealtimeVoice();
    }
    assert.equal(track.stopped, true);
});

test('实时语音将不存在的麦克风设备转换为可操作提示且不创建会话', async () => {
    const error = new Error();
    error.name = 'NotFoundError';
    const voice = loadRealtimeVoice({ getUserMedia: async () => { throw error; } });

    const session = await voice.api.startRealtimeVoice();

    assert.equal(session, null);
    assert.equal(voice.requests.filter(item => item.url === '/api/chat/voice-sessions').length, 0);
    assert.deepEqual(voice.toasts.at(-1), {
        level: 'error',
        message: '未检测到可用的麦克风。请确认系统已启用输入设备，并允许当前浏览器或桌面客户端访问麦克风后重试。'
    });
});

test('实时语音把明确任务控制口令送往绑定会话，而不提交为聊天文本', async () => {
    const { stream } = createStream();
    const voice = loadRealtimeVoice({
        getUserMedia: async () => stream,
        apiFetchHandler: async url => ({
            ok: true,
            json: async () => url.endsWith('/task-control')
                ? { message: '任务已暂停，可说“继续任务”从安全检查点续跑。' }
                : { voiceSession: { id: 'voice-1' } }
        })
    });
    try {
        const session = await voice.api.startRealtimeVoice();
        session.recognition.onresult({
            resultIndex: 0,
            results: [{ isFinal: true, 0: { transcript: '暂停任务' } }]
        });
        await new Promise(resolve => setTimeout(resolve, 0));
        const taskControl = voice.requests.find(item => item.url.endsWith('/task-control'));
        assert.ok(taskControl);
        assert.equal(JSON.parse(taskControl.options.body).action, 'pause');
        assert.equal(voice.elements['user-input'].value, '');
    } finally {
        voice.api.stopRealtimeVoice();
    }
});
