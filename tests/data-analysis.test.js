const nodePath = require('node:path');
const nodeFs = require('node:fs');
const nodeOs = require('node:os');

const previousAnalysisDir = process.env.PIVOT_ANALYSIS_DIR;
const previousMaxRows = process.env.DATA_ANALYSIS_MAX_ROWS;
const analysisTestRoot = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'pivot-data-analysis-'));
process.env.PIVOT_ANALYSIS_DIR = analysisTestRoot;
process.env.DATA_ANALYSIS_MAX_ROWS = '1000';

const {
    assert,
    fs,
    path,
    removeTestPath,
    test,
    uploadRoot
} = require('./security-helpers');
const { db } = require('../server/db');
const Sqlite = require('better-sqlite3');


const {
    importDataset,
    getDatasetDetail,
    getDatasetSummary,
    listDatasetArtifacts,
    sanitizeRows,
    updateDataset
} = require('../server/services/data-analysis/datasets');
const { redactAnalysisRows, recordArtifact } = require('../server/services/data-analysis/shared');
const { validateUserSql } = require('../server/services/data-analysis/query-pivot');
const {
    listFieldGovernance,
    updateFieldGovernance,
    previewCalculatedField,
    materializeCalculatedField,
    saveAnalysisView,
    runSavedView,
    saveDashboard,
    saveDashboardItem,
    refreshDashboard,
    saveRefreshSchedule,
    saveAlertRule,
    evaluateAlertRulesForDataset
} = require('../server/services/data-analysis/governance');
const {
    saveMetricDefinition,
    evaluateMetricDefinition,
    saveDataModel,
    addDataModelRelation,
    runDataModelJoin,
    createAsyncQueryJob,
    processAsyncQueryJobs,
    getAsyncQueryJob
} = require('../server/services/data-analysis/semantic-models');
const {
    appendIncrementalDataset,
    createDatasetPartitions,
    saveMaterialization,
    getScalabilityState
} = require('../server/services/data-analysis/scalability');

function cleanupAnalysisRows(userId) {
    db.prepare('DELETE FROM analysis_artifacts WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM analysis_datasets WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM users WHERE id = ?').run(userId);
}

function createAnalysisUser(username, nickname) {
    return db.prepare(`
        INSERT INTO users (username, password_hash, nickname, unit, role, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, datetime('now', '+8 hours'))
    `).run(username, 'hash', nickname, 'QA', 'user', 'active');
}

test('数据分析支持上传 SQLite 文件生成数据集', async () => {
    const suffix = Date.now().toString(36);
    const username = `analysis_sqlite_${suffix}`;
    const userInfo = createAnalysisUser(username, 'Data Analysis SQLite Test');
    const userId = userInfo.lastInsertRowid;
    const tempDir = path.join(uploadRoot, 'data-analysis-sqlite-test', String(userId));
    fs.mkdirSync(tempDir, { recursive: true });
    const sqlitePath = path.join(tempDir, `${suffix}.sqlite`);
    const sqlite = new Sqlite(sqlitePath);
    sqlite.exec(`
        CREATE TABLE sales (
            department TEXT NOT NULL,
            amount INTEGER NOT NULL
        );
        INSERT INTO sales (department, amount) VALUES ('华东', 120), ('华南', 180);
    `);
    sqlite.close();

    let dataset = null;
    try {
        dataset = await importDataset({
            user: { id: userId, username },
            file: {
                path: sqlitePath,
                originalname: '销售.sqlite',
                mimetype: 'application/vnd.sqlite3',
                size: fs.statSync(sqlitePath).size
            },
            name: '销售数据'
        });

        assert.equal(dataset.fileType, 'sqlite');
        assert.equal(dataset.rowCount, 2);
        assert.equal(dataset.columnCount, 2);
        assert.equal(dataset.sourceRowCount, 2);
        assert.equal(dataset.sourceColumnCount, 2);
        assert.equal(dataset.truncated, false);
        assert.equal(dataset.sheetName, 'sales');
        assert.deepEqual(dataset.columns.map(column => column.name), ['department', 'amount']);

        const detail = await getDatasetDetail(userId, dataset.id);
        assert.equal(detail.previewRows.length, 2);
        assert.deepEqual(detail.previewRows[0], { c_1: '华东', c_2: '120' });
        assert.deepEqual(detail.previewRows[1], { c_1: '华南', c_2: '180' });

        const summary = await getDatasetSummary(userId);
        assert.equal(summary.count, 1);
        assert.equal(summary.rowCount, 2);
    } finally {
        cleanupAnalysisRows(userId);
        removeTestPath(tempDir, { recursive: true });
    }
});

