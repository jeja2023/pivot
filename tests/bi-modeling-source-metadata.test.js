'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { fixture, cleanupUser } = require('../scripts/test_support/bi_modeling');
const { queryOne, execute } = require('../server/db/client');
const metadata = require('../server/repositories/analysis-source-metadata');
const { normalizeSourceMetadata } = require('../server/services/data-analysis/bi/source-metadata');
const { captureManifest } = require('../server/services/data-analysis/bi/manifests');

async function update(user, datasetId, values) {
    const before = await metadata.get(user.id, datasetId);
    return metadata.save(user.id, datasetId, { expectedSourceRevision: before.sourceRevision, metadata: { ...before.metadata, ...values } });
}

test('来源业务信息严格校验批次、期间、覆盖状态和带时区的业务截止时间', () => {
    assert.deepEqual(normalizeSourceMetadata(), { inputBatchId: '', businessPeriod: '', dataUpdatedAt: '', coverage: 'full' });
    for (const input of [{ inputBatchId: 'a\nb' }, { businessPeriod: 'x'.repeat(81) }, { coverage: 'complete' }, { dataUpdatedAt: '2026-10-01' }, { dataUpdatedAt: new Date(Date.now() + 86400000).toISOString() }]) assert.throws(() => normalizeSourceMetadata(input), error => error.code === 'ANALYSIS_SOURCE_METADATA_INVALID');
    assert.equal(normalizeSourceMetadata({ dataUpdatedAt: '2026-10-01T08:00:00+08:00' }).dataUpdatedAt, '2026-10-01T00:00:00.000Z');
});

test('补录生成不可变新版本且不伪造数据刷新，旧版本与历史来源清单保留原水位', { timeout: 60000 }, async () => fixture(async ({ user, model, fact }) => {
    const original = await captureManifest({ user, modelId: model.id, definition: model.definition });
    const before = await metadata.get(user.id, fact.id), old = await queryOne('SELECT * FROM analysis_dataset_versions WHERE id=?', [before.versionId]);
    const saved = await update(user, fact.id, { inputBatchId: 'batch-202611', businessPeriod: '2026-11', dataUpdatedAt: '' });
    assert.notEqual(saved.versionId, before.versionId); assert.ok(Number(saved.sourceRevision) > Number(before.sourceRevision));
    assert.equal(saved.metadata.dataUpdatedAt, before.metadata.dataUpdatedAt);
    assert.deepEqual(await queryOne('SELECT * FROM analysis_dataset_versions WHERE id=?', [before.versionId]), old);
    await assert.rejects(execute("UPDATE analysis_dataset_versions SET manifest_json='{}' WHERE id=?", [saved.versionId]), error => error.code === 'P0001');
    const next = await captureManifest({ user, modelId: model.id, definition: model.definition });
    assert.notEqual(next.id, original.id); assert.equal(next.manifest_json.members[0].inputBatchId, 'batch-202611');
    assert.equal(next.manifest_json.members[0].watermark.period, '2026-11');
    assert.equal(original.manifest_json.members[0].inputBatchId, '');
    assert.equal(next.manifest_json.members[0].watermark.updatedAt, original.manifest_json.members[0].watermark.updatedAt);
    assert.equal((await update(user, fact.id, {})).versionId, saved.versionId);
    const audit = await queryOne("SELECT details_json FROM analysis_audit_events WHERE user_id=? AND action='source_metadata_updated'", [user.id]); assert.equal(audit.details_json.metadata.inputBatchId, 'batch-202611');
}));

