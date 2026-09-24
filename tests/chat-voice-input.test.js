const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'client', 'chat', 'engine-personal-actions.js'), 'utf8');

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
        API_BASE: '',
        Event: class Event { constructor(type, options) { this.type = type; this.options = options; } },
        SpeechRecognition: Recognition,
        apiFetch: async () => ({ json: async () => ({}) }),
        currentSessionId: null,
        document: { getElementById: id => elements[id] || null },
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
        moduleApi() { return {}; }
    };
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
    assert.equal(recognitions[0].started, true);
    voice.api.stopChatVoiceInput();
    assert.equal(recognitions[0].aborted, true);
    assert.equal(track.stopped, true);

    await voice.api.startChatVoiceInput();
    voice.globalListeners.get('pagehide')();
    assert.equal(second.track.stopped, true);
});

test('Voice input gives actionable microphone errors and handles unsupported browsers', async () => {
    const rejected = [
        ['NotAllowedError', '请在系统或浏览器设置中允许本应用访问麦克风后重试'],
        ['NotFoundError', '未检测到可用的麦克风设备，请连接或启用麦克风后重试。'],
        ['NotReadableError', '麦克风正在被其他应用占用，请关闭占用程序后重试。']
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
        message: '请在系统或浏览器设置中允许本应用访问麦克风后重试'
    });

    const unsupported = loadVoiceActions({ Recognition: undefined, getUserMedia: undefined });
    await unsupported.api.startChatVoiceInput();
    assert.deepEqual(unsupported.toasts.at(-1), {
        level: 'warning',
        message: '当前浏览器不支持语音输入，请使用支持麦克风访问和语音识别的浏览器。'
    });
});
