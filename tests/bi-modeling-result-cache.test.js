'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const { fixture, checked, cleanupUser } = require('../scripts/test_support/bi_modeling');
const { queryOne, execute } = require('../server/db/client');
const jobs = require('../server/services/data-analysis/bi/jobs');
const runner = require('../server/services/data-analysis/bi/runner');
const objectRepository = require('../server/repositories/analysis-objects');
const objects = require('../server/services/data-analysis/bi/objects');
if (process.env.PIVOT_TEST_ANALYSIS_CONTAINER_ACCEPTANCE === 'true') process.env.DATA_ANALYSIS_MODEL_RUNTIME = 'docker';

async function query(user, model, extra = {}) {
    return jobs.createModelQuery({ user, modelId: model.id, body: { publishedVersion: 1, dimensions: ['region'], metrics: ['amount', 'orders', 'average'], requestKey: crypto.randomUUID(), ...extra } });
}
async function finish(user, job) {
    await runner.processModelJobs();
    const result = await jobs.getModelJob(user, job.id);
    assert.equal(result.status, 'succeeded', result.lastError);
    return result;
}
async function warm(user, model) {
    const report = await checked(user, model);
    await jobs.publishModel({ user, modelId: model.id, body: { expectedVersion: model.version, checkId: report.id, requestKey: crypto.randomUUID() } });
    return finish(user, await query(user, model));
}
function pauseResultVerification(objectId) {
    const original = objects.verify;
    let enter, release;
    const entered = new Promise(resolve => { enter = resolve; }), resumed = new Promise(resolve => { release = resolve; });
    objects.verify = async (row, options) => {
        if (row?.id === objectId) { enter(); await resumed; }
        return original(row, options);
    };
    return { entered, release, restore: () => { objects.verify = original; } };
}

test('独立请求命中固定口径缓存，仍登记独立任务/审计/引用并保留原始计算和来源时间', { timeout: 120000 }, async () => fixture(async ({ user, model }) => {
    const original = await warm(user, model);
    assert.equal(original.result.cache.hit, false); assert.match(original.result.cache.key, /^[a-f0-9]{64}$/);
    const next = await query(user, model); assert.notEqual(next.id, original.id); assert.equal(next.status, 'queued');
    const hit = await finish(user, next);
    assert.equal(hit.result.cache.hit, true); assert.equal(hit.result.cache.sourceRunId, original.id);
    assert.equal(hit.result.cache.computedAt, original.result.cache.computedAt);
    assert.equal(hit.result.runId, next.id); assert.equal(hit.result.total.values.amount.value, '250.00'); assert.equal(hit.result.total.values.average.value, '125.00');
    assert.deepEqual(hit.result.dataTimes, original.result.dataTimes);
    assert.equal(hit.executionMetrics.cacheHit, true); assert.equal(hit.executionMetrics.workerMs, 0);
    const before = await queryOne('SELECT result_object_id,result_page_object_id FROM analysis_query_jobs WHERE id=?', [original.id]);
    assert.deepEqual(await queryOne('SELECT result_object_id,result_page_object_id FROM analysis_query_jobs WHERE id=?', [hit.id]), before);
    assert.equal(Number((await queryOne("SELECT COUNT(*) AS n FROM analysis_object_references WHERE reference_kind='run' AND reference_id=? AND object_id IN (?,?)", [hit.id, before.result_object_id, before.result_page_object_id])).n), new Set(Object.values(before)).size);
    await objectRepository.release('run', original.id);
    await execute("UPDATE analysis_data_objects SET expires_at=NOW()-INTERVAL '1 day' WHERE id=?", [before.result_object_id]);
    assert.equal(await objectRepository.claimDeletion(before.result_object_id), null);
    assert.equal(Number((await queryOne("SELECT COUNT(*) AS n FROM analysis_audit_events WHERE model_id=? AND action='model_queried'", [model.id])).n), 2);
}));

