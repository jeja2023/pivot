const { assert, db, test, vm } = require('../security-helpers');
const fs = require('node:fs');
const path = require('node:path');
const { deleteRegulationDocuments, listRegulationDocuments } = require('../../server/services/regulations');
const { createDocument, createRegulationBatchServer } = require('../helpers/regulations-server');

test('法规批量删除校验整个输入列表，非法请求不删除任何文档', async () => {
    const id = createDocument('批量参数校验法规');
    for (const ids of [undefined, [], '1', Array(2001).fill(id), [id, '2abc'], [id, 0], [id, -1], [id, 1.5], [id, true], [id, {}], [id, [2]], [id, Number.MAX_SAFE_INTEGER + 1]]) {
        await assert.rejects(deleteRegulationDocuments({ documentIds: ids, userId: 1 }), { status: 400 });
        assert.equal(db.prepare('SELECT deleted_at FROM regulation_documents WHERE id = ?').get(id).deleted_at, null);
    }
});

test('法规批量删除去重、记录操作者并返回不存在或已删除的文档', async () => {
    const first = createDocument('批量删除法规甲');
    const second = createDocument('批量删除法规乙');
    const result = await deleteRegulationDocuments({ documentIds: [first, String(first), second, 2147483647], userId: 1 });
    assert.equal(result.total, 3);
    assert.deepEqual(result.deleted, [first, second]);
    assert.deepEqual(result.failed, [{ documentId: 2147483647, message: '法规文档不存在或已删除，请刷新列表' }]);
    for (const id of [first, second]) {
        const row = db.prepare('SELECT status, deleted_at, deleted_by_user FROM regulation_documents WHERE id = ?').get(id);
        assert.equal(row.status, 'archived');
        assert.ok(row.deleted_at);
        assert.equal(Number(row.deleted_by_user), 1);
    }
    const listed = await listRegulationDocuments({ query: '批量删除法规' });
    assert.ok(listed.data.every(doc => ![first, second].includes(Number(doc.id))));
    const repeated = await deleteRegulationDocuments({ documentIds: [first], userId: 1 });
    assert.equal(repeated.deleted.length, 0);
    assert.equal(repeated.failed.length, 1);
    const boundary = await deleteRegulationDocuments({ documentIds: Array(300).fill(first), userId: 1 });
    assert.equal(boundary.total, 1);
});

test('法规批量删除单项异常后继续处理，失败信息不暴露内部错误', async () => {
    const servicePath = path.join(__dirname, '../../server/services/regulations/document-batch.js');
    const attempted = [];
    const sandbox = {
        module: { exports: {} },
        require: () => ({ deleteRegulationDocument: async ({ documentId }) => {
            attempted.push(documentId);
            if (documentId === 2) throw new Error('数据库连接串和内部路径');
            return true;
        } })
    };
    vm.runInNewContext(fs.readFileSync(servicePath, 'utf8'), sandbox);
    const result = await sandbox.module.exports.deleteRegulationDocuments({ documentIds: [1, 2, 3], userId: 1 });
    assert.deepEqual(attempted, [1, 2, 3]);
    assert.deepEqual(Array.from(result.deleted), [1, 3]);
    assert.equal(result.failed[0].message, '删除失败，请稍后重试');
});

test('法规批量删除 HTTP 接口仅允许 admin，返回参数错误、删除结果和审计记录', async () => {
    const id = createDocument('批量权限校验法规');
    const { request, audit, close } = await createRegulationBatchServer();
    try {
        for (const [username, status] of [['', 401], ['ordinary', 403], ['manager', 403]]) {
            assert.equal((await request(username, [id])).status, status);
            assert.equal(db.prepare('SELECT deleted_at FROM regulation_documents WHERE id = ?').get(id).deleted_at, null);
        }
        assert.equal((await request('admin', [id, '错误ID'])).status, 400);
        assert.equal(audit.length, 0);
        const response = await request('admin', [id, 2147483647]);
        assert.equal(response.status, 200);
        const result = await response.json();
        assert.deepEqual(result.deleted, [id]);
        assert.equal(result.failed.length, 1);
        assert.equal(audit[0].action, '法规查询批量删除');
        assert.match(audit[0].detail, /成功 1 \/ 共 2，失败 1/);
    } finally {
        await close();
    }
});