test('数据分析显式记录导入截断并对模型观测脱敏', () => {
    const rows = [['姓名', '邮箱', '金额']];
    for (let index = 0; index < 1001; index += 1) {
        rows.push([`用户${index}`, `user${index}@example.com`, String(index)]);
    }
    const sanitized = sanitizeRows(rows);
    assert.equal(sanitized.rows.length, 1000);
    assert.equal(sanitized.sourceRowCount, 1001);
    assert.equal(sanitized.truncated, true);
    assert.equal(sanitized.truncatedRows, true);
    assert.deepEqual(
        redactAnalysisRows([{ c_1: '张三', c_2: 'test@example.com', c_3: '120' }], sanitized.columns),
        [{ c_1: '[已脱敏]', c_2: '[已脱敏]', c_3: '120' }]
    );
});

test('数据分析 SQL 仍拒绝多语句和外部文件读取', () => {
    assert.throws(() => validateUserSql('SELECT 1; DROP TABLE data'), /单条查询/);
    assert.throws(() => validateUserSql('SELECT * FROM read_parquet(\'x.parquet\')'), /不允许/);
    assert.equal(validateUserSql('SELECT COUNT(*) AS total FROM data'), 'SELECT COUNT(*) AS total FROM data');
});

test('数据分析支持受控增量导入、分区 Parquet、版本记录和物化聚合', async () => {
    const suffix = Date.now().toString(36);
    const username = `analysis_scale_${suffix}`;
    const userInfo = createAnalysisUser(username, 'Data Analysis Scale Test');
    const user = { id: userInfo.lastInsertRowid, username, unit: 'QA', role: 'user', status: 'active' };
    const incrementDir = path.join(uploadRoot, 'data-analysis-increment-test', String(user.id));
    const incrementPath = path.join(incrementDir, 'increment.csv');
    let dataset = null;
    try {
        dataset = await require('../server/services/data-analysis/datasets').createDatasetFromRows({
            user,
            name: '规模化销售数据',
            rows: [{ region: '华东', amount: 100 }, { region: '华南', amount: 200 }],
            sourceType: 'database'
        });
        fs.mkdirSync(incrementDir, { recursive: true });
        fs.writeFileSync(incrementPath, 'region,amount\n华东,50\n', 'utf8');
        const appended = await appendIncrementalDataset({
            user,
            datasetId: dataset.id,
            file: { path: incrementPath, originalname: 'increment.csv', size: fs.statSync(incrementPath).size }
        });
        assert.equal(appended.appendedRows, 1);
        assert.equal(appended.totalRows, 3);
        assert.equal(appended.sourceVersion, 2);

        const partitions = await createDatasetPartitions({ user, datasetId: dataset.id, fieldKey: 'c_1' });
        assert.equal(partitions.partitionCount, 2);
        assert.deepEqual(partitions.partitions.map(item => item.rowCount).sort((a, b) => a - b), [1, 2]);

        const materialization = await saveMaterialization({
            user,
            datasetId: dataset.id,
            body: {
                name: '按区域销售额',
                groupBy: ['c_1'],
                metrics: [{ name: '销售额', aggregation: 'sum', fieldKey: 'c_2' }]
            }
        });
        assert.equal(materialization.rowCount, 2);
        assert.equal(materialization.previewRows.length, 2);

        const state = await getScalabilityState(user, dataset.id);
        assert.equal(state.sourceVersion, 2);
        assert.equal(state.storageMode, 'managed_fs_partitioned');
        assert.equal(state.versions.length >= 2, true);
        assert.equal(state.materializations[0].id, materialization.id);
    } finally {
        cleanupAnalysisRows(user.id);
        removeTestPath(incrementDir, { recursive: true });
    }
});

