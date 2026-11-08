'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { query, queryOne, execute, transaction } = require('../server/db/client');
const objects = require('../server/services/data-analysis/bi/objects');
const repository = require('../server/repositories/analysis-integrity');
const objectRepository = require('../server/repositories/analysis-objects');
const service = require('../server/services/data-analysis/bi/jobs');
const models = require('../server/services/data-analysis/bi/models');
const runner = require('../server/services/data-analysis/bi/runner');
const consumers = require('../server/services/data-analysis/bi/consumers');

process.env.DATA_ANALYSIS_MODEL_ENABLED = 'true';
process.env.DATA_ANALYSIS_MODEL_RUNTIME = 'development_process';

async function fixture(run) {
    assert.match(process.env.PG_TEST_SCHEMA || '', /^pivot_test_/);
    const suffix = crypto.randomBytes(6).toString('hex');
    const user = await queryOne("INSERT INTO users(username,password_hash,unit) VALUES (?,'hash','QA') RETURNING id,username,status,unit", [`bi_integrity_${suffix}`]);
    const root = path.join(process.env.DATA_DIR, `bi-integrity-${suffix}`); await fs.mkdir(root, { recursive: true });
    try { await run({ user, root, suffix }); }
    finally {
        await execute('UPDATE analysis_runtime_slots SET job_id=NULL WHERE job_id IN (SELECT id FROM analysis_query_jobs WHERE user_id=?)', [user.id]);
        await execute('DELETE FROM analysis_dashboard_items WHERE user_id=?', [user.id]);
        await execute('DELETE FROM analysis_saved_views WHERE user_id=?', [user.id]);
        await execute('DELETE FROM analysis_query_jobs WHERE user_id=?', [user.id]);
        await execute('DELETE FROM analysis_model_data_bindings WHERE model_id IN (SELECT id FROM analysis_data_models WHERE user_id=?)', [user.id]);
        await execute('DELETE FROM analysis_data_model_checks WHERE user_id=?', [user.id]);
        await execute('DELETE FROM analysis_data_model_versions WHERE published_by=?', [user.id]);
        await execute('DELETE FROM analysis_source_manifests WHERE user_id=?', [user.id]);
        await execute('DELETE FROM analysis_object_references WHERE object_id IN (SELECT id FROM analysis_data_objects WHERE user_id=?)', [user.id]);
        const files = await query('SELECT storage_key FROM analysis_data_objects WHERE user_id=?', [user.id]);
        for (const file of files) if (file.storage_key) await objects.store.removeStorageFile(file.storage_key);
        await execute('DELETE FROM analysis_data_objects WHERE user_id=?', [user.id]);
        await execute('DELETE FROM analysis_audit_events WHERE user_id=?', [user.id]);
        await execute('DELETE FROM analysis_data_models WHERE user_id=?', [user.id]);
        await execute('DELETE FROM analysis_datasets WHERE user_id=?', [user.id]);
        await execute('DELETE FROM users WHERE id=?', [user.id]);
        await fs.rm(root, { recursive: true, force: true });
    }
}

async function published(user) {
    const fact = await require('../server/services/data-analysis/datasets').createDatasetFromRows({ user, name: '完整性订单', rows: [{ 编号: '01', 地区: '北', 金额: '10.25' }, { 编号: '02', 地区: '南', 金额: '20.75' }] });
    const created = await require('../server/services/data-analysis/semantic-models').saveDataModel({ user, body: { modelKind: 'production', name: '完整性验收模型', factDatasetId: fact.id, businessOwner: '验收负责人', maintenanceContact: '验收维护人' } });
    const model = await models.saveProductionDraft({ user, modelId: created.id, body: { expectedVersion: 1, definition: { ...created.definition, grainDescription: '一条订单', nodes: [{ ...created.definition.nodes[0], grainKeys: ['c_1'] }],
        dimensions: [{ id: 'region', nodeId: 'fact', fieldKey: 'c_2' }], metrics: [{ id: 'amount', type: 'sum', field: { nodeId: 'fact', fieldKey: 'c_3' }, currency: 'CNY' }] } } });
    const checked = await service.createModelCheck({ user, modelId: model.id, body: { expectedVersion: model.version, requestKey: crypto.randomUUID() } });
    await runner.processModelJobs();
    assert.equal((await service.getModelCheck(user, model.id, checked.check.id)).status, 'passed');
    await service.publishModel({ user, modelId: model.id, body: { expectedVersion: model.version, checkId: checked.check.id, requestKey: crypto.randomUUID(), warningAcceptance: [] } });
    return { model, fact, checkId: checked.check.id };
}
async function runQuery(user, model, dimensions = ['region']) {
    const job = await service.createModelQuery({ user, modelId: model.id, body: { publishedVersion: 1, requestKey: crypto.randomUUID(), dimensions, metrics: ['amount'] } });
    await runner.processModelJobs();
    assert.equal((await service.getModelJob(user, job.id)).status, 'succeeded');
    return job;
}

