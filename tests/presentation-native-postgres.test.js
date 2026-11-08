'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { queryOne, execute } = require('../server/db/client');
const repository = require('../server/repositories/presentation-native');
const taskStore = require('../server/services/tool-tasks');

test('原生文稿保存受账号、版本及活跃租约共同约束，取消后不能提交，重试不生成重复版本', { skip: !process.env.DATABASE_URL }, async () => {
    const user = await queryOne('SELECT * FROM users ORDER BY id LIMIT 1'), tenantId = 1, documentId = 'native_' + crypto.randomUUID().replace(/-/g, '');
    const jobs = [];
    const create = async request => { const task = await taskStore.create({ user, toolName: repository.TOOL, inputRequest: request }); jobs.push(task.id); const lease = crypto.randomUUID(); assert.ok(await repository.claim(user, task.id, lease)); return { task, lease }; };
    const output = { packageRef: 'artifact-cas://' + 'a'.repeat(64), packageDigest: 'b'.repeat(64), manifest: { slides: [] } };
    const object = await require('../server/services/agent-artifact-cas').putBuffer({ buffer: Buffer.from('原稿引用事务测试-' + documentId), mimeType: 'application/octet-stream', tenantId, ownerUserId: user.id, kind: 'ppt_native_test' });
    output.objectIds = [object.objectId];
    try {
        const request = { kind: 'import', documentId, title: '原稿版本验收' }, first = await create(request);
        await assert.rejects(() => repository.commit(user, tenantId, first.task.id, 'wrong', request, output), /租约/);
        await assert.rejects(() => repository.commit(user, tenantId, first.task.id, first.lease, request, { ...output, objectIds: [object.objectId, 'missing-object'] }), /失效/);
        await assert.rejects(() => repository.withExecution(user, first.task.id, first.lease, async executor => { await repository.commit(user, tenantId, first.task.id, first.lease, request, output, executor); throw new Error('模拟交付中断'); }), /模拟交付中断/);
        assert.equal(await repository.read(user, tenantId, documentId), null);
        assert.equal(Number((await queryOne('SELECT ref_count FROM agent_artifact_objects WHERE id=?', [object.objectId])).ref_count), 0, 'CAS引用失败须连同原稿版本回滚');
        const committed = await repository.commit(user, tenantId, first.task.id, first.lease, request, output); assert.equal(committed.version, 1); assert.equal(committed.created, true);
        assert.equal((await repository.commit(user, tenantId, first.task.id, first.lease, request, output)).created, false);
        assert.equal(Number((await queryOne('SELECT ref_count FROM agent_artifact_objects WHERE id=?', [object.objectId])).ref_count), 1, '幂等提交不能重复增加引用');
        assert.equal(await repository.read({ id: Number(user.id) + 99999 }, tenantId, documentId), null);
        await taskStore.complete(first.task.id, user, {}, { expectedLease: first.lease });
        const edit = { kind: 'patch', documentId, baseVersion: 1 }, second = await create(edit);
        assert.equal((await repository.commit(user, tenantId, second.task.id, second.lease, edit, output)).version, 2);
        await taskStore.complete(second.task.id, user, {}, { expectedLease: second.lease });
        const stale = await create(edit); await assert.rejects(() => repository.commit(user, tenantId, stale.task.id, stale.lease, edit, output), /新版本/);
        await taskStore.requestCancel(stale.task.id, user);
        await assert.rejects(() => repository.commit(user, tenantId, stale.task.id, stale.lease, { ...edit, baseVersion: 2 }, output), /停止|租约/);
        assert.equal((await repository.versions(user, tenantId, documentId)).length, 2);
        assert.equal(await repository.resume(user, stale.task.id), null);
        await repository.remove(user, tenantId, documentId); assert.equal(await repository.read(user, tenantId, documentId), null);
    } finally {
        await execute('DELETE FROM presentation_native_documents WHERE id=?', [documentId]);
        for (const id of jobs) await execute('DELETE FROM tool_tasks WHERE id=?', [id]);
    }
});

test('原稿与视频任务接纳在同一事务中限制并发，旧租约不能写入检查点', { skip: !process.env.DATABASE_URL }, async () => {
    const user = await queryOne('SELECT * FROM users ORDER BY id LIMIT 1'), created = [];
    const create = () => repository.admit(user, client => taskStore.createToolTaskStore({ queryOne: client.queryOne, execute: client.execute }).create({ user, toolName: repository.TOOL }));
    try {
        const results = await Promise.allSettled([create(), create()]);
        for (const result of results) if (result.status === 'fulfilled') created.push(result.value.id);
        assert.equal(created.length, 1); assert.equal(results.filter(result => result.status === 'rejected').length, 1);
        const lease = crypto.randomUUID(); assert.ok(await repository.claim(user, created[0], lease));
        assert.equal(await repository.checkpoint(user, created[0], 'old', {}, {}), null);
        assert.ok(await repository.checkpoint(user, created[0], lease, { clips: [{ duration: 2 }] }, { message: '已编码一页' }));
        assert.equal((await repository.readJob(user, created[0])).result_json.state.clips.length, 1);
        await taskStore.requestCancel(created[0], user);
    } finally { for (const id of created) await execute('DELETE FROM tool_tasks WHERE id=?', [id]); }
});