test('数据分析历史可回放 AI 结果且百分比画像保持比例口径', async () => {
    const suffix = Date.now().toString(36);
    const username = `analysis_ai_${suffix}`;
    const userInfo = createAnalysisUser(username, 'Data Analysis AI Test');
    const userId = userInfo.lastInsertRowid;
    let dataset = null;
    try {
        dataset = await require('../server/services/data-analysis/datasets').createDatasetFromRows({
            user: { id: userId, username },
            name: '比例测试',
            rows: [{ metric: '12%' }, { metric: '18%' }],
            sourceType: 'database'
        });
        const metric = dataset.profile.find(column => column.name === 'metric');
        assert.equal(metric.numeric.avg, 0.15);
        await recordArtifact({
            userId,
            datasetId: dataset.id,
            type: 'ai_analysis',
            title: '比例分析',
            content: JSON.stringify({ answer: '已完成', scope: 'profile' }),
            metadata: { mode: 'summary' }
        });
        const artifacts = await listDatasetArtifacts(userId, dataset.id);
        assert.deepEqual(artifacts[0].analysis, { answer: '已完成', scope: 'profile' });
    } finally {
        cleanupAnalysisRows(userId);
    }
});

test('数据分析数据总览支持编辑修改数据集名称与原始文件名/备注', async () => {
    const suffix = Date.now().toString(36);
    const username = `analysis_edit_${suffix}`;
    const userInfo = createAnalysisUser(username, 'Data Analysis Edit Test');
    const userId = userInfo.lastInsertRowid;
    let dataset = null;
    try {
        dataset = await require('../server/services/data-analysis/datasets').createDatasetFromRows({
            user: { id: userId, username },
            name: '原始数据集名称',
            rows: [{ item: 'A', val: 10 }, { item: 'B', val: 20 }],
            sourceType: 'database'
        });
        assert.equal(dataset.name, '原始数据集名称');

        // 测试更新名称与原始文件名
        const updated = await updateDataset(userId, dataset.id, {
            name: '修改后的数据集名称',
            originalName: 'custom_source.xlsx'
        });
        assert.equal(updated.name, '修改后的数据集名称');
        assert.equal(updated.originalName, 'custom_source.xlsx');

        // 验证持久化详情
        const detail = await getDatasetDetail(userId, dataset.id);
        assert.equal(detail.name, '修改后的数据集名称');
        assert.equal(detail.originalName, 'custom_source.xlsx');

        // 验证前端契约包含编辑按钮与编辑弹窗，且右上角不包含多余关闭按钮
        const viewCode = fs.readFileSync(path.join(__dirname, '..', 'client', 'chat', 'data-analysis', 'view.js'), 'utf8');
        assert.match(viewCode, /data-data-analysis-action-edit/);
        assert.match(viewCode, /id="data-analysis-edit-dataset-modal"/);
        assert.match(viewCode, /id="data-analysis-edit-dataset-form"/);
        assert.match(viewCode, /id="data-analysis-edit-dataset-cancel"/);
        assert.ok(!viewCode.includes('id="data-analysis-edit-dataset-close"'));

        const eventsCode = fs.readFileSync(path.join(__dirname, '..', 'client', 'chat', 'data-analysis', 'events.js'), 'utf8');
        assert.match(eventsCode, /data-data-analysis-action-edit/);
        assert.match(eventsCode, /openEditDatasetModal/);
        assert.match(eventsCode, /submitEditDataset/);
    } finally {
        cleanupAnalysisRows(userId);
    }
});

