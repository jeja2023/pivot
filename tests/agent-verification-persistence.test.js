'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { execute, queryOne } = require('../server/db/client');
const { getTaskVerificationForUser, verifyAndRecordTaskOutcome } = require('../server/services/agent-verification');

test('task verification is persisted and isolated to the run owner', async () => {
    const user = await queryOne('SELECT id FROM users ORDER BY id LIMIT 1');
    assert.ok(user?.id);
    const suffix = `${process.pid}-${Date.now()}`;
    const runId = `verification-${suffix}`;
    try {
        await execute(`
            INSERT INTO agent_runs (id, user_id, title, goal, status, metadata, created_at, updated_at)
            VALUES (?, ?, 'verification', '生成合规结果', 'running', '{}', NOW(), NOW())
        `, [runId, user.id]);
        const report = await verifyAndRecordTaskOutcome({
            runId,
            run: { id: runId, user_id: user.id, goal: '生成合规结果', metadata: { taskContract: { acceptance: { requiredPhrases: ['合规'] } } } },
            answer: '结果合规。'
        });
        assert.equal(report.outcomeStatus, 'verified');
        const stored = await getTaskVerificationForUser(runId, user);
        assert.equal(stored.outcomeStatus, 'verified');
        assert.equal(stored.report.rules.some(rule => rule.key === 'required_phrase'), true);
        assert.equal(await getTaskVerificationForUser(runId, { id: Number(user.id) + 999999 }), null);
    } finally {
        await execute('DELETE FROM agent_runs WHERE id = ?', [runId]);
    }
});

test('预检索的知识库证据实际参与持久化验收，避免有答案却反复等待输入', async () => {
    const user = await queryOne('SELECT id FROM users ORDER BY id LIMIT 1');
    const runId = `rag-verification-${process.pid}-${Date.now()}`;
    const metadata = { chatBridge: { version: 1, ragEnabled: true,
        ragContext: '[引用 1 | citation:policy-1 | 来源: 请假规定]\n年假应提前提交申请。' }, taskContract: { acceptance: { requireEvidence: true } } };
    try {
        await execute("INSERT INTO agent_runs (id,user_id,title,goal,status,metadata,created_at,updated_at) VALUES (?,?,'知识问答','请假规定是什么','verifying',?::jsonb,NOW(),NOW())", [runId, user.id, JSON.stringify(metadata)]);
        const run = await queryOne('SELECT * FROM agent_runs WHERE id = ?', [runId]);
        const report = await verifyAndRecordTaskOutcome({ runId, run, user, answer: '年假应提前提交申请。[引用 1 | citation:policy-1]', observations: [] });
        assert.equal(report.outcomeStatus, 'verified');
        assert.equal(report.observationCount, 1);
        assert.equal((await getTaskVerificationForUser(runId, user)).outcomeStatus, 'verified');
    } finally { await execute('DELETE FROM agent_runs WHERE id = ?', [runId]); }
});
