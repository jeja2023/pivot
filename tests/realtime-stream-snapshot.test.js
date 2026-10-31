'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { queryOne, execute } = require('../server/db/client');
const { writeSnapshot, readSnapshot, createSnapshotWriter } = require('../server/services/realtime-stream-snapshot');

test('流式快照加密存储，按用户和执行租约隔离并拒绝旧执行者', { skip: !process.env.DATABASE_URL, timeout: 30000 }, async () => {
    const user = await queryOne('SELECT id FROM users ORDER BY id LIMIT 1');
    const runId = `snapshot-test-${process.pid}-${Date.now()}`;
    await execute("INSERT INTO agent_runs (id,user_id,title,goal,status,metadata,locked_by,realtime_lease_epoch,lock_expires_at,created_at,updated_at) VALUES (?,?,'snapshot','snapshot','planning','{}','owner-a',1,NOW()+INTERVAL '5 minutes',NOW(),NOW())", [runId, user.id]);
    const snapshot = { runId, step: 1, content: 'private stream content', partialToolCalls: [{ argumentsRaw: 'private arguments' }] };
    try {
        assert.equal(await writeSnapshot({ runId, userId: user.id, leaseOwner: 'owner-a', leaseEpoch: '1', step: 1, snapshot }), true);
        const stored = await queryOne('SELECT snapshot_ciphertext FROM realtime_stream_snapshots WHERE run_id = ?', [runId]);
        assert.doesNotMatch(stored.snapshot_ciphertext, /private stream content|private arguments/);
        assert.deepEqual(await readSnapshot(runId, user.id), { ...snapshot, streamLeaseEpoch: '1', streamRevision: '1' });
        assert.equal(await readSnapshot(runId, Number(user.id) + 100000), null);
        const smallLimit = await queryOne('SELECT byte_length FROM realtime_stream_snapshots WHERE run_id = ?', [runId]);
        assert.ok(smallLimit.byte_length > 0);
        const oversized = 'x'.repeat(32 * 1024 * 1024 + 1);
        await assert.rejects(writeSnapshot({ runId, userId: user.id, leaseOwner: 'owner-a', leaseEpoch: '1', step: 1, snapshot: { ...snapshot, content: oversized } }), /大小上限/);
        await execute("UPDATE agent_runs SET locked_by = 'owner-b', realtime_lease_epoch = 2, lock_expires_at = NOW()+INTERVAL '5 minutes' WHERE id = ?", [runId]);
        assert.equal(await readSnapshot(runId, user.id), null);
        assert.equal(await writeSnapshot({ runId, userId: user.id, leaseOwner: 'owner-a', leaseEpoch: '1', step: 2, snapshot: { ...snapshot, step: 2 } }), false);
        const replacement = { ...snapshot, step: 2, content: 'new owner' };
        assert.equal(await writeSnapshot({ runId, userId: user.id, leaseOwner: 'owner-b', leaseEpoch: '2', step: 2, snapshot: replacement }), true);
        assert.deepEqual(await readSnapshot(runId, user.id), { ...replacement, streamLeaseEpoch: '2', streamRevision: '2' });
        assert.equal(await writeSnapshot({ runId, userId: user.id, leaseOwner: 'owner-b', leaseEpoch: '2', step: 1, snapshot }), false);
        await execute('UPDATE agent_runs SET realtime_lease_epoch = 3 WHERE id = ?', [runId]);
        assert.equal(await writeSnapshot({ runId, userId: user.id, leaseOwner: 'owner-b', leaseEpoch: '2', step: 3, snapshot: { ...snapshot, step: 3 } }), false);
        assert.equal(await readSnapshot(runId, user.id), null);
        await execute("UPDATE realtime_stream_snapshots SET updated_at = NOW() - INTERVAL '6 minutes' WHERE run_id = ?", [runId]);
        assert.equal(await readSnapshot(runId, user.id), null);
        let notified = 0;
        const writer = createSnapshotWriter({ runId, userId: user.id, leaseOwner: 'owner-b', leaseEpoch: '3', enabled: true, notify() { notified += 1; } });
        writer.push({ ...replacement, content: 'first' });
        writer.push({ ...replacement, content: 'latest' });
        await writer.finish();
        assert.equal((await readSnapshot(runId, user.id)).content, 'latest');
        assert.equal(notified, 1);
        // 旧节点通过原有 SQL 重新认领时也会由数据库提升代次，旧执行者不能继续覆盖。
        await execute("UPDATE agent_runs SET status = 'queued', locked_by = NULL WHERE id = ?", [runId]);
        await execute("UPDATE agent_runs SET status = 'running', locked_by = 'owner-b', lock_expires_at = NOW()+INTERVAL '5 minutes' WHERE id = ?", [runId]);
        const epoch = await queryOne('SELECT realtime_lease_epoch::text AS epoch FROM agent_runs WHERE id = ?', [runId]);
        assert.equal(epoch.epoch, '4');
        assert.equal(await writeSnapshot({ runId, userId: user.id, leaseOwner: 'owner-b', leaseEpoch: '3', step: 2, snapshot: replacement }), false);
        await execute("UPDATE agent_runs SET status = 'completed' WHERE id = ?", [runId]);
        assert.equal(await readSnapshot(runId, user.id), null);
    } finally { await execute('DELETE FROM agent_runs WHERE id = ?', [runId]); }
});

