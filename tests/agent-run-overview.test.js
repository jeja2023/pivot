'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { getRunOverview } = require('../server/services/agent-run-overview');
const { readRunDetailParts } = require('../server/services/agent-run-detail-parts');

test('详情首屏不等待完整诊断，并移除会话和资料大正文', async () => {
    const run = { id: 'run', status: 'running', max_steps: 30, metadata: { chatHistory: [{ content: '历史私有正文' }],
        chatBridge: { ragContext: '资料私有正文', currentMessage: { content: '附件长文' }, executionProfile: 'standard' }, taskVerification: { outcomeStatus: 'partial' } } };
    const value = await getRunOverview(run, { id: 7 }, { read: async () => ({ steps: [], dagNodes: [], truncated: false }) });
    assert.equal(value.detailLevel, 'overview'); assert.equal(value.diagnosticsDeferred, true);
    assert.equal(value.verification.outcomeStatus, 'partial'); assert.equal(value.trace, null);
    assert.doesNotMatch(JSON.stringify(value), /历史私有正文|资料私有正文|附件长文/);
});

test('可选诊断超时或失败时返回已有记录和明确提示，核心记录失败保持错误', async () => {
    const value = await readRunDetailParts([async () => ['step'], async () => ['node'], () => new Promise(() => {}), async () => { throw new Error('数据库不可用'); }], { timeoutMs: 20 });
    assert.deepEqual(value.values.slice(0, 2), [['step'], ['node']]);
    assert.deepEqual(value.values.slice(2), [null, null]); assert.equal(value.warnings.length, 2);
    assert.doesNotMatch(JSON.stringify(value), /数据库不可用/);
    await assert.rejects(readRunDetailParts([() => new Promise(() => {}), async () => []], { timeoutMs: 20 }), error => error.code === 'AGENT_DETAIL_TIMEOUT');
});

test('相同请求只复核一次来源，不同请求重新检查权限，避免跨请求缓存撤权结果', async () => {
    const repository = require('../server/repositories/knowledge-run-evidence');
    const original = repository.readRunKnowledgeEvidence;
    let count = 0, active = true;
    repository.readRunKnowledgeEvidence = async () => { count++; return { run: { metadata: {} }, actor: { id: 7, status: active ? 'active' : 'disabled' }, rows: [] }; };
    try {
        const { inspectRunKnowledgeAccess } = require('../server/services/knowledge-run-access');
        const { runWithRequestContext } = require('../server/services/request-context');
        const values = await runWithRequestContext({ requestId: 'request-one' }, () => Promise.all([inspectRunKnowledgeAccess('run', { id: 7 }), inspectRunKnowledgeAccess('run', { id: 7 })]));
        assert.ok(values.every(item => item.current)); assert.equal(count, 1);
        active = false;
        const next = await runWithRequestContext({ requestId: 'request-two' }, () => inspectRunKnowledgeAccess('run', { id: 7 }));
        assert.equal(next.current, false); assert.equal(count, 2);
    } finally { repository.readRunKnowledgeEvidence = original; }
});
