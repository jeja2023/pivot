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

function loadRealtimeVoice({ getUserMedia, apiFetchHandler = null, recognitionStart = null, recognitionUsesServerInput = false,
    sendMessage = null, stopVoiceRequest = null, voices = null, navigatorLanguage = 'zh-CN',
    timeout = setTimeout, cancelTimeout = clearTimeout }) {
    const modules = new Map();
    const toasts = [];
    const requests = [];
    const elements = { 'chat-realtime-voice': createElement(), 'chat-voice-status': createElement(), 'user-input': { value: '', dispatchEvent() {} } };
    const spoken = [];
    const stoppedRequests = [];
    let playbackCancels = 0;
    class Recognition {
        constructor() { this.processLocally = true; this.usesServerInput = recognitionUsesServerInput; }
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
        setTimeout: timeout,
        clearTimeout: cancelTimeout,
        setInterval,
        clearInterval
    };
    context.speechSynthesis = {
        getVoices: () => voices || [{ lang: 'zh-CN', localService: true }],
        cancel() { playbackCancels++; spoken.at(-1)?.onerror?.({ error: 'canceled' }); },
        speak(utterance) { spoken.push(utterance); }
    };
    context.SpeechSynthesisUtterance = class SpeechSynthesisUtterance { constructor(text) { this.text = text; } };
    context.addEventListener = () => {};
    context.globalThis = context;
    context.window = context;
    context.Pivot = {
        legacy: { sendMessage },
        exposeModule(name, api) { modules.set(name, api); },
        moduleApi(name) { return modules.get(name); }
    };
    modules.set('chat.execution', { stopVoiceRequest(id) { stoppedRequests.push(id); stopVoiceRequest?.(id); } });
    vm.runInNewContext(platform, context, { filename: 'client/chat/voice-platform.js' });
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../client/chat/voice-text.js'), 'utf8'), context);
    vm.runInNewContext(source, context, { filename: 'client/chat/realtime-voice.js' });
    return { api: modules.get('chat.realtimeVoice'), elements, requests, toasts, spoken, stoppedRequests,
        synthesis: context.speechSynthesis,
        get playbackCancels() { return playbackCancels; } };
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

test('服务器识别先采集默认麦克风再尝试回声消除，设备不支持增强时仍可开始', async () => {
    const constraints = [];
    const { stream, track } = createStream();
    stream.getAudioTracks = () => [track];
    track.applyConstraints = async value => { constraints.push(value); throw Error('设备不支持'); };
    const voice = loadRealtimeVoice({ recognitionUsesServerInput: true,
        getUserMedia: async value => { assert.equal(value.audio, true); return stream; } });
    try {
        assert.ok(await voice.api.startRealtimeVoice());
        assert.equal(constraints.length, 4);
        assert.equal(constraints[0].echoCancellation, true);
        assert.equal(track.stopped, false);
    } finally { voice.api.stopRealtimeVoice(); }
    assert.equal(track.stopped, true);
});

test('低置信度最终识别不触发对话或任务控制，保留输入并停止自动聆听', async () => {
    let recognition; let sent = 0;
    const voice = loadRealtimeVoice({ getUserMedia: async () => createStream().stream,
        recognitionStart(value) { recognition = value; value.onstart(); }, sendMessage: async () => { sent++; } });
    await voice.api.startRealtimeVoice();
    recognition.onresult({ resultIndex: 0, results: [{ isFinal: true, requiresReview: true, 0: { transcript: '金额是十五万元' } }] });
    assert.equal(sent, 0);
    assert.match(voice.elements['user-input'].value, /十五万元/);
    assert.equal(recognition.aborted, true);
    assert.equal(voice.elements['chat-realtime-voice'].getAttribute('aria-pressed'), 'false');
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

function recognize(session, text, isFinal = true) {
    session.recognition.onresult({ resultIndex: 0, results: [{ isFinal, 0: { transcript: text } }] });
}

test('朗读期间保持识别，仅确认的插话停止朗读和模型，再接续新问题', async () => {
    const sends = [];
    let finish;
    const voice = loadRealtimeVoice({ getUserMedia: async () => createStream().stream,
        sendMessage: options => {
            sends.push(options);
            return new Promise(resolve => { finish = resolve; });
        } });
    const session = await voice.api.startRealtimeVoice();
    try {
        recognize(session, '解释一下原理');
        voice.api.handleAssistantDelta('第一句回答。后续回答。尚未说完', session.id);
        const previousUtterance = voice.spoken[0];
        previousUtterance.onstart();
        assert.equal(session.recognition.aborted, undefined, '朗读期间不能关闭识别器');

        recognize(session, '换个角度', false);
        assert.equal(voice.playbackCancels, 0, '不因不稳定的中间识别结果打断朗读');
        recognize(session, '换个角度解释');
        assert.equal(voice.playbackCancels, 1);
        assert.deepEqual(voice.stoppedRequests, [session.id]);
        assert.equal(session.speaking, false);
        assert.equal(session.speechQueue.length, 0);
        assert.equal(session.speechBuffer, '');
        assert.equal(session.active, true, '取消朗读触发的错误回调不能结束语音会话');

        voice.api.handleAssistantDelta('不应继续朗读。', session.id);
        voice.api.flushAssistantSpeech('旧回答全文。', session.id);
        previousUtterance.onend();
        assert.equal(sends.length, 1, '旧请求结束前只暂存新问题');
        finish();
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(sends.length, 2);
        assert.equal(voice.elements['user-input'].value, '换个角度解释');
        assert.equal(voice.spoken.length, 1, '旧请求的剩余内容和迟到回调不能重新播放');
        assert.equal(voice.requests.filter(item => item.options.body === '{"event":"barge_in"}').length, 1);
        voice.api.handleAssistantDelta('这是新的回答。', session.id);
        assert.equal(voice.spoken.length, 2, '新一轮仍能正常朗读');
    } finally {
        finish?.();
        voice.api.stopRealtimeVoice();
    }
});

test('模型尚未开始朗读时也能打断，最终识别结果在旧请求取消后接续发送', async () => {
    let finish;
    const sends = [];
    const voice = loadRealtimeVoice({ getUserMedia: async () => createStream().stream,
        sendMessage: options => { sends.push(options); return new Promise(resolve => { finish = resolve; }); },
        stopVoiceRequest: () => finish?.() });
    const session = await voice.api.startRealtimeVoice();
    try {
        recognize(session, '原问题');
        recognize(session, '改问另一个问题');
        assert.deepEqual(voice.stoppedRequests, [session.id]);
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(sends.length, 2);
        assert.equal(voice.elements['user-input'].value, '改问另一个问题');
    } finally { finish?.(); voice.api.stopRealtimeVoice(); }
});

test('过滤朗读回声及结束后的迟到回声，朗读结束后仍能用最终结果插话', async () => {
    const sends = [];
    const voice = loadRealtimeVoice({ getUserMedia: async () => createStream().stream,
        sendMessage: async options => { sends.push(options); } });
    const session = await voice.api.startRealtimeVoice();
    try {
        recognize(session, '解释原理');
        await new Promise(resolve => setImmediate(resolve));
        voice.api.handleAssistantDelta('这是回答的第一句话。', session.id);
        recognize(session, '回答的第一句话', false);
        recognize(session, '这是回答的第一句话。');
        assert.equal(voice.playbackCancels, 0);
        assert.equal(sends.length, 1);
        voice.spoken[0].onend();
        recognize(session, '这是回答的第一句话');
        assert.equal(sends.length, 1, '朗读结束后的迟到回声也不能提交');

        voice.api.handleAssistantDelta('另一个回答句子。', session.id);
        recognize(session, '这是回答的第一句话。另一个回答句子。');
        assert.equal(sends.length, 1, '跨朗读分段的合并回声不能提交');
        assert.equal(voice.playbackCancels, 0);
        recognize(session, '请换个话题');
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(voice.playbackCancels, 1);
        assert.equal(sends.length, 2);
    } finally { voice.api.stopRealtimeVoice(); }
});

test('朗读期间识别器意外结束后仍会重启，插话通道保持可用', async () => {
    let starts = 0;
    const voice = loadRealtimeVoice({ getUserMedia: async () => createStream().stream,
        recognitionStart: recognition => { starts++; recognition.onstart?.(); } });
    const session = await voice.api.startRealtimeVoice();
    try {
        voice.api.flushAssistantSpeech('正在朗读的回答。', session.id);
        session.recognition.onend();
        await new Promise(resolve => setTimeout(resolve, 300));
        assert.equal(starts, 2);
        assert.equal(session.active, true);
        assert.equal(session.speaking, true);
    } finally { voice.api.stopRealtimeVoice(); }
});

test('朗读期间的任务控制口令先打断当前回复，再控制绑定任务', async () => {
    const voice = loadRealtimeVoice({ getUserMedia: async () => createStream().stream,
        apiFetchHandler: async url => ({ ok: true, json: async () => url.endsWith('/task-control')
            ? { message: '任务已暂停。' } : { voiceSession: { id: 'voice-1' } } }) });
    const session = await voice.api.startRealtimeVoice();
    try {
        voice.api.flushAssistantSpeech('正在介绍任务运行情况。', session.id);
        recognize(session, '暂停任务');
        assert.equal(voice.playbackCancels, 1);
        const control = voice.requests.find(item => item.url.endsWith('/task-control'));
        assert.ok(control);
        assert.equal(JSON.parse(control.options.body).action, 'pause');
        assert.equal(session.active, true);
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(session.speaking, true, '任务控制确认仍可朗读');
        recognize(session, '继续任务');
        assert.equal(voice.playbackCancels, 2, '任务确认朗读也支持再次打断');
    } finally { voice.api.stopRealtimeVoice(); }
});

test('普通语音聊天中说停止会打断回复，没有后台任务时不误报任务失败', async () => {
    const voice = loadRealtimeVoice({ getUserMedia: async () => createStream().stream,
        apiFetchHandler: async url => url.endsWith('/task-control')
            ? { ok: false, json: async () => ({ code: 'AGENT_VOICE_TASK_TARGET_NOT_FOUND', error: '当前聊天没有可控制的运行中任务。' }) }
            : { ok: true, json: async () => ({ voiceSession: { id: 'voice-1' } }) } });
    const session = await voice.api.startRealtimeVoice();
    try {
        voice.api.flushAssistantSpeech('还在朗读的回答。', session.id);
        recognize(session, '停止');
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(voice.playbackCancels, 1);
        assert.deepEqual(voice.toasts.at(-1), { message: '已停止当前回复。', level: 'info' });
        assert.equal(session.active, true);
    } finally { voice.api.stopRealtimeVoice(); }
});

test('朗读回声带少量错字不触发打断，最终新问题仍能打断', async () => {
    const voice = loadRealtimeVoice({ getUserMedia: async () => createStream().stream, sendMessage: async () => {} });
    const session = await voice.api.startRealtimeVoice();
    try {
        voice.api.handleAssistantDelta('这个问题需要结合具体场景分析。', session.id);
        recognize(session, '这个问题须要结合具体场景分折', false);
        recognize(session, '这个问题须要结合具体场景分折');
        assert.equal(voice.playbackCancels, 0);
        assert.equal(session.speaking, true);
        recognize(session, '不要讲这个，解释其他原因');
        assert.equal(voice.playbackCancels, 1);
    } finally { voice.api.stopRealtimeVoice(); }
});

test('超过 2000 字的回答完整读完，重复完成事件不会重读且最终尾部不丢失', async () => {
    const voice = loadRealtimeVoice({ getUserMedia: async () => createStream().stream });
    const session = await voice.api.startRealtimeVoice();
    try {
        const beginning = '第一段回答。';
        const tail = '这是没有标点的长回答'.repeat(250) + '最后一句';
        voice.api.handleAssistantDelta(beginning, session.id);
        voice.api.flushAssistantSpeech(beginning + tail, session.id);
        voice.api.flushAssistantSpeech(beginning + tail, session.id);
        let played = '';
        for (let count = 0; count < 100 && session.utterance; count++) {
            const utterance = session.utterance;
            assert.ok(utterance.text.length <= 120);
            played += utterance.text;
            utterance.onstart();
            utterance.onend();
            await new Promise(resolve => setTimeout(resolve, 1));
        }
        assert.equal(played, beginning + tail);
        assert.equal(session.speechQueue.length, 0);
        assert.equal(session.active, true);
        assert.equal(voice.playbackCancels, 0);
    } finally { voice.api.stopRealtimeVoice(); }
});

test('本地朗读没有 onstart 但引擎在播放时，不因启动看门狗误结束会话', async () => {
    const timers = new Map();
    const voice = loadRealtimeVoice({ getUserMedia: async () => createStream().stream,
        timeout: (callback, delay) => { timers.set(callback, delay); return callback; },
        cancelTimeout: callback => timers.delete(callback) });
    const session = await voice.api.startRealtimeVoice();
    try {
        voice.api.flushAssistantSpeech('仍在播放的回答。', session.id);
        voice.synthesis.speaking = true;
        for (const [callback, delay] of timers) if (delay === 15000) callback();
        assert.equal(session.active, true);
        assert.equal(voice.toasts.some(item => item.level === 'error'), false);
    } finally { voice.api.stopRealtimeVoice(); }
});

test('聆听、等待和朗读阶段说退出都会关闭实时语音，清理请求、队列与麦克风', async () => {
    for (const phase of ['listening', 'thinking', 'speaking']) {
        let finish;
        let sends = 0;
        const { stream, track } = createStream();
        const voice = loadRealtimeVoice({ getUserMedia: async () => stream,
            sendMessage: () => { sends++; return new Promise(resolve => { finish = resolve; }); } });
        const session = await voice.api.startRealtimeVoice();
        if (phase !== 'listening') recognize(session, '请介绍一下');
        if (phase === 'speaking') voice.api.handleAssistantDelta('正在朗读的回答。后面还要读的内容。', session.id);
        if (phase === 'speaking') voice.api.handleAssistantDelta('可以说退出结束语音。', session.id);
        const previousSends = sends;
        recognize(session, phase === 'speaking' ? '请退出实时语音。' : '退出');
        assert.equal(session.active, false, phase);
        assert.equal(track.stopped, true);
        assert.equal(session.recognition.aborted, true);
        assert.equal(session.speechQueue.length, 0);
        assert.equal(session.history.length, 0);
        assert.equal(voice.elements['chat-realtime-voice'].getAttribute('aria-pressed'), 'false');
        assert.equal(voice.elements['chat-voice-status'].hidden, true);
        assert.equal(sends, previousSends, '退出命令不发送给模型');
        assert.equal(voice.requests.some(item => item.url.endsWith('/task-control')), false);
        finish?.();
        await new Promise(resolve => setImmediate(resolve));
        voice.api.handleAssistantDelta('退出后的迟到回复。', session.id);
        assert.equal(session.active, false);
    }
});

test('不把临时识别中的退出片段或普通解释问题当成退出命令', async () => {
    let sends = 0;
    const voice = loadRealtimeVoice({ getUserMedia: async () => createStream().stream,
        sendMessage: async () => { sends++; } });
    const session = await voice.api.startRealtimeVoice();
    try {
        recognize(session, '退出', false);
        assert.equal(session.active, true);
        recognize(session, '退出是什么意思');
        assert.equal(session.active, true);
        assert.equal(sends, 1);
    } finally { voice.api.stopRealtimeVoice(); }
});
