'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { execute, query, queryOne } = require('../server/db/client');
const {
    createPersistedAgentStepContext,
    listAgentContextWindowsForUser,
    listAgentWorldStateSnapshotsForUser,
    pruneAgentWorldStateSnapshots
} = require('../server/services/agent-world-state-store');
const { listAgentEventsForUser } = require('../server/services/agent-event-log');

async function insertRun(runId, userId) {
    const now = '2026-08-22 14:00:00';
    await execute(`
        INSERT INTO agent_runs (id, user_id, title, goal, status, tool_policy, approval_policy, metadata, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'queued', 'all', 'safe_mcp_auto', '{}', ?, ?)
    `, [runId, userId, 'WorldState window test', '分析当前指标', now, now]);
}

test('persisted WorldState windows restore baselines and rotate on material changes', async () => {
    const user = await queryOne('SELECT id FROM users ORDER BY id LIMIT 1');
    assert.ok(user?.id);
    const runId = `world-state-${process.pid}-${Date.now()}`;
    const run = {
        id: runId,
        user_id: user.id,
        goal: '分析当前指标',
        run_mode: 'standard',
        tool_policy: 'all',
        approval_policy: 'safe_mcp_auto',
        metadata: {}
    };
    const firstModel = { id: 1, name: 'model-one', model_name: 'model-one' };
    const secondModel = { id: 2, name: 'model-two', model_name: 'model-two' };
    const toolList = [{ name: 'models.list', source: 'builtin', idempotent: true }];
    await insertRun(runId, user.id);
    try {
        const first = await createPersistedAgentStepContext({
            run,
            user,
            turnId: `${runId}:turn:1`,
            stepIndex: 1,
            modelCfg: firstModel,
            toolList,
            contextConfig: { locale: 'zh-CN' }
        });
        assert.equal(first.worldStateInjection.mode, 'full');
        assert.equal(first.worldStateWindow.fullRefreshReason, 'initial');
        assert.equal(first.worldStateWindow.windowVersion, 1);

        // Deliberately omit previousWorldState to simulate a fresh worker process.
        const second = await createPersistedAgentStepContext({
            run,
            user,
            turnId: `${runId}:turn:2`,
            stepIndex: 2,
            modelCfg: firstModel,
            toolList,
            contextConfig: { locale: 'zh-CN' }
        });
        assert.equal(second.worldStateInjection.mode, 'reference');
        assert.equal(second.worldStateInjection.baseHash, first.worldStateHash);
        assert.equal(second.worldStateWindow.windowId, first.worldStateWindow.windowId);

        const changed = await createPersistedAgentStepContext({
            run: { ...run, goal: '分析本月指标' },
            user,
            turnId: `${runId}:turn:3`,
            stepIndex: 3,
            modelCfg: firstModel,
            toolList,
            contextConfig: { locale: 'zh-CN' }
        });
        assert.equal(changed.worldStateInjection.mode, 'diff');
        assert.equal(changed.worldStateWindow.windowId, first.worldStateWindow.windowId);
        assert.ok(changed.worldStateInjection.patch.some(item => item.path === '/run/goal'));

        const modelChanged = await createPersistedAgentStepContext({
            run: { ...run, goal: '分析本月指标' },
            user,
            turnId: `${runId}:turn:4`,
            stepIndex: 4,
            modelCfg: secondModel,
            toolList,
            contextConfig: { locale: 'zh-CN' }
        });
        assert.equal(modelChanged.worldStateInjection.mode, 'full');
        assert.equal(modelChanged.worldStateWindow.fullRefreshReason, 'model_changed');
        assert.equal(modelChanged.worldStateWindow.windowVersion, 2);
        assert.equal(modelChanged.worldStateWindow.parentWindowId, first.worldStateWindow.windowId);

        const compacted = await createPersistedAgentStepContext({
            run: { ...run, goal: '分析本月指标' },
            user,
            turnId: `${runId}:turn:5`,
            stepIndex: 5,
            modelCfg: secondModel,
            toolList,
            contextConfig: { locale: 'zh-CN', contextCompacted: true }
        });
        assert.equal(compacted.worldStateInjection.mode, 'full');
        assert.equal(compacted.worldStateWindow.fullRefreshReason, 'context_compacted');
        assert.equal(compacted.worldStateWindow.windowVersion, 3);

        const windows = await listAgentContextWindowsForUser(runId, user);
        assert.deepEqual(windows.map(item => [item.window_version, item.status, item.opened_reason]), [
            [1, 'superseded', 'initial'],
            [2, 'superseded', 'model_changed'],
            [3, 'active', 'context_compacted']
        ]);
        const snapshots = await listAgentWorldStateSnapshotsForUser(runId, user);
        assert.equal(snapshots.length, 5);
        assert.deepEqual(snapshots.map(item => item.injection_mode), ['full', 'reference', 'diff', 'full', 'full']);
        assert.equal(snapshots[2].base_state_hash, first.worldStateHash);

        const events = await listAgentEventsForUser(runId, user, { types: ['step.context_captured'] });
        assert.equal(events.length, 5);
        assert.equal(events.at(-1).payload.contextWindow.fullRefreshReason, 'context_compacted');
        const otherUser = { id: Number(user.id) + 999999 };
        assert.deepEqual(await listAgentWorldStateSnapshotsForUser(runId, otherUser), []);
    } finally {
        await execute('DELETE FROM agent_runs WHERE id = ?', [runId]);
    }
});

