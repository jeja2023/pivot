'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { queryOne, execute } = require('../server/db/client');
const { recordAgentEvent } = require('../server/services/agent-event-log');
const { assessAgentRuntimeSlo, getAgentContextCompactionMetrics, getAgentMetrics, runAgentRuntimeSloMonitor } = require('../server/services/agent-monitoring');

test('Agent runtime SLO never treats an undersampled period as passing', () => {
    const result = assessAgentRuntimeSlo({ total: 29, completed: 29, p95DurationMs: 1000 });
    assert.equal(result.status, 'insufficient_data');
    assert.ok(result.blockers.includes('sample_insufficient'));
});

test('Agent runtime SLO evaluates success, failure and p95 thresholds independently', () => {
    const passing = assessAgentRuntimeSlo({ total: 40, completed: 39, completedWithErrors: 1, p95DurationMs: 120000 });
    assert.equal(passing.status, 'passing');
    const failing = assessAgentRuntimeSlo({ total: 40, completed: 36, error: 4, p95DurationMs: 400000 });
    assert.equal(failing.status, 'attention');
    assert.ok(failing.blockers.includes('success_rate_low'));
    assert.ok(failing.blockers.includes('failure_rate_high'));
    assert.ok(failing.blockers.includes('p95_duration_high'));
});

test('Agent runtime SLO excludes active and user-cancelled runs from its quality sample', () => {
    const result = assessAgentRuntimeSlo({ total: 100, terminalCount: 40, completed: 39, completedWithErrors: 1, cancelled: 60, p95DurationMs: 120000 });
    assert.equal(result.total, 40);
    assert.equal(result.status, 'passing');
});

test('Agent runtime SLO metrics execute the JSONB compaction filter without treating it as a SQL parameter', async () => {
    const admin = await queryOne("SELECT id, username, role FROM users WHERE username = 'admin' ORDER BY id LIMIT 1");
    assert.ok(admin?.id);
    const metrics = await getAgentMetrics(admin, 7);
    assert.equal(metrics.days, 7);
    assert.ok(metrics.runtimeSlo && typeof metrics.runtimeSlo.status === 'string');
});

test('压缩事件保留安全计数，旧脱敏或异常数据不会中断 SLO 或污染统计', async () => {
    const admin = await queryOne("SELECT id, username, role FROM users WHERE username = 'admin' ORDER BY id LIMIT 1");
    const runId = `slo-compaction-${process.pid}-${Date.now()}`;
    await execute("INSERT INTO agent_runs (id, user_id, title, goal, status, metadata, created_at, updated_at) VALUES (?, ?, '测试', '测试', 'queued', '{}', NOW(), NOW())", [runId, admin.id]);
    try {
        const good = await recordAgentEvent({ runId, userId: admin.id, type: 'context.compacted', payload: { compaction: {
            inputTokensBefore: 1200, inputTokensAfter: 300, targetTokens: 500, accessToken: '秘密', retained: { hardFieldLoss: false }
        } } });
        const saved = await queryOne('SELECT payload FROM agent_events WHERE id = ?', [good.id]);
        const data = typeof saved.payload === 'string' ? JSON.parse(saved.payload) : saved.payload;
        assert.equal(data.compaction.inputTokensBefore, 1200);
        assert.equal(data.compaction.inputTokensAfter, 300);
        assert.equal(data.compaction.accessToken, '[已脱敏]');
        const old = await recordAgentEvent({ runId, userId: admin.id, type: 'context.compacted', payload: { compaction: { inputTokensBefore: 'secret-value', inputTokensAfter: 'secret-value', retained: { hardFieldLoss: 'invalid' } } } });
        const oldSaved = await queryOne('SELECT payload FROM agent_events WHERE id = ?', [old.id]);
        const oldData = typeof oldSaved.payload === 'string' ? JSON.parse(oldSaved.payload) : oldSaved.payload;
        assert.equal(oldData.compaction.inputTokensBefore, '[已脱敏]');
        await recordAgentEvent({ runId, userId: admin.id, type: 'context.compacted', payload: { compaction: { inputTokensBefore: 9999999999999, inputTokensAfter: 20, retained: { hardFieldLoss: true } } } });
        const metrics = await getAgentContextCompactionMetrics({ id: admin.id, tenant_id: 123, role: 'user' }, 7);
        assert.equal(metrics.eventCount, 3);
        assert.equal(metrics.tokenSampleCount, 1);
        assert.equal(metrics.unavailableTokenSamples, 2);
        assert.equal(metrics.savingsRate, 0.75);
        assert.equal(metrics.lossSampleCount, 2);
        assert.equal(metrics.hardFieldLosses, 1);
        assert.ok((await getAgentMetrics(admin, 7)).runtimeSlo);
    } finally {
        await execute('DELETE FROM agent_runs WHERE id = ?', [runId]);
    }
});

test('Agent runtime SLO monitor alerts administrators only for actionable threshold breaches', async () => {
    const events = [];
    const result = await runAgentRuntimeSloMonitor({
        listAdmins: async () => [{ id: 7, username: 'admin', role: 'admin' }],
        getMetrics: async () => ({ days: 7, runtimeSlo: { status: 'attention', total: 42, p95DurationMs: 420000, blockers: ['p95_duration_high'] } }),
        createInboxEvent: async (_user, event) => events.push(event)
    });
    assert.equal(result.alerts, 1);
    assert.equal(events[0].eventKey, 'runtime.slo:7:p95_duration_high');
    const insufficient = await runAgentRuntimeSloMonitor({
        listAdmins: async () => [{ id: 7, username: 'admin', role: 'admin' }],
        getMetrics: async () => ({ days: 7, runtimeSlo: { status: 'insufficient_data', total: 3, blockers: ['sample_insufficient'] } }),
        createInboxEvent: async () => { throw new Error('不应创建低样本告警'); }
    });
    assert.equal(insufficient.alerts, 0);
});

test('Agent runtime maintenance schedule wires the SLO monitor into its periodic job set', () => {
    const root = path.resolve(__dirname, '..');
    const schedules = fs.readFileSync(path.join(root, 'server/services/agent-schedules.js'), 'utf8');
    const runtime = fs.readFileSync(path.join(root, 'server/services/agent-runtime/index.js'), 'utf8');
    assert.match(schedules, /runSloMonitor/);
    assert.match(schedules, /运行 SLO 监视执行失败/);
    assert.match(runtime, /runSloMonitor: \(\) => runAgentRuntimeSloMonitor\(\)/);
});
