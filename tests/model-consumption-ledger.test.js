'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { queryOne, execute, transaction } = require('../server/db/client');
const { getModelDailyUsageAsync } = require('../server/services/models');
const { getBeijingTimestamp } = require('../server/time');

test('日消费在软删除、物理清理及幂等重放后保持，失败事务不产生消费', async () => {
    assert.match(process.env.PG_TEST_SCHEMA || '', /^pivot_test_/);
    const suffix = crypto.randomUUID(), session = `quota_${suffix}`;
    const user = await queryOne("INSERT INTO users(username,password_hash,role) VALUES (?,'fixture','user') RETURNING id", [`quota_${suffix}`]);
    const model = await queryOne("INSERT INTO models(user_id,name,model_name,url) VALUES (?,'额度回归','fixture','http://localhost') RETURNING id", [user.id]);
    try {
        await execute('INSERT INTO sessions(id,user_id,title) VALUES (?,?,?)', [session,user.id,'额度回归']);
        const message = await queryOne("INSERT INTO messages(session_id,user_id,role,content,model_id,token_count) VALUES (?,?,'assistant','测试',?,950) RETURNING id", [session,user.id,model.id]);
        assert.equal(await getModelDailyUsageAsync(user.id,model.id),950);
        await execute('UPDATE messages SET deleted_at=NOW() WHERE id=?',[message.id]);
        assert.equal(await getModelDailyUsageAsync(user.id,model.id),950);
        await execute('DELETE FROM messages WHERE id=?',[message.id]);
        assert.equal(await getModelDailyUsageAsync(user.id,model.id),950);
        await assert.rejects(transaction(async trx => {
            await trx.execute('INSERT INTO model_usage_events(user_id,model_id,token_count) VALUES (?,?,100)',[user.id,model.id]);
            throw new Error('模拟回滚');
        }), /模拟回滚/);
        assert.equal(await getModelDailyUsageAsync(user.id,model.id),950);
        for(let i=0;i<2;i++) await execute('INSERT INTO model_usage_events(user_id,model_id,token_count,delivery_id) VALUES (?,?,50,?) ON CONFLICT(delivery_id) DO NOTHING',[user.id,model.id,suffix]);
        assert.equal(await getModelDailyUsageAsync(user.id,model.id),1000);
        const migration=require('../server/db/migrations/model-consumption-ledger')[0];
        await transaction(trx=>migration.upPg({query:trx.query}));
        assert.equal(await getModelDailyUsageAsync(user.id,model.id),1000,'重跑迁移不能重复回填消费');
        const day=getBeijingTimestamp().slice(0,10);
        await execute("INSERT INTO model_usage_events(user_id,model_id,token_count,created_at) VALUES (?,?,400,?::timestamptz - interval '1 second')",[user.id,model.id,day+'T00:00:00+08:00']);
        assert.equal(await getModelDailyUsageAsync(user.id,model.id),1000);
    } finally {
        await execute('DELETE FROM messages WHERE user_id=?',[user.id]);
        await execute('DELETE FROM sessions WHERE user_id=?',[user.id]);
        await execute('DELETE FROM model_usage_events WHERE user_id=?',[user.id]);
        await execute('DELETE FROM model_daily_consumption WHERE user_id=?',[user.id]);
        await execute('DELETE FROM models WHERE id=?',[model.id]);
        await execute('DELETE FROM users WHERE id=?',[user.id]);
    }
});