test('共同批次与共同业务期间可从真实版本匹配，缺失和不一致的水位拒绝固定', { timeout: 60000 }, async () => fixture(async ({ user, model, fact }) => {
    const dimension = await require('../server/services/data-analysis/datasets').createDatasetFromRows({ user, name: '地区信息', rows: [{ 地区: '北' }, { 地区: '南' }] });
    const definition = { ...model.definition, nodes: [...model.definition.nodes, { id: 'district', datasetId: dimension.id, role: 'dimension', name: '地区信息', grainKeys: ['c_1'] }],
        relations: [{ id: 'district_relation', leftNodeId: 'fact', rightNodeId: 'district', joinType: 'left', cardinality: 'many_to_one', keyPairs: [{ leftFieldKey: 'c_4', rightFieldKey: 'c_1' }] }] };
    for (const policy of ['same_batch', 'same_period']) {
        await update(user, fact.id, { inputBatchId: '', businessPeriod: '' }); await update(user, dimension.id, { inputBatchId: '', businessPeriod: '' });
        const options = { user, modelId: model.id, definition: { ...definition, watermarkPolicy: policy } };
        await assert.rejects(captureManifest(options), error => error.code === 'ANALYSIS_MODEL_WATERMARK_MISMATCH');
        await update(user, fact.id, { inputBatchId: '共同批次1', businessPeriod: '2026-10' }); await update(user, dimension.id, { inputBatchId: '共同批次2', businessPeriod: '2026-11' });
        await assert.rejects(captureManifest(options), error => error.code === 'ANALYSIS_MODEL_WATERMARK_MISMATCH');
        await update(user, dimension.id, { inputBatchId: '共同批次1', businessPeriod: '2026-10' });
        const fixed = await captureManifest(options); assert.equal(fixed.manifest_json.members.length, 2); assert.equal(fixed.coverage, 'full');
        assert.ok(fixed.manifest_json.members.every(member => member.inputBatchId === '共同批次1' && member.watermark.period === '2026-10'));
    }
}));

test('增量、部分和未知覆盖不能伪装全量，已声明部分分析才可固定对应清单', { timeout: 60000 }, async () => fixture(async ({ user, model, fact }) => {
    for (const coverage of ['incremental', 'partial', 'unknown']) {
        await update(user, fact.id, { coverage });
        await assert.rejects(captureManifest({ user, modelId: model.id, definition: model.definition }), error => error.code === 'ANALYSIS_MODEL_COVERAGE_INCOMPLETE');
        const partial = await captureManifest({ user, modelId: model.id, definition: { ...model.definition, coveragePolicy: 'partial' } });
        assert.equal(partial.manifest_json.members[0].coverage, coverage); assert.equal(partial.coverage, coverage === 'unknown' ? 'unknown' : 'partial');
    }
}));

test('来源业务信息按当前所有权和版本写入，撤权、旧修订及准备期间并发更新均拒绝', { timeout: 90000 }, async () => fixture(async ({ user, model, fact }) => {
    const reader = await queryOne("INSERT INTO users(username,password_hash,unit) VALUES (?,'hash','QA') RETURNING id,username,status,unit", [`metadata_reader_${crypto.randomUUID()}`]);
    try {
        await execute("UPDATE analysis_datasets SET scope='shared',allowed_user_ids=? WHERE id=?", [String(reader.id), fact.id]);
        const visible = await metadata.get(reader.id, fact.id); assert.equal(visible.canEdit, false);
        await assert.rejects(metadata.save(reader.id, fact.id, { expectedSourceRevision: visible.sourceRevision, metadata: { inputBatchId: '越权' } }), error => error.status === 404);
        const old = await metadata.get(user.id, fact.id); await update(user, fact.id, { inputBatchId: '新批次' });
        await assert.rejects(metadata.save(user.id, fact.id, { expectedSourceRevision: old.sourceRevision, metadata: { inputBatchId: '覆盖并发编辑' } }), error => error.code === 'ANALYSIS_SOURCE_CHANGED');
        await assert.rejects(captureManifest({ user, modelId: model.id, definition: model.definition, fault: async phase => { if (phase === 'objects_prepared') await update(user, fact.id, { inputBatchId: '准备后变化' }); } }), error => error.code === 'ANALYSIS_SOURCE_CHANGED');
        await execute("UPDATE analysis_datasets SET scope='personal',allowed_user_ids='' WHERE id=?", [fact.id]);
        await assert.rejects(metadata.get(reader.id, fact.id), error => error.status === 404);
        await execute("UPDATE users SET status='disabled' WHERE id=?", [user.id]);
        await assert.rejects(metadata.get(user.id, fact.id), error => error.status === 404);
    } finally { await execute("UPDATE users SET status='active' WHERE id=?", [user.id]); await cleanupUser(reader); }
}));

