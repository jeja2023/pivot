'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { fixture, cleanupUser } = require('../scripts/test_support/bi_modeling');
const { queryOne, execute } = require('../server/db/client');
const { appendIncrementalDataset } = require('../server/services/data-analysis/scalability');
const sourceMetadata = require('../server/repositories/analysis-source-metadata');
const shared = require('../server/services/data-analysis/shared');
const { captureManifest } = require('../server/services/data-analysis/bi/manifests');

const rows = '订单,明细,金额,地区\nc,1,75.50,北\n';
async function inputFile(text = rows, name = 'increment.csv') {
    await shared.ensureAnalysisDirs();
    const file = path.join(shared.tempRoot, `${crypto.randomUUID()}.csv`); await fs.writeFile(file, text);
    return { path: file, originalname: name, size: Buffer.byteLength(text) };
}
async function append(user, datasetId, input = {}, text = rows, extra = {}) { return appendIncrementalDataset({ user, datasetId, file: await inputFile(text), input, ...extra }); }
async function actual(datasetId) {
    const dataset = await queryOne('SELECT * FROM analysis_datasets WHERE id=?', [datasetId]), { instance, connection } = await shared.createDuckConnection();
    try { return { dataset, values: (await connection.runAndReadAll(`SELECT COUNT(*) AS n,SUM(CAST(c_3 AS DECIMAL(18,2)))::VARCHAR AS amount FROM read_parquet(${shared.sqlLiteral(shared.getDatasetPaths(dataset).parquetPath)})`)).getRowObjectsJson()[0] }; }
    finally { connection.closeSync(); instance.closeSync(); }
}

test('追加固定真实原文件和合并 CAS，以批次去重并保留旧清单，错误内容不能重用同一批次', { timeout: 90000 }, async () => fixture(async ({ user, model, fact }) => {
    const original = await captureManifest({ user, modelId: model.id, definition: model.definition });
    const old = await queryOne('SELECT * FROM analysis_datasets WHERE id=?', [fact.id]), oldBytes = await fs.readFile(shared.getDatasetPaths(old).parquetPath);
    const result = await append(user, fact.id, { inputBatchId: '订单追加20261101', expectedSourceRevision: 1 });
    assert.equal(result.reused, false); assert.equal(result.sourceVersion, 2); assert.equal(result.appendedRows, 1); assert.equal(result.totalRows, 4);
    const reused = await append(user, fact.id, { inputBatchId: '订单追加20261101', expectedSourceRevision: 1 });
    assert.equal(reused.reused, true); assert.equal(reused.sourceVersion, result.sourceVersion);
    await assert.rejects(append(user, fact.id, { inputBatchId: '订单追加20261101' }, rows.replace('75.50', '90.50')), error => error.code === 'ANALYSIS_INCREMENTAL_BATCH_CONFLICT');
    const stored = await actual(fact.id); assert.equal(Number(stored.values.n), 4); assert.equal(stored.values.amount, '325.50'); assert.equal(stored.dataset.source_path, '');
    assert.deepEqual(await fs.readFile(shared.getDatasetPaths(old).parquetPath), oldBytes);
    const version = await queryOne("SELECT * FROM analysis_dataset_versions WHERE dataset_id=? AND operation='append'", [fact.id]);
    assert.match(version.manifest_json.inputDigest, /^[a-f0-9]{64}$/); assert.equal(Number(version.manifest_json.inputBytes), Buffer.byteLength(rows));
    assert.equal(version.manifest_json.sourceMetadata.inputBatchId, result.inputBatchId);
    assert.equal(Number((await queryOne("SELECT COUNT(*) AS n FROM analysis_object_references WHERE reference_kind='manifest' AND reference_id=?", [`dataset-version:${version.id}`])).n), 2);
    const next = await captureManifest({ user, modelId: model.id, definition: model.definition });
    assert.notEqual(next.id, original.id); assert.equal(next.manifest_json.members[0].inputBatchId, result.inputBatchId); assert.equal(original.manifest_json.members[0].inputBatchId, '');
    const metadata = await sourceMetadata.get(user.id, fact.id);
    const edited = await sourceMetadata.save(user.id, fact.id, { expectedSourceRevision: metadata.sourceRevision, metadata: { ...metadata.metadata, businessPeriod: '2026-11' } });
    assert.equal(Number((await queryOne("SELECT COUNT(*) AS n FROM analysis_object_references WHERE reference_kind='manifest' AND reference_id=?", [`dataset-version:${edited.versionId}`])).n), 2);
    const duplicate = `dsv_${crypto.randomUUID()}`;
    await assert.rejects(execute("INSERT INTO analysis_dataset_versions(id,dataset_id,user_id,version,operation,parquet_path,manifest_json) VALUES (?,?,?,999,'append',?,?::jsonb)", [duplicate, fact.id, user.id, version.parquet_path, JSON.stringify(version.manifest_json)]), error => error.code === '23505');
}));