test('缓存不跨用户，过滤/发布/来源清单变化或过期运行均重新执行', { timeout: 180000 }, async () => fixture(async ({ user, model, fact }) => {
    const original = await warm(user, model);
    const filtered = await finish(user, await query(user, model, { filters: [{ dimensionId: 'region', operator: 'eq', value: '北' }] }));
    assert.equal(filtered.result.cache.hit, false); assert.equal(filtered.result.total.values.amount.value, '200.00');
    const reader = await queryOne("INSERT INTO users(username,password_hash,unit) VALUES (?,'hash','QA') RETURNING id,username,status,unit", [`cache_reader_${crypto.randomUUID()}`]);
    try {
        await execute("UPDATE analysis_data_models SET scope='shared',allowed_user_ids=? WHERE id=?", [String(reader.id), model.id]);
        await execute("UPDATE analysis_datasets SET scope='shared',allowed_user_ids=? WHERE id=?", [String(reader.id), fact.id]);
        const readerFirst = await finish(reader, await query(reader, model)); assert.equal(readerFirst.result.cache.hit, false);
        const readerSecond = await finish(reader, await query(reader, model)); assert.equal(readerSecond.result.cache.hit, true); assert.equal(readerSecond.result.cache.sourceRunId, readerFirst.id);
        assert.notEqual(readerFirst.result.cache.key, original.result.cache.key);
        await execute('UPDATE users SET unit=? WHERE id=?', ['当前新单位', reader.id]);
        const changedIdentity = await finish(reader, await query(reader, model)); assert.equal(changedIdentity.result.cache.hit, false);
    } finally {
        await execute("UPDATE analysis_data_models SET scope='personal',allowed_user_ids='' WHERE id=?", [model.id]);
        await cleanupUser(reader);
    }
    await execute("UPDATE analysis_query_jobs SET result_metadata_json=result_metadata_json||'{\"resultExpired\":true}'::jsonb WHERE model_id=? AND execution_kind='model_query'", [model.id]);
    const expired = await finish(user, await query(user, model)); assert.equal(expired.result.cache.hit, false);
    const published = await queryOne('SELECT check_id FROM analysis_model_data_bindings WHERE model_id=? AND published_version=1', [model.id]);
    const second = await jobs.publishModel({ user, modelId: model.id, body: { expectedVersion: model.version, checkId: published.check_id, requestKey: crypto.randomUUID() } });
    assert.equal(second.version, 2);
    const changedVersion = await finish(user, await query(user, model, { publishedVersion: 2 })); assert.equal(changedVersion.result.cache.hit, false);
    const binding = await queryOne('SELECT revision FROM analysis_model_data_bindings WHERE model_id=? AND published_version=2', [model.id]);
    await execute('UPDATE analysis_datasets SET source_version=source_version+1,updated_at=NOW() WHERE id=?', [fact.id]);
    const refresh = await jobs.createModelRefresh({ user, modelId: model.id, body: { publishedVersion: 2, bindingRevision: Number(binding.revision), requestKey: crypto.randomUUID() } });
    await runner.processModelJobs(); assert.equal((await jobs.getModelCheck(user, model.id, refresh.check.id)).status, 'passed');
    const changedManifest = await finish(user, await query(user, model, { publishedVersion: 2 })); assert.equal(changedManifest.result.cache.hit, false);
    assert.notEqual(changedManifest.manifestId, changedVersion.manifestId);
}));

test('缓存文件实际损坏时隔离并拒绝交付，不用元数据或缓存命中掩盖摘要失败', { timeout: 120000 }, async () => fixture(async ({ user, model }) => {
    const original = await warm(user, model), row = await queryOne('SELECT result_object_id FROM analysis_query_jobs WHERE id=?', [original.id]);
    const object = await objectRepository.get(row.result_object_id), file = await objects.verify(object);
    await fs.appendFile(file, '损坏缓存字节');
    const next = await query(user, model); await runner.processModelJobs();
    const failed = await jobs.getModelJob(user, next.id); assert.equal(failed.status, 'failed'); assert.equal(failed.result, null);
    assert.match(failed.lastError, /校验失败|已隔离/);
    assert.equal((await objectRepository.get(object.id)).state, 'quarantined');
    assert.equal(Number((await queryOne("SELECT COUNT(*) AS n FROM analysis_object_references WHERE reference_kind='lease' AND reference_id=?", [`${next.id}:1:cache`])).n), 0);
    await assert.rejects(jobs.getModelJob(user, original.id), error => error.code === 'ANALYSIS_MODEL_RESULT_UNAVAILABLE');
}));

test('缓存验证期间授权修订改变仍有权限时退回重算，不能把旧授权键登记为命中', { timeout: 120000 }, async () => fixture(async ({ user, model }) => {
    const original = await warm(user, model), source = await queryOne('SELECT result_object_id FROM analysis_query_jobs WHERE id=?', [original.id]);
    const next = await query(user, model), pause = pauseResultVerification(source.result_object_id);
    const running = runner.processModelJobs();
    try {
        await pause.entered; await execute('UPDATE users SET unit=? WHERE id=?', ['仍有权限的新单位', user.id]); pause.release();
        await running;
        const result = await jobs.getModelJob(user, next.id); assert.equal(result.status, 'succeeded', result.lastError);
        assert.equal(result.result.cache.hit, false); assert.notEqual(result.result.cache.key, original.result.cache.key);
        assert.equal(result.result.total.values.amount.value, '250.00');
    } finally { pause.release(); pause.restore(); await running; }
}));

