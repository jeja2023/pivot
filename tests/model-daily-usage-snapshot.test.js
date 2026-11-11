'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { queryOne, execute } = require('../server/db/client');
const models = require('../server/services/models');
const { flushAllWrites } = require('../server/services/db-write-queue');

test('真实用量计数在排队、刷新竞争和落库后保持一致，不漏计或双计', { skip: !process.env.DATABASE_URL }, async () => {
    const user = await queryOne("INSERT INTO users(username,password_hash,status,role) VALUES (?,'hash','active','user') RETURNING id", [`usage_snapshot_${crypto.randomUUID()}`]);
    let model;
    try {
        model = await queryOne("INSERT INTO models(user_id,name,url,model_name,status) VALUES (?,'用量快照回归','https://synthetic.invalid/v1','synthetic','active') RETURNING id", [user.id]);
        models.recordModelTokenUsage(user.id, model.id, 17, 'synthetic_test', 10, 7);
        assert.equal(await models.getModelDailyUsageAsync(user.id, model.id), 17);
        const [, ...snapshots] = await Promise.all([flushAllWrites(), ...Array.from({ length: 10 }, () => models.getModelDailyUsageAsync(user.id, model.id))]);
        assert.deepEqual(snapshots, Array(10).fill(17));
        assert.equal(await models.getModelDailyUsageAsync(user.id, model.id), 17);
    } finally {
        await flushAllWrites();
        if (model) { await execute('DELETE FROM model_usage_events WHERE user_id=? AND model_id=?', [user.id, model.id]); await execute('DELETE FROM models WHERE id=?', [model.id]); }
        await execute('DELETE FROM users WHERE id=?', [user.id]);
    }
});