test('Agent 流式执行路径保存最终完整快照并发送不含正文的本地提示', { skip: !process.env.DATABASE_URL, timeout: 30000 }, async () => {
    const user = await queryOne('SELECT id FROM users ORDER BY id LIMIT 1');
    const runId = `snapshot-runtime-${process.pid}-${Date.now()}`;
    await execute("INSERT INTO agent_runs (id,user_id,title,goal,status,metadata,locked_by,realtime_lease_epoch,lock_expires_at,created_at,updated_at) VALUES (?,?,'snapshot','snapshot','planning','{}','owner-runtime',1,NOW()+INTERVAL '5 minutes',NOW(),NOW())", [runId, user.id]);
    const previous = process.env.PIVOT_DEPLOYMENT_MODE;
    process.env.PIVOT_DEPLOYMENT_MODE = 'multi_node';
    const { tryRunAgentStreaming } = require('../server/services/agent-streaming-runtime');
    const visible = [];
    const deps = {
        logger: { warn() {} }, listSteps: async () => [], insertStep: async () => {},
        captureStepContext: async () => ({}), recordAgentEvent: async () => {}, recordNativeToolCallCapability: async () => {},
        recordAgentModelUsage: async () => {}, recordAgentToolCall: async () => {}, updateRun: async () => {},
        withTimeout: async executeModel => executeModel(null), startAgentTraceSpan: async () => 'span', finishAgentTraceSpan: async () => {},
        publishUserEvent: (_user, _type, payload, options) => { visible.push({ payload, options }); },
        verifyAgentOutcome: async () => ({ outcomeStatus: 'verified', hardFailures: [] }),
        createAgentNotification: async () => {}, getRunMetadata: () => ({}), getAgentRunTitle: () => 'test',
        callModelStreamingWithTools: async (_model, _messages, _tools, options) => {
            options.onDelta({ content: 'partial snapshot', partialToolCalls: [] });
            await new Promise(resolve => setTimeout(resolve, 350));
            return { content: 'complete snapshot', hasToolCalls: false, toolCalls: [], finishReason: 'stop' };
        }
    };
    try {
        const result = await tryRunAgentStreaming({ run: { id: runId, goal: 'test', max_steps: 1, run_mode: 'standard', realtimeLeaseOwner: 'owner-runtime', realtimeLeaseEpoch: '1' },
            user: { id: user.id }, modelCfg: { id: 1 }, runId, toolList: [], deadline: Date.now() + 10000,
            assertRunWithinBudget() {}, assertRunNotCancelled: async () => {}, observations: [] }, deps);
        assert.equal(result.completed, true);
        const recovered = await readSnapshot(runId, user.id);
        assert.equal(recovered.content, 'complete snapshot');
        assert.equal(recovered.completed, true);
        assert.ok(visible.some(item => item.payload.content === 'partial snapshot' && item.options?.crossNode === false));
    } finally {
        if (previous === undefined) delete process.env.PIVOT_DEPLOYMENT_MODE; else process.env.PIVOT_DEPLOYMENT_MODE = previous;
        await execute('DELETE FROM agent_runs WHERE id = ?', [runId]);
    }
});
