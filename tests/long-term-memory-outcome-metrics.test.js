'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { execute, queryOne } = require('../server/db/client');
const { recordMemoryUsage } = require('../server/services/long-term-memory');
const {
    assessMemoryOutcomeMetrics,
    getMemoryOutcomeMetrics,
    listMemoryOutcomePeriods,
    snapshotMemoryOutcomePeriod
} = require('../server/services/long-term-memory/memory-outcome-metrics');

test('长期记忆效用指标关联注入、验收、反馈、过期和撤销残留证据', async () => {
    const user = await queryOne('SELECT id FROM users ORDER BY id LIMIT 1');
    assert.ok(user?.id);
    const suffix = `${process.pid}-${Date.now()}`;
    const runs = [`memory-outcome-good-${suffix}`, `memory-outcome-conflict-${suffix}`, `memory-outcome-residual-${suffix}`];
    const memoryIds = [];
    try {
        for (const [index, runId] of runs.entries()) {
            await execute(`
                INSERT INTO agent_runs (id, user_id, title, goal, status, metadata, created_at, updated_at)
                VALUES (?, ?, ?, '记忆效用回归', 'completed', '{}', NOW(), NOW())
            `, [runId, user.id, `记忆效用-${index}`]);
        }
        const ordinary = await queryOne(`INSERT INTO memories (user_id, type, content, status, created_at, updated_at) VALUES (?, 'fact', ?, 'active', NOW(), NOW()) RETURNING id`, [user.id, `有效记忆-${suffix}`]);
        const conflicting = await queryOne(`INSERT INTO memories (user_id, type, content, status, expires_at, created_at, updated_at) VALUES (?, 'fact', ?, 'active', NOW() - INTERVAL '1 second', NOW(), NOW()) RETURNING id`, [user.id, `过期记忆-${suffix}`]);
        const residual = await queryOne(`INSERT INTO memories (user_id, type, content, status, revoked_at, created_at, updated_at) VALUES (?, 'fact', ?, 'disabled', NOW() - INTERVAL '1 second', NOW(), NOW()) RETURNING id`, [user.id, `撤销记忆-${suffix}`]);
        memoryIds.push(Number(ordinary.id), Number(conflicting.id), Number(residual.id));
        const usages = await Promise.all([
            recordMemoryUsage(user.id, [{ id: ordinary.id }], { eventType: 'injected', runId: runs[0], queryText: '有效记忆' }),
            recordMemoryUsage(user.id, [{ id: conflicting.id }], { eventType: 'injected', runId: runs[1], queryText: '冲突记忆' }),
            recordMemoryUsage(user.id, [{ id: residual.id }], { eventType: 'injected', runId: runs[2], queryText: '撤销记忆' })
        ]);
        assert.deepEqual(usages.map(item => item.recorded), [1, 1, 1]);
        for (const [index, runId] of runs.entries()) {
            const outcome = index === 1 ? 'partial' : 'verified';
            await execute(`
                INSERT INTO agent_verifications (id, run_id, user_id, contract, outcome_status, report, created_at, updated_at)
                VALUES (?, ?, ?, '{}', ?, '{}', NOW(), NOW())
            `, [`verify-${runId}`, runId, user.id, outcome]);
            await execute(`
                INSERT INTO agent_feedback (user_id, run_id, outcome, rating, correction, tool_failures, metadata, source, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, '[]', '{}', 'user', NOW(), NOW())
            `, [user.id, runId, index === 1 ? 'failure' : 'success', index === 1 ? 1 : 5, index === 1 ? '记忆冲突' : '']);
        }
        const metrics = await getMemoryOutcomeMetrics(user.id, { days: 1 });
        assert.equal(metrics.injectedCount, 3);
        assert.equal(metrics.evaluatedCount, 3);
        assert.equal(metrics.helpfulCount, 2);
        assert.equal(metrics.conflictCount, 1);
        assert.equal(metrics.expiredHitCount, 1);
        assert.equal(metrics.revokedResidualCount, 1);
        assert.equal(metrics.status, 'insufficient_data');
        const snapshot = await snapshotMemoryOutcomePeriod(user.id, { periodStart: '2026-09-01', periodEnd: '2026-10-01' });
        assert.equal(snapshot.metrics.evaluatedCount, 0);
        const periods = await listMemoryOutcomePeriods(user.id, { limit: 5 });
        assert.ok(periods.some(item => item.periodStart === '2026-09-01'));
        const passing = assessMemoryOutcomeMetrics({ evaluatedCount: 30, helpfulRate: 0.8, conflictRate: 0.05, expiredHitRate: 0, revokedResidualRate: 0 });
        assert.equal(passing.status, 'passing');
    } finally {
        await execute(`DELETE FROM agent_feedback WHERE user_id = ? AND run_id IN (${runs.map(() => '?').join(',')})`, [user.id, ...runs]);
        await execute(`DELETE FROM agent_verifications WHERE user_id = ? AND run_id IN (${runs.map(() => '?').join(',')})`, [user.id, ...runs]);
        await execute('DELETE FROM memory_quality_periods WHERE user_id = ? AND period_start = ?::date', [user.id, '2026-09-01']);
        if (memoryIds.length) await execute(`DELETE FROM memories WHERE id IN (${memoryIds.map(() => '?').join(',')})`, memoryIds);
        await execute(`DELETE FROM agent_runs WHERE id IN (${runs.map(() => '?').join(',')})`, runs);
    }
});
