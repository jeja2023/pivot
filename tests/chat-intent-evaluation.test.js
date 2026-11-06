'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { evaluateChatIntentCase, summarizeChatIntentEvaluation } = require('../scripts/lib/chat_intent_evaluation');

test('模型失败后的兜底澄清不得作为正确语义判断计分', () => {
    const item = { expected: ['clarify'] };
    for (const decision of [
        { action: 'clarify', capabilityDecisionUnavailable: true },
        { action: 'clarify', reasonCode: 'decision_unavailable' },
        { action: 'clarify', failureCode: 'intent_timeout' },
        { action: 'clarify', shadow: true }
    ]) assert.equal(evaluateChatIntentCase(item, decision).passed, false);
    assert.equal(evaluateChatIntentCase(item, { action: 'clarify', reasonCode: 'semantic_intent' }).passed, true);
});

test('动作相同仍检查检索问题、来源、能力、续接对象和验收要求', () => {
    const item = { expected: ['continue_run'], expectedContinuationOf: 'owned', expectedQueryIncludes: ['实习生', '婚假'],
        expectedRouting: { knowledge: 'required' }, expectedCapabilities: ['knowledge.search'], expectedAcceptance: { requireEvidence: true }, expectedConstraintIncludes: ['只读'] };
    const decision = { action: 'continue_run', continuationOf: 'owned', routing: { knowledge: 'required', retrievalQuery: '实习生婚假规则' },
        requiredCapabilities: ['knowledge.search'], acceptance: { requireEvidence: true }, constraints: ['只读查询'] };
    assert.equal(evaluateChatIntentCase(item, decision).passed, true);
    for (const changed of [{ continuationOf: 'wrong' }, { acceptance: {} }, { requiredCapabilities: [] }, { constraints: [] }, { routing: { knowledge: 'required', retrievalQuery: '那他们呢？' } }]) {
        assert.equal(evaluateChatIntentCase(item, { ...decision, ...changed }).passed, false);
    }
    const report = summarizeChatIntentEvaluation([{ ...evaluateChatIntentCase(item, decision), critical: true, baselinePassed: false, durationMs: 5 },
        { ...evaluateChatIntentCase(item, { action: 'clarify', failureCode: 'intent_timeout' }), critical: true, durationMs: 30 }]);
    assert.equal(report.passed, 1);
    assert.equal(report.criticalFailures, 1);
    assert.equal(report.unavailable, 1);
    assert.equal(report.p95Ms, 30);
});

test('工程边界集和保留验证集分别冻结，包含反向断言且不修改历史版本', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const crypto = require('node:crypto');
    const manifest = require('./fixtures/chat-intent-evaluation-manifest.v2.json');
    const ids = new Set();
    for (const entry of manifest.suites) {
        const text = fs.readFileSync(path.join(__dirname, 'fixtures', entry.file), 'utf8').replace(/\r\n/g, '\n');
        assert.equal(crypto.createHash('sha256').update(text).digest('hex'), entry.sha256, entry.file);
        const fixture = JSON.parse(text);
        assert.equal(fixture.cases.length, entry.caseCount);
        for (const item of fixture.cases) {
            assert.equal(ids.has(item.id), false, item.id);
            ids.add(item.id);
            assert.ok(item.expected.length);
        }
    }
    assert.ok(manifest.suites.some(entry => entry.role === 'holdout'));
});

test('实现摘要覆盖聊天入口、范围约束、模型协议、任务契约和运行时策略', async () => {
    const { chatIntentImplementation } = require('../scripts/lib/chat_intent_implementation');
    const path = require('node:path');
    const value = await chatIntentImplementation(path.resolve(__dirname, '..'), { mode: 'active' });
    for (const file of ['server/routes/chat/index.js', 'client/chat/chat-auto-route.js', 'server/services/chat-route-correction-handler.js',
        'server/services/chat-request-scope.js', 'server/services/chat-intent-schema.js', 'server/services/chat-task-contract-update.js', 'server/services/agent-policy.js']) {
        assert.ok(value.implementationFiles.includes(file), file);
    }
    assert.match(value.implementationDigest, /^[a-f0-9]{64}$/);
});
