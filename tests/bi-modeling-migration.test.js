'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { queryOne, execute, query } = require('../server/db/client');
const datasets = require('../server/services/data-analysis/datasets');
const legacy = require('../server/services/data-analysis/semantic-models');
const models = require('../server/services/data-analysis/bi/models');
const migration = require('../server/services/data-analysis/bi/migration');
const jobs = require('../server/services/data-analysis/bi/jobs');
const runner = require('../server/services/data-analysis/bi/runner');
process.env.DATA_ANALYSIS_MODEL_ENABLED = 'true'; process.env.DATA_ANALYSIS_MODEL_RUNTIME = 'development_process';

async function fixture(run, { many = false, huge = false } = {}) {
    assert.match(process.env.PG_TEST_SCHEMA || '', /^pivot_test_/);
    const suffix = crypto.randomBytes(6).toString('hex'), users = [];
    for (const role of ['owner', 'source', 'other']) users.push(await queryOne("INSERT INTO users(username,password_hash,unit) VALUES (?,'hash','QA') RETURNING id,username,unit,status", [`bi_migrate_${role}_${suffix}`]));
    const [user, sourceUser, other] = users;
    try {
        const fact = await datasets.createDatasetFromRows({ user, name: '迁移订单', rows: many ? Array.from({ length: 5001 }, (_, index) => ({ 编号: String(index), 部门: 'a', 金额: '0.01' })) : [{ 编号: '01', 部门: 'a', 金额: huge ? '9007199254740993.01' : '10.25' }, { 编号: '02', 部门: 'b', 金额: '20.75' }, { 编号: '03', 部门: 'x', 金额: '5.00' }] });
        const dim = await datasets.createDatasetFromRows({ user: sourceUser, name: '迁移部门', rows: [{ 编号: 'a', 名称: '甲' }, { 编号: 'b', 名称: '乙' }] });
        await execute("UPDATE analysis_datasets SET scope='shared',allowed_user_ids=? WHERE id=?", [String(user.id), dim.id]);
        let old = await legacy.saveDataModel({ user, body: { name: '原关联探索' } });
        await legacy.addDataModelRelation({ user, modelId: old.id, body: { expectedVersion: old.version, leftDatasetId: fact.id, rightDatasetId: dim.id, leftFieldKey: 'c_2', rightFieldKey: 'c_1', joinType: 'left', cardinality: 'many_to_one' } });
        old = (await legacy.getDataModel(user, old.id)).model;
        const metric = await legacy.saveMetricDefinition({ user, datasetId: fact.id, body: { name: '旧金额', metricConfig: { fieldKey: 'c_3', aggregation: 'sum' }, unit: '元' } });
        const view = await require('../server/services/data-analysis/governance').saveAnalysisView({ user, datasetId: fact.id, body: { name: '旧订单视图', viewType: 'query', config: { sql: 'SELECT * FROM data' } } });
        await run({ user, sourceUser, other, fact, dim, old, metric, view });
    } finally {
        const ids = users.map(item => item.id);
        await execute('UPDATE analysis_runtime_slots SET job_id=NULL WHERE job_id IN (SELECT id FROM analysis_query_jobs WHERE user_id=ANY(?::bigint[]))', [ids]);
        for (const table of ['analysis_saved_views', 'analysis_query_jobs']) await execute(`DELETE FROM ${table} WHERE user_id=ANY(?::bigint[])`, [ids]);
        for (const table of ['analysis_model_origins', 'analysis_model_data_bindings', 'analysis_model_reviews', 'analysis_data_model_checks', 'analysis_data_model_versions']) await execute(`DELETE FROM ${table} WHERE model_id IN (SELECT id FROM analysis_data_models WHERE user_id=ANY(?::bigint[]))`, [ids]);
        await execute('DELETE FROM analysis_source_manifests WHERE user_id=ANY(?::bigint[])', [ids]);
        await execute('DELETE FROM analysis_object_references WHERE object_id IN (SELECT id FROM analysis_data_objects WHERE user_id=ANY(?::bigint[]))', [ids]);
        await execute('DELETE FROM analysis_data_objects WHERE user_id=ANY(?::bigint[])', [ids]);
        await execute('DELETE FROM analysis_audit_events WHERE user_id=ANY(?::bigint[])', [ids]);
        await execute('DELETE FROM analysis_data_models WHERE user_id=ANY(?::bigint[])', [ids]);
        for (const item of users) await execute('DELETE FROM users WHERE id=?', [item.id]);
    }
}
async function converted(user, old, fact) {
    const inventory = await migration.migrationInventory({ user, modelId: old.id });
    const body = { name: '正式迁移模型', factDatasetId: fact.id, grainKeys: ['c_1'], grainDescription: '一行订单', businessOwner: '业务人', maintenanceContact: '维护人', expectedVersion: old.version, snapshotHash: inventory.snapshotHash, requestKey: crypto.randomUUID() };
    return { model: await migration.migrateExploration({ user, modelId: old.id, body }), body, inventory };
}
const selection = model => ({ dimensions: [model.definition.dimensions.find(item => item.nodeId === model.definition.nodes.find(node => node.role === 'fact').id && item.fieldKey === 'c_2').id], metrics: ['records', 'legacy_metric_0'] });
async function checked(user, model, choose = selection(model)) {
    const created = await jobs.createModelCheck({ user, modelId: model.id, body: { expectedVersion: model.version, requestKey: crypto.randomUUID(), migrationComparison: choose } });
    await runner.processModelJobs();
    const record = await jobs.getModelCheck(user, model.id, created.check.id);
    assert.notEqual(record.status, 'incomplete', JSON.stringify(record.report));
    return record;
}
const publishBody = (model, check, accept = true) => ({ expectedVersion: model.version, checkId: check.id, requestKey: crypto.randomUUID(), warningAcceptance: accept ? check.report.warnings.map(issue => ({ ...issue, reason: '逐项核对固定来源差异，接受此业务范围' })) : [] });

