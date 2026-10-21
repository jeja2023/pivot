'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '../client/chat/voice-platform.js'), 'utf8');

function platform({ local = true, status = 'available', secure = true } = {}) {
    let api;
    const constructed = [];
    class Recognition {
        constructor() { if (local) this.processLocally = false; constructed.push(this); }
        static async available(options) { assert.equal(options.processLocally, true); return status; }
    }
    const context = { SpeechRecognition: Recognition, isSecureContext: secure, setTimeout, clearTimeout,
        navigator: { language: 'en-US', mediaDevices: { getUserMedia() { throw Error('预检查不应打开麦克风'); } } },
        document: { documentElement: { lang: 'zh-CN' }, readyState: 'complete', getElementById: () => null },
        Pivot: { exposeModule(_name, value) { api = value; } } };
    context.window = context;
    vm.runInNewContext(source, context);
    return { api, constructed };
}

test('语音预检查拒绝不可信地址和不能保证本地处理的浏览器', async () => {
    for (const settings of [{ secure: false }, { local: false }]) {
        const { api } = platform(settings);
        assert.ok(api.availability());
        await assert.rejects(api.prepareRecognition(), error => Boolean(error.voiceMessage));
    }
});

test('本地语音包缺失时明确保持关闭，包已就绪后设置页面语言并强制本地识别', async () => {
    for (const status of ['unavailable', 'downloadable', 'downloading']) {
        const { api } = platform({ status });
        await assert.rejects(api.prepareRecognition(), error => /语音包|不支持/.test(error.voiceMessage));
    }
    const { api } = platform();
    const recognition = await api.prepareRecognition();
    assert.equal(recognition.processLocally, true);
    assert.equal(recognition.lang, 'zh-CN');
});

test('管理员配置统一语音服务后网页与桌面均优先使用；服务故障或非安全地址不静默回退', async () => {
    for (const available of [true, false]) {
        let api; let nativeCalls = 0;
        const server = { supported: () => true, status: async () => ({ serverPreferred: true, available, reason: '模型尚未就绪' }), prepare: async () => ({ unified: true }) };
        const context = { navigator: {}, document: { documentElement: { lang: 'zh-CN' }, readyState: 'complete', getElementById: () => null },
            Pivot: { exposeModule(_name, value) { api = value; }, moduleApi: name => name === 'chat.serverVoiceRecognition' ? server : { supported: () => true, prepare() { nativeCalls++; } } } };
        context.window = context;
        vm.runInNewContext(source, context);
        if (available) assert.equal((await api.prepareRecognition()).unified, true);
        else await assert.rejects(api.prepareRecognition(), error => /模型尚未就绪/.test(error.voiceMessage));
        assert.equal(nativeCalls, 0);
        server.supported = () => false;
        if (available) await assert.rejects(api.prepareRecognition(), error => /HTTPS/.test(error.voiceMessage));
    }
});

test('采集增强逐项保留成功设置，设备不支持的单项不会撤销其它增强', async () => {
    const { api } = platform();
    const calls = [];
    await api.enhanceStream({ getAudioTracks: () => [{ applyConstraints: async constraints => {
        calls.push(constraints);
        if (constraints.autoGainControl) throw new Error('自动增益不可用');
    } }] });
    assert.equal(calls.length, 4);
    assert.equal(calls[1].echoCancellation, true);
    assert.equal(calls[3].echoCancellation, true);
    assert.equal(calls[3].noiseSuppression, true);
    assert.equal(calls[3].autoGainControl, undefined);
});
