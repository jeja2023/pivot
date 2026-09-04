const nodePath = require('node:path');

const analysisTestRoot = nodePath.resolve(__dirname, '..', 'artifacts', 'data-analysis-test-' + process.pid + '-' + Date.now());
process.env.PIVOT_ANALYSIS_DIR = analysisTestRoot;
process.env.DATA_ANALYSIS_MAX_ROWS = '1000';

const {
    assert,
    db,
    fs,
    path,
    removeTestPath,
    test,
    uploadRoot
} = require('./security-helpers');
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
        try {
            removeTestPath(analysisTestRoot, { recursive: true, maxRetries: 1, retryDelay: 20 });
        } catch (_err) {
            // Windows may release DuckDB-read Parquet handles shortly after the test exits.
        }
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
        try { removeTestPath(analysisTestRoot, { recursive: true, maxRetries: 1, retryDelay: 20 }); } catch (_err) {}
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
        try { removeTestPath(analysisTestRoot, { recursive: true, maxRetries: 1, retryDelay: 20 }); } catch (_err) {}
    }
});