test('数据分析产品层提供字段治理、计算字段、共享字段权限、保存视图、仪表盘、刷新和告警', async () => {
    const suffix = Date.now().toString(36);
    const ownerInfo = createAnalysisUser(`analysis_governance_${suffix}`, '治理所有者');
    const viewerInfo = createAnalysisUser(`analysis_viewer_${suffix}`, '治理查看者');
    const owner = { id: ownerInfo.lastInsertRowid, username: `analysis_governance_${suffix}`, unit: 'QA', role: 'user', status: 'active' };
    const viewer = { id: viewerInfo.lastInsertRowid, username: `analysis_viewer_${suffix}`, unit: 'QA', role: 'user', status: 'active' };
    let source;
    let output;
    try {
        source = await require('../server/services/data-analysis/datasets').createDatasetFromRows({
            user: owner,
            name: '治理销售数据',
            rows: [
                { region: '华东', amount: '100', secret: 'S-001' },
                { region: '华南', amount: '200', secret: 'S-002' }
            ],
            sourceType: 'database'
        });
        const initialFields = await listFieldGovernance(owner, source.id);
        assert.equal(initialFields.length, 3);
        const governed = await updateFieldGovernance({
            user: owner,
            datasetId: source.id,
            fields: [
                { fieldKey: 'c_1', displayName: '区域', isDimension: true, businessDefinition: '销售区域' },
                { fieldKey: 'c_2', displayName: '销售额', logicalType: 'number', unit: '元', isMetric: true, businessDefinition: '已确认销售金额' },
                { fieldKey: 'c_3', displayName: '客户密钥', sensitivity: 'restricted', businessDefinition: '仅所有者可见' }
            ]
        });
        assert.equal(governed.fields.find(item => item.fieldKey === 'c_2').unit, '元');
        assert.equal(governed.dataset.columns.find(item => item.key === 'c_2').name, '销售额');

        const preview = await previewCalculatedField({ user: owner, datasetId: source.id, input: { name: '含税销售额', expression: '{{c_2}} * 1.13', unit: '元' } });
        assert.equal(preview.formula.dependencies[0], 'c_2');
        assert.ok(Math.abs(Number(preview.rows[0].calculated_value) - 113) < 0.000001);
        const created = await materializeCalculatedField({ user: owner, datasetId: source.id, input: { name: '含税销售额', expression: '{{c_2}} * 1.13', unit: '元' } });
        output = created.dataset;
        assert.equal(output.parentDatasetId, source.id);
        assert.equal(output.columns.some(column => column.key === created.calculation.fieldKey), true);

        const view = await saveAnalysisView({
            user: owner,
            datasetId: source.id,
            body: { name: '销售额汇总', viewType: 'query', config: { sql: 'SELECT SUM("销售额") AS total FROM data', limit: 10 } }
        });
        const run = await runSavedView(owner, view.id);
        assert.equal(Number(run.result.rows[0].total), 300);

        const dashboard = await saveDashboard({ user: owner, body: { name: '销售看板' } });
        const widget = await saveDashboardItem({
            user: owner,
            dashboardId: dashboard.id,
            body: { title: '按区域销售额', itemType: 'chart', datasetId: source.id, config: { xField: 'c_1', yField: 'c_2', aggregation: 'sum', chartType: 'bar' } }
        });
        assert.equal(widget.dashboardId, dashboard.id);
        const refreshed = await refreshDashboard({ user: owner, dashboardId: dashboard.id });
        assert.equal(refreshed.snapshot.items[0].status, 'succeeded');
        const schedule = await saveRefreshSchedule({ user: owner, body: { name: '销售看板刷新', dashboardId: dashboard.id, frequency: 'interval', intervalMinutes: 5 } });
        assert.equal(schedule.frequency, 'interval');
        const alert = await saveAlertRule({
            user: owner,
            body: { name: '销售额阈值', datasetId: source.id, metricConfig: { fieldKey: 'c_2', aggregation: 'sum' }, operator: 'gt', threshold: 250 }
        });
        assert.equal(alert.datasetId, source.id);
        const alerts = await evaluateAlertRulesForDataset(owner, source.id);
        assert.equal(alerts.length, 1);

        await updateDataset(owner, source.id, { scope: 'shared', allowedUnits: ['QA'] });
        const sharedDetail = await getDatasetDetail(viewer, source.id);
        assert.equal(sharedDetail.columns.some(column => column.key === 'c_3'), false);
        assert.equal(sharedDetail.previewRows.every(row => !Object.prototype.hasOwnProperty.call(row, 'c_3')), true);
        const sharedQuery = await require('../server/services/data-analysis/query-pivot').runUserQuery(viewer, source.id, { sql: 'SELECT * FROM data', limit: 10 });
        assert.equal(sharedQuery.columns.includes('客户密钥'), false);
        await assert.rejects(
            require('../server/services/data-analysis/chart-summary').buildChart(viewer, source.id, { xField: 'c_1', yField: 'c_3', aggregation: 'count' }),
            error => error?.code === 'ANALYSIS_FIELD_ACCESS_DENIED'
        );
    } finally {
        cleanupAnalysisRows(owner.id);
        cleanupAnalysisRows(viewer.id);
    }
});

