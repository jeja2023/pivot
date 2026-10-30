'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { execute, queryOne } = require('../server/db/client');
const {
    claimAgentEventOutbox,
    createAgentEventOutboxDispatcher,
    dispatchAgentEventOutboxBatch,
    failAgentEventOutbox,
    retireDeliveredAgentEvents
} = require('../server/services/agent-event-outbox');
const {
    getAgentRunResources,
    buildForkHistory,
    initializeAgentRunResources,
    recordAgentRunResourceUsage,
    releaseChildRunReservation,
    reserveChildRunResources
} = require('../server/services/agent-run-resources');
const { replayAgentEventsForUser, recordAgentEvent, recordAgentEventBatch } = require('../server/services/agent-event-log');
const { buildToolExecutionPlan, summarizeToolExecutionPlan } = require('../server/services/agent-tool-execution-plan');

async function createRun(userId, id, parentRunId = null, budgetConfig = '{}', maxTokenBudget = 0) {
    const now = '2026-08-22 12:00:00';
    await execute(`
        INSERT INTO agent_runs (id, user_id, title, goal, status, parent_run_id, metadata,
                                budget_config, max_token_budget, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'queued', ?, '{}', ?, ?, ?, ?)
    `, [id, userId, id, id, parentRunId, budgetConfig, maxTokenBudget, now, now]);
}

test('outbox 停止等待在途投递并阻止定时器继续调度', async () => {
    let release;
    let count = 0;
    const pending = new Promise(resolve => { release = resolve; });
    const dispatcher = createAgentEventOutboxDispatcher({
        intervalMs: 250,
        dispatchBatch: async () => { count += 1; await pending; },
        retireEvents: async () => 0
    });
    dispatcher.start();
    let stopped = false;
    const stopping = dispatcher.stop().then(() => { stopped = true; });
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.equal(count, 1);
    assert.equal(stopped, false);
    release();
    await stopping;
    assert.equal(stopped, true);
});

test('outbox 同步投递错误不会阻断后续轮询', async () => {
    let count = 0;
    const dispatcher = createAgentEventOutboxDispatcher({
        logger: { warn() {} },
        dispatchBatch: () => { count += 1; throw new Error('simulated synchronous failure'); }
    });
    await dispatcher.tick();
    await dispatcher.tick();
    assert.equal(count, 2);
    await dispatcher.stop();
});