test('旧客户端未填批次时按原文件摘要去重，重命名同一文件也不会重复事实', { timeout: 90000 }, async () => fixture(async ({ user, fact }) => {
    const first = await append(user, fact.id);
    const second = await appendIncrementalDataset({ user, datasetId: fact.id, file: await inputFile(rows, 'renamed.csv') });
    assert.match(first.inputBatchId, /^file:[a-f0-9]{64}$/); assert.equal(second.reused, true); assert.equal(second.sourceVersion, first.sourceVersion);
    const stored = await actual(fact.id); assert.equal(Number(stored.values.n), 4); assert.equal(stored.values.amount, '325.50');
    assert.equal(Number((await queryOne("SELECT COUNT(*) AS n FROM analysis_audit_events WHERE user_id=? AND action='dataset_incremented'", [user.id])).n), 1);
}));

test('追加以当前所有权和来源修订提交，准备期间治理变化或账号停用不产生新版本', { timeout: 90000 }, async () => fixture(async ({ user, fact }) => {
    const reader = await queryOne("INSERT INTO users(username,password_hash,unit) VALUES (?,'hash','QA') RETURNING id,username,status,unit", [`append_reader_${crypto.randomUUID()}`]);
    try {
        await execute("UPDATE analysis_datasets SET scope='shared',allowed_user_ids=? WHERE id=?", [String(reader.id), fact.id]);
        await assert.rejects(append(reader, fact.id), error => error.status === 404);
        await assert.rejects(append(user, fact.id, { inputBatchId: '过期修订', expectedSourceRevision: 999 }), error => error.code === 'ANALYSIS_SOURCE_CHANGED');
        await assert.rejects(append(user, fact.id, { inputBatchId: '准备后治理变化' }, rows, { fault: async phase => {
            if (phase === 'objects_prepared') { const current = await sourceMetadata.get(user.id, fact.id); await sourceMetadata.save(user.id, fact.id, { expectedSourceRevision: current.sourceRevision, metadata: { ...current.metadata, businessPeriod: '2026-11' } }); }
        } }), error => error.code === 'ANALYSIS_SOURCE_CHANGED');
        await assert.rejects(append(user, fact.id, { inputBatchId: '准备后停用' }, rows, { fault: async phase => { if (phase === 'objects_prepared') await execute("UPDATE users SET status='disabled' WHERE id=?", [user.id]); } }), error => error.status === 404);
        await execute("UPDATE users SET status='active' WHERE id=?", [user.id]);
        await assert.rejects(append(user, fact.id, { inputBatchId: '准备后取消' }, rows, { fault: async phase => {
            if (phase === 'objects_prepared') { const job = require('../server/services/data-analysis/runtime-budget').executionJob(); await execute("UPDATE analysis_query_jobs SET status='cancelling',cancel_requested_at=NOW(),cancel_cause='user' WHERE id=?", [job.id]); }
        } }), error => error.code === 'ANALYSIS_MODEL_LEASE_LOST');
        const stored = await actual(fact.id); assert.equal(Number(stored.values.n), 3); assert.equal(stored.values.amount, '250.00');
        assert.equal(Number((await queryOne("SELECT COUNT(*) AS n FROM analysis_dataset_versions WHERE dataset_id=? AND operation='append'", [fact.id])).n), 0);
        assert.equal(Number((await queryOne("SELECT COUNT(*) AS n FROM analysis_object_references r JOIN analysis_data_objects o ON o.id=r.object_id WHERE o.user_id=? AND r.reference_kind='lease' AND r.reference_id LIKE 'increment_%'", [user.id])).n), 0);
    } finally { await execute("UPDATE users SET status='active' WHERE id=?", [user.id]); await cleanupUser(reader); }
}));

test('来源原有覆盖不足时追加仍标记部分，不能靠追加操作把未合并的全业务范围改为全量', { timeout: 90000 }, async () => fixture(async ({ user, model, fact }) => {
    const current = await sourceMetadata.get(user.id, fact.id);
    await sourceMetadata.save(user.id, fact.id, { expectedSourceRevision: current.sourceRevision, metadata: { ...current.metadata, coverage: 'incremental' } });
    await append(user, fact.id, { inputBatchId: '部分来源继续追加' });
    assert.equal((await sourceMetadata.get(user.id, fact.id)).metadata.coverage, 'partial');
    await assert.rejects(captureManifest({ user, modelId: model.id, definition: model.definition }), error => error.code === 'ANALYSIS_MODEL_COVERAGE_INCOMPLETE');
    const partial = await captureManifest({ user, modelId: model.id, definition: { ...model.definition, coveragePolicy: 'partial' } }); assert.equal(partial.coverage, 'partial');
}));
