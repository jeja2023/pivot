const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'client', 'chat', 'engine-personal-actions.js'), 'utf8');
const platform = fs.readFileSync(path.join(__dirname, '..', 'client', 'chat', 'voice-platform.js'), 'utf8');

function createElement(initial = {}) {
    const attributes = new Map();
    const listeners = new Map();
    return {
        ...initial,
        addEventListener(type, listener) { listeners.set(type, listener); },
        attributes,
        classList: {
            toggle(name, enabled) {
                if (enabled) this.add(name);
                else this.remove(name);
            },
            add(name) { this._items ||= new Set(); this._items.add(name); },
            remove(name) { this._items?.delete(name); },
            has(name) { return this._items?.has(name) || false; }
        },
        dispatchEvent() {},
        getAttribute(name) { return attributes.get(name); },
        removeAttribute(name) { attributes.delete(name); },
        setAttribute(name, value) { attributes.set(name, String(value)); }
    };
}

function loadVoiceActions({ Recognition, getUserMedia }) {
    const toasts = [];
    const globalListeners = new Map();
    const modules = new Map();
    const elements = {
        'chat-voice-input': createElement(),
        'user-input': createElement({ value: '' })
    };
    const context = {
        setTimeout, clearTimeout,
        API_BASE: '',
        Event: class Event { constructor(type, options) { this.type = type; this.options = options; } },
        SpeechRecognition: Recognition,
        apiFetch: async () => ({ json: async () => ({}) }),
        currentSessionId: null,
        document: {
            getElementById: id => elements[id] || null,
            addEventListener: (type, listener) => globalListeners.set(`document:${type}`, listener)
        },
        navigator: {
            language: 'zh-CN',
            mediaDevices: getUserMedia ? { getUserMedia } : undefined
        },
        showToast: (message, level) => toasts.push({ level, message })
    };
    context.addEventListener = (type, listener) => globalListeners.set(type, listener);
    context.globalThis = context;
    context.window = context;
    context.Pivot = {
        exposeModule(name, api) { modules.set(name, api); },
        moduleApi(name) { return modules.get(name); }
    };
    if (Recognition) Recognition.prototype.processLocally = false;
    vm.runInNewContext(platform, context, { filename: 'voice-platform.js' });
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../client/chat/voice-text.js'), 'utf8'), context);
    vm.runInNewContext(source, context, { filename: 'engine-personal-actions.js' });
    return {
        api: modules.get('chat.memoryActions'),
        elements,
        globalListeners,
        toasts
    };
}

function createStream() {
    const track = { stopped: false, stop() { this.stopped = true; } };
    return { stream: { getTracks: () => [track] }, track };
}

test('Voice input requests microphone access and releases it when stopped or unloaded', async () => {
    const { stream, track } = createStream();
    const second = createStream();
    const recognitions = [];
    let microphoneRequests = 0;
    class Recognition {
        constructor() { recognitions.push(this); }
        abort() { this.aborted = true; }
        start() { this.started = true; }
    }
    const voice = loadVoiceActions({
        Recognition,
        getUserMedia: async constraints => {
            microphoneRequests += 1;
            assert.equal(constraints.audio, true);
            return microphoneRequests === 1 ? stream : second.stream;
        }
    });

    await voice.api.startChatVoiceInput();
    assert.equal(microphoneRequests, 1);
    assert.equal(recognitions.at(-1).started, true);
    voice.api.stopChatVoiceInput();
    assert.equal(recognitions.at(-1).aborted, true);
    assert.equal(track.stopped, true);

    await voice.api.startChatVoiceInput();
    voice.globalListeners.get('pagehide')();
    assert.equal(second.track.stopped, true);
});

