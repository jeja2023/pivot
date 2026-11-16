'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { compactMessages, planRequest, usageRecord } = require('../server/services/presentations/master/context');
const { estimateMessagesTokens } = require('../server/services/context-budget');

function turn(path, text, result = { path, sha256: require('node:crypto').createHash('sha256').update(text).digest('hex') }) {
    return [
        { role: 'assistant', content: JSON.stringify({ actions: [{ action: 'write', path, text }] }) },
        { role: 'user', content: JSON.stringify([{ action: 'write', result }]) }
    ];
}

test('只收敛已确认写入的旧正文，保留指引、用户确认、失败、最近操作及原检查点', () => {
    const source = [{ role: 'system', content: '安全指引' }, { role: 'user', content: '用户确认方案并保留数字' },
        ...turn('project/page.svg', '长正文'.repeat(10000)),
        ...turn('project/failed.svg', '失败内容', { error: '未写入' }),
        ...turn('project/recent.svg', '最近正文'),
        { role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/jpeg;base64,test' } }] }];
    const before = JSON.stringify(source), result = compactMessages(source);
    assert.equal(result.compactedWrites, 1);
    assert.equal(JSON.stringify(source), before);
    assert.equal(result.messages[0].content, source[0].content);
    assert.equal(result.messages[1].content, source[1].content);
    assert.match(result.messages[2].content, /已成功写入/);
    assert.doesNotMatch(result.messages[2].content, /长正文/);
    assert.equal(result.messages[4].content, source[4].content);
    assert.equal(result.messages[6].content, source[6].content);
    assert.deepEqual(result.messages.at(-1), source.at(-1));
    assert.ok(estimateMessagesTokens(result.messages) < estimateMessagesTokens(source));
});

test('无匹配文件回执、工具失败或不完整消息时不压缩', () => {
    const messages = [...turn('a.svg', '正文', { path: 'b.svg' }), ...turn('changed.svg', '正文', { path: 'changed.svg', sha256: '0'.repeat(64) }),
        { role: 'assistant', content: JSON.stringify({ actions: [{ action: 'write', path: 'b.svg', text: '正文' }] }) },
        { role: 'user', content: JSON.stringify([{ action: 'write', error: '失败' }]) },
        ...turn('c.svg', '最近正文')];
    const result = compactMessages(messages);
    assert.equal(result.compactedWrites, 0);
    assert.deepEqual(result.messages, messages);
});

test('单轮窗口与累计预算分别限制模型调用，并预留输出和安全余量', () => {
    const messages = [{ role: 'user', content: '内容'.repeat(1000) }];
    assert.throws(() => planRequest(messages, messages, { context_window_tokens: 4000 }, 100000), { code: 'PPT_MASTER_CONTEXT_LIMIT' });
    assert.throws(() => planRequest(messages, messages, { context_window_tokens: 256000 }, 5000), { code: 'PPT_MASTER_BUDGET_EXHAUSTED' });
    const plan = planRequest(messages, messages, { context_window_tokens: 9000 }, 100000);
    assert.ok(plan.maxTokens >= 2000);
    assert.ok(plan.inputEstimate + plan.maxTokens + 256 <= 9000);
    assert.equal(planRequest(messages, messages, { context_window_tokens: 256000, max_tokens: 3000 }, 100000).maxTokens, 3000);
    assert.throws(() => planRequest(messages, messages, { context_window_tokens: 256000, max_tokens: 1000 }, 100000), { code: 'PPT_MASTER_MODEL_OUTPUT_LIMIT' });
});

test('诊断按供应方实际用量累计，缺失用量明确标记估算，且不保存正文', () => {
    const state = { steps: 10, usedTokens: 100 }, plan = { inputEstimate: 500, originalEstimate: 900, breakdown: { initial: 200, history: 300, toolResults: 0, images: 0 } };
    usageRecord(state, plan, { usage: { prompt_tokens: 300, completion_tokens: 20 } }, '用户正文', 2, () => 10);
    assert.equal(state.usedTokens, 420);
    assert.deepEqual(state.usageDiagnostics[0], { call: 1, step: 11, inputTokens: 300, outputTokens: 20, inputEstimated: false, outputEstimated: false, inputEstimate: 500, originalEstimate: 900, compactedWrites: 2, breakdown: plan.breakdown, cumulativeTokens: 420 });
    usageRecord(state, plan, { usage: {} }, '敏感正文', 0, () => 10);
    assert.equal(state.usedTokens, 930);
    assert.equal(state.usageDiagnostics[1].inputEstimated, true);
    assert.equal(state.usageDiagnostics[1].outputEstimated, true);
    assert.doesNotMatch(JSON.stringify(state.usageDiagnostics), /正文/);
});
