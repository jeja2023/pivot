'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const { queryOne, query, execute } = require('../server/db/client');
const datasets = require('../server/services/data-analysis/datasets');
const models = require('../server/services/data-analysis/semantic-models');
const queries = require('../server/services/data-analysis/async-query-jobs');
const jobs = require('../server/repositories/analysis-query-jobs');
async function checkedStep(label, run) {
    if (process.env.PIVOT_ANALYSIS_TEST_DEBUG === 'true') console.error(`数据分析测试阶段：${label}`);
    const result = await run();
    if (process.env.PIVOT_ANALYSIS_TEST_DEBUG === 'true') console.error(`数据分析测试阶段已完成：${label}`);
    return result;
}

async function fixture(run) {
    assert.match(process.env.PG_TEST_SCHEMA || '', /^pivot_test_/);
    const user = await queryOne("INSERT INTO users(username,password_hash,role,status,unit) VALUES (?, 'hash', 'user', 'active', 'QA') RETURNING id, username, role, status, unit", [`foundation_${crypto.randomUUID()}`]);
    try { await run(user); }
    finally { await execute('DELETE FROM users WHERE id = ?', [user.id]); }
}

test('同一显示数值在画像、图表、透视、查询、指标和计算字段中保持一致', { timeout: 60000 }, async () => fixture(async user => {
    const dataset = await checkedStep('创建数值数据集', () => datasets.createDatasetFromRows({ user, name: '数值口径核对', rows: [
        { 部门: '甲', 金额: '￥1,200.50', 比例: '25%', 编号: '001' },
        { 部门: '甲', 金额: '200', 比例: '75%', 编号: '002' },
        { 部门: '甲', 金额: '待核对', 比例: '无', 编号: '003' }
    ] }));
    const { buildChart } = require('../server/services/data-analysis/chart-summary');
    const { runPivot, runUserQuery } = require('../server/services/data-analysis/query-pivot');
    const { evaluateMetric, previewCalculatedField } = require('../server/services/data-analysis/governance');
    assert.equal(dataset.profile.find(column => column.key === 'c_2').numeric.sum, 1400.5);
    const chart = await checkedStep('图表汇总', () => buildChart(user, dataset.id, { xField: 'c_1', yField: 'c_2', aggregation: 'sum' }));
    assert.equal(chart.rows[0].value, 1400.5);
    const pivot = await checkedStep('透视汇总', () => runPivot(user, dataset.id, { rowField: 'c_1', valueField: 'c_2', aggregation: 'sum' }));
    assert.equal(pivot.grandTotal, 1400.5);
    const result = await checkedStep('查询汇总', () => runUserQuery(user, dataset.id, { sql: 'SELECT SUM("金额") AS total, AVG("比例") AS rate FROM data' }));
    assert.equal(result.rows[0].total, 1400.5); assert.equal(result.rows[0].rate, 0.5);
    assert.equal((await evaluateMetric(user, dataset.id, { fieldKey: 'c_2', aggregation: 'sum' })).value, 1400.5);
    const calculated = await checkedStep('计算字段预览', () => previewCalculatedField({ user, datasetId: dataset.id, input: { name: '金额翻倍', expression: '{{c_2}} * 2' } }));
    assert.equal(calculated.rows[0].calculated_value, 2401);
    assert.equal(calculated.rows[2].calculated_value, null);
    const derived = await checkedStep('计算字段物化', () => require('../server/services/data-analysis/governance').materializeCalculatedField({ user, datasetId: dataset.id, input: { name: '二倍金额', expression: '{{c_2}} * 2' } }));
    const chained = await checkedStep('派生字段连续计算', () => previewCalculatedField({ user, datasetId: derived.dataset.id, input: { name: '四倍金额', expression: `{{${derived.calculation.fieldKey}}} * 2` } }));
    assert.equal(chained.rows[0].calculated_value, 4802);
    const preview = await datasets.getDatasetDetail(user, dataset.id);
    assert.equal(preview.previewRows[0].c_4, '001');
}));

