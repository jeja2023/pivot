const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'client', 'chat', 'realtime-voice.js'), 'utf8');
const platform = fs.readFileSync(path.join(__dirname, '..', 'client', 'chat', 'voice-platform.js'), 'utf8');

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

function loadRealtimeVoice({ getUserMedia, apiFetchHandler = null, recognitionStart = null, sendMessage = null, voices = null, navigatorLanguage = 'zh-CN' }) {
    const modules = new Map();
    const toasts = [];
    const requests = [];
    const elements = { 'chat-realtime-voice': createElement(), 'chat-voice-status': createElement(), 'user-input': { value: '', dispatchEvent() {} } };
    const spoken = [];
    class Recognition {
        constructor() { this.processLocally = true; }
        start() { this.started = true; if (recognitionStart) recognitionStart(this); else this.onstart?.(); }
        abort() { this.aborted = true; }
    }
    const context = {
        API_BASE: '/api',
        Event: class Event {},
        SpeechRecognition: Recognition,
        currentSessionId: 'session-1',
        document: { getElementById: id => elements[id] || null },
        navigator: { language: navigatorLanguage, mediaDevices: { getUserMedia } },
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
        getVoices: () => voices || [{ lang: 'zh-CN', localService: true }],
        cancel() {},
        speak(utterance) { spoken.push(utterance); }
    };
    context.SpeechSynthesisUtterance = class SpeechSynthesisUtterance {};
    context.addEventListener = () => {};
    context.globalThis = context;
    context.window = context;
    context.Pivot = {
        legacy: { sendMessage },
        exposeModule(name, api) { modules.set(name, api); },
        moduleApi(name) { return modules.get(name); }
    };
    vm.runInNewContext(platform, context, { filename: 'client/chat/voice-platform.js' });
    vm.runInNewContext(source, context, { filename: 'client/chat/realtime-voice.js' });
    return { api: modules.get('chat.realtimeVoice'), elements, requests, toasts, spoken };
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

test('识别启动失败不能显示成功或继续占用麦克风', async () => {
    const { stream, track } = createStream();
    const voice = loadRealtimeVoice({ getUserMedia: async () => stream,
        recognitionStart: () => { throw Object.assign(new Error(), { name: 'NotAllowedError' }); } });
    assert.equal(await voice.api.startRealtimeVoice(), null);
    assert.equal(track.stopped, true);
    assert.equal(voice.elements['chat-realtime-voice'].getAttribute('aria-pressed'), 'false');
    assert.ok(voice.toasts.every(item => item.level !== 'success'));
    assert.match(voice.toasts.at(-1).message, /允许.*麦克风/);
});

test('只有识别器真正开始后才切换按钮，后续再次点击能结束', async () => {
    let ready;
    const { stream, track } = createStream();
    const voice = loadRealtimeVoice({ getUserMedia: async () => stream, recognitionStart: recognition => { ready = () => recognition.onstart(); } });
    const starting = voice.api.startRealtimeVoice();
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(voice.elements['chat-realtime-voice'].getAttribute('aria-pressed'), 'false');
    ready();
    await starting;
    assert.equal(voice.elements['chat-realtime-voice'].getAttribute('aria-pressed'), 'true');
    await voice.api.startRealtimeVoice();
    assert.equal(track.stopped, true);
    assert.equal(voice.elements['chat-realtime-voice'].getAttribute('aria-pressed'), 'false');
});

test('连续语音第二轮携带仅在内存中的上下文，停止时清空', async () => {
    const sends = [];
    let voice;
    voice = loadRealtimeVoice({ getUserMedia: async () => createStream().stream, sendMessage: async options => {
        sends.push(options);
        voice.api.flushAssistantSpeech(`回答${sends.length}`, 'voice-1');
    } });
    const session = await voice.api.startRealtimeVoice();
    const say = async text => {
        session.speaking = false;
        session.recognition.onresult({ resultIndex: 0, results: [{ isFinal: true, 0: { transcript: text } }] });
        await new Promise(resolve => setTimeout(resolve, 0));
    };
    await say('第一轮问题');
    await say('继续解释刚才的回答');
    assert.equal(sends.length, 2);
    assert.equal(sends[0].voiceHistory.length, 0);
    assert.deepEqual(Array.from(sends[1].voiceHistory, item => item.content), ['第一轮问题', '回答1']);
    voice.api.stopRealtimeVoice();
    assert.equal(session.history.length, 0);
});

test('实时语音逐阶段显示聆听、识别、等待与朗读，朗读语言跟随实际声音', async () => {
    let complete;
    const voice = loadRealtimeVoice({ navigatorLanguage: 'en-US', getUserMedia: async () => createStream().stream,
        sendMessage: () => new Promise(resolve => { complete = resolve; }), voices: [{ lang: 'zh-CN', localService: true }] });
    const session = await voice.api.startRealtimeVoice();
    try {
        const status = voice.elements['chat-voice-status'];
        assert.equal(status.hidden, false);
        assert.equal(status.getAttribute('data-state'), 'listening');
        session.recognition.onresult({ resultIndex: 0, results: [{ isFinal: false, 0: { transcript: '请解释' } }] });
        assert.equal(status.getAttribute('data-state'), 'recognizing');
        session.recognition.onresult({ resultIndex: 0, results: [{ isFinal: true, 0: { transcript: '请解释四季的原因' } }] });
        assert.equal(status.getAttribute('data-state'), 'thinking');
        voice.api.handleAssistantDelta('这是语音回答。', 'voice-1');
        const utterance = voice.spoken[0];
        assert.equal(utterance.lang, 'zh-CN');
        assert.equal(session.utterance, utterance);
        utterance.onstart();
        assert.equal(status.getAttribute('data-state'), 'speaking');
        utterance.onend();
        assert.equal(session.utterance, null);
        assert.equal(status.getAttribute('data-state'), 'thinking');
        complete();
        await new Promise(resolve => setTimeout(resolve, 0));
        assert.equal(status.getAttribute('data-state'), 'listening');
    } finally { complete?.(); voice.api.stopRealtimeVoice(); }
    assert.equal(voice.elements['chat-voice-status'].hidden, true);
});

test('朗读播放错误给出声音和设备排查提示，并清理麦克风及状态', async () => {
    const { stream, track } = createStream();
    const voice = loadRealtimeVoice({ getUserMedia: async () => stream });
    const session = await voice.api.startRealtimeVoice();
    voice.api.flushAssistantSpeech('这段文字需要朗读。', 'voice-1');
    voice.spoken[0].onerror({ error: 'audio-busy' });
    assert.equal(session.active, false);
    assert.equal(session.utterance, null);
    assert.equal(track.stopped, true);
    assert.equal(voice.elements['chat-voice-status'].hidden, true);
    assert.match(voice.toasts.at(-1).message, /系统音量、默认输出设备和中文语音组件/);
});