test('数据分析高级图表覆盖散点、堆叠、漏斗、热力、箱线和双轴口径', async () => {
    const suffix = Date.now().toString(36);
    const userInfo = createAnalysisUser(`analysis_charts_${suffix}`, '高级图表测试');
    const user = { id: userInfo.lastInsertRowid, username: `analysis_charts_${suffix}`, unit: 'QA', role: 'user', status: 'active' };
    let dataset;
    try {
        dataset = await require('../server/services/data-analysis/datasets').createDatasetFromRows({
            user,
            name: '高级图表数据',
            rows: [
                { category: '甲', amount: 10, quantity: 2, group: '一组' },
                { category: '甲', amount: 16, quantity: 3, group: '二组' },
                { category: '乙', amount: 20, quantity: 4, group: '一组' },
                { category: '乙', amount: 30, quantity: 6, group: '二组' }
            ],
            sourceType: 'database'
        });
        const { buildChart } = require('../server/services/data-analysis/chart-summary');
        const base = { xField: 'c_1', yField: 'c_2', aggregation: 'sum', limit: 20 };
        const cases = [
            ['scatter', { xField: 'c_2', yField: 'c_3' }, 'scatter'],
            ['stacked_bar', { groupField: 'c_4' }, 'bar'],
            ['funnel', {}, 'funnel'],
            ['heatmap', { groupField: 'c_4' }, 'heatmap'],
            ['boxplot', {}, 'boxplot'],
            ['dual_axis', { y2Field: 'c_3' }, 'bar']
        ];
        for (const [chartType, extra, expectedSeriesType] of cases) {
            const result = await buildChart(user, dataset.id, { ...base, ...extra, chartType });
            assert.equal(result.chart.chartType, chartType);
            assert.equal(result.chart.echartsOption.series[0].type, expectedSeriesType);
        }
    } finally {
        cleanupAnalysisRows(user.id);
    }
});

test('数据分析指标口径、跨数据集模型与可恢复异步查询保持受控边界', async () => {
    const suffix = Date.now().toString(36);
    const userInfo = createAnalysisUser(`analysis_semantic_${suffix}`, '语义模型测试');
    const user = { id: userInfo.lastInsertRowid, username: `analysis_semantic_${suffix}`, unit: 'QA', role: 'user', status: 'active' };
    let sales;
    let regions;
    try {
        sales = await require('../server/services/data-analysis/datasets').createDatasetFromRows({
            user, name: '订单事实表', rows: [{ region: '华东', amount: 100 }, { region: '华南', amount: 200 }], sourceType: 'database'
        });
        regions = await require('../server/services/data-analysis/datasets').createDatasetFromRows({
            user, name: '区域维表', rows: [{ region: '华东', manager: '甲' }, { region: '华南', manager: '乙' }], sourceType: 'database'
        });
        const metric = await saveMetricDefinition({
            user, datasetId: sales.id,
            body: { name: '确认销售额', description: '订单事实表销售额求和', unit: '元', metricConfig: { fieldKey: 'c_2', aggregation: 'sum' } }
        });
        const measured = await evaluateMetricDefinition(user, metric.id);
        assert.equal(measured.result.value, 300);

        const model = await saveDataModel({ user, body: { name: '订单区域模型', description: '订单关联区域负责人' } });
        const relation = await addDataModelRelation({
            user, modelId: model.id,
            body: { leftDatasetId: sales.id, leftFieldKey: 'c_1', rightDatasetId: regions.id, rightFieldKey: 'c_1', joinType: 'left', cardinality: 'many_to_one' }
        });
        assert.equal(relation.quality.leftRows, 2);
        const joined = await runDataModelJoin({ user, modelId: model.id, relationId: relation.id, limit: 10 });
        assert.equal(joined.rows.length, 2);
        assert.equal(joined.columns.some(column => column.includes('区域负责人') || column.includes('manager')), true);

        const job = await createAsyncQueryJob({ user, datasetId: sales.id, sql: 'SELECT SUM("amount") AS total FROM data', limit: 10000 });
        assert.equal(job.status, 'queued');
        const processed = await processAsyncQueryJobs({ limit: 1 });
        assert.equal(processed.processed, 1);
        const completed = await getAsyncQueryJob(user, job.id);
        assert.equal(completed.status, 'succeeded', completed.lastError);
        assert.equal(Number(completed.previewRows[0].total), 300);
    } finally {
        cleanupAnalysisRows(user.id);
    }
});

test.after(() => {
    if (previousAnalysisDir !== undefined) process.env.PIVOT_ANALYSIS_DIR = previousAnalysisDir;
    else delete process.env.PIVOT_ANALYSIS_DIR;
    if (previousMaxRows !== undefined) process.env.DATA_ANALYSIS_MAX_ROWS = previousMaxRows;
    else delete process.env.DATA_ANALYSIS_MAX_ROWS;
    try {
        removeTestPath(analysisTestRoot, { recursive: true, maxRetries: 3, retryDelay: 50 });
    } catch (_err) {}
});
