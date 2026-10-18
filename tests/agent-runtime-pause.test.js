'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createRunLifecycle } = require('../server/services/agent-runtime/run-lifecycle');
const { canTransitionAgentRunStatus } = require('../server/services/agent-runtime/state-machine');

test('pause moves a running Agent to resumable needs_input and aborts the active controller', async () => {
    const controllers = new Map();
    const controller = new AbortController();
    controllers.set('run-voice-pause', controller);
    const run = { id: 'run-voice-pause', user_id: 7, status: 'executing', title: '语音暂停任务' };
    const updates = [];
    const steps = [];
    const lifecycle = createRunLifecycle({
        activeRunControllers: controllers,
        ACTIVE_STATUSES: new Set(['executing']),
        getRunForUser: async () => run,
        getBeijingTimestamp: () => '2026-10-18 10:00:00',
        updateRun: async (_id, fields) => { updates.push(fields); Object.assign(run, fields); },
        query: async () => [],
        listSteps: async () => steps,
        insertStep: async (_id, _index, step) => steps.push(step),
        createAgentNotification: async () => {},
        getAgentRunTitle: value => value.title
    });

    const paused = await lifecycle.pauseAgentRun(run.id, { id: 7 });

    assert.equal(paused.status, 'needs_input');
    assert.equal(controller.signal.aborted, true);
    assert.equal(controller.signal.reason.code, 'AGENT_RUN_PAUSED');
    assert.equal(updates[0].status, 'needs_input');
    assert.equal(Object.hasOwn(updates[0], 'completed_at'), false);
    assert.equal(steps.at(-1).title, '用户暂停运行');
    assert.equal(steps.at(-1).output.resumable, true);
});

test('pause leaves approval and commit boundaries unchanged', async () => {
    const run = { id: 'run-awaiting-commit', user_id: 7, status: 'awaiting_commit', title: '等待提交' };
    const lifecycle = createRunLifecycle({
        activeRunControllers: new Map(),
        ACTIVE_STATUSES: new Set(['awaiting_commit']),
        getRunForUser: async () => run
    });
    const result = await lifecycle.pauseAgentRun(run.id, { id: 7 });
    assert.equal(result.status, 'awaiting_commit');
});

test('queued and resuming runs can enter the resumable pause state', () => {
    assert.equal(canTransitionAgentRunStatus('queued', 'needs_input'), true);
    assert.equal(canTransitionAgentRunStatus('resuming', 'needs_input'), true);
});

test('cancelling an unowned run never aborts its active controller', async () => {
    const controller = new AbortController();
    const lifecycle = createRunLifecycle({
        activeRunControllers: new Map([['another-user-run', controller]]),
        ACTIVE_STATUSES: new Set(['running']),
        getRunForUser: async () => null
    });
    assert.equal(await lifecycle.cancelAgentRun('another-user-run', { id: 9 }), null);
    assert.equal(controller.signal.aborted, false);
});

test('cancellation does not overwrite a concurrent transition to awaiting commit', async () => {
    const controller = new AbortController();
    let reads = 0;
    const lifecycle = createRunLifecycle({
        activeRunControllers: new Map([['run-race', controller]]),
        ACTIVE_STATUSES: new Set(['running', 'awaiting_commit']),
        getRunForUser: async () => ({ id: 'run-race', status: ++reads === 1 ? 'running' : 'awaiting_commit' }),
        getBeijingTimestamp: () => '2026-10-18 10:00:00',
        updateRunCas: async () => 0
    });
    await assert.rejects(() => lifecycle.cancelAgentRun('run-race', { id: 7 }), error => error.code === 'AGENT_TASK_COMMIT_DECISION_REQUIRED');
    assert.equal(controller.signal.aborted, false);
});
