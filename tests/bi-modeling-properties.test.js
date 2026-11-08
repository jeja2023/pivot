'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { DuckDBInstance } = require('@duckdb/node-api');
const { compileModelQuery } = require('../server/services/data-analysis/bi/query');
const { consumeModelQuery } = require('../server/services/data-analysis/bi/result');
const { checkModelQuality } = require('../server/services/data-analysis/bi/quality');

// 独立整数分参考实现不调用语义编译器、指标求值器或生产十进制模块。
function money(cents) { return `${cents < 0n ? '-' : ''}${(cents < 0n ? -cents : cents) / 100n}.${((cents < 0n ? -cents : cents) % 100n).toString().padStart(2, '0')}`; }
function rounded(numerator, denominator) {
    const negative = numerator < 0n, value = negative ? -numerator : numerator;
    return (value / denominator + (value % denominator * 2n >= denominator ? 1n : 0n)) * (negative ? -1n : 1n);
}
function random(seed) { let value = seed >>> 0; return () => { value ^= value << 13; value ^= value >>> 17; value ^= value << 5; return value >>> 0; }; }
function reference(rows) {
    const cents = rows.reduce((sum, row) => sum + row.cents, 0n), orders = BigInt(new Set(rows.map(row => row.order)).size);
    return { sum: money(cents), orders: orders.toString(), rows: String(rows.length), average: money(rounded(cents, BigInt(rows.length))), average_order: money(rounded(cents, orders)) };
}
function definition() {
    return { nodes: [{ id: 'fact', datasetId: 'facts', role: 'fact', grainKeys: ['id'] }], relations: [], dimensions: [{ id: 'group', nodeId: 'fact', fieldKey: 'region' }], metrics: [
        { id: 'sum', type: 'sum', field: { nodeId: 'fact', fieldKey: 'amount' }, scale: 2 }, { id: 'orders', type: 'count_distinct', field: { nodeId: 'fact', fieldKey: 'order_id' }, scale: 0 },
        { id: 'rows', type: 'count', scale: 0 }, { id: 'average', type: 'avg', field: { nodeId: 'fact', fieldKey: 'amount' }, scale: 2 },
        { id: 'average_order', type: 'derived', scale: 2, expression: { op: 'divide', args: [{ metricId: 'sum' }, { metricId: 'orders' }] } }
    ] };
}

test('固定随机种子差分：行序、合法未使用左维度和 Top N 均不改变完整精确总计', async () => {
    for (const seed of [1, 7, 42, 12345, 0xdeadbeef, 20261107]) {
        const next = random(seed);
        const rows = Array.from({ length: 60 }, (_, index) => ({ id: String(index), order: `O${next() % 19}`, region: `R${next() % 5}`, customer: `C${next() % 7}`, cents: BigInt(Number(next() % 200001) - 100000) }));
        const expected = reference(rows);
        const instance = await DuckDBInstance.create(':memory:'), connection = await instance.connect();
        try {
            await connection.run('CREATE TEMP TABLE bi_input_0(id VARCHAR,order_id VARCHAR,region VARCHAR,customer VARCHAR,amount VARCHAR)');
            await connection.run("CREATE TEMP TABLE bi_input_1 AS SELECT 'C'||i AS customer, '未使用'||i AS label FROM range(7) t(i)");
            const sources = { fact: { tableName: 'bi_input_0', columns: ['id', 'order_id', 'region', 'customer', 'amount'].map(key => ({ key })) }, dimension: { tableName: 'bi_input_1', columns: [{ key: 'customer' }, { key: 'label' }] } };
            async function replace(values) { await connection.run('DELETE FROM bi_input_0'); for (const row of values) await connection.run('INSERT INTO bi_input_0 VALUES (?,?,?,?,?)', [row.id, row.order, row.region, row.customer, money(row.cents)]); }
            async function run(model, limit) { return consumeModelQuery(connection, compileModelQuery(model, { dimensions: ['group'], metrics: Object.keys(expected), limit }, sources)); }
            await replace(rows);
            const model = definition(), result = await run(model, 100);
            for (const [id, value] of Object.entries(expected)) assert.equal(result.total.values[id].value, value, `种子 ${seed} 指标 ${id}`);
            for (const group of result.rows) {
                const expectedGroup = reference(rows.filter(row => row.region === group.members.group.label));
                for (const [id, value] of Object.entries(expectedGroup)) assert.equal(group.values[id].value, value, `种子 ${seed} 分组 ${group.members.group.label} 指标 ${id}`);
            }
            const shuffled = rows.map(row => ({ row, priority: next() })).sort((left, right) => left.priority - right.priority).map(item => item.row);
            await replace(shuffled);
            assert.deepEqual((await run(model, 1)).total, result.total, `种子 ${seed} 行序与 Top N`);
            model.nodes.push({ id: 'dimension', datasetId: 'dimensions', role: 'dimension', grainKeys: ['customer'] });
            model.relations.push({ id: 'unused', leftNodeId: 'fact', rightNodeId: 'dimension', joinType: 'left', cardinality: 'many_to_one', keyPairs: [{ leftFieldKey: 'customer', rightFieldKey: 'customer' }] });
            const quality = await checkModelQuality(connection, model, sources);
            assert.equal(quality.passed, true, `种子 ${seed} 合法多对一`);
            assert.deepEqual((await run(model, 2)).total, result.total, `种子 ${seed} 未使用左维度`);
            assert.equal(result.total.values.rows.value, '60');
        } finally { connection.closeSync(); instance.closeSync(); }
    }
});
