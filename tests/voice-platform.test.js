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
