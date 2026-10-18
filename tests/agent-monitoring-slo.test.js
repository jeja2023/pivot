'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { queryOne } = require('../server/db/client');
const { assessAgentRuntimeSlo, getAgentMetrics, runAgentRuntimeSloMonitor } = require('../server/services/agent-monitoring');

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
