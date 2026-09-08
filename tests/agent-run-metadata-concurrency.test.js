const assert = require('node:assert/strict');
const test = require('node:test');
const { db } = require('../server/db');
const { updateAgentRunMetadataWithRetry } = require('../server/services/agent-run-metadata-patch');

test('Agent 运行元数据的并发补丁会保留双方写入而非后写覆盖先写', async () => {
    const userId = db.prepare('SELECT id FROM users ORDER BY id LIMIT 1').get()?.id;
    assert.ok(userId, 'test database should contain a seeded user');
    const runId = `metadata-concurrency-${process.pid}-${Date.now()}`;
    const now = new Date().toISOString();
    db.prepare(`
        INSERT INTO agent_runs (id, user_id, title, goal, status, metadata, created_at, updated_at)
        VALUES (?, ?, 'metadata', 'metadata', 'queued', '{}', ?, ?)
    `).run(runId, userId, now, now);
    try {
        await Promise.all([
            updateAgentRunMetadataWithRetry(runId, current => ({
                ...current,
                workflowApprovals: { ...(current.workflowApprovals || {}), approvalA: { state: 'granted' } }
            })),
            updateAgentRunMetadataWithRetry(runId, current => ({
                ...current,
                workflowApprovals: { ...(current.workflowApprovals || {}), approvalB: { state: 'granted' } }
            }))
        ]);
        const row = db.prepare('SELECT metadata FROM agent_runs WHERE id = ?').get(runId);
        const metadata = typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata;
        assert.deepEqual(metadata.workflowApprovals, {
            approvalA: { state: 'granted' },
            approvalB: { state: 'granted' }
        });
    } finally {
        db.prepare('DELETE FROM agent_runs WHERE id = ?').run(runId);
    }
});