test('对象解除引用重新计算最短保留期，取消摘要读取不隔离合法字节，GC 故障可重试', async () => fixture(async ({ user, root }) => {
    const file = path.join(root, 'value'); await fs.writeFile(file, '受控来源字节');
    const object = await objects.importFile({ userId: user.id, file, leaseId: 'integrity-retention' });
    await objectRepository.release('lease', 'integrity-retention');
    assert.ok(new Date((await objectRepository.get(object.id)).expires_at).getTime() > Date.now() + 29 * 86400000);
    const controller = new AbortController(); controller.abort();
    await assert.rejects(objects.verify(object, { signal: controller.signal }));
    assert.equal((await objectRepository.get(object.id)).state, 'ready');
    await execute("UPDATE analysis_data_objects SET expires_at=NOW()-INTERVAL '1 day' WHERE id=?", [object.id]);
    await assert.rejects(objects.garbageCollect({ fault: phase => { if (phase === 'file_deleted') throw new Error('删除后登记前崩溃'); } }), /登记前崩溃/);
    assert.equal((await objectRepository.get(object.id)).state, 'deleting');
    assert.equal((await objects.garbageCollect()).deleted, 1);
    assert.equal((await objectRepository.get(object.id)).state, 'expired');
}));

test('读取引用与 GC 竞争同一对象行锁，已接纳读者始终保护文件', async () => fixture(async ({ user, root }) => {
    const file = path.join(root, 'value'); await fs.writeFile(file, '并发保留字节');
    const object = await objects.importFile({ userId: user.id, file, leaseId: 'initial-reader' });
    await objectRepository.release('lease', 'initial-reader');
    await execute("UPDATE analysis_data_objects SET expires_at=NOW()-INTERVAL '1 day' WHERE id=?", [object.id]);
    let release, entered;
    const gate = new Promise(resolve => { release = resolve; }), acquired = new Promise(resolve => { entered = resolve; });
    const reading = transaction(async trx => { await objectRepository.pin([object.id], { kind: 'lease', referenceId: 'racing-reader' }, trx); entered(); await gate; });
    await acquired;
    let settled = false;
    const deleting = objectRepository.claimDeletion(object.id).finally(() => { settled = true; });
    await new Promise(resolve => setTimeout(resolve, 40)); assert.equal(settled, false);
    release(); await reading; assert.equal(await deleting, null);
    await objects.verify(await objectRepository.get(object.id));
}));

