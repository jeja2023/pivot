const nodePath = require('node:path');

const analysisTestRoot = nodePath.resolve(__dirname, '..', 'artifacts', 'data-analysis-test-' + process.pid + '-' + Date.now());
process.env.PIVOT_ANALYSIS_DIR = analysisTestRoot;

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
    getDatasetSummary
} = require('../server/services/data-analysis/datasets');

function cleanupAnalysisRows(userId) {
    db.prepare('DELETE FROM analysis_artifacts WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM analysis_datasets WHERE user_id = ?').run(userId);
}

test('数据分析支持上传 SQLite 文件生成数据集', async () => {
    const suffix = Date.now().toString(36);
    const username = `analysis_sqlite_${suffix}`;
    const userInfo = db.prepare(`
        INSERT INTO users (username, password_hash, nickname, unit, role, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, datetime('now', '+8 hours'))
    `).run(username, 'hash', 'Data Analysis SQLite Test', 'QA', 'user', 'active');
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
        db.prepare('DELETE FROM users WHERE id = ?').run(userId);
        removeTestPath(tempDir, { recursive: true });
        try {
            removeTestPath(analysisTestRoot, { recursive: true, maxRetries: 1, retryDelay: 20 });
        } catch (_err) {
            // Windows may release DuckDB-read Parquet handles shortly after the test exits.
        }
    }
});