test('模型支持无副作用质量检查、结构校验、并发冲突以及所有者编辑和删除', { timeout: 60000 }, async () => fixture(async user => {
    const sales = await datasets.createDatasetFromRows({ user, name: '订单', rows: [{ key: 'a', amount: '￥10' }, { key: 'a', amount: '20%' }, { key: 'x', amount: '5' }] });
    const right = await datasets.createDatasetFromRows({ user, name: '分组', rows: [{ key: 'a', group: '一' }, { key: 'a', group: '二' }, { key: 'z', group: '三' }] });
    const model = await models.saveDataModel({ user, body: { name: '质量核对' } });
    const input = { leftDatasetId: sales.id, leftFieldKey: 'key', rightDatasetId: right.id, rightFieldKey: 'key', joinType: 'left', cardinality: 'many_to_one', expectedVersion: 1 };
    const checked = await models.previewDataModelRelation({ user, modelId: model.id, body: input });
    assert.equal(checked.quality.joinedRows, 5); assert.equal(checked.quality.matchedLeftRows, 2);
    assert.equal(checked.quality.rightDuplicateKeys, 1); assert.equal(checked.quality.cardinalityMismatch, true);
    assert.equal((await models.getDataModel(user, model.id)).model.relations.length, 0);
    const relation = await models.addDataModelRelation({ user, modelId: model.id, body: input });
    assert.equal(relation.leftFieldKey, 'c_1');
    await assert.rejects(models.addDataModelRelation({ user, modelId: model.id, body: { ...input, leftDatasetId: right.id, rightDatasetId: sales.id, expectedVersion: 2 } }), /环路/);
    const changed = await Promise.allSettled(['甲版', '乙版'].map(name => models.saveDataModel({ user, modelId: model.id, body: { name, expectedVersion: 2 } })));
    assert.equal(changed.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(changed.find(result => result.status === 'rejected').reason.status, 409);
    await assert.rejects(models.deleteDataModelRelation({ user: { ...user, id: Number(user.id) + 10000 }, modelId: model.id, relationId: relation.id, expectedVersion: 3 }), error => error.status === 404);
    const edited = await models.addDataModelRelation({ user, modelId: model.id, relationId: relation.id, body: { ...input, joinType: 'inner', expectedVersion: 3 } });
    assert.equal(edited.quality.joinedRows, 4);
    await models.deleteDataModelRelation({ user, modelId: model.id, relationId: relation.id, expectedVersion: 4 });
    assert.equal((await models.getDataModel(user, model.id)).model.relations.length, 0);
    await models.deleteDataModel({ user, modelId: model.id, expectedVersion: 5 });
    await assert.rejects(models.getDataModel(user, model.id), error => error.status === 404);
    assert.ok(await datasets.getDatasetDetail(user, sales.id));
}));

test('后台查询精确限行、保留空结果字段，来源更新后不再提供历史预览', { timeout: 60000 }, async () => fixture(async user => {
    const dataset = await datasets.createDatasetFromRows({ user, name: '后台查询', rows: [{ key: '一' }, { key: '二' }, { key: '三' }] });
    const job = await queries.createAsyncQueryJob({ user, datasetId: dataset.id, sql: 'SELECT * FROM data', limit: 2 });
    await queries.processAsyncQueryJobs({ limit: 1 });
    const result = await queries.getAsyncQueryJob(user, job.id);
    assert.equal(result.status, 'succeeded', result.lastError); assert.equal(result.rowCount, 2); assert.equal(result.truncated, true); assert.equal(result.previewRows.length, 2);
    const row = await jobs.get(user.id, job.id);
    const { fromProjectRelative, parquetToRows } = require('../server/services/data-analysis/shared');
    assert.equal((await parquetToRows(fromProjectRelative(row.result_file_path), { limit: 10 })).length, 2);
    const empty = await queries.createAsyncQueryJob({ user, datasetId: dataset.id, sql: 'SELECT "key" AS "空结果字段" FROM data WHERE 1=0', limit: 2 });
    await queries.processAsyncQueryJobs({ limit: 1 });
    const noRows = await queries.getAsyncQueryJob(user, empty.id);
    assert.deepEqual(noRows.columns, ['空结果字段']); assert.deepEqual(noRows.previewRows, []); assert.equal(noRows.truncated, false);
    await execute('UPDATE analysis_datasets SET source_version = source_version + 1 WHERE id = ?', [dataset.id]);
    const stale = await queries.getAsyncQueryJob(user, job.id);
    assert.equal(stale.resultUnavailable, true); assert.deepEqual(stale.previewRows, []); assert.equal(stale.hasFile, false);
}));

test('后台查询的取消和恢复按执行代次隔离，旧执行器不能回写或登记文件', { timeout: 60000 }, async () => fixture(async user => {
    const dataset = await datasets.createDatasetFromRows({ user, name: '查询恢复', rows: [{ key: '甲' }] });
    const first = await queries.createAsyncQueryJob({ user, datasetId: dataset.id, sql: 'SELECT * FROM data', limit: 2 });
    const attempt = await jobs.claim(60000);
    assert.equal(attempt.id, first.id);
    await queries.cancelAsyncQueryJob(user, first.id);
    await jobs.fail(attempt, { retry: true, message: '不应写回', backoffMs: 1 });
    assert.equal(await jobs.renew(attempt), false);
    assert.equal(await jobs.finish(attempt, { columns: [], previewRows: [], rowCount: 0, truncated: false, filePath: '' }, { id: 'not_created', title: '旧输出', metadata: {} }), false);
    assert.equal((await queries.getAsyncQueryJob(user, first.id)).status, 'cancelled');
    assert.equal((await query('SELECT id FROM analysis_artifacts WHERE id = ?', ['not_created'])).length, 0);
    const second = await queries.createAsyncQueryJob({ user, datasetId: dataset.id, sql: 'SELECT * FROM data', limit: 2 });
    const original = await jobs.claim(60000);
    await execute("UPDATE analysis_query_jobs SET locked_at = NOW() - INTERVAL '2 minutes' WHERE id = ?", [second.id]);
    const recovered = await jobs.claim(60000);
    assert.equal(recovered.attempts, original.attempts + 1);
    assert.equal(await jobs.renew(original), false);
    assert.equal(await jobs.renew(recovered), true);
    await queries.cancelAsyncQueryJob(user, second.id);
    const invalid = await queries.createAsyncQueryJob({ user, datasetId: dataset.id, sql: 'SELECT missing FROM data', limit: 2 });
    await queries.processAsyncQueryJobs({ limit: 1 });
    assert.equal((await queries.getAsyncQueryJob(user, invalid.id)).status, 'failed');
    const files = await fs.readdir(require('../server/services/data-analysis/shared').resolveInside(require('../server/services/data-analysis/shared').exportRoot, String(user.id)));
    assert.equal(files.some(file => file.startsWith(invalid.id)), false);
}));

test('共享仪表盘在字段收紧或来源版本变化后不返回旧快照正文', { timeout: 60000 }, async () => fixture(async user => {
    const governance = require('../server/services/data-analysis/governance');
    const dataset = await datasets.createDatasetFromRows({ user, name: '受控快照', rows: [{ 部门: '甲', 金额: 100, 秘密: '需要隐藏的正文' }] });
    const viewer = await queryOne("INSERT INTO users(username,password_hash,role,status,unit) VALUES (?, 'hash', 'user', 'active', 'QA') RETURNING id, username, role, status, unit", [`snapshot_viewer_${crypto.randomUUID()}`]);
    try {
        await datasets.updateDataset(user, dataset.id, { scope: 'shared', allowedUserIds: String(viewer.id) });
        const dashboard = await governance.saveDashboard({ user, body: { name: '受控看板', scope: 'shared', allowedUserIds: String(viewer.id) } });
        await governance.saveDashboardItem({ user, dashboardId: dashboard.id, body: { title: '查询', itemType: 'query', datasetId: dataset.id, config: { sql: 'SELECT * FROM data' } } });
        await governance.refreshDashboard({ user, dashboardId: dashboard.id });
        assert.match(JSON.stringify((await governance.getDashboard(viewer, dashboard.id)).dashboard.lastSnapshot), /需要隐藏的正文/);
        await governance.updateFieldGovernance({ user, datasetId: dataset.id, fields: [{ fieldKey: 'c_3', sensitivity: 'restricted' }] });
        const hidden = (await governance.getDashboard(viewer, dashboard.id)).dashboard;
        assert.doesNotMatch(JSON.stringify(hidden.lastSnapshot), /需要隐藏的正文/);
        assert.equal(hidden.lastSnapshot.items[0].status, 'access_denied');
        assert.doesNotMatch(JSON.stringify(await governance.listDashboards(viewer)), /需要隐藏的正文/);
        assert.equal((await governance.getDashboard(user, dashboard.id)).dashboard.lastSnapshot.items[0].status, 'stale');
    } finally { await execute('DELETE FROM users WHERE id = ?', [viewer.id]); }
}));

test('分析资产先过滤权限再分页，其他账号的近期私有资产不会挤掉自己的模型和仪表盘', async () => fixture(async user => {
    const governance = require('../server/services/data-analysis/governance');
    const ownModel = await models.saveDataModel({ user, body: { name: '自己的模型' } });
    const ownDashboard = await governance.saveDashboard({ user, body: { name: '自己的仪表盘' } });
    const foreign = await queryOne("INSERT INTO users(username,password_hash,role,status,unit) VALUES (?, 'hash', 'user', 'active', '其他部门') RETURNING id, username, role, status, unit", [`assets_foreign_${crypto.randomUUID()}`]);
    try {
        for (const table of ['analysis_data_models', 'analysis_dashboards']) {
            await execute(`INSERT INTO ${table}(id,user_id,name,created_at,updated_at) SELECT ? || n::text, ?, '不可见资产', NOW(), NOW() + INTERVAL '1 day' FROM generate_series(1,210) n`, [`foreign_${foreign.id}_`, foreign.id]);
        }
        assert.deepEqual((await models.listDataModels(user)).map(model => model.id), [ownModel.id]);
        assert.deepEqual((await governance.listDashboards(user)).map(dashboard => dashboard.id), [ownDashboard.id]);
        const shared = await models.saveDataModel({ user: foreign, body: { name: '明确共享模型', scope: 'shared', allowedUserIds: String(user.id) } });
        assert.ok((await models.listDataModels(user)).some(model => model.id === shared.id));
    } finally { await execute('DELETE FROM users WHERE id = ?', [foreign.id]); }
}));

test('共享摘要遵守字段权限，全部字段受限时查询与导出不能回退到全列', async () => fixture(async user => {
    const governance = require('../server/services/data-analysis/governance');
    const dataset = await datasets.createDatasetFromRows({ user, name: '受限摘要', rows: [{ 公开字段: '可见', 秘密字段: '隐藏的业务内容' }] });
    const viewer = await queryOne("INSERT INTO users(username,password_hash,role,status,unit) VALUES (?, 'hash', 'user', 'active', 'QA') RETURNING id, username, role, status, unit", [`summary_viewer_${crypto.randomUUID()}`]);
    try {
        await datasets.updateDataset(user, dataset.id, { scope: 'shared', allowedUserIds: String(viewer.id) });
        await governance.updateFieldGovernance({ user, datasetId: dataset.id, fields: [{ fieldKey: 'c_2', sensitivity: 'restricted' }] });
        const summary = await require('../server/services/data-analysis/chart-summary').runSummary(viewer, dataset.id);
        assert.doesNotMatch(JSON.stringify(summary), /隐藏的业务内容|秘密字段/);
        const scale = require('../server/services/data-analysis/scalability');
        await scale.saveMaterialization({ user, datasetId: dataset.id, body: { name: '私密分组', groupBy: ['c_2'], metrics: [{ aggregation: 'count' }] } });
        await scale.createDatasetPartitions({ user, datasetId: dataset.id, fieldKey: 'c_2' });
        const state = await scale.getScalabilityState(viewer, dataset.id);
        assert.doesNotMatch(JSON.stringify(state.partitions), /隐藏的业务内容/);
        assert.equal(state.materializations.length, 0);
        await governance.updateFieldGovernance({ user, datasetId: dataset.id, fields: [{ fieldKey: 'c_1', sensitivity: 'restricted' }] });
        await assert.rejects(require('../server/services/data-analysis/query-pivot').runUserQuery(viewer, dataset.id, { sql: 'SELECT * FROM data' }), error => error.code === 'ANALYSIS_FIELD_ACCESS_DENIED');
        for (const format of ['csv', 'xlsx', 'parquet']) await assert.rejects(require('../server/services/data-analysis/export').exportDataset(viewer, dataset.id, format), error => error.code === 'ANALYSIS_FIELD_ACCESS_DENIED');
    } finally { await execute('DELETE FROM users WHERE id = ?', [viewer.id]); }
}));

test('仪表盘部分和全部项目失败时保留真实状态，不记为全部成功', async () => fixture(async user => {
    const governance = require('../server/services/data-analysis/governance');
    const dataset = await datasets.createDatasetFromRows({ user, name: '刷新状态', rows: [{ 金额: 100 }] });
    const dashboard = await governance.saveDashboard({ user, body: { name: '刷新核对' } });
    await governance.saveDashboardItem({ user, dashboardId: dashboard.id, body: { title: '正常查询', itemType: 'query', datasetId: dataset.id, config: { sql: 'SELECT * FROM data' } } });
    await governance.saveDashboardItem({ user, dashboardId: dashboard.id, body: { title: '字段错误', itemType: 'query', datasetId: dataset.id, config: { sql: 'SELECT missing FROM data' } } });
    const partial = await governance.refreshDashboard({ user, dashboardId: dashboard.id });
    assert.equal(partial.status, 'partial_success');
    assert.equal((await queryOne('SELECT status FROM analysis_refresh_runs WHERE id = ?', [partial.runId])).status, 'partial_success');
    await datasets.softDeleteDataset(user.id, dataset.id);
    const failed = await governance.refreshDashboard({ user, dashboardId: dashboard.id });
    assert.equal(failed.status, 'failed');
    assert.equal((await queryOne('SELECT status FROM analysis_refresh_runs WHERE id = ?', [failed.runId])).status, 'failed');
}));