test('来源信息迁移可重复执行，丢失不可变保护会阻断正式执行器就绪', { timeout: 60000 }, async () => {
    const client = await require('../server/db/pg-connection').getPgPool().connect(), migration = require('../server/db/migrations/analysis-source-metadata')[0];
    try {
        await client.query('BEGIN'); await migration.upPg(client); await migration.upPg(client); assert.equal(await migration.checkPg(client), true); await client.query('ROLLBACK');
        await execute('DROP TRIGGER analysis_dataset_version_immutable ON analysis_dataset_versions');
        await assert.rejects(require('../server/repositories/analysis-model-readiness').schemaContract(), error => error.code === 'ANALYSIS_MODEL_SCHEMA_INCOMPATIBLE');
        await client.query('BEGIN'); await migration.upPg(client); await client.query('COMMIT');
    } finally { await client.query('ROLLBACK'); client.release(); }
});

test('来源业务信息在真正交付前再次核对权限，准备响应后撤权不会发送旧业务水位', { timeout: 60000 }, async () => fixture(async ({ user, fact }) => {
    const reader = await queryOne("INSERT INTO users(username,password_hash,unit) VALUES (?,'hash','QA') RETURNING id,username,status,unit", [`metadata_delivery_${crypto.randomUUID()}`]);
    try {
        await update(user, fact.id, { inputBatchId: '受保护业务批次' });
        await execute("UPDATE analysis_datasets SET scope='shared',allowed_user_ids=? WHERE id=?", [String(reader.id), fact.id]);
        const response = await require('../server/services/data-analysis/bi/source-information').getSourceInformation(reader, fact.id);
        await execute("UPDATE analysis_datasets SET scope='personal',allowed_user_ids='' WHERE id=?", [fact.id]);
        let sent = false;
        await assert.rejects(require('../server/services/data-analysis/bi/delivery').consume({ source: response }, () => { sent = true; }), error => error.status === 404);
        assert.equal(sent, false);
    } finally { await cleanupUser(reader); }
}));

test('来源信息 HTTP 接口复用真实会话，参数、旧版本、越权写入与撤权均明确拒绝', { timeout: 90000 }, async () => fixture(async ({ user, fact }) => {
    const app = require('express')(); app.use(require('express').json());
    const { authMiddleware, generateAccessToken } = require('../server/auth');
    require('../server/routes/apps/data-analysis-source-routes').registerDataAnalysisSourceRoutes(app, { authMiddleware });
    app.use((error, _req, res, _next) => res.status(error.status || 500).json({ code: error.code, error: error.message }));
    const server = require('node:http').createServer(app); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const reader = await queryOne("INSERT INTO users(username,password_hash,unit) VALUES (?,'hash','QA') RETURNING id,username,status,unit", [`metadata_http_${crypto.randomUUID()}`]);
    const token = generateAccessToken(user, { sessionIp: '127.0.0.1' }), readerToken = generateAccessToken(reader, { sessionIp: '127.0.0.1' });
    const request = (options = {}, credential = token) => fetch(`http://127.0.0.1:${server.address().port}/apps/data-analysis/datasets/${fact.id}/source-metadata`, { ...options, headers: { authorization: `Bearer ${credential}`, 'content-type': 'application/json' } });
    try {
        const first = await request(); assert.equal(first.status, 200); assert.match(first.headers.get('cache-control'), /no-store/);
        const { source } = await first.json(), body = { expectedSourceRevision: source.sourceRevision, metadata: { inputBatchId: 'HTTP实际批次', businessPeriod: '2026-11', coverage: 'full' } };
        const saved = await request({ method: 'PUT', body: JSON.stringify(body) }); assert.equal(saved.status, 200); assert.equal((await saved.json()).source.metadata.inputBatchId, 'HTTP实际批次');
        assert.equal((await request({ method: 'PUT', body: JSON.stringify(body) })).status, 409);
        assert.equal((await request({ method: 'PUT', body: JSON.stringify({ ...body, metadata: { coverage: '无效覆盖' } }) })).status, 400);
        await execute("UPDATE analysis_datasets SET scope='shared',allowed_user_ids=? WHERE id=?", [String(reader.id), fact.id]);
        assert.equal((await request({}, readerToken)).status, 200);
        assert.equal((await request({ method: 'PUT', body: JSON.stringify(body) }, readerToken)).status, 404);
        await execute("UPDATE analysis_datasets SET scope='personal',allowed_user_ids='' WHERE id=?", [fact.id]); assert.equal((await request({}, readerToken)).status, 404);
        await execute('UPDATE users SET token_version=token_version+1 WHERE id=?', [user.id]); assert.equal((await request()).status, 401);
    } finally { await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); await cleanupUser(reader); }
}));