test('旧探索迁移生成新 ID、原子记录不可改写来源，重复和并发请求只产生一个草稿', { timeout: 60000 }, () => fixture(async ({ user, other, fact, old, metric, view }) => {
    const before = await require('../server/services/data-analysis/model-analysis').runDataModelAnalysis({ user, modelId: old.id, dimension: { datasetId: fact.id, fieldKey: 'c_2' }, measure: { datasetId: fact.id, fieldKey: 'c_3' }, aggregation: 'sum' });
    const { model, body, inventory } = await converted(user, old, fact);
    assert.notEqual(model.id, old.id); assert.equal(model.migrationOrigin.sourceModelId, old.id);
    assert.equal(model.migrationOrigin.metrics[0].sourceMetricId, metric.id); assert.equal(model.definition.metrics.find(item => item.id === 'legacy_metric_0').unit, '元');
    assert.equal(inventory.snapshot.views[0].id, view.id); assert.ok(inventory.snapshot.nodes.every(node => Number(node.currentRowCount) > 0 && typeof node.currentVersionRegistered === 'boolean'));
    const repeats = await Promise.all([1, 2].map(() => migration.migrateExploration({ user, modelId: old.id, body })));
    assert.ok(repeats.every(item => item.id === model.id));
    assert.equal((await query('SELECT * FROM analysis_model_origins WHERE source_model_id=?', [old.id])).length, 1);
    await assert.rejects(migration.migrateExploration({ user, modelId: old.id, body: { ...body, name: '不同内容' } }), error => error.code === 'ANALYSIS_MODEL_REQUEST_CONFLICT');
    await assert.rejects(migration.migrationInventory({ user: other, modelId: old.id }), error => error.status === 404);
    await assert.rejects(execute("UPDATE analysis_model_origins SET snapshot_hash='changed' WHERE model_id=?", [model.id]), /不可改写/);
    await legacy.saveMetricDefinition({ user, datasetId: fact.id, metricId: metric.id, body: { name: '修改后的旧指标', metricConfig: { aggregation: 'count' } } });
    assert.equal((await models.getProductionModel(user, model.id)).model.definition.metrics.find(item => item.id === 'legacy_metric_0').type, 'sum');
    assert.deepEqual((await require('../server/services/data-analysis/model-analysis').runDataModelAnalysis({ user, modelId: old.id, dimension: { datasetId: fact.id, fieldKey: 'c_2' }, measure: { datasetId: fact.id, fieldKey: 'c_3' }, aggregation: 'sum' })).rows, before.rows);
    assert.equal((await legacy.getDataModel(user, old.id)).model.modelKind, 'exploration');
}));

