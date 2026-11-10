'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { DuckDBInstance } = require('@duckdb/node-api');
const { sqlLiteral } = require('../server/services/data-analysis/bi/sql-expressions');
const { normalizeFlowGraph, resolveExecutionPlan } = require('../server/services/data-analysis/bi/flow-graph');
const { compileAndMaterializePlan } = require('../server/services/data-analysis/bi/flow-engine');

async function execute(kind, config, values) {
    const instance = await DuckDBInstance.create(':memory:');
    const connection = await instance.connect();
    try {
        await connection.run(`CREATE TABLE src AS SELECT * FROM (VALUES ${values.map(value => `(${value === null ? 'NULL' : sqlLiteral(value)},'应剔除字段')`).join(',')}) v(amount,secret)`);
        const nodes = [{ id: 'fact', role: 'fact', datasetId: 'ds' }];
        const graph = normalizeFlowGraph({ nodes: [{ id: 'op', kind, name: '验证节点', config }], edges: [{ id: 'edge', fromNodeId: 'fact', toNodeId: 'op' }] }, { definitionNodeIds: new Set(['fact']) });
        const output = await compileAndMaterializePlan(connection, resolveExecutionPlan('op', nodes, graph), new Map([['ds', 'src']]));
        return (await connection.runAndReadAll(`SELECT * FROM "${output.stepTables.get('op')}"`)).getRowObjectsJson();
    } finally { connection.closeSync(); instance.closeSync(); }
}

test('数值等于与不等于互斥，文本编号保留前导零，空值不被误选', async () => {
    const values = ['100', '100.00', '00100', '200', 'abc', null];
    const filter = (operator, valueType = 'auto') => execute('filter', { conditions: [{ field: 'amount', operator, value: '100', valueType }] }, values);
    assert.deepEqual((await filter('eq')).map(row => row.amount), ['100', '100.00', '00100']);
    assert.deepEqual((await filter('neq')).map(row => row.amount), ['200', 'abc']);
    assert.deepEqual((await filter('eq', 'text')).map(row => row.amount), ['100']);
    assert.deepEqual((await filter('neq', 'number')).map(row => row.amount), ['200']);
    assert.deepEqual((await execute('filter', { conditions: [{ field: 'amount', operator: 'in', value: '100,200', valueType: 'number' }] }, values)).map(row => row.amount), values.slice(0, 4));
});

test('最大最小值按数值比较，十进制金额汇总不丢失大整数尾数，文本统计明确选择', async () => {
    const aggregations = [{ fn: 'min', field: 'amount', alias: 'min' }, { fn: 'max', field: 'amount', alias: 'max' }];
    const rows = await execute('aggregate', { aggregations }, ['9', '100', '20']);
    assert.equal(Number(rows[0].min), 9); assert.equal(Number(rows[0].max), 100);
    const total = await execute('aggregate', { aggregations: [{ fn: 'sum', field: 'amount', alias: 'total' }] }, ['9999999999999999.99', '0.01']);
    assert.equal(total[0].total, '10000000000000000.00000000');
    const average = await execute('aggregate', { aggregations: [{ fn: 'avg', field: 'amount', alias: 'average' }] }, ['9999999999999999.98', '0.01']);
    assert.equal(average[0].average, '4999999999999999.99500000');
    const half = await execute('aggregate', { aggregations: [{ fn: 'avg', field: 'amount', alias: 'average' }] }, ['-0.00000001', '0']);
    assert.equal(half[0].average, '-0.00000001');
    const text = await execute('aggregate', { aggregations: aggregations.map(item => ({ ...item, valueType: 'text' })) }, ['b', 'a']);
    assert.deepEqual(text, [{ min: 'a', max: 'b' }]);
    await assert.rejects(execute('aggregate', { aggregations }, ['9', '无效']), error => error.code === 'ANALYSIS_MODEL_FLOW_INVALID');
});

test('明确取消所有输出字段必须阻断，未配置选择仍可预览原字段', async () => {
    await assert.rejects(execute('select', { columns: [{ field: 'amount', enabled: false }, { field: 'secret', enabled: false }] }, ['1']), error => error.code === 'ANALYSIS_MODEL_FLOW_INVALID');
    assert.deepEqual(Object.keys((await execute('select', { columns: [] }, ['1']))[0]), ['amount', 'secret']);
});

test('服务端阻断多余输入和向来源节点接线，不能忽略连线后执行另一条口径', () => {
    const sources = new Set(['fact', 'dim1', 'dim2']);
    assert.throws(() => normalizeFlowGraph({ nodes: [{ id: 'join', kind: 'join' }], edges: [...sources].map((id, index) => ({ id: `e${index}`, fromNodeId: id, toNodeId: 'join' })) }, { definitionNodeIds: sources }), error => error.code === 'ANALYSIS_MODEL_FLOW_INVALID');
    assert.throws(() => normalizeFlowGraph({ nodes: [{ id: 'src', kind: 'source' }], edges: [{ id: 'e', fromNodeId: 'fact', toNodeId: 'src' }] }, { definitionNodeIds: sources }), error => error.code === 'ANALYSIS_MODEL_FLOW_INVALID');
});