test('WorldState snapshot rows retain full state needed for replay', async () => {
    const user = await queryOne('SELECT id FROM users ORDER BY id LIMIT 1');
    const runId = `world-state-replay-${process.pid}-${Date.now()}`;
    const run = { id: runId, user_id: user.id, goal: '回放检查', tool_policy: 'all', metadata: {} };
    await insertRun(runId, user.id);
    try {
        const context = await createPersistedAgentStepContext({
            run,
            user,
            turnId: `${runId}:turn:1`,
            stepIndex: 1,
            modelCfg: { id: 9, name: 'replay-model' },
            toolList: [{ name: 'models.list', source: 'builtin' }],
            environment: { workspace: 'E:/pivot/workspaces/replay' }
        });
        const rows = await query(`
            SELECT state, state_hash, context_hash
            FROM agent_world_state_snapshots
            WHERE run_id = ?
        `, [runId]);
        assert.equal(rows.length, 1);
        const state = typeof rows[0].state === 'string' ? JSON.parse(rows[0].state) : rows[0].state;
        assert.equal(state.hash, context.worldStateHash);
        assert.equal(state.environment.workspace, 'E:/pivot/workspaces/replay');
        assert.equal(rows[0].context_hash, context.contextHash);
    } finally {
        await execute('DELETE FROM agent_runs WHERE id = ?', [runId]);
    }
});

test('WorldState retention keeps each window baseline and recent snapshots', async () => {
    const user = await queryOne('SELECT id FROM users ORDER BY id LIMIT 1');
    const runId = `world-state-retention-${process.pid}-${Date.now()}`;
    const run = { id: runId, user_id: user.id, goal: '保留策略', tool_policy: 'all', metadata: {} };
    await insertRun(runId, user.id);
    try {
        for (let step = 1; step <= 8; step += 1) {
            await createPersistedAgentStepContext({
                run: { ...run, goal: `保留策略 ${step}` }, user,
                turnId: `${runId}:turn:${step}`, stepIndex: step,
                modelCfg: { id: 10, name: 'retention-model' },
                toolList: [{ name: 'models.list', source: 'builtin' }]
            });
        }
        const result = await pruneAgentWorldStateSnapshots(runId, user, { keepLatest: 2, keepPerWindow: 1 });
        assert.ok(result.deleted >= 4);
        const rows = await listAgentWorldStateSnapshotsForUser(runId, user);
        assert.ok(rows.length <= 3);
        assert.equal(rows.some(row => row.snapshot_version === 1), true);
        assert.equal(rows.at(-1).snapshot_version, 8);
    } finally {
        await execute('DELETE FROM agent_runs WHERE id = ?', [runId]);
    }
});
