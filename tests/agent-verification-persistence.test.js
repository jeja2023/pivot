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
