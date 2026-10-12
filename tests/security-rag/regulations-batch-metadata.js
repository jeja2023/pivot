const { assert, db, test, vm } = require('../security-helpers');
const fs = require('node:fs');
const path = require('node:path');
const { updateRegulationDocument, updateRegulationDocuments, deleteRegulationDocument, listRegulationDocumentChangeLogs, revertRegulationDocumentBatch } = require('../../server/services/regulations');
const { createDocument, createRegulationBatchServer } = require('../helpers/regulations-server');

test('法规批量修改仅更新指定字段、保留各文档其它信息并记录操作者', async () => {
    const first = createDocument('批量修改法规甲');
    const second = createDocument('批量修改法规乙');
    await updateRegulationDocument({ documentId: first, userId: 1, patch: { category: '法律', issuingBody: '发布机构甲', jurisdiction: '全国', summary: '摘要甲' } });
    await updateRegulationDocument({ documentId: second, userId: 1, patch: { category: '部门规章', issuingBody: '发布机构乙', jurisdiction: '北京市', summary: '摘要乙', status: 'archived' } });
    const result = await updateRegulationDocuments({ documentIds: [first, String(first), second], userId: 1, patch: { category: '  行政法规  ', issuingBody: '国务院' } });
    assert.equal(result.total, 2);
    assert.equal(result.updated.length, 2);
    assert.deepEqual(result.fields, ['分类', '发布机构']);
    const rows = [first, second].map(id => db.prepare('SELECT * FROM regulation_documents WHERE id = ?').get(id));
    assert.deepEqual(rows.map(row => row.category), ['行政法规', '行政法规']);
    assert.deepEqual(rows.map(row => row.issuing_body), ['国务院', '国务院']);
    assert.deepEqual(rows.map(row => row.jurisdiction), ['全国', '北京市']);
    assert.deepEqual(rows.map(row => row.status), ['active', 'archived']);
    assert.deepEqual(rows.map(row => row.summary), ['摘要甲', '摘要乙']);
    assert.deepEqual(rows.map(row => row.title), ['批量修改法规甲', '批量修改法规乙']);
    assert.ok(rows.every(row => Number(row.updated_by_user) === 1));
    assert.ok(result.batchId);
    const changeLogs = await listRegulationDocumentChangeLogs({ batchId: result.batchId });
    assert.equal(changeLogs.length, 2);
    assert.equal(changeLogs[0].before.category, '法律');
    assert.equal(changeLogs[0].after.category, '行政法规');
    const cleared = await updateRegulationDocuments({ documentIds: [first, second], userId: 1, patch: { category: '', issuingBody: '', jurisdiction: '上海市', status: 'active' } });
    assert.ok(cleared.updated.every(doc => doc.category === '' && doc.issuing_body === '' && doc.jurisdiction === '上海市' && doc.status === 'active'));
});

test('法规批量修改可撤销，但不会覆盖此后被更新过的文档', async () => {
    const first = createDocument('批量撤销法规甲');
    const second = createDocument('批量撤销法规乙');
    await updateRegulationDocument({ documentId: first, userId: 1, patch: { category: '法律' } });
    await updateRegulationDocument({ documentId: second, userId: 1, patch: { category: '部门规章' } });
    const batch = await updateRegulationDocuments({ documentIds: [first, second], userId: 1, patch: { category: '行政法规' } });
    await updateRegulationDocument({ documentId: second, userId: 2, patch: { category: '地方性法规' } });
    const result = await revertRegulationDocumentBatch({ batchId: batch.batchId, userId: 1 });
    assert.equal(result.reverted.length, 1);
    assert.equal(Number(result.reverted[0].id), first);
    assert.equal(result.failed.length, 1);
    assert.match(result.failed[0].message, /已发生变化/);
    assert.equal(db.prepare('SELECT category FROM regulation_documents WHERE id = ?').get(first).category, '法律');
    assert.equal(db.prepare('SELECT category FROM regulation_documents WHERE id = ?').get(second).category, '地方性法规');
});

