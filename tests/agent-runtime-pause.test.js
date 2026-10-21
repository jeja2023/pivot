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
        updateRunCas: async (_id, expected, fields) => { assert.ok(expected.includes(run.status)); updates.push(fields); Object.assign(run, fields); return 1; },
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

test('暂停与验收完成并发时保留最新终态，不能中断已完成任务或覆盖提交边界', async () => {
    for (const target of ['completed', 'awaiting_commit']) {
        const controller = new AbortController();
        let status = 'verifying';
        const lifecycle = createRunLifecycle({
            activeRunControllers: new Map([['run-pause-race', controller]]),
            getRunForUser: async () => ({ id: 'run-pause-race', status }),
            getBeijingTimestamp: () => '2026-10-20 09:00:00',
            updateRunCas: async () => { status = target; return 0; }
        });
        const result = await lifecycle.pauseAgentRun('run-pause-race', { id: 7 });
        assert.equal(result.status, target);
        assert.equal(controller.signal.aborted, false);
    }
});

test('停止父任务同时停止等待输入和验收中的子任务', async () => {
    const parent = { id: 'parent-stop', status: 'running' };
    const child = { id: 'child-stop', status: 'needs_input' };
    const runs = new Map([[parent.id, parent], [child.id, child]]);
    const lifecycle = createRunLifecycle({
        activeRunControllers: new Map(), ACTIVE_STATUSES: new Set(['running', 'needs_input']),
        getRunForUser: async id => runs.get(id),
        getBeijingTimestamp: () => '2026-10-20 09:00:00',
        updateRunCas: async (id, _expected, fields) => { Object.assign(runs.get(id), fields); return 1; },
        query: async (sql, args) => {
            assert.match(sql, /'verifying'/);
            assert.match(sql, /'needs_input'/);
            return args[0] === parent.id ? [{ id: child.id }] : [];
        },
        listSteps: async () => [], insertStep: async () => {}, createAgentNotification: async () => {}, getAgentRunTitle: run => run.id
    });
    await lifecycle.cancelAgentRun(parent.id, { id: 7 });
    assert.equal(parent.status, 'cancelled');
    assert.equal(child.status, 'cancelled');
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