test('Agent event outbox is retryable and event replay advances by seq', { skip: !process.env.DATABASE_URL }, async () => {
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
            publish: async () => { throw new Error('simulated delivery failure'); }
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

test('并发领取批量 outbox 不重复且数据库往返不随事件数量增长', { skip: !process.env.DATABASE_URL }, async () => {
    const { transaction } = require('../server/db/client');
    const user = await queryOne('SELECT id FROM users ORDER BY id LIMIT 1');
    const runId = `outbox-claim-${process.pid}-${Date.now()}`;
    await createRun(user.id, runId);
    let calls = 0;
    const transactionFn = callback => transaction(trx => callback(Object.fromEntries(
        ['query', 'execute'].map(name => [name, (...args) => { calls += 1; return trx[name](...args); }])
    )));
    try {
        await recordAgentEventBatch(Array.from({ length: 100 }, (_, i) => ({ runId, userId: user.id, type: 'model.progress', eventKey: `claim-${i}`, payload: {} })));
        const [first, second] = await Promise.all([
            claimAgentEventOutbox({ workerId: 'claim-first', limit: 50, transactionFn }),
            claimAgentEventOutbox({ workerId: 'claim-second', limit: 50, transactionFn })
        ]);
        assert.equal(first.length + second.length, 100);
        assert.equal(new Set([...first, ...second].map(row => row.id)).size, 100);
        assert.ok(calls <= 6, `领取 100 条事件使用 ${calls} 次数据库操作`);
        const row = await queryOne('SELECT COUNT(*) AS count FROM agent_event_outbox WHERE run_id = ? AND status = ? AND delivery_attempts = 1', [runId, 'claimed']);
        assert.equal(Number(row.count), 100);
    } finally {
        await execute('DELETE FROM agent_runs WHERE id = ?', [runId]);
    }
});

test('outbox 按数值顺序领取超出安全整数范围的事件 ID', { skip: !process.env.DATABASE_URL }, async () => {
    const user = await queryOne('SELECT id FROM users ORDER BY id LIMIT 1');
    const runId = `outbox-bigint-${process.pid}-${Date.now()}`;
    await createRun(user.id, runId);
    try {
        const eventIds = ['9007199254740993', '9007199254740994'];
        const outboxIds = ['9999999999999999', '10000000000000000'];
        for (let index = 0; index < 2; index += 1) {
            await execute(`INSERT INTO agent_events (id, run_id, user_id, event_seq, event_type, payload_hash)
                OVERRIDING SYSTEM VALUE VALUES (?, ?, ?, ?, 'model.progress', 'test')`, [eventIds[index], runId, user.id, index + 1]);
            await execute(`INSERT INTO agent_event_outbox (id, event_id, run_id, user_id, event_seq, event_type, available_at)
                OVERRIDING SYSTEM VALUE VALUES (?, ?, ?, ?, ?, 'model.progress', '2020-01-01')`, [outboxIds[index], eventIds[index], runId, user.id, index + 1]);
        }
        const published = [];
        const result = await dispatchAgentEventOutboxBatch({ workerId: 'bigint-test', publish: (_user, _type, event) => published.push(event.eventId) });
        assert.equal(result.delivered, 2);
        assert.deepEqual(published, eventIds);
        const express = require('express');
        const http = require('node:http');
        const { createEventsRouter } = require('../server/routes/events');
        const app = express();
        app.use(createEventsRouter({ authMiddleware(req, _res, next) { req.user = user; next(); } }));
        const server = await new Promise(resolve => {
            const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
        });
        try {
            const frames = await new Promise((resolve, reject) => {
                const request = http.get({ host: '127.0.0.1', port: server.address().port, path: '/events', headers: { 'Last-Event-ID': '9007199254740992' } }, response => {
                    let received = '';
                    response.on('data', data => {
                        received += data.toString();
                        if (received.includes(`id: ${eventIds[1]}\n`)) {
                            resolve(received);
                            response.destroy();
                        }
                    });
                    response.on('error', reject);
                });
                request.setTimeout(5000, () => request.destroy(new Error('SSE replay timed out')));
                request.on('error', reject);
            });
            assert.ok(frames.indexOf(`id: ${eventIds[0]}\n`) < frames.indexOf(`id: ${eventIds[1]}\n`));
        } finally {
            await new Promise(resolve => server.close(resolve));
        }
        await execute("UPDATE agent_event_outbox SET delivered_at = '2020-01-01' WHERE run_id = ?", [runId]);
        assert.equal(await retireDeliveredAgentEvents(), 2);
        const remaining = await queryOne('SELECT COUNT(*) AS count FROM agent_event_outbox WHERE run_id = ?', [runId]);
        assert.equal(Number(remaining.count), 0);
    } finally {
        await execute('DELETE FROM agent_runs WHERE id = ?', [runId]);
    }
});

test('单条与批量写入在大整数 ID 下保持事件和 outbox 关联', { skip: !process.env.DATABASE_URL }, async () => {
    const user = await queryOne('SELECT id FROM users ORDER BY id LIMIT 1');
    const runId = `event-write-bigint-${process.pid}-${Date.now()}`;
    await createRun(user.id, runId);
    const previous = await queryOne('SELECT last_value::text AS last_value, is_called FROM agent_events_id_seq');
    try {
        await queryOne("SELECT setval(pg_get_serial_sequence('agent_events', 'id'), ?::bigint, true)", ['9007199254740992']);
        const input = { runId, userId: user.id, type: 'model.progress', eventKey: 'large-single', payload: {} };
        const single = await recordAgentEvent(input);
        const batch = await recordAgentEventBatch([{ ...input, eventKey: 'large-batch' }, input]);
        assert.equal(single.id, '9007199254740993');
        assert.equal(batch[0].id, '9007199254740994');
        assert.equal(batch[1].id, single.id);
        const count = await queryOne('SELECT COUNT(*) AS count FROM agent_event_outbox WHERE run_id = ?', [runId]);
        assert.equal(Number(count.count), 2);
    } finally {
        await execute('DELETE FROM agent_runs WHERE id = ?', [runId]);
        await queryOne("SELECT setval(pg_get_serial_sequence('agent_events', 'id'), ?::bigint, ?)", [previous.last_value, previous.is_called]);
    }
});

test('同一用户不同运行的事件按事务提交顺序分配 ID', { skip: !process.env.DATABASE_URL }, async () => {
    const { transaction } = require('../server/db/client');
    const user = await queryOne('SELECT id FROM users ORDER BY id LIMIT 1');
    const suffix = `${process.pid}-${Date.now()}`;
    const firstRun = `event-order-a-${suffix}`;
    const secondRun = `event-order-b-${suffix}`;
    const otherRun = `event-order-c-${suffix}`;
    const otherUser = await queryOne("INSERT INTO users (username, password_hash, nickname, unit, role, status) VALUES (?, 'hash', 'other', 'QA', 'user', 'active') RETURNING id", [`event-order-${suffix}`]);
    await createRun(user.id, firstRun);
    await createRun(user.id, secondRun);
    await createRun(otherUser.id, otherRun);
    let release;
    let notify;
    const waiting = new Promise(resolve => { notify = resolve; });
    const barrier = new Promise(resolve => { release = resolve; });
    let first;
    let second;
    let other;
    let firstError;
    try {
        first = recordAgentEvent({ runId: firstRun, userId: user.id, type: 'model.progress', payload: {} }, {
            transactionFn: callback => transaction(async trx => {
                const result = await callback(trx);
                notify();
                await barrier;
                return result;
            })
        }).catch(error => { firstError = error; notify(); return null; });
        await waiting;
        if (firstError) throw firstError;
        let secondCommitted = false;
        second = recordAgentEvent({ runId: secondRun, userId: user.id, type: 'model.progress', payload: {} })
            .then(result => { secondCommitted = true; return result; });
        await new Promise(resolve => setTimeout(resolve, 100));
        assert.equal(secondCommitted, false, '较新的事件不得在前一事务提交前完成');
        other = recordAgentEvent({ runId: otherRun, userId: otherUser.id, type: 'model.progress', payload: {} });
        let timeout;
        const otherResult = await Promise.race([
            other,
            new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('其他用户的事件被意外阻塞')), 2000); })
        ]).finally(() => clearTimeout(timeout));
        assert.ok(otherResult?.id);
        release();
        const [a, b] = await Promise.all([first, second]);
        assert.ok(BigInt(a.id) < BigInt(b.id));
    } finally {
        release();
        await Promise.allSettled([first, second, other].filter(Boolean));
        await execute('DELETE FROM agent_runs WHERE id IN (?, ?, ?)', [firstRun, secondRun, otherRun]);
        await execute('DELETE FROM users WHERE id = ?', [otherUser.id]);
    }
});