test('法规批量修改先校验全部字段和文档 ID，非法请求不修改任何文档', async () => {
    const id = createDocument('批量修改参数校验法规');
    for (const patch of [undefined, null, [], '错误类型', {}, { category: '法律', title: '错误标题' }, { summary: '' }, { versionLabel: '' }, { deleted_at: '' }, { category: null }, { category: true }, { category: {} }, { issuingBody: 1 }, { jurisdiction: '法'.repeat(121) }, { status: 'deleted' }, JSON.parse('{"__proto__":"错误字段"}')]) {
        await assert.rejects(updateRegulationDocuments({ documentIds: [id], userId: 1, patch }), { status: 400 });
        assert.equal(db.prepare('SELECT category FROM regulation_documents WHERE id = ?').get(id).category, '');
    }
    for (const ids of [[], Array(2001).fill(id), [id, '2abc'], [id, false]]) {
        await assert.rejects(updateRegulationDocuments({ documentIds: ids, userId: 1, patch: { category: '法律' } }), { status: 400 });
    }
    assert.equal(db.prepare('SELECT category FROM regulation_documents WHERE id = ?').get(id).category, '');
    assert.equal((await updateRegulationDocuments({ documentIds: Array(300).fill(id), userId: 1, patch: { category: '法律' } })).total, 1);
});

test('法规批量修改会报告已删除和不存在的文档，并继续处理其它文档', async () => {
    const valid = createDocument('批量修改有效法规');
    const deleted = createDocument('批量修改已删除法规');
    await deleteRegulationDocument({ documentId: deleted, userId: 1 });
    const result = await updateRegulationDocuments({ documentIds: [valid, deleted, 2147483647], userId: 1, patch: { category: '法律' } });
    assert.equal(result.updated.length, 1);
    assert.equal(Number(result.updated[0].id), valid);
    assert.deepEqual(result.failed.map(item => item.documentId), [deleted, 2147483647]);
    assert.equal(db.prepare('SELECT category FROM regulation_documents WHERE id = ?').get(deleted).category, '');
});

test('法规批量修改单项异常不阻断其余文档，失败信息不暴露内部错误', async () => {
    const attempted = [];
    const sandbox = {
        module: { exports: {} },
        require: request => {
            if (request.includes('mutations')) return { updateRegulationDocument: async ({ documentId, patch }) => {
                attempted.push(documentId);
                if (documentId === 2) throw new Error('数据库内部信息');
                return { id: documentId, category: patch.category || '', issuing_body: patch.issuingBody || '', jurisdiction: patch.jurisdiction || '', status: patch.status || 'active' };
            } };
            if (request.includes('catalog')) return { getRegulationDocumentById: async id => ({ id, category: '', issuing_body: '', jurisdiction: '', status: 'active', deleted_at: null }) };
            if (request.includes('db/client')) return { execute: async () => 1, query: async () => [] };
            if (request.includes('time')) return { getBeijingTimestamp: () => '2026-10-12 20:00:00' };
            return {};
        }
    };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../server/services/regulations/document-batch.js'), 'utf8'), sandbox);
    const result = await sandbox.module.exports.updateRegulationDocuments({ documentIds: [1, 2, 3], userId: 1, patch: { category: '法律' } });
    assert.deepEqual(attempted, [1, 2, 3]);
    assert.equal(result.updated.length, 2);
    assert.equal(result.failed[0].message, '修改失败，请稍后重试');
});

test('法规批量修改 HTTP 接口沿用管理员权限，校验参数并记录审计', async () => {
    const id = createDocument('批量修改权限法规');
    const { request, audit, close } = await createRegulationBatchServer();
    const send = (username, patch, ids = [id]) => request(username, ids, { endpoint: 'batch-update', patch });
    try {
        assert.equal((await send('', { category: '法律' })).status, 401);
        assert.equal((await send('ordinary', { category: '法律' })).status, 403);
        assert.equal(db.prepare('SELECT category FROM regulation_documents WHERE id = ?').get(id).category, '');
        assert.equal((await send('admin', { category: '法律', title: '错误标题' })).status, 400);
        assert.equal((await send('admin', {})).status, 400);
        assert.equal(audit.length, 0);
        const managerResponse = await send('manager', { category: '法律' }, [id, 2147483647]);
        assert.equal(managerResponse.status, 200);
        const result = await managerResponse.json();
        assert.equal(result.updated.length, 1);
        assert.equal(result.failed.length, 1);
        assert.equal(audit[0].action, '法规查询批量修改信息');
        assert.match(audit[0].detail, /字段：分类，成功 1 \/ 共 2，失败 1/);
        assert.equal((await send('admin', { issuingBody: '国务院', jurisdiction: '全国' })).status, 200);
        const doc = db.prepare('SELECT * FROM regulation_documents WHERE id = ?').get(id);
        assert.equal(doc.category, '法律');
        assert.equal(doc.issuing_body, '国务院');
        assert.equal(doc.jurisdiction, '全国');
    } finally {
        await close();
    }
});