test('固定来源对照覆盖行数、未匹配、金额与全部分组；首次发布及旧视图切换均须明确确认', { timeout: 90000 }, () => fixture(async ({ user, fact, old, view }) => {
    let { model } = await converted(user, old, fact);
    await assert.rejects(jobs.createModelCheck({ user, modelId: model.id, body: { expectedVersion: model.version, requestKey: crypto.randomUUID() } }), error => error.code === 'ANALYSIS_MODEL_MIGRATION_INVALID');
    const { canonicalHash } = require('../server/services/data-analysis/bi/canonical'), { BI_POLICY } = require('../server/services/data-analysis/bi/policy');
    const withoutComparison = await require('../server/repositories/analysis-model-jobs').admit({ userId: user.id, modelId: model.id, kind: 'model_check', expectedVersion: model.version, definition: model.definition, semanticHash: canonicalHash(model.definition), rulesHash: canonicalHash(BI_POLICY), requestKey: crypto.randomUUID(), requestHash: crypto.randomUUID(), authorize: jobs.authorize(user, model.id, model.definition, { all: true, write: true }) });
    await runner.processModelJobs();
    const oldWorkerReport = await jobs.getModelCheck(user, model.id, withoutComparison.check_id); assert.equal(oldWorkerReport.status, 'passed');
    await assert.rejects(jobs.publishModel({ user, modelId: model.id, body: publishBody(model, oldWorkerReport) }), error => error.code === 'ANALYSIS_MODEL_MIGRATION_CHECK_REQUIRED');
    const equivalent = await checked(user, model);
    assert.equal(equivalent.status, 'passed', JSON.stringify(equivalent.report)); assert.equal(equivalent.report.migrationComparison.complete, true); assert.equal(equivalent.report.migrationComparison.hasDifferences, false);
    assert.deepEqual(equivalent.report.migrationComparison.rows, { legacy: '3', formal: '3' });
    assert.deepEqual(equivalent.report.migrationComparison.totals.find(item => item.metricId === 'legacy_metric_0'), { metricId: 'legacy_metric_0', legacy: '36.00', formal: '36.00' });
    assert.equal(equivalent.report.migrationComparison.unmatched[0].legacy, '1');
    const fixedJob = await queryOne("SELECT id FROM analysis_query_jobs WHERE check_id=?", [equivalent.id]);
    await assert.rejects(execute("UPDATE analysis_query_jobs SET query_ast_json='{}' WHERE id=?", [fixedJob.id]), /不可改写/);
    await assert.rejects(execute('UPDATE analysis_query_jobs SET manifest_id=NULL WHERE id=?', [fixedJob.id]), /不可改写/);
    model = await models.saveProductionDraft({ user, modelId: model.id, body: { expectedVersion: model.version, definition: { ...model.definition, relations: model.definition.relations.map(item => ({ ...item, joinType: 'inner' })) } } });
    const report = await checked(user, model); assert.equal(report.report.migrationComparison.hasDifferences, true);
    assert.deepEqual(report.report.migrationComparison.rows, { legacy: '3', formal: '2' });
    await assert.rejects(jobs.publishModel({ user, modelId: model.id, body: publishBody(model, report, false) }), error => error.code === 'ANALYSIS_MODEL_WARNINGS_UNACCEPTED');
    await jobs.publishModel({ user, modelId: model.id, body: publishBody(model, report) });
    const run = await jobs.createModelQuery({ user, modelId: model.id, body: { publishedVersion: 1, ...selection(model), requestKey: crypto.randomUUID() } }); await runner.processModelJobs();
    assert.equal((await jobs.getModelJob(user, run.id)).result.total.values.legacy_metric_0.value, '31.00');
    const consumers = require('../server/services/data-analysis/bi/consumers');
    const body = { sourceRunId: run.id, name: view.name, viewType: 'query', expectedVersion: view.version };
    await assert.rejects(consumers.saveModelView({ user, modelId: model.id, viewId: view.id, body }), error => error.code === 'ANALYSIS_MODEL_VIEW_UPGRADE_REQUIRED');
    assert.equal((await queryOne('SELECT source_type FROM analysis_saved_views WHERE id=?', [view.id])).source_type, 'dataset');
    const switched = await consumers.saveModelView({ user, modelId: model.id, viewId: view.id, body: { ...body, confirmMigration: true } });
    assert.equal(switched.modelId, model.id); assert.equal(switched.scope, 'personal');
    assert.equal((await queryOne('SELECT dataset_id FROM analysis_saved_views WHERE id=?', [view.id])).dataset_id, null);
    assert.equal((await legacy.getDataModel(user, old.id)).model.version, old.version);
    const subsequent = await jobs.createModelCheck({ user, modelId: model.id, body: { expectedVersion: model.version, requestKey: crypto.randomUUID() } });
    await runner.processModelJobs(); assert.equal((await jobs.getModelCheck(user, model.id, subsequent.check.id)).status, 'passed');
}));