test('批量投递只确认成功项，异步投递失败仍可重试', { skip: !process.env.DATABASE_URL }, async () => {
    const user = await queryOne('SELECT id FROM users ORDER BY id LIMIT 1');
    const runId = `outbox-delivery-${process.pid}-${Date.now()}`;
    await createRun(user.id, runId);
    try {
        const events = await recordAgentEventBatch(Array.from({ length: 30 }, (_, index) => ({
            runId, userId: user.id, type: 'model.progress', eventKey: `delivery-${index}`, payload: { index }
        })));
        const failed = String(events[7].id);
        const result = await dispatchAgentEventOutboxBatch({
            workerId: 'batch-delivery', limit: 100,
            publish: async (_user, _type, event) => { if (String(event.eventId) === failed) throw new Error('simulated'); }
        });
        assert.deepEqual(result, { claimed: 30, delivered: 29 });
        const counts = await queryOne("SELECT COUNT(*) FILTER (WHERE status = 'delivered') AS delivered, COUNT(*) FILTER (WHERE status = 'pending') AS pending FROM agent_event_outbox WHERE run_id = ?", [runId]);
        assert.equal(Number(counts.delivered), 29);
        assert.equal(Number(counts.pending), 1);
    } finally {
        await execute('DELETE FROM agent_runs WHERE id = ?', [runId]);
    }
});

test('批量确认写入失败时逐条确认已经投递的事件', { skip: !process.env.DATABASE_URL }, async () => {
    const user = await queryOne('SELECT id FROM users ORDER BY id LIMIT 1');
    const runId = `outbox-fallback-${process.pid}-${Date.now()}`;
    await createRun(user.id, runId);
    try {
        await recordAgentEventBatch(Array.from({ length: 3 }, (_, index) => ({ runId, userId: user.id, type: 'model.progress', eventKey: `fallback-${index}`, payload: {} })));
        await execute(`CREATE FUNCTION test_reject_batch_outbox_delivery() RETURNS trigger LANGUAGE plpgsql AS $$
            BEGIN
                IF (SELECT count(*) FROM changed_outbox WHERE status = 'delivered') > 1 THEN
                    RAISE EXCEPTION 'simulated batch confirmation failure';
                END IF;
                RETURN NULL;
            END $$`);
        await execute(`CREATE TRIGGER test_reject_batch_outbox_delivery AFTER UPDATE ON agent_event_outbox
            REFERENCING NEW TABLE AS changed_outbox FOR EACH STATEMENT EXECUTE FUNCTION test_reject_batch_outbox_delivery()`);
        const result = await dispatchAgentEventOutboxBatch({ workerId: 'fallback-delivery', publish: () => {} });
        assert.deepEqual(result, { claimed: 3, delivered: 3 });
        const count = await queryOne("SELECT COUNT(*) AS count FROM agent_event_outbox WHERE run_id = ? AND status = 'delivered'", [runId]);
        assert.equal(Number(count.count), 3);
    } finally {
        await execute('DROP TRIGGER IF EXISTS test_reject_batch_outbox_delivery ON agent_event_outbox');
        await execute('DROP FUNCTION IF EXISTS test_reject_batch_outbox_delivery()');
        await execute('DELETE FROM agent_runs WHERE id = ?', [runId]);
    }
});

