'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createRunState } = require('../server/services/agent-runtime/run-state');

test('run state dispatches lifecycle start once and terminal completion after the durable transition', async () => {
    const run = {
        id: 'run-lifecycle', user_id: 7, status: 'queued', title: '生命周期测试', goal: '验证 Hook',
        updated_at: '', started_at: '', completed_at: '', last_heartbeat_at: '', error_message: ''
    };
    const lifecycle = [];
    const events = [];
    const state = createRunState({
        crypto: require('crypto'),
        logger: { warn() {}, error() {} },
        getBeijingTimestamp: () => '2026-10-17 21:00:00',
        getAgentRunTitle: value => value.title,
        getRunMetadata: () => ({}),
        assertAgentRunStatusTransition() {},
        canTransitionAgentRunStatus: () => true,
        TERMINAL_STATUSES: new Set(['completed', 'completed_with_errors', 'partial', 'error', 'failed', 'cancelled', 'deleted']),
        releaseChildRunReservation: async () => {},
        persistAgentRunChatResult: async () => {},
        deliverChannelGatewayRunResult: async () => {},
        deliverGoalRunResult: async () => {},
        recordCollaboratorCompletion: async () => {},
        recordAgentRunOutcome: async () => {},
        recordFirstTaskTerminal: async () => {},
        recordAgentEvent: async event => events.push(event),
        publishUserEvent: async () => {},
        parseJsonObject: () => ({}),
        updateAgentRunMetadataWithRetry: async () => ({}),
        dispatchPostLifecycleHook: async request => lifecycle.push({ ...request, observedStatus: run.status }),
        queryOne: async sql => {
            if (/SELECT status FROM agent_runs/.test(sql)) return { status: run.status };
            if (/SELECT metadata FROM agent_runs/.test(sql)) return { metadata: '{}' };
            if (/SELECT u\.id,/.test(sql)) return { id: 7, username: 'tester', role: 'user' };
            if (/FROM agent_runs/.test(sql)) return run;
            return null;
        },
        execute: async (sql, params) => {
            if (/UPDATE agent_runs SET/.test(sql)) {
                const statusIndex = /status = \?/.test(sql) ? 0 : -1;
                if (statusIndex >= 0) run.status = params[statusIndex];
                return 1;
            }
            return 0;
        }
    });

    await state.updateRun(run.id, { status: 'planning', updated_at: '2026-10-17 21:00:00' });
    assert.equal(run.status, 'planning');
    assert.equal(lifecycle.length, 1);
    assert.equal(lifecycle[0].eventType, 'run.started');
    assert.equal(lifecycle[0].observedStatus, 'planning');

    await state.updateRun(run.id, { status: 'completed', completed_at: '2026-10-17 21:00:02' });
    assert.equal(run.status, 'completed');
    assert.equal(lifecycle.length, 2);
    assert.equal(lifecycle[1].eventType, 'run.finished');
    assert.equal(lifecycle[1].observedStatus, 'completed');
    assert.ok(events.some(event => event.type === 'run.completed'));
});
