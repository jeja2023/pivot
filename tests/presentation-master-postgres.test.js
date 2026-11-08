'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { queryOne, execute } = require('../server/db/client');
const taskStore = require('../server/services/tool-tasks');
const repository = require('../server/repositories/presentation-master-tasks');

test('完整引擎真实租约防止重复执行，保留检查点与确认答复并隔离账号，取消后旧租约不能写回', { skip: !process.env.DATABASE_URL, timeout: 60000 }, async () => {
    const user = await queryOne('SELECT * FROM users ORDER BY id LIMIT 1');
    const other = { id: Number(user.id) + 99999 };
    const task = await taskStore.create({ user, toolName: repository.TOOL, inputRequest: { presentationId: 'ppt-protected' }, ttlMs: 600000 });
    try {
        const first = crypto.randomUUID(), second = crypto.randomUUID();
        const claims = await Promise.all([repository.claim(user, task.id, first), repository.claim(user, task.id, second)]);
        assert.equal(claims.filter(Boolean).length, 1);
        const winner = claims[0] ? first : second, loser = claims[0] ? second : first;
        const state = { request: { presentationId: 'ppt-protected' }, steps: 2, usedTokens: 123, prepared: true };
        assert.ok(await repository.save(user, task.id, winner, state, { phase: 'authoring' }));
        assert.equal(await repository.save(user, task.id, loser, state, {}), null);
        assert.equal(await repository.read(other, task.id), null);
        assert.equal(await repository.claim(other, task.id, crypto.randomUUID()), null);
        assert.equal((await repository.read(user, task.id)).result_json.state.usedTokens, 123);
        await taskStore.requestInput(task.id, user, { question: '旧租约问题' }, { expectedLease: loser });
        assert.equal((await repository.read(user, task.id)).status, 'working');
        await taskStore.complete(task.id, user, { stale: true }, { expectedLease: loser, failed: true });
        assert.equal((await repository.read(user, task.id)).status, 'working', '旧执行不能将新租约任务标为失败');
        await taskStore.requestInput(task.id, user, { question: '确认方案？' });
        assert.equal(await repository.claim(user, task.id, crypto.randomUUID()), null);
        const answered = { ...state, response: '确认，保留金额。' };
        const accepted = await Promise.all([repository.acceptResponse(user, task.id, answered), repository.acceptResponse(user, task.id, answered)]);
        assert.equal(accepted.filter(Boolean).length, 1);
        assert.equal((await repository.latest(user, 'ppt-protected')).id, task.id);
        assert.equal((await repository.read(user, task.id)).result_json.state.response, answered.response);
        const resumedLease = crypto.randomUUID(); assert.ok(await repository.claim(user, task.id, resumedLease));
        assert.equal(await repository.resume(user, task.id, answered), null, '有效租约不能被继续请求接管');
        await taskStore.requestCancel(task.id, user);
        assert.equal(await repository.save(user, task.id, resumedLease, state, {}), null);
        assert.equal(await repository.resume(user, task.id, answered), null, '取消的任务不能被自动恢复');
    } finally { await execute('DELETE FROM tool_tasks WHERE id=? AND user_id=?', [task.id, user.id]); }
});

test('完整引擎接纳与任务创建在同一事务中，多个请求不能突破单用户名额', { skip: !process.env.DATABASE_URL, timeout: 60000 }, async () => {
    const user = await queryOne('SELECT * FROM users ORDER BY id LIMIT 1');
    const created = [];
    const create = () => repository.admit(user, client => taskStore.createToolTaskStore({ queryOne: client.queryOne, execute: client.execute }).create({ user, toolName: repository.TOOL, ttlMs: 600000 }));
    try {
        const results = await Promise.allSettled([create(), create()]);
        for (const result of results) if (result.status === 'fulfilled') created.push(result.value.id);
        assert.equal(created.length, 1); assert.equal(results.filter(item => item.status === 'rejected' && item.reason.code === 'PPT_MASTER_CAPACITY_BUSY').length, 1);
        await taskStore.requestCancel(created[0], user);
        const next = await create(); created.push(next.id); assert.notEqual(next.id, created[0]);
    } finally { for (const id of created) await execute('DELETE FROM tool_tasks WHERE id=? AND user_id=?', [id, user.id]); }
});
