const { assert, db, test, vm } = require('../security-helpers');
const fs = require('node:fs');
const path = require('node:path');
const {
    updateRegulationDocument,
    updateRegulationDocuments,
    deleteRegulationDocument,
    listRegulationDocumentChangeLogs,
    reindexRegulationDocuments,
    rebuildRegulationDocumentLocations,
    revertRegulationDocumentBatch
} = require('../../server/services/regulations');
const { createDocument, createRegulationBatchServer } = require('../helpers/regulations-server');

function attachCurrentVersion(documentId, { indexStatus = 'lexical_ready', extractedText = '第一条 批量治理测试正文。' } = {}) {
    const now = new Date().toISOString();
    const versionId = Number(db.prepare(`
        INSERT INTO regulation_versions (
            document_id, version_label, source_name, source_path, source_size, source_format,
            extracted_text, effect_status, review_status, parse_status, index_status, uploaded_by_user, created_at, updated_at
        ) VALUES (?, 'v1', 'batch.txt', 'uploads/regulations/batch.txt', 1, 'txt', ?, 'unverified', 'pending', 'ready', ?, 1, ?, ?)
    `).run(documentId, extractedText, indexStatus, now, now).lastInsertRowid);
    const articleId = Number(db.prepare(`
        INSERT INTO regulation_articles (document_id, version_id, sort_order, article_label, content, status, created_at)
        VALUES (?, ?, 1, '第一条', '第一条 批量治理测试正文。', 'active', ?)
    `).run(documentId, versionId, now).lastInsertRowid);
    db.prepare('UPDATE regulation_documents SET current_version_id = ?, version_count = 1, article_count = 1 WHERE id = ?').run(versionId, documentId);
    return { versionId, articleId };
}

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

test('法规批量修改支持元数据审核与维护人分派，并保留可撤销审计', async () => {
    const first = createDocument('批量治理法规甲');
    const second = createDocument('批量治理法规乙');
    const batch = await updateRegulationDocuments({
        documentIds: [first, second],
        userId: 1,
        patch: {
            legalLevel: '法律',
            officialSourceUrl: 'https://authority.example/regulations',
            maintainerUserId: '1',
            metadataReviewStatus: 'approved'
        }
    });
    assert.equal(batch.updated.length, 2);
    assert.deepEqual(batch.fields, ['法规层级', '权威来源地址', '维护人', '元数据审核状态']);
    const rows = [first, second].map(id => db.prepare('SELECT * FROM regulation_documents WHERE id = ?').get(id));
    assert.ok(rows.every(row => row.legal_level === '法律' && row.official_source_url === 'https://authority.example/regulations'));
    assert.ok(rows.every(row => Number(row.maintainer_user_id) === 1 && row.metadata_review_status === 'approved'));
    const reverted = await revertRegulationDocumentBatch({ batchId: batch.batchId, userId: 1 });
    assert.equal(reverted.reverted.length, 2);
    const revertedRows = [first, second].map(id => db.prepare('SELECT * FROM regulation_documents WHERE id = ?').get(id));
    assert.ok(revertedRows.every(row => row.legal_level === '' && row.official_source_url === '' && row.maintainer_user_id == null && row.metadata_review_status === 'unreviewed'));
});

test('法规批量治理可更新当前版本，并对选中项重建索引和条文定位', async () => {
    const first = createDocument('批量版本治理法规甲');
    const second = createDocument('批量版本治理法规乙');
    const firstVersion = attachCurrentVersion(first);
    const secondVersion = attachCurrentVersion(second);
    const governance = await updateRegulationDocuments({
        documentIds: [first, second],
        userId: 1,
        patch: { effectStatus: 'effective', reviewStatus: 'approved' }
    });
    assert.equal(governance.updated.length, 2);
    assert.deepEqual(governance.fields, ['效力状态', '版本审核状态']);
    assert.ok([firstVersion.versionId, secondVersion.versionId].every(versionId => {
        const row = db.prepare('SELECT effect_status, review_status FROM regulation_versions WHERE id = ?').get(versionId);
        return row.effect_status === 'effective' && row.review_status === 'approved';
    }));
    const reindex = await reindexRegulationDocuments({ documentIds: [first, second] });
    assert.equal(reindex.queuedVersions, 2);
    assert.deepEqual(new Set(reindex.queuedDocumentIds), new Set([first, second]));
    assert.ok([firstVersion.versionId, secondVersion.versionId].every(versionId => db.prepare('SELECT index_status FROM regulation_versions WHERE id = ?').get(versionId).index_status === 'retry_wait'));
    const locations = await rebuildRegulationDocumentLocations({ documentIds: [first, second] });
    assert.equal(locations.rebuilt.length, 2);
    assert.ok([firstVersion.articleId, secondVersion.articleId].every(articleId => db.prepare('SELECT COUNT(*) AS count FROM regulation_article_locations WHERE article_id = ?').get(articleId).count > 0));
    const reverted = await revertRegulationDocumentBatch({ batchId: governance.batchId, userId: 1 });
    assert.equal(reverted.reverted.length, 2);
    assert.ok([firstVersion.versionId, secondVersion.versionId].every(versionId => {
        const row = db.prepare('SELECT effect_status, review_status FROM regulation_versions WHERE id = ?').get(versionId);
        return row.effect_status === 'unverified' && row.review_status === 'pending';
    }));
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

test('法规批量修改以集合事务写入，2,000 项不会退化为逐文档元数据调用', async () => {
    const statements = [];
    const ids = Array.from({ length: 2000 }, (_, index) => index + 1);
    const rows = ids.map(id => ({
        id,
        title: `法规 ${id}`,
        category: '',
        legal_level: '',
        issuing_body: '',
        jurisdiction: '',
        official_source_url: '',
        metadata_review_status: 'unreviewed',
        maintainer_user_id: null,
        status: 'active',
        current_version_id: null,
        batch_version_id: null,
        batch_version_label: '',
        batch_effect_status: '',
        batch_review_status: ''
    }));
    const sandbox = {
        module: { exports: {} },
        require: request => {
            if (request.includes('mutations')) return {};
            if (request.includes('catalog')) return {};
            if (request.includes('governance')) return { notifyRegulationSubscribersBulk: async () => ({ notified: 0 }) };
            if (request.includes('shared')) return { normalizeRegulationIssuingBodies: value => String(value || '') };
            if (request.includes('logger')) return { logger: { warn: () => {} } };
            if (request.includes('db/client')) {
                const runQuery = async sql => {
                    statements.push(sql);
                    if (sql.includes('FROM regulation_documents d')) return rows;
                    if (sql.includes('UPDATE regulation_documents')) return rows.map(row => ({ ...row, category: '法律' }));
                    return [];
                };
                const runExecute = async sql => { statements.push(sql); return 3; };
                return {
                    execute: runExecute,
                    query: runQuery,
                    transaction: async callback => await callback({ query: runQuery, queryOne: async () => null, execute: runExecute })
                };
            }
            if (request.includes('time')) return { getBeijingTimestamp: () => '2026-10-12 20:00:00' };
            return {};
        }
    };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../server/services/regulations/document-batch.js'), 'utf8'), sandbox);
    const result = await sandbox.module.exports.updateRegulationDocuments({ documentIds: ids, userId: 1, patch: { category: '法律' } });
    assert.equal(result.updated.length, 2000);
    assert.equal(result.failed.length, 0);
    assert.equal(statements.filter(sql => sql.includes('UPDATE regulation_documents')).length, 1);
    assert.equal(statements.filter(sql => sql.includes('INSERT INTO regulation_document_change_logs')).length, 1);
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
