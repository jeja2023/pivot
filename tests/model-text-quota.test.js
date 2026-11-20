'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { estimateTokens } = require('../server/llm');
const modelsPath = require.resolve('../server/services/models');
const forwarderPath = require.resolve('../server/services/model-forwarder');
const runtimePath = require.resolve('../server/services/model-runtime');
let used = 0, calls = 0, outputLimit = 0, behavior = null, usageRead = null;
const models = require(modelsPath);
require.cache[modelsPath].exports = { ...models, getModelDailyUsageAsync: async () => usageRead ? usageRead() : used,
    recordModelTokenUsage: (_user, _model, tokens) => { used += tokens; } };
require(forwarderPath);
require.cache[forwarderPath].exports = { forwardChatCompletion: async input => {
    calls++; outputLimit = input.data.max_tokens;
    const response = behavior && await behavior(input);
    if (response) return response;
    return { data: { choices: [{ message: { content: '受控回答' } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } } };
} };
require(runtimePath);
require.cache[runtimePath].exports = { acquireModelSlot: async () => () => {}, recordModelFailure() {}, recordModelSuccess() {} };
delete require.cache[require.resolve('../server/services/model-text-call')];
const { callModelTextWithBudget } = require('../server/services/model-text-call');
const { getInflightQuota } = require('../server/services/model-daily-quota');
const { aiSemaphore } = require('../server/services/concurrency');
const originalConcurrency = aiSemaphore.getStatus().max;
aiSemaphore.updateMaxConcurrent(4);
test.after(() => aiSemaphore.updateMaxConcurrent(originalConcurrency));
const user = { id: 713 };
const messages = [{ role: 'user', content: '额度回归' }];
const model = { id: 712, url: 'https://model.invalid/v1', model_name: 'synthetic', max_tokens: 8192, max_input_tokens: 10000 };
const run = extra => callModelTextWithBudget({ user, modelCfg: model, messages, maxTokens: 1200, ...extra });

test('每日额度耗尽时在调用上游前拒绝，释放两层资源', async () => {
    used = 30; calls = 0; behavior = null; model.daily_token_limit = 30;
    const before = aiSemaphore.getStatus().active;
    await assert.rejects(run(), error => error.code === 'INSUFFICIENT_QUOTA' && error.status === 429);
    assert.equal(calls, 0); assert.equal(getInflightQuota(user.id, model.id), 0);
    assert.equal(aiSemaphore.getStatus().active, before);
});

test('同一账号模型的并发预留不超发，成功落账后释放且兼容语义分析入口', async () => {
    used = 0; calls = 0;
    model.daily_token_limit = estimateTokens(JSON.stringify(messages)) + 1205;
    let release, entered;
    const started = new Promise(resolve => { entered = resolve; });
    behavior = async () => { entered(); await new Promise(resolve => { release = resolve; }); };
    const first = run(); await started;
    await assert.rejects(run(), error => error.code === 'INSUFFICIENT_QUOTA');
    assert.equal(calls, 1); assert.ok(getInflightQuota(user.id, model.id) > 0);
    release(); await first;
    assert.equal(used, 2); assert.equal(getInflightQuota(user.id, model.id), 0);
    assert.equal(require('../server/services/data-analysis/semantic-quota').getInflightQuota, getInflightQuota);
    behavior = null; await run(); assert.equal(calls, 2);
});

test('取消和失败均释放额度预留，不能永久占用后续调用', async () => {
    used = 0; model.daily_token_limit = 5000;
    const controller = new AbortController();
    behavior = async input => { controller.abort(); input.signal.throwIfAborted(); };
    await assert.rejects(run({ signal: controller.signal }));
    assert.equal(getInflightQuota(user.id, model.id), 0);
    behavior = async () => { throw new Error('受控上游故障'); };
    await assert.rejects(run(), /受控上游故障/);
    assert.equal(getInflightQuota(user.id, model.id), 0);
    behavior = null; await run();
});

test('明确输出预算不被模型默认值扩大，业务与模型硬上限同时生效', async () => {
    behavior = null; model.daily_token_limit = 0; model.max_tokens = 8192;
    await run(); assert.equal(outputLimit, 1200);
    await run({ maxOutputTokensCap: 500 }); assert.equal(outputLimit, 500);
    model.max_tokens = 256; await run(); assert.equal(outputLimit, 256);
});

test('请求 JSON 对象仅在端点明确拒绝时兼容回退，截断仍真实计费', async () => {
    model.daily_token_limit = 0;
    model.max_tokens = 8192;
    used = 0; calls = 0;
    const sent = [];
    behavior = async input => {
        sent.push(input.data.response_format);
        if (input.data.response_format) throw Object.assign(new Error('unsupported response_format'), { response: { status: 400 } });
        return { data: { choices: [{ finish_reason: 'length', message: { content: '{"slides":[' } }],
            usage: { prompt_tokens: 3, completion_tokens: 12, total_tokens: 15 } } };
    };
    const result = await run({ jsonObject: true });
    assert.deepEqual(sent, [{ type: 'json_object' }, undefined]);
    assert.equal(result.finishReason, 'length');
    assert.equal(result.truncated, true);
    assert.equal(result.jsonObjectAccepted, false);
    assert.equal(used, 15);
    behavior = async () => { throw Object.assign(new Error('input invalid'), { response: { status: 400 } }); };
    await assert.rejects(run({ jsonObject: true }), /input invalid/);
    assert.equal(calls, 3);
    behavior = null;
});

test('用量读取期间另一请求结算释放预留，旧快照必须重读再接纳', async () => {
    const { ensureModelQuota } = require('../server/services/model-daily-quota');
    used = 0; behavior = null; model.max_tokens = 8192;
    model.daily_token_limit = estimateTokens(JSON.stringify(messages)) + 1200;
    const release = await ensureModelQuota(user, model, messages, 1200);
    let resumeRead, entered;
    const started = new Promise(resolve => { entered = resolve; });
    let reads = 0;
    usageRead = async () => {
        if (++reads === 1) { entered(); await new Promise(resolve => { resumeRead = resolve; }); return 0; }
        return used;
    };
    const pending = ensureModelQuota(user, model, messages, 1200);
    await started; used = 2; release(); resumeRead();
    try { await assert.rejects(pending, error => error.code === 'INSUFFICIENT_QUOTA'); assert.equal(reads, 2); }
    finally { usageRead = null; }
});
