'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveChatIntent } = require('../server/services/chat-intent-resolver');

const input = { user: { id: 9 }, sessionId: 'intent-recovery', userMessageId: 42, prompt: '请解释向量检索的工作原理', modelCfg: { id: 'intent-recovery' } };
const direct = { action: 'direct_answer', objective: input.prompt, requiredCapabilities: [], routing: { knowledge: 'none', tools: 'none' } };
const config = { mode: 'active', rolloutPercent: 100, timeoutMs: 4000 };
const deps = callModelJson => ({ config, recordDecision() {}, callModelJson });

test('意图JSON损坏、字段错误和输出截断仅在原预算内补判一次', async () => {
    for (const first of ['{broken', { ...direct, routing: undefined }, 'truncated']) {
        let calls = 0, firstDeadline;
        const result = await resolveChatIntent(input, deps(async (_model, messages, options) => {
            calls++;
            options.usageRef.queueMs = 3;
            options.usageRef.providerMs = 7;
            options.usageRef.usage = { prompt_tokens: 10, completion_tokens: 5 };
            if (calls === 1) {
                firstDeadline = options.deadlineAt;
                if (first === 'truncated') options.usageRef.truncated = true;
                return first;
            }
            assert.equal(options.deadlineAt, firstDeadline);
            assert.match(messages[0].content, /上次响应未通过格式校验/);
            return { decision: direct };
        }));
        assert.equal(result.failureCode, undefined);
        assert.equal(result.action, 'direct_answer');
        assert.equal(result.modelCalls, 2);
        assert.equal(result.contractRetries, 1);
        assert.deepEqual(result.usage, { inputTokens: 20, outputTokens: 10 });
        assert.equal(result.timing.queueMs, 6);
        assert.equal(result.timing.providerMs, 14);
    }
});

test('补判仍拒绝未授权工具、未知续接和连续无效响应，剩余预算不足不补判', async () => {
    for (const invalid of ['{broken', { ...direct, requiredCapabilities: ['admin.all'] }, { ...direct, action: 'continue_run', continuationOf: 'foreign' }]) {
        let calls = 0;
        const result = await resolveChatIntent(input, deps(async () => { calls++; return invalid; }));
        assert.equal(calls, 2);
        assert.equal(result.failureCode, 'intent_invalid_contract');
        assert.equal(result.textOnlyFallback, true);
    }
    let calls = 0;
    const short = await resolveChatIntent(input, { ...deps(async () => { calls++; return '{broken'; }), config: { ...config, timeoutMs: 1000 } });
    assert.equal(calls, 1);
    assert.equal(short.failureCode, 'intent_invalid_contract');
});

test('提前发生的上游超时可恢复，持续超时保留耗时并归为超时', async () => {
    for (const code of ['ECONNABORTED', 'ETIMEDOUT', 'AGENT_MODEL_FIRST_RESPONSE_TIMEOUT']) {
        let calls = 0;
        const recovered = await resolveChatIntent(input, deps(async (_model, _messages, options) => {
            calls++;
            options.usageRef.providerMs = (options.usageRef.providerMs || 0) + 12;
            if (calls === 1) throw Object.assign(new Error('合成上游超时'), { code });
            return direct;
        }));
        assert.equal(recovered.failureCode, undefined);
        assert.equal(recovered.providerRetries, 1);
        const failed = await resolveChatIntent(input, deps(async (_model, _messages, options) => {
            options.usageRef.queueMs = 5;
            options.usageRef.providerMs = 19;
            throw Object.assign(new Error('合成上游持续超时'), { code });
        }));
        assert.equal(failed.failureCode, 'intent_timeout');
        assert.equal(failed.modelCalls, 2);
        assert.equal(failed.timing.queueMs, 5);
        assert.equal(failed.timing.providerMs, 19);
    }
});

test('取消与总截止不能触发格式补判或上游重试', async () => {
    const controller = new AbortController();
    let calls = 0;
    await assert.rejects(() => resolveChatIntent({ ...input, signal: controller.signal }, deps(async () => {
        calls++;
        controller.abort(new Error('取消意图判断'));
        return '{broken';
    })), /取消意图判断/);
    assert.equal(calls, 1);
    const timedOut = await resolveChatIntent(input, { ...deps(() => new Promise(() => {})), config: { ...config, timeoutMs: 20 } });
    assert.equal(timedOut.failureCode, 'intent_timeout');
    assert.equal(timedOut.modelCalls, 1);
});