test('不支持的原基数和反向事实选择留在草稿，不能自动反转、删关系或带阻断项发布', { timeout: 60000 }, () => fixture(async ({ user, dim, old }) => {
    await execute("UPDATE analysis_data_model_relations SET cardinality='many_to_many' WHERE model_id=?", [old.id]);
    const inventory = await migration.migrationInventory({ user, modelId: old.id });
    const model = await migration.migrateExploration({ user, modelId: old.id, body: { name: '待完善迁移', factDatasetId: dim.id, grainKeys: ['c_1'], grainDescription: '部门', expectedVersion: old.version, snapshotHash: inventory.snapshotHash, requestKey: crypto.randomUUID() } });
    assert.equal(model.definition.relations[0].cardinality, 'many_to_many'); assert.equal(model.definition.relations[0].leftNodeId, inventory.snapshot.relations[0].leftNodeId);
    assert.ok(model.draftIssues.length); assert.equal(model.definition.metrics.find(item => item.id === 'legacy_metric_0').field.nodeId, inventory.snapshot.nodes.find(node => node.datasetId !== dim.id).id);
    await assert.rejects(jobs.createModelCheck({ user, modelId: model.id, body: { expectedVersion: model.version, requestKey: crypto.randomUUID() } }), error => error.code?.startsWith('ANALYSIS_MODEL_'));
}));

