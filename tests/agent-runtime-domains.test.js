const assert = require('node:assert/strict');
const test = require('node:test');
const runtime = require('../server/services/agent-runtime');

test('Agent Runtime 只提供具名领域 API，不再泄露无边界平铺导出', () => {
    assert.equal(typeof runtime.runs.createAgentRun, 'function');
    assert.equal(typeof runtime.runs.cancelAgentRun, 'function');
    assert.equal(typeof runtime.runs.recoverAgentRuns, 'function');
    assert.equal(typeof runtime.runs.startAgentRecoveryRunner, 'function');
    assert.equal(typeof runtime.schedules.createAgentSchedule, 'function');
    assert.equal(typeof runtime.schedules.listAgentSchedules, 'function');
    assert.equal(typeof runtime.schedules.computeNextScheduleRun, 'function');
    assert.equal(typeof runtime.schedules.startAgentScheduleRunner, 'function');
    assert.equal(typeof runtime.workflows.createAgentWorkflow, 'function');
    assert.equal(typeof runtime.artifacts.saveAgentRunArtifact, 'function');
    assert.equal(typeof runtime.goals.runDueAgentGoals, 'function');
    assert.equal(typeof runtime.monitoring.syncAgentRuntimeConcurrency, 'function');
    assert.equal(typeof runtime.notifications.markAgentNotificationRead, 'function');
    ['createAgentRun', 'cancelAgentRun', 'getAgentQueue', 'listAgentWorkflows', 'saveAgentRunArtifact'].forEach(name => {
        assert.equal(Object.hasOwn(runtime, name), false, `${name} 不应再作为平铺运行时导出`);
    });
});
