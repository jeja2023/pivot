'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pivot-model-query-'));
const quote = value => `'${String(value).replace(/'/g, "''")}'`;
const ident = value => `"${String(value).replace(/"/g, '""')}"`;
const datasets = new Map();
let relations = [];
let deniedDataset = '';
let deniedField = '';
let DuckDBInstance;
const mocks = {
    '../server/services/data-analysis/semantic-models': { getDataModel: async () => ({ model: { relations } }) },
    '../server/services/data-analysis/governance': {
        getAccessibleDatasetColumns: async (_user, dataset) => dataset.columns.filter(column => column.key !== deniedField),
        assertDatasetFieldsAccessible: async (_user, _dataset, keys) => { if (keys.includes(deniedField)) throw new Error('字段受限'); }
    },
    '../server/services/data-analysis/shared': {
        getDatasetForUser: async (_user, id) => { if (id === deniedDataset) throw new Error('数据集无权访问'); return datasets.get(id); },
        getDatasetPaths: dataset => ({ parquetPath: dataset.path }), sqlIdent: ident, sqlLiteral: quote,
        withAnalysisSlot: fn => fn(), withDuckTimeout: (_connection, fn) => fn(),
        createDuckConnection: async () => { const instance = await DuckDBInstance.create(':memory:'); return { instance, connection: await instance.connect() }; }
    }
};
for (const [name, exports] of Object.entries(mocks)) {
    const filename = require.resolve(name);
    require.cache[filename] = { id: filename, filename, loaded: true, exports };
}
const { planRelations, runDataModelAnalysis } = require('../server/services/data-analysis/model-analysis');

test('多表模型汇总使用关联后的完整数据并执行权限检查', async () => {
    ({ DuckDBInstance } = require('@duckdb/node-api'));
    const instance = await DuckDBInstance.create(':memory:');
    const connection = await instance.connect();
    try {
        for (const [id, sql, columns] of [
            ['sales', "SELECT * FROM (VALUES ('E', 100), ('W', 200), ('X', 50)) t(region, amount)", ['region', 'amount']],
            ['regions', "SELECT * FROM (VALUES ('E', 'A'), ('W', 'B')) t(region, manager)", ['region', 'manager']],
            ['managers', "SELECT * FROM (VALUES ('A', '一组'), ('B', '二组')) t(manager, team)", ['manager', 'team']]
        ]) {
            const file = path.join(root, `${id}.parquet`);
            await connection.run(`COPY (${sql}) TO ${quote(file)} (FORMAT PARQUET)`);
            datasets.set(id, { path: file, columns: columns.map(key => ({ key })) });
        }
    } finally { connection.closeSync(); instance.closeSync(); }
    relations = [
        { status: 'active', leftDatasetId: 'sales', leftFieldKey: 'region', rightDatasetId: 'regions', rightFieldKey: 'region', joinType: 'left' },
        { status: 'active', leftDatasetId: 'regions', leftFieldKey: 'manager', rightDatasetId: 'managers', rightFieldKey: 'manager', joinType: 'left' }
    ];
    const input = { user: { id: 1 }, modelId: 'model', dimension: { datasetId: 'managers', fieldKey: 'team' }, measure: { datasetId: 'sales', fieldKey: 'amount' }, aggregation: 'sum' };
    const result = await runDataModelAnalysis(input);
    assert.deepEqual(result.rows.map(row => [row['分组'], Number(row['汇总值'])]), [['二组', 200], ['一组', 100], [null, 50]]);
    assert.equal((await runDataModelAnalysis({ ...input, limit: 1 })).truncated, true);
    deniedDataset = 'regions';
    await assert.rejects(runDataModelAnalysis(input), /无权访问/);
    deniedDataset = '';
    deniedField = 'manager';
    await assert.rejects(runDataModelAnalysis(input), /字段受限/);
    deniedField = 'amount';
    await assert.rejects(runDataModelAnalysis(input), /可访问/);
});

test('关联规划拒绝环路和孤立表', () => {
    const relation = (leftDatasetId, rightDatasetId) => ({ leftDatasetId, rightDatasetId, status: 'active' });
    assert.deepEqual(planRelations([relation('a', 'b'), relation('c', 'd'), relation('b', 'c')]).datasetIds, ['a', 'b', 'c', 'd']);
    assert.throws(() => planRelations([relation('a', 'b'), relation('b', 'a')]), /环路/);
    assert.throws(() => planRelations([relation('a', 'b'), relation('c', 'd')]), /不相连/);
});

test.after(() => fs.rmSync(root, { recursive: true, force: true }));
