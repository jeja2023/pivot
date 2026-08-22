'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { execute, queryOne } = require('../server/db/client');
const {
    dispatchAgentEventOutboxBatch,
    failAgentEventOutbox
} = require('../server/services/agent-event-outbox');
const {
    getAgentRunResources,
    buildForkHistory,
    initializeAgentRunResources,
    recordAgentRunResourceUsage,
    releaseChildRunReservation,
    reserveChildRunResources
} = require('../server/services/agent-run-resources');
const { replayAgentEventsForUser, recordAgentEvent } = require('../server/services/agent-event-log');
const { buildToolExecutionPlan, summarizeToolExecutionPlan } = require('../server/services/agent-tool-execution-plan');

async function createRun(userId, id, parentRunId = null, budgetConfig = '{}', maxTokenBudget = 0) {
    const now = '2026-08-22 12:00:00';
    await execute(`
        INSERT INTO agent_runs (id, user_id, title, goal, status, parent_run_id, metadata,
                                budget_config, max_token_budget, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'queued', ?, '{}', ?, ?, ?, ?)
    `, [id, userId, id, id, parentRunId, budgetConfig, maxTokenBudget, now, now]);
}

test('Agent event outbox is retryable and event replay advances by seq', async () => {
    const user = await queryOne('SELECT id FROM users ORDER BY id LIMIT 1');
    const runId = `event-outbox-${process.pid}-${Date.now()}`;
    await createRun(user.id, runId);
    try {
        const event = await recordAgentEvent({
            runId,
            userId: user.id,
            type: 'model.requested',
            payload: { prompt: 'redact', secret: 'hidden' },
            eventKey: `test:${runId}`
        });
        assert.ok(event?.event_seq);
        const outbox = await queryOne('SELECT * FROM agent_event_outbox WHERE event_id = ?', [event.id]);
        assert.equal(outbox.status, 'pending');

        const wrongWorker = await failAgentEventOutbox(outbox.id, 'missing-worker', new Error('wrong worker'));
        assert.equal(wrongWorker.length, 0);
        const delivered = [];
        const result = await dispatchAgentEventOutboxBatch({
            workerId: `worker-${runId}`,
            publish: () => { throw new Error('simulated delivery failure'); }
        });
        assert.equal(result.delivered, 0, 'failed item remains pending for retry');

        await execute('UPDATE agent_event_outbox SET available_at = ? WHERE event_id = ?', ['2020-01-01 00:00:00', event.id]);
        const retried = await dispatchAgentEventOutboxBatch({
            workerId: `worker-${runId}`,
            publish: (userId, type, payload) => delivered.push({ userId, type, payload })
        });
        assert.equal(retried.delivered, 1);
        assert.equal(delivered[0].type, 'agent.event');
        assert.equal(delivered[0].payload.eventSeq, event.event_seq);
        assert.equal(delivered[0].payload.payload.secret, '[已脱敏]');

        const replay = await replayAgentEventsForUser(runId, user);
        assert.equal(replay.events.length, 1);
        assert.equal(replay.nextAfter, event.event_seq);
        assert.equal(replay.hasMore, false);
    } finally {
        await execute('DELETE FROM agent_runs WHERE id = ?', [runId]);
    }
});

test('Agent child resources inherit budget, enforce concurrency, and roll usage into parent', async () => {
    const user = await queryOne('SELECT id FROM users ORDER BY id LIMIT 1');
    const suffix = `${process.pid}-${Date.now()}`;
    const parentId = `resource-parent-${suffix}`;
    const childId = `resource-child-${suffix}`;
    await createRun(user.id, parentId, null, JSON.stringify({ max_children: 1 }), 200);
    try {
        const reservation = await reserveChildRunResources({
            parentRunId: parentId,
            userId: user.id,
            requestedTokenBudget: 120,
            forkHistory: { mode: 'turns', turns: 2 }
        });
        assert.equal(reservation.tokenBudget, 120);
        await assert.rejects(
            () => reserveChildRunResources({ parentRunId: parentId, userId: user.id, requestedTokenBudget: 20 }),
            error => error.code === 'AGENT_CHILD_CONCURRENCY_EXCEEDED'
        );
        await createRun(user.id, childId, parentId);
        await initializeAgentRunResources({
            runId: childId,
            userId: user.id,
            parentRunId: parentId,
            tokenBudget: 120,
            forkHistory: { mode: 'turns', turns: 2 }
        });
        await execute(`INSERT INTO agent_steps (run_id, step_index, type, title, input, output, status) VALUES (?, 1, 'tool', '证据', '{}', '{"value":1}', 'success')`, [parentId]);
        const history = await buildForkHistory(parentId, user.id, { mode: 'turns', turns: 1 });
        assert.equal(history.items.length, 1);
        await recordAgentRunResourceUsage(childId, 60);
        await releaseChildRunReservation(childId);
        const parent = await getAgentRunResources(parentId, user.id);
        assert.equal(Number(parent.active_children), 0);
        assert.equal(Number(parent.tokens_reserved), 0);
        assert.equal(Number(parent.tokens_consumed), 60);
    } finally {
        await execute('DELETE FROM agent_runs WHERE id IN (?, ?)', [parentId, childId]);
    }
});

test('Tool execution plan records approval, network and sandbox boundaries', async () => {
    const readPlan = await buildToolExecutionPlan({
        run: { tool_policy: 'all', approval_policy: 'safe_mcp_auto' },
        tool: { name: 'records.search', source: 'builtin', side_effect: false },
        input: { query: 'pivot' }
    });
    assert.equal(readPlan.policy.decision, 'allow');
    assert.equal(readPlan.sandbox.mode, 'none');
    assert.equal(summarizeToolExecutionPlan(readPlan).retryable, true);

    const approvalPlan = await buildToolExecutionPlan({
        run: { tool_policy: 'all', approval_policy: 'approve_all_mcp' },
        tool: { name: 'mcp.remote.write', source: 'mcp', side_effect: true, approval_required: true },
        input: { value: 'x' }
    });
    assert.equal(approvalPlan.policy.decision, 'require_approval');
    assert.equal(approvalPlan.approval.required, true);

    const sandboxPlan = await buildToolExecutionPlan({
        run: { tool_policy: 'all', approval_policy: 'safe_mcp_auto' },
        tool: { name: 'agent.code', source: 'builtin', side_effect: true },
        input: { code: 'return 1' },
        context: { autonomous: true, sandboxAvailable: false }
    });
    assert.equal(sandboxPlan.sandbox.preflight, 'denied');
    assert.equal(sandboxPlan.sandbox.error.code, 'AGENT_SANDBOX_REQUIRED');
});