test('批量事件保持顺序、幂等及失败时整体回滚', { skip: !process.env.DATABASE_URL }, async () => {
    const user = await queryOne('SELECT id FROM users ORDER BY id LIMIT 1');
    const runId = `event-batch-${process.pid}-${Date.now()}`;
    await createRun(user.id, runId);
    try {
        const event = (key, payload = {}) => ({ runId, userId: user.id, type: 'model.provider_event', eventKey: key, payload });
        const results = await recordAgentEventBatch([event('a'), event('b'), event('a')]);
        assert.equal(results[0].id, results[2].id);
        assert.equal(Number(results[1].event_seq), Number(results[0].event_seq) + 1);
        const replay = await replayAgentEventsForUser(runId, user);
        assert.equal(replay.events.length, 2);
        assert.equal((await queryOne('SELECT COUNT(*) AS count FROM agent_event_outbox WHERE run_id = ?', [runId])).count, 2);
        await assert.rejects(recordAgentEventBatch([event('c'), event('bad', { value: 1n })]));
        const after = await replayAgentEventsForUser(runId, user);
        assert.equal(after.events.length, 2);
        assert.equal(after.cursor.eventSeq, Number(results[1].event_seq));
    } finally {
        await execute('DELETE FROM agent_runs WHERE id = ?', [runId]);
    }
});

test('大批事件使用固定数量的数据库往返并与并发单条写入保持连续序号', { skip: !process.env.DATABASE_URL }, async () => {
    const { transaction } = require('../server/db/client');
    const user = await queryOne('SELECT id FROM users ORDER BY id LIMIT 1');
    const runId = `event-bulk-${process.pid}-${Date.now()}`;
    await createRun(user.id, runId);
    let queries = 0;
    const transactionFn = callback => transaction(trx => callback(Object.fromEntries(
        ['query', 'queryOne', 'execute'].map(name => [name, (...args) => { queries += 1; return trx[name](...args); }])
    )));
    try {
        const batch = Array.from({ length: 128 }, (_, index) => ({ runId, userId: user.id, type: 'model.provider_event', eventKey: `event-${index}`, payload: { sequence: index } }));
        const [results] = await Promise.all([
            recordAgentEventBatch(batch, { transactionFn }),
            recordAgentEvent({ runId, userId: user.id, type: 'model.progress', eventKey: 'concurrent', payload: {} })
        ]);
        assert.equal(results.length, 128);
        assert.ok(queries <= 7, `批量数据库往返数为 ${queries}`);
        const replay = await replayAgentEventsForUser(runId, user, { limit: 200 });
        assert.equal(replay.events.length, 129);
        assert.deepEqual(replay.events.map(row => Number(row.event_seq)), Array.from({ length: 129 }, (_, index) => index + 1));
        assert.deepEqual(results.map(row => Number(row.event_seq)), Array.from({ length: 128 }, (_, index) => Number(results[0].event_seq) + index));
    } finally {
        await execute('DELETE FROM agent_runs WHERE id = ?', [runId]);
    }
});

test('清理已投递 outbox 后重复事件不会重新入队，待投递记录仍保留', { skip: !process.env.DATABASE_URL }, async () => {
    const user = await queryOne('SELECT id FROM users ORDER BY id LIMIT 1');
    const runId = `event-retire-${process.pid}-${Date.now()}`;
    await createRun(user.id, runId);
    try {
        const input = { runId, userId: user.id, type: 'model.requested', eventKey: 'retired', payload: {} };
        const event = await recordAgentEvent(input);
        const pending = await recordAgentEvent({ ...input, eventKey: 'pending' });
        await execute("UPDATE agent_event_outbox SET status = 'delivered', delivered_at = '2020-01-01' WHERE event_id = ?", [event.id]);
        assert.equal(await retireDeliveredAgentEvents(), 1);
        assert.equal(await queryOne('SELECT id FROM agent_event_outbox WHERE event_id = ?', [event.id]), null);
        assert.ok(await queryOne('SELECT id FROM agent_event_outbox WHERE event_id = ?', [pending.id]));
        const repeated = await recordAgentEvent(input);
        assert.equal(repeated.id, event.id);
        assert.equal(await queryOne('SELECT id FROM agent_event_outbox WHERE event_id = ?', [event.id]), null);
        assert.equal((await replayAgentEventsForUser(runId, user)).events.length, 2);
    } finally {
        await execute('DELETE FROM agent_runs WHERE id = ?', [runId]);
    }
});

test('Agent child resources inherit budget, enforce concurrency, and roll usage into parent', { skip: !process.env.DATABASE_URL }, async () => {
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
            error => error.code === 'AGENT_CHILD_CONCURRENCY_EXCEEDED' && error.status === 409
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
