'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { execute, queryOne } = require('../server/db/client');
const { persistWorkingMemoryRevision, listWorkingMemoryRevisionsForUser } = require('../server/services/agent-working-memory-revisions');

test('working memory revisions are immutable, deduplicated, and report constraint loss across compaction', async () => {
    const user = await queryOne('SELECT id FROM users ORDER BY id LIMIT 1');
    assert.ok(user?.id);
    const runId = `working-memory-${process.pid}-${Date.now()}`;
    await execute(`
        INSERT INTO agent_runs (id, user_id, title, goal, status, metadata, created_at, updated_at)
        VALUES (?, ?, 'working memory', '保留关键约束', 'running', '{}', NOW(), NOW())
    `, [runId, user.id]);
    try {
        const initial = {
            goal: '保留关键约束',
            constraints: [{ id: 'c-security', text: '不得泄露凭据', status: 'active' }],
            pendingWork: [{ id: 'p-report', text: '交付报告', status: 'pending' }], decisions: [], evidence: []
        };
        const first = await persistWorkingMemoryRevision({ run: { id: runId, user_id: user.id, goal: initial.goal }, user, state: initial, reason: 'initial' });
        assert.equal(first.revision, 1);
        const duplicate = await persistWorkingMemoryRevision({ run: { id: runId, user_id: user.id, goal: initial.goal }, user, state: initial, reason: 'retry' });
        assert.equal(duplicate.deduped, true);
        const boundary = await persistWorkingMemoryRevision({ run: { id: runId, user_id: user.id, goal: initial.goal }, user, state: initial, reason: 'context_compacted' });
        assert.equal(boundary.revision, 2);
        assert.equal(boundary.retention.blockingLoss, false);
        const compacted = await persistWorkingMemoryRevision({
            run: { id: runId, user_id: user.id, goal: initial.goal }, user,
            state: { ...initial, constraints: [], pendingWork: [], evidence: [{ id: 'e-1', text: '压缩后的观察', status: 'observed' }] },
            reason: 'context_compacted'
        });
        assert.equal(compacted.revision, 3);
        assert.equal(compacted.retention.blockingLoss, true);
        assert.deepEqual(compacted.retention.missingConstraintIds, ['c-security']);
        const revisions = await listWorkingMemoryRevisionsForUser(runId, user);
        assert.equal(revisions.length, 3);
        assert.equal(revisions[0].reason, 'context_compacted');
    } finally {
        await execute('DELETE FROM agent_runs WHERE id = ?', [runId]);
    }
});