test('过期结果解除普通运行引用，固定视图及当前来源绑定继续保留', { timeout: 90000 }, async () => fixture(async ({ user }) => {
    const { model } = await published(user), ordinary = await runQuery(user, model, []), fixed = await runQuery(user, model);
    await consumers.saveModelView({ user, modelId: model.id, body: { sourceRunId: fixed.id, name: '固定历史报告', viewType: 'query', binding: { strategy: 'historical', manifestId: fixed.manifestId }, config: {} } });
    await execute("UPDATE analysis_query_jobs SET completed_at=NOW()-INTERVAL '10 days' WHERE id IN (?,?)", [ordinary.id, fixed.id]);
    await execute("UPDATE analysis_data_objects SET expires_at=NOW()-INTERVAL '1 minute' WHERE id IN (SELECT result_object_id FROM analysis_query_jobs WHERE id IN (?,?)) OR id IN (SELECT result_page_object_id FROM analysis_query_jobs WHERE id IN (?,?))", [ordinary.id, fixed.id, ordinary.id, fixed.id]);
    const retention = await repository.retention(); assert.equal(retention.resultsExpired, 1);
    await objects.garbageCollect();
    const expired = await service.getModelJob(user, ordinary.id); assert.equal(expired.resultExpired, true); assert.equal(expired.result, null);
    await assert.rejects(require('../server/services/data-analysis/bi/results').resultPage({ user, jobId: ordinary.id, session: 'expired-session' }), error => error.code === 'ANALYSIS_MODEL_RESULT_UNAVAILABLE');
    await assert.rejects(require('../server/services/data-analysis/bi/results').createModelExport({ user, jobId: ordinary.id, body: { format: 'csv', requestKey: crypto.randomUUID() } }), error => error.code === 'ANALYSIS_MODEL_EXPORT_INVALID');
    const fixedRow = await require('../server/repositories/analysis-model-jobs').get(user.id, fixed.id);
    assert.equal((await objectRepository.get(fixedRow.result_object_id)).state, 'ready');
    await objects.verify(await objectRepository.get(fixedRow.result_object_id));
    assert.equal((await service.getModelJob(user, fixed.id)).resultExpired, false);
    const binding = await queryOne('SELECT * FROM analysis_model_data_bindings WHERE model_id=?', [model.id]);
    const members = await require('../server/repositories/analysis-manifests').members(binding.manifest_id);
    assert.ok(members.every(member => member.object_state === 'ready'));
}));

test('持久巡检发现损坏对象和孤儿文件，阻断绑定并记录全量游标，巡检本身占统一预算', { timeout: 90000 }, async () => fixture(async ({ user, suffix }) => {
    const { model } = await published(user);
    const previousRun = await runQuery(user, model);
    const binding = await queryOne('SELECT * FROM analysis_model_data_bindings WHERE model_id=?', [model.id]);
    const [member] = await require('../server/repositories/analysis-manifests').members(binding.manifest_id);
    await fs.writeFile(objects.store.resolveStoragePath(member.storage_key), '模拟损坏');
    const orphanKey = `source/${user.id}/aa/${'a'.repeat(64)}`;
    const orphanFile = objects.store.resolveStoragePath(orphanKey); await fs.mkdir(path.dirname(orphanFile), { recursive: true }); await fs.writeFile(orphanFile, suffix);
    await execute("DELETE FROM analysis_integrity_state WHERE id='main'");
    try {
        const before = await queryOne("SELECT COUNT(*) AS total FROM analysis_query_jobs WHERE execution_kind='legacy_operation'");
        const result = await require('../server/services/data-analysis/bi/integrity').reconcileAnalysisObjects();
        assert.ok(result.checked >= 1); assert.equal(result.objectScanComplete, true);
        assert.equal((await objectRepository.get(member.object_id)).state, 'quarantined');
        assert.equal((await queryOne('SELECT data_state FROM analysis_model_data_bindings WHERE model_id=?', [model.id])).data_state, 'source_unavailable');
        assert.equal((await models.getProductionModel(user, model.id)).model.availability, 'source_unavailable');
        await assert.rejects(service.getModelJob(user, previousRun.id), error => error.code === 'ANALYSIS_MODEL_SOURCE_UNAVAILABLE');
        assert.ok(await queryOne("SELECT 1 FROM analysis_integrity_findings WHERE kind='object_corrupted' AND target_id=? AND resolved_at IS NULL", [member.object_id]));
        assert.ok(await queryOne("SELECT 1 FROM analysis_integrity_findings WHERE kind='orphan_file' AND target_id=?", [orphanKey]));
        assert.ok((await repository.state()).last_full_scan_at);
        assert.equal(Number((await queryOne("SELECT COUNT(*) AS total FROM analysis_query_jobs WHERE execution_kind='legacy_operation'")).total), Number(before.total) + 1);
        await assert.rejects(service.createModelQuery({ user, modelId: model.id, body: { publishedVersion: 1, requestKey: crypto.randomUUID(), dimensions: [], metrics: ['amount'] } }), error => error.code === 'ANALYSIS_MODEL_SOURCE_UNAVAILABLE');
    } finally { await fs.unlink(orphanFile); }
}));