test('对照保留旧键的当前权限要求；移除来源、陈旧盘点和停用身份不能绕过', { timeout: 60000 }, () => fixture(async ({ user, other, fact, dim, old }) => {
    const stale = await migration.migrationInventory({ user, modelId: old.id });
    await execute("UPDATE analysis_datasets SET name='调整后的部门',source_version=source_version+1 WHERE id=?", [dim.id]);
    await assert.rejects(migration.migrateExploration({ user, modelId: old.id, body: { name: '陈旧迁移', factDatasetId: fact.id, grainKeys: ['c_1'], grainDescription: '订单', expectedVersion: old.version, snapshotHash: stale.snapshotHash, requestKey: crypto.randomUUID() } }), error => error.code === 'ANALYSIS_MODEL_MIGRATION_CHANGED');
    let { model } = await converted(user, old, fact);
    const dimNode = model.definition.nodes.find(node => node.datasetId === dim.id);
    // 新模型改用另一键；旧探索对照仍依赖原始键，不能借草稿修改绕过撤权。
    model = await models.saveProductionDraft({ user, modelId: model.id, body: { expectedVersion: model.version, definition: { ...model.definition, nodes: model.definition.nodes.map(node => node.id === dimNode.id ? { ...node, grainKeys: ['c_2'] } : node), dimensions: model.definition.dimensions.filter(item => item.nodeId !== dimNode.id), metrics: model.definition.metrics.map(item => ({ ...item, allowedDimensionIds: item.allowedDimensionIds.filter(id => model.definition.dimensions.some(dimension => dimension.id === id && dimension.nodeId !== dimNode.id)) })), relations: model.definition.relations.map(item => ({ ...item, keyPairs: [{ leftFieldKey: 'c_2', rightFieldKey: 'c_2' }] })) } } });
    const completed = await checked(user, model);
    await execute("UPDATE analysis_datasets SET scope='shared',allowed_user_ids=? WHERE id=?", [String(other.id), fact.id]);
    await execute("UPDATE analysis_datasets SET allowed_user_ids=? WHERE id=?", [`${user.id},${other.id}`, dim.id]);
    const sharing = require('../server/services/data-analysis/bi/sharing');
    const reviewBody = { expectedVersion: model.version, reviewerId: Number(other.id), checkId: completed.id, allowedUserIds: String(other.id), requestKey: crypto.randomUUID() };
    const review = await sharing.requestModelReview({ user, modelId: model.id, body: reviewBody });
    assert.equal((await sharing.getModelReview(other, review.id)).report.migrationComparison.complete, true);
    await execute('DELETE FROM analysis_query_jobs WHERE check_id=?', [completed.id]);
    await execute("INSERT INTO analysis_field_governance(user_id,dataset_id,field_key,logical_type,sensitivity,status) VALUES (?,?,?,'auto','restricted','active')", [user.id, dim.id, 'c_1']);
    await assert.rejects(jobs.getModelCheck(user, model.id, completed.id), error => error.code === 'ANALYSIS_MODEL_FIELD_UNAVAILABLE');
    await assert.rejects(sharing.getModelReview(other, review.id), error => error.code === 'ANALYSIS_MODEL_FIELD_UNAVAILABLE');
    await assert.rejects(sharing.requestModelReview({ user, modelId: model.id, body: { ...reviewBody, requestKey: crypto.randomUUID() } }), error => error.code === 'ANALYSIS_MODEL_FIELD_UNAVAILABLE');
    await assert.rejects(jobs.createModelCheck({ user, modelId: model.id, body: { expectedVersion: model.version, requestKey: crypto.randomUUID(), migrationComparison: selection(model) } }), error => error.code === 'ANALYSIS_MODEL_FIELD_UNAVAILABLE');
    await execute("UPDATE analysis_field_governance SET sensitivity='internal' WHERE dataset_id=?", [dim.id]);
    model = await models.saveProductionDraft({ user, modelId: model.id, body: { expectedVersion: model.version, definition: { ...model.definition, nodes: model.definition.nodes.filter(node => node.id !== dimNode.id), relations: [] } } });
    await assert.rejects(jobs.createModelCheck({ user, modelId: model.id, body: { expectedVersion: model.version, requestKey: crypto.randomUUID(), migrationComparison: selection(model) } }), error => error.code === 'ANALYSIS_MODEL_MIGRATION_INVALID');
    await execute("UPDATE users SET status='disabled' WHERE id=?", [user.id]);
    await assert.rejects(migration.migrationInventory({ user, modelId: old.id }), error => error.status === 404);
}));

