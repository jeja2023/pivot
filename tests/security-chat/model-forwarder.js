// 模型转发服务单测：校验参数守卫与“先做出网安全校验、再发请求”的契约。
// 由 security-chat.test.js 统一加载。
const { assert, test } = require('../security-helpers');
const { forwardChatCompletion, DEFAULT_FORWARD_TIMEOUT_MS } = require('../../server/services/model-forwarder');

test('forwardChatCompletion 缺少 modelCfg 或 url 时直接抛错', async () => {
    await assert.rejects(() => forwardChatCompletion({ url: 'https://model.example/v1/chat/completions' }), /modelCfg is required/);
    await assert.rejects(() => forwardChatCompletion({ modelCfg: { id: 1, user_id: null } }), /url is required/);
});

test('forwardChatCompletion 在发请求前对非法协议 URL 做安全校验并拒绝', async () => {
    // ftp 协议会在 validateModelUrl 阶段被拒，证明安全校验先于 axios 发起。
    await assert.rejects(
        () => forwardChatCompletion({ modelCfg: { id: 1, user_id: null }, url: 'ftp://evil.example/x' }),
        /HTTP or HTTPS/
    );
});

test('forwardChatCompletion 导出默认超时常量', () => {
    assert.equal(DEFAULT_FORWARD_TIMEOUT_MS, 180000);
});

test('safe HTTP helpers reject multipart-like payloads by default', () => {
    const { assertJsonOnlyPayload } = require('../../server/services/safe-http-client');
    assert.throws(
        () => assertJsonOnlyPayload({ getBoundary() { return 'boundary'; } }),
        /Multipart payloads must use the upload-specific client/
    );
});

test('forwardChatCompletion rejects multipart-like payloads before axios dispatch', async () => {
    await assert.rejects(
        () => forwardChatCompletion({
            modelCfg: { id: 1, user_id: null, url: 'https://model.example/v1' },
            url: 'https://model.example/v1/chat/completions',
            data: { getBoundary() { return 'boundary'; } },
            headers: {}
        }),
        /Multipart payloads must use the upload-specific client/
    );
});