'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const crypto = require('node:crypto');
const { queryOne, execute } = require('../server/db/client');
const { createRunState } = require('../server/services/agent-runtime/run-state');
const { assertAgentRunStatusTransition, canTransitionAgentRunStatus } = require('../server/services/agent-runtime/state-machine');
const { deferAfterChildTool } = require('../server/services/agent-child-wait');

test('真实数据库等待CAS保留预算与工作状态，旧代次和取消后不能重新入队', async () => {
    const user = await queryOne('SELECT id FROM users ORDER BY id LIMIT 1');
    const id = `child-wait-${process.pid}-${Date.now()}`;
    await execute("INSERT INTO agent_runs (id,user_id,title,goal,status,locked_by,started_at,metadata,usage_stats,created_at,updated_at) VALUES (?,?,'等待汇总','汇总子任务','running','wait-owner',NOW(),?::jsonb,?::jsonb,NOW(),NOW())",
        [id, user.id, JSON.stringify({ workingState: { goal: '保留原目标' } }), JSON.stringify({ counts: { steps: 7, tokens_total: 321 } })]);
    const state = createRunState({ queryOne, execute, crypto, assertAgentRunStatusTransition, canTransitionAgentRunStatus,
        TERMINAL_STATUSES: new Set(), publishUserEvent: async () => {}, getAgentRunTitle: () => '等待汇总',
        recordAgentEvent: async () => {}, logger: { warn() {} } });
    let enqueued = 0;
    const deps = { updateRunCas: state.updateRunCas, enqueueAgentRun: () => { enqueued++; }, assertRunNotCancelled: async () => {} };
    try {
        const row = await queryOne('SELECT * FROM agent_runs WHERE id=?', [id]);
        const run = { ...row, realtimeLeaseOwner: row.locked_by, realtimeLeaseEpoch: String(row.realtime_lease_epoch) };
        const output = { type: 'agent_wait', parentRunId: id, complete: false, children: [{ id: 'direct-child', status: 'running' }] };
        const waiting = () => deferAfterChildTool({ run, user, toolName: 'agent.wait', output }, deps);
        await execute('UPDATE agent_runs SET realtime_lease_epoch = realtime_lease_epoch + 1 WHERE id=?', [id]);
        assert.equal(await waiting(), true); assert.equal(enqueued, 0);
        assert.equal((await queryOne('SELECT status FROM agent_runs WHERE id=?', [id])).status, 'running');
        run.realtimeLeaseEpoch = String((await queryOne('SELECT realtime_lease_epoch FROM agent_runs WHERE id=?', [id])).realtime_lease_epoch);
        assert.equal(await waiting(), true); assert.equal(enqueued, 1);
        const stored = await queryOne('SELECT status,metadata,usage_stats FROM agent_runs WHERE id=?', [id]);
        assert.equal(stored.status, 'queued'); assert.equal(stored.metadata.workingState.goal, '保留原目标');
        assert.deepEqual(stored.metadata.awaitingChildren.childRunIds, ['direct-child']);
        assert.deepEqual(stored.usage_stats.counts, { steps: 7, tokens_total: 321 });
        await execute("UPDATE agent_runs SET status='cancelled' WHERE id=?", [id]);
        assert.equal(await waiting(), true); assert.equal(enqueued, 1);
        assert.equal((await queryOne('SELECT status FROM agent_runs WHERE id=?', [id])).status, 'cancelled');
    } finally { await execute('DELETE FROM agent_runs WHERE id=?', [id]); }
});