for (const mode of ['cancel', 'disable']) test(`缓存验证期间${mode === 'cancel' ? '取消先提交' : '当前账号停用'}时不登记可读取结果`, { timeout: 120000 }, async () => fixture(async ({ user, model }) => {
    const original = await warm(user, model), source = await queryOne('SELECT result_object_id FROM analysis_query_jobs WHERE id=?', [original.id]);
    const next = await query(user, model), pause = pauseResultVerification(source.result_object_id), running = runner.processModelJobs();
    try {
        await pause.entered;
        if (mode === 'cancel') await jobs.cancelModelJob(user, next.id);
        else await execute("UPDATE users SET status='disabled' WHERE id=?", [user.id]);
        pause.release(); await running;
        const row = await queryOne('SELECT status,result_object_id,result_page_object_id FROM analysis_query_jobs WHERE id=?', [next.id]);
        assert.equal(row.status, mode === 'cancel' ? 'cancelled' : 'failed'); assert.equal(row.result_object_id, null); assert.equal(row.result_page_object_id, null);
        assert.equal(Number((await queryOne('SELECT COUNT(*) AS n FROM analysis_runtime_slots WHERE job_id=?', [next.id])).n), 0);
        if (mode === 'disable') await assert.rejects(jobs.getModelJob(user, next.id));
    } finally {
        pause.release(); pause.restore(); await running;
        if (mode === 'disable') await execute("UPDATE users SET status='active' WHERE id=?", [user.id]);
    }
}));

test('缓存迁移可重复执行，缺失缓存索引时停止就绪而不退回无界查找', { timeout: 60000 }, async () => {
    const pool = require('../server/db/pg-connection').getPgPool(), client = await pool.connect();
    try {
        const migration = require('../server/db/migrations/analysis-model-result-cache')[0];
        await client.query('BEGIN'); await client.query('DROP INDEX idx_analysis_job_result_cache');
        assert.equal(await migration.checkPg(client), false); await migration.upPg(client); await migration.upPg(client);
        assert.equal(await migration.checkPg(client), true); await client.query('ROLLBACK');
        await execute('DROP INDEX idx_analysis_job_result_cache');
        await assert.rejects(require('../server/repositories/analysis-model-readiness').schemaContract(), error => error.code === 'ANALYSIS_MODEL_SCHEMA_INCOMPATIBLE');
        await client.query('BEGIN'); await migration.upPg(client); await client.query('COMMIT');
    } finally { await client.query('ROLLBACK'); client.release(); }
});

test('指标到期后仍可按当前权限读取已完成结果，新编译拒绝过期依赖且停用账号仍被拒绝', { timeout: 120000 }, async t => fixture(async ({ user, model }) => {
    const expiresAt = new Date(Date.now() + 3600000).toISOString();
    const saved = await require('../server/services/data-analysis/bi/models').saveProductionDraft({ user, modelId: model.id, body: { expectedVersion: model.version,
        definition: { ...model.definition, metrics: model.definition.metrics.map(metric => metric.id === 'amount' ? { ...metric, validTo: expiresAt } : metric) } } });
    const completed = await warm(user, saved);
    const clock = t.mock.method(Date, 'now', () => Date.parse(expiresAt) + 1000);
    try {
        // 模拟业务时钟跨越有效期后，仍真实重验独立日志，避免把完整性审计超时当成指标历史读取失败。
        await require('../server/services/data-analysis/bi/security-journal').flush({ force: true, full: true });
        const historical = await jobs.getModelJob(user, completed.id); assert.equal(historical.result.total.values.average.value, '125.00');
        const page = await require('../server/services/data-analysis/bi/results').resultPage({ user, jobId: completed.id, session: 'isolated-expired-metric-history' });
        assert.equal(page.total.values.amount.value, '250.00');
        assert.throws(() => require('../server/services/data-analysis/bi/query').compileModelQuery(saved.definition, { dimensions: ['region'], metrics: ['average'], filters: [], orderBy: [], limit: 100 },
            { fact: { tableName: 'bi_input_0', columns: ['c_1', 'c_2', 'c_3', 'c_4'].map(key => ({ key })) } }), error => error.code === 'ANALYSIS_METRIC_EXPIRED');
    } finally { clock.mock.restore(); }
    await execute("UPDATE users SET status='disabled' WHERE id=?", [user.id]);
    try { await assert.rejects(jobs.getModelJob(user, completed.id)); }
    finally { await execute("UPDATE users SET status='active' WHERE id=?", [user.id]); }
}));
