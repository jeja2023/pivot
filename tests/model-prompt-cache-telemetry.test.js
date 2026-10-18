'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { execute, queryOne } = require('../server/db/client');
const { getPromptCacheTelemetry } = require('../server/services/models');

test('Prompt 缓存遥测只汇总当前用户的提供方已观测字段', async () => {
    const suffix = `${process.pid}-${Date.now()}`;
    const username = `cache-telemetry-${suffix}`;
    let user = null;
    try {
        user = await queryOne(`
            INSERT INTO users (username, password_hash, nickname, role, status, created_at)
            VALUES (?, 'hash', '缓存遥测测试', 'user', 'active', NOW()) RETURNING *
        `, [username]);
        await execute(`
            INSERT INTO model_usage_events (
                user_id, model_id, source, token_count, input_tokens, output_tokens,
                cache_read_tokens, cache_creation_tokens, cache_observed, created_at
            ) VALUES
                (?, 990001, 'agent_planner', 100, 80, 20, 60, 10, TRUE, NOW()),
                (?, 990001, 'agent_planner', 80, 60, 20, 0, 0, FALSE, NOW())
        `, [user.id, user.id]);
        const telemetry = await getPromptCacheTelemetry(user, { days: 1 });
        assert.equal(telemetry.scope, 'user');
        assert.equal(telemetry.totalCalls, 2);
        assert.equal(telemetry.observedCalls, 1);
        assert.equal(telemetry.observationRate, 0.5);
        assert.equal(telemetry.cacheReadTokens, 60);
        assert.equal(telemetry.cacheCreationTokens, 10);
        assert.equal(telemetry.byModel[0].source, 'agent_planner');
    } finally {
        if (user?.id) {
            await execute('DELETE FROM model_usage_events WHERE user_id = ?', [user.id]);
            await execute('DELETE FROM users WHERE id = ?', [user.id]);
        }
    }
});
