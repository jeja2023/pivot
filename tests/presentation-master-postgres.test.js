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

test('过期检查点可续跑，待确认任务必须先提交实际答复，取消任务不能复活', { skip: !process.env.DATABASE_URL }, async () => {
    const user = await queryOne('SELECT * FROM users ORDER BY id LIMIT 1');
    const task = await taskStore.create({ user, toolName: repository.TOOL, ttlMs: 600000 });
    const base = { request: { presentationId: '', tokenBudget: 1000000, maxSteps: 80 }, steps: 3, usedTokens: 321 };
    try {
        await execute("UPDATE tool_tasks SET status='expired',result_json=?::jsonb WHERE id=?", [JSON.stringify({ state: base }), task.id]);
        assert.ok(await repository.resume(user, task.id, base));
        assert.equal((await repository.read(user, task.id)).result_json.state.usedTokens, 321);
        const pending = { ...base, pendingKind: 'confirmation' };
        await execute("UPDATE tool_tasks SET status='expired',result_json=?::jsonb WHERE id=?", [JSON.stringify({ state: pending }), task.id]);
        assert.equal(await repository.resume(user, task.id, pending), null);
        assert.ok(await repository.acceptResponse(user, task.id, { ...pending, response: '确认保留金额' }));
        assert.equal((await repository.read(user, task.id)).result_json.state.response, '确认保留金额');
        await execute("UPDATE tool_tasks SET status='expired' WHERE id=?", [task.id]);
        assert.ok(await repository.resume(user, task.id, { ...pending, response: '确认保留金额' }));
        await taskStore.requestCancel(task.id, user);
        assert.equal(await repository.resume(user, task.id, base), null);
        assert.equal(await repository.acceptResponse(user, task.id, pending), null);
    } finally { await execute('DELETE FROM tool_tasks WHERE id=? AND user_id=?', [task.id, user.id]); }
});

test('压缩归档随租约检查点持久化，隔离账号不能读取，恢复后可分页取回原观察', { skip: !process.env.DATABASE_URL }, async () => {
    const user = await queryOne('SELECT * FROM users ORDER BY id LIMIT 1');
    const task = await taskStore.create({ user, toolName: repository.TOOL, ttlMs: 600000 });
    const state = { request: { presentationId: '', tokenBudget: 1000000, maxSteps: 80 }, messages: [{ role: 'system', content: '完整指引' }] };
    for (let index = 0; index < 12; index++) {
        state.messages.push({ role: 'assistant', content: JSON.stringify({ actions: [{ action: 'read', path: `inputs/${index}.md` }] }) });
        state.messages.push({ role: 'user', content: JSON.stringify([{ action: 'read', result: { path: `inputs/${index}.md`, text: '中文资料'.repeat(18000) } }]) });
    }
    const original = state.messages[2].content, lease = crypto.randomUUID();
    try {
        assert.equal(await require('../server/services/presentations/master/history').archiveOlderObservations(state), true);
        assert.ok(await repository.claim(user, task.id, lease));
        assert.ok(await repository.save(user, task.id, lease, state, { phase: 'authoring' }));
        assert.equal(await repository.read({ id: Number(user.id) + 99999 }, task.id), null);
        const restored = (await repository.read(user, task.id)).result_json.state;
        let text = '', offset = 0;
        do {
            const chunk = await require('../server/services/presentations/master/history').readHistory(restored, { archive: 0, index: 2, offset });
            text += chunk.text; offset = chunk.nextOffset;
        } while (offset !== null);
        assert.equal(text, original);
    } finally { await execute('DELETE FROM tool_tasks WHERE id=? AND user_id=?', [task.id, user.id]); }
});
