const assert = require('node:assert/strict');
const test = require('node:test');
const { execute, queryOne } = require('../server/db/client');
const {
    MAX_ATTEMPTS,
    claimChannelDelivery,
    deliverChannelDelivery,
    dispatchChannelDeliveries,
    enqueueChannelDelivery
} = require('../server/services/agent-channel-adapters');
const {
    configureAgentGoals,
    recordAgentGoalRunOutcome,
    runAgentGoalNow
} = require('../server/services/agent-goals');

test('渠道投递以原子认领抵御并发重复，失败上限进入死信且过期认领可恢复', async () => {
    const user = await queryOne("SELECT id, username, nickname, unit, role FROM users WHERE username = 'admin'");
    assert.ok(user, '测试数据库应包含管理员');
    const suffix = `${process.pid}-${Date.now()}`;
    const bindingId = `channel-reliability-${suffix}`;
    let firstDeliveryId = null;
    let expiredDeliveryId = null;
    await execute(`
        INSERT INTO agent_channel_bindings (
            id, user_id, channel_type, channel_key, credential_ref, config, notification_policy, status, created_at, updated_at
        ) VALUES (?, ?, 'unsupported-test-channel', ?, '', '{}'::jsonb, '{}'::jsonb, 'active', NOW(), NOW())
    `, [bindingId, user.id, `reliability-${suffix}`]);

    try {
        const key = `delivery-${suffix}`;
        const [first, duplicate] = await Promise.all([
            enqueueChannelDelivery(user, { bindingId, idempotencyKey: key, eventType: 'test', subject: '可靠性', body: '需要投递' }),
            enqueueChannelDelivery(user, { bindingId, idempotencyKey: key, eventType: 'test', subject: '可靠性', body: '需要投递' })
        ]);
        firstDeliveryId = Number(first.id);
        assert.equal(Number(duplicate.id), firstDeliveryId, '同一绑定与幂等键只能生成一条投递记录');

        await execute(`
            UPDATE agent_channel_deliveries
            SET attempts = ?, status = 'queued', next_attempt_at = NOW() - INTERVAL '1 second'
            WHERE id = ?
        `, [MAX_ATTEMPTS - 1, firstDeliveryId]);
        let deadLetters = 0;
        const results = await Promise.all([
            deliverChannelDelivery(firstDeliveryId, { onDeadLetter: async () => { deadLetters += 1; } }),
            deliverChannelDelivery(firstDeliveryId, { onDeadLetter: async () => { deadLetters += 1; } })
        ]);
        assert.equal(results.filter(Boolean).length, 1, '并发 worker 中只有一个可获得投递租约');
        const dead = await queryOne('SELECT status, attempts, dead_lettered_at, claim_token FROM agent_channel_deliveries WHERE id = ?', [firstDeliveryId]);
        assert.equal(dead.status, 'dead_letter');
        assert.equal(Number(dead.attempts), MAX_ATTEMPTS);
        assert.ok(dead.dead_lettered_at);
        assert.equal(dead.claim_token, null);
        assert.equal(deadLetters, 1, '死信回调只能触发一次');

        const expired = await enqueueChannelDelivery(user, {
            bindingId,
            idempotencyKey: `expired-${suffix}`,
            eventType: 'test',
            subject: '过期租约',
            body: '重新认领'
        });
        expiredDeliveryId = Number(expired.id);
        assert.ok(await claimChannelDelivery(expiredDeliveryId, `expired-claim-${suffix}`));
        await execute("UPDATE agent_channel_deliveries SET claim_expires_at = NOW() - INTERVAL '1 second' WHERE id = ?", [expiredDeliveryId]);
        await dispatchChannelDeliveries(1);
        const reclaimed = await queryOne('SELECT status, attempts, claim_token FROM agent_channel_deliveries WHERE id = ?', [expiredDeliveryId]);
        assert.equal(reclaimed.status, 'queued', '崩溃遗留的 delivering 状态必须重新进入队列');
        assert.equal(Number(reclaimed.attempts), 1);
        assert.equal(reclaimed.claim_token, null);
    } finally {
        if (firstDeliveryId || expiredDeliveryId) await execute('DELETE FROM agent_channel_deliveries WHERE binding_id = ?', [bindingId]);
        await execute('DELETE FROM agent_channel_bindings WHERE id = ?', [bindingId]);
    }
});

test('持续目标会阻止冷却窗口内重复运行，并在失败阈值后熔断暂停', async () => {
    const user = await queryOne("SELECT id, username, nickname, unit, role FROM users WHERE username = 'admin'");
    assert.ok(user, '测试数据库应包含管理员');
    const suffix = `${process.pid}-${Date.now()}`;
    const goalId = `goal-reliability-${suffix}`;
    const runId = `goal-reliability-run-${suffix}`;
    configureAgentGoals({ createAgentRun: async () => ({ id: `unexpected-${suffix}` }) });
    await execute(`
        INSERT INTO agent_runs (id, user_id, title, goal, status, metadata, created_at, updated_at)
        VALUES (?, ?, '目标可靠性运行', '验证冷却和熔断', 'error', ?::jsonb, NOW(), NOW())
    `, [runId, user.id, JSON.stringify({ goalId })]);
    await execute(`
        INSERT INTO agent_goals (
            id, user_id, title, goal, priority, status, trigger_spec, authorization_spec, budget_spec,
            cooldown_seconds, max_failures, last_run_id, next_run_at, failure_count, created_at, updated_at
        ) VALUES (?, ?, '可靠性目标', '验证持续目标冷却与熔断', 0, 'active', ?::jsonb, '{}'::jsonb, '{}'::jsonb,
                  3600, 1, ?, NOW(), 0, NOW(), NOW())
    `, [goalId, user.id, JSON.stringify({ type: 'timer', frequency: 'daily', timeOfDay: '09:00', dayOfWeek: 1, intervalMinutes: 60, cronExpression: '' }), runId]);

    try {
        const goal = await queryOne('SELECT * FROM agent_goals WHERE id = ?', [goalId]);
        await assert.rejects(
            () => runAgentGoalNow(goal, user),
            error => error?.status === 429 && /冷却/.test(error.message)
        );
        const outcome = await recordAgentGoalRunOutcome(runId, 'failure');
        assert.equal(outcome.paused, true);
        const paused = await queryOne('SELECT status, failure_count, next_run_at FROM agent_goals WHERE id = ?', [goalId]);
        assert.equal(paused.status, 'paused');
        assert.equal(Number(paused.failure_count), 1);
        assert.equal(paused.next_run_at, null);
    } finally {
        await execute('DELETE FROM agent_runs WHERE id = ?', [runId]);
        await execute('DELETE FROM agent_goals WHERE id = ?', [goalId]);
    }
});