test('Voice input gives actionable microphone errors and handles unsupported browsers', async () => {
    const rejected = [
        ['NotAllowedError', '请在系统或浏览器设置中允许 Pivot 访问麦克风后重试。'],
        ['NotFoundError', '未检测到可用的麦克风，请连接或启用输入设备后重试。'],
        ['NotReadableError', '麦克风不可用或被其他程序占用，请检查输入设备后重试。']
    ];

    for (const [name, message] of rejected) {
        const voice = loadVoiceActions({
            Recognition: class Recognition {},
            getUserMedia: async () => { const error = new Error(name); error.name = name; throw error; }
        });
        await voice.api.startChatVoiceInput();
        assert.deepEqual(voice.toasts.at(-1), { level: 'error', message });
    }

    const granted = createStream();
    let recognition = null;
    class Recognition {
        constructor() { recognition = this; }
        start() {}
    }
    const deniedByRecognition = loadVoiceActions({ Recognition, getUserMedia: async () => granted.stream });
    await deniedByRecognition.api.startChatVoiceInput();
    recognition.onerror({ error: 'not-allowed' });
    assert.equal(granted.track.stopped, true);
    assert.deepEqual(deniedByRecognition.toasts.at(-1), {
        level: 'error',
        message: '请在系统或浏览器设置中允许 Pivot 访问麦克风后重试。'
    });

    const unsupported = loadVoiceActions({ Recognition: undefined, getUserMedia: undefined });
    await unsupported.api.startChatVoiceInput();
    assert.deepEqual(unsupported.toasts.at(-1), {
        level: 'warning',
        message: '当前浏览器无法访问麦克风，请使用支持音频输入的浏览器。'
    });
});

test('语音输入保留已完成文本与最新中间结果，强制使用设备端识别', async () => {
    let recognition;
    class Recognition {
        constructor() { recognition = this; }
        start() {}
    }
    const voice = loadVoiceActions({ Recognition, getUserMedia: async () => createStream().stream });
    voice.elements['user-input'].value = '已有草稿';
    await voice.api.startChatVoiceInput();
    assert.equal(recognition.processLocally, true);
    recognition.onresult({ resultIndex: 0, results: [{ isFinal: true, 0: { transcript: '第一句。' } }, { isFinal: false, 0: { transcript: '第二' } }] });
    assert.equal(voice.elements['user-input'].value, '已有草稿 第一句。第二');
    recognition.onresult({ resultIndex: 1, results: [{ isFinal: true, 0: { transcript: '第一句。' } }, { isFinal: true, 0: { transcript: '第二句。' } }] });
    assert.equal(voice.elements['user-input'].value, '已有草稿 第一句。第二句。');
    voice.api.stopChatVoiceInput();
});

test('点击完成语音输入保留最终尾句，页面关闭仍立即取消且忽略迟到结果', async () => {
    let recognition;
    class Recognition {
        constructor() { recognition = this; }
        start() {}
        stop() { this.stopped = true; }
        abort() { this.aborted = true; }
    }
    const { stream, track } = createStream();
    const voice = loadVoiceActions({ Recognition, getUserMedia: async () => stream });
    try {
        const current = await voice.api.startChatVoiceInput();
        current.onresult({ resultIndex: 0, results: [{ isFinal: false, 0: { transcript: '还没有说完' } }] });
        await voice.api.startChatVoiceInput();
        assert.equal(current.stopped, true);
        assert.equal(current.aborted, undefined);
        current.onresult({ resultIndex: 0, results: [{ isFinal: true, 0: { transcript: '还没有说完的完整句子' } }] });
        const lateResult = current.onresult;
        current.onend();
        assert.equal(track.stopped, true);
        assert.equal(voice.elements['user-input'].value, '还没有说完的完整句子');
        lateResult({ resultIndex: 0, results: [{ isFinal: true, 0: { transcript: '不应覆盖草稿' } }] });
        assert.equal(voice.elements['user-input'].value, '还没有说完的完整句子');

        await voice.api.startChatVoiceInput();
        voice.globalListeners.get('pagehide')();
        assert.equal(recognition.aborted, true);
    } finally { voice.api.stopChatVoiceInput(); }
});

test('语音输入多段英文保留词间空格', async () => {
    let recognition;
    class Recognition { constructor() { recognition = this; } start() {} }
    const voice = loadVoiceActions({ Recognition, getUserMedia: async () => createStream().stream });
    await voice.api.startChatVoiceInput();
    recognition.onresult({ resultIndex: 0, results: [
        { isFinal: true, 0: { transcript: 'hello' } }, { isFinal: true, 0: { transcript: 'world' } }
    ] });
    assert.equal(voice.elements['user-input'].value, 'hello world');
    voice.api.stopChatVoiceInput();
});
