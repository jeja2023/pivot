'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { normalizeHookRegistration } = require('../server/services/agent-lifecycle-hooks');
const { recordPlannerModelEvent } = require('../server/services/agent-runtime/planning-lifecycle');

test('规划生命周期事件是受支持的声明式 Hook 事件', () => {
    for (const eventType of ['plan.requested', 'plan.completed', 'plan.failed', 'plan.failover']) {
        const hook = normalizeHookRegistration({ hookName: `test-${eventType}`, eventType, phase: 'post', status: 'enabled', signatureVerified: true });
        assert.equal(hook.eventType, eventType);
    }
});

test('规划 Hook 仅接收脱敏元数据，模型事件与后置 Hook 使用关联键', async () => {
    const events = [];
    const hooks = [];
    await recordPlannerModelEvent('failed', {
        runId: 'run-plan-1', user: { id: 7 }, turnId: 'turn-1', step: 3,
        stepContext: { contextHash: 'context-hash' }, model: { id: 12, name: 'planner-model' },
        purpose: 'agent_planner_failed', messageCount: 9,
        error: Object.assign(new Error('provider detail must stay outside Hook payload'), { code: 'UPSTREAM_TIMEOUT' }),
        recordEvent: async event => events.push(event),
        buildAuditFields: () => ({ safeAudit: true }),
        dispatch: async request => { hooks.push(request); return { dispatched: true, result: { decisions: [] } }; }
    });
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'model.failed');
    assert.equal(events[0].payload.safeAudit, true);
    assert.equal(events[0].payload.errorCode, 'UPSTREAM_TIMEOUT');
    assert.equal(hooks.length, 1);
    assert.equal(hooks[0].eventType, 'plan.failed');
    assert.equal(hooks[0].payload.planning.errorCode, 'UPSTREAM_TIMEOUT');
    assert.equal(Object.hasOwn(hooks[0].payload.planning, 'errorMessage'), false);
    assert.equal(JSON.stringify(hooks[0].payload).includes('provider detail'), false);
    assert.match(hooks[0].eventKey, /^lifecycle:plan\.failed:run-plan-1:3:12$/);
});