test('旧双精度金额差异明确展示，不能冒充精确一致', { timeout: 60000 }, () => fixture(async ({ user, fact, old }) => {
    const { model } = await converted(user, old, fact), checkedModel = await checked(user, model);
    assert.equal(checkedModel.status, 'passed', JSON.stringify(checkedModel.report));
    const amount = checkedModel.report.migrationComparison.totals.find(item => item.metricId === 'legacy_metric_0');
    assert.equal(amount.formal, '9007199254741018.76'); assert.notEqual(amount.legacy, amount.formal);
    assert.ok(checkedModel.report.warnings.some(issue => issue.code === 'ANALYSIS_MODEL_MIGRATION_DIFFERENCE'));
}, { huge: true }));

test('超过五千分组的对照保持未完成，禁止仅凭前五百行发布', { timeout: 90000 }, () => fixture(async ({ user, fact, old }) => {
    const { model } = await converted(user, old, fact), definition = model.definition;
    const dimension = definition.dimensions.find(item => item.nodeId === definition.nodes.find(node => node.role === 'fact').id && item.fieldKey === 'c_1');
    const report = await checked(user, model, { dimensions: [dimension.id], metrics: ['legacy_metric_0'] });
    assert.equal(report.status, 'failed'); assert.equal(report.report.migrationComparison.complete, false);
    await assert.rejects(jobs.publishModel({ user, modelId: model.id, body: publishBody(model, report) }), error => error.code === 'ANALYSIS_MODEL_CHECK_REQUIRED');
}, { many: true }));

test('迁移 HTTP 验证当前会话、非法输入与无权读取，导入指标修改仍比较冻结旧配置', { timeout: 60000 }, () => fixture(async ({ user, other, fact, old }) => {
    const express = require('express'), http = require('node:http'), auth = require('../server/auth');
    const app = express(); app.use(express.json()); require('../server/routes/apps/data-analysis-model-routes').registerDataAnalysisModelRoutes(app, { authMiddleware: auth.authMiddleware });
    app.use((error, _req, res, _next) => { res.status(error.status || 500).json({ code: error.code, error: error.message }); });
    const server = http.createServer(app); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const tokens = new Map([user, other].map(actor => [actor.id, auth.generateAccessToken(actor, { sessionIp: '127.0.0.1' })]));
    const call = async (actor, suffix, body) => { const response = await fetch(`http://127.0.0.1:${server.address().port}/apps/data-analysis/models/${old.id}${suffix}`, { method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${tokens.get(actor.id)}`, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) }); return { status: response.status, json: await response.json(), headers: response.headers }; };
    try {
        assert.equal((await call(other, '/migration-inventory')).status, 404);
        const inventory = await call(user, '/migration-inventory'); assert.equal(inventory.status, 200); assert.match(inventory.headers.get('cache-control'), /no-store/);
        const body = { name: 'HTTP迁移', factDatasetId: fact.id, grainKeys: ['c_1'], grainDescription: '订单', expectedVersion: old.version, snapshotHash: inventory.json.snapshotHash, requestKey: crypto.randomUUID() };
        assert.equal((await call(user, '/formal-drafts', { ...body, grainKeys: [] })).status, 400);
        const response = await call(user, '/formal-drafts', body); assert.equal(response.status, 201);
        let model = response.json.model;
        model = await models.saveProductionDraft({ user, modelId: model.id, body: { expectedVersion: model.version, definition: { ...model.definition, metrics: model.definition.metrics.map(item => item.id === 'legacy_metric_0' ? { ...item, type: 'count', field: undefined, numeric: undefined, scale: 0 } : item).map(item => JSON.parse(JSON.stringify(item))) } } });
        const report = await checked(user, model);
        const amount = report.report.migrationComparison.totals.find(item => item.metricId === 'legacy_metric_0');
        assert.equal(amount.legacy, '36'); assert.equal(amount.formal, '3'); assert.equal(report.report.migrationComparison.hasDifferences, true);
        assert.ok(report.report.migrationComparison.reasons.some(reason => reason.includes('冻结的原指标')));
        await execute('UPDATE users SET token_version=token_version+1 WHERE id=?', [user.id]);
        assert.equal((await call(user, '/migration-inventory')).status, 401);
    } finally { await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); }
}));