test('临时目录维护不按父目录年龄删除活跃任务，孤儿任务可在宽限后清理', { timeout: 90000 }, async () => fixture(async ({ user }) => {
    const { model } = await published(user);
    const queued = await service.createModelQuery({ user, modelId: model.id, body: { publishedVersion: 1, requestKey: crypto.randomUUID(), dimensions: [], metrics: ['amount'] } });
    const { tempRoot } = require('../server/services/data-analysis/shared');
    const root = path.join(tempRoot, 'model-jobs'), active = path.join(root, `${queued.id}-1`), orphan = path.join(root, `query_job_${crypto.randomUUID()}-1`);
    for (const folder of [active, orphan]) { await fs.mkdir(folder, { recursive: true }); await fs.writeFile(path.join(folder, 'running'), '受控文件'); await fs.utimes(folder, new Date(0), new Date(0)); }
    await fs.utimes(root, new Date(0), new Date(0));
    try {
        await require('../server/services/data-analysis/datasets').cleanupAnalysisWorkspace();
        await fs.access(active); await assert.rejects(fs.access(orphan), error => error.code === 'ENOENT');
        assert.equal((await service.getModelJob(user, queued.id)).status, 'queued');
    } finally { await fs.rm(active, { recursive: true, force: true }); }
}));

test('无消费者的旧清单可解除保留，当前绑定即使引用异常也不得被 GC 删除', { timeout: 90000 }, async () => fixture(async ({ user, suffix }) => {
    const { model } = await published(user);
    const binding = await queryOne('SELECT * FROM analysis_model_data_bindings WHERE model_id=?', [model.id]);
    const sourceRepository = require('../server/repositories/analysis-manifests');
    const manifest = await sourceRepository.get(binding.manifest_id), [member] = await sourceRepository.members(manifest.id);
    const unusedId = `manifest_unused_${suffix}`, snapshot = { ...manifest.manifest_json, retentionEvidence: suffix };
    await transaction(async trx => {
        await trx.execute("INSERT INTO analysis_source_manifests(id,user_id,manifest_hash,manifest_json,coverage,created_at) VALUES (?,?,?,?::jsonb,'full',NOW()-INTERVAL '31 days')", [unusedId, user.id, require('../server/services/data-analysis/bi/canonical').canonicalHash(snapshot), JSON.stringify(snapshot)]);
        await trx.execute(`INSERT INTO analysis_source_manifest_members(manifest_id,node_id,dataset_id,dataset_version_id,object_id,schema_hash,governance_hash,source_revision,input_batch_id,watermark_json,coverage)
            SELECT ?,node_id,dataset_id,dataset_version_id,object_id,schema_hash,governance_hash,source_revision,input_batch_id,watermark_json,coverage FROM analysis_source_manifest_members WHERE manifest_id=?`, [unusedId, manifest.id]);
        await objectRepository.pin([member.object_id], { kind: 'manifest', referenceId: unusedId }, trx);
    });
    const cleaned = await repository.retention(); assert.equal(cleaned.manifestsDeleted, 1);
    assert.equal(await sourceRepository.get(unusedId), null); assert.ok(await sourceRepository.get(manifest.id));
    assert.ok(new Date((await objectRepository.get(member.object_id)).expires_at).getTime() > Date.now() + 29 * 86400000);
    await execute('DELETE FROM analysis_object_references WHERE object_id=?', [member.object_id]);
    await execute("UPDATE analysis_data_objects SET expires_at=NOW()-INTERVAL '1 day' WHERE id=?", [member.object_id]);
    assert.equal(await objectRepository.claimDeletion(member.object_id), null);
    await objects.verify(await objectRepository.get(member.object_id));
}));
