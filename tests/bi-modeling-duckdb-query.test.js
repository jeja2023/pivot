'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { DuckDBInstance } = require('@duckdb/node-api');
const { compileModelQuery } = require('../server/services/data-analysis/bi/query');
const { checkModelQuality } = require('../server/services/data-analysis/bi/quality');
const { consumeModelQuery } = require('../server/services/data-analysis/bi/result');
const { evaluateMetricValues } = require('../server/services/data-analysis/bi/metrics');
const { decimalProjection, keyProjection, dimensionProjection } = require('../server/services/data-analysis/bi/sql-expressions');
const fixture = require('./fixtures/bi-modeling/orders-v1.json');

function definition() {
    return {
        timezone: 'Asia/Shanghai',
        nodes: [
            { id: 'sales', datasetId: 'ds_sales', role: 'fact', grainKeys: ['order_id', 'line_id'] },
            { id: 'customers', datasetId: 'ds_customers', role: 'dimension', grainKeys: ['id'] },
            { id: 'products', datasetId: 'ds_products', role: 'dimension', grainKeys: ['id'] }
        ],
        relations: [
            { id: 'r_customers', leftNodeId: 'sales', rightNodeId: 'customers', joinType: 'left', cardinality: 'many_to_one', keyPairs: [{ leftFieldKey: 'customer_id', rightFieldKey: 'id', normalization: { type: 'text' } }] },
            { id: 'r_products', leftNodeId: 'sales', rightNodeId: 'products', joinType: 'left', cardinality: 'many_to_one', keyPairs: [{ leftFieldKey: 'product_id', rightFieldKey: 'id', normalization: { type: 'text' } }] }
        ],
        dimensions: [
            { id: 'region', nodeId: 'customers', fieldKey: 'region' },
            { id: 'product', nodeId: 'products', fieldKey: 'name', memberKeyFields: ['id'] },
            { id: 'month', nodeId: 'sales', fieldKey: 'date', logicalType: 'date', granularity: 'month' }
        ],
        metrics: [
            { id: 'sales', type: 'sum', scale: 2, field: { nodeId: 'sales', fieldKey: 'amount' }, numeric: { precision: 18, scale: 2 } },
            { id: 'orders', type: 'count_distinct', scale: 0, field: { nodeId: 'sales', fieldKey: 'order_id' } },
            { id: 'rows', type: 'count', scale: 0 },
            { id: 'average_line', type: 'avg', scale: 2, field: { nodeId: 'sales', fieldKey: 'amount' } },
            { id: 'average_order', type: 'derived', scale: 2, expression: { op: 'divide', args: [{ metricId: 'sales' }, { metricId: 'orders' }] } }
        ]
    };
}

async function withData(run) {
    const instance = await DuckDBInstance.create(':memory:');
    const connection = await instance.connect();
    const sources = {};
    try {
        for (const [index, [id, rows]] of Object.entries({ sales: fixture.fact, customers: fixture.customers, products: fixture.products }).entries()) {
            const tableName = `bi_input_${index}`;
            const columns = Object.keys(rows[0]);
            await connection.run(`CREATE TEMP TABLE "${tableName}" (${columns.map(key => `"${key}" VARCHAR`).join(',')})`);
            for (const row of rows) await connection.run(`INSERT INTO "${tableName}" VALUES (${columns.map(() => '?').join(',')})`, columns.map(key => row[key]));
            sources[id] = { tableName, columns: columns.map(key => ({ key })) };
        }
        await run(connection, sources);
    } finally { connection.closeSync(); instance.closeSync(); }
}

async function execute(connection, sources, model, query) {
    const compiled = compileModelQuery(model, query, sources);
    const raw = (await connection.runAndReadAll(compiled.sql, compiled.parameters)).getRowObjectsJson();
    const rows = raw.map(row => {
        const aggregates = Object.create(null);
        for (const column of compiled.aggregateColumns) aggregates[column.id] = column.countColumn ? { sum: row[column.valueColumn], count: row[column.countColumn] } : row[column.valueColumn];
        return { ...row, values: evaluateMetricValues(compiled.metrics, aggregates) };
    });
    return { rows, compiled };
}

test('真实 DuckDB 从完整事实范围按地区分组，保留未匹配成员并重新计算总计', async () => withData(async (connection, sources) => {
    const { rows } = await execute(connection, sources, definition(), { dimensions: ['region'], metrics: ['sales', 'orders', 'rows', 'average_line', 'average_order'], limit: 1 });
    const total = rows.find(row => row.is_total);
    for (const id of ['sales', 'orders', 'rows', 'average_line', 'average_order']) assert.equal(total.values[id].value, fixture.expected.total[id]);
    const detail = rows.filter(row => !row.is_total);
    assert.equal(detail.length, 3);
    assert.equal(detail.find(row => row.d0_label === '北区').values.sales.value, '220.00');
    const unmatched = detail.find(row => row.d0_unmatched);
    assert.equal(unmatched.values.sales.value, '80.00');
    assert.equal(unmatched.d0_label, null);
}));

test('产品分组去重订单数不能相加为总计，内关联未展示时仍限制事实范围', async () => withData(async (connection, sources) => {
    const result = await execute(connection, sources, definition(), { dimensions: ['product'], metrics: ['sales', 'orders'] });
    assert.equal(result.rows.filter(row => !row.is_total).reduce((count, row) => count + Number(row.values.orders.value), 0), 5);
    assert.equal(result.rows.find(row => row.is_total).values.orders.value, '4');
    const model = definition(); model.relations[0].joinType = 'inner';
    const inner = await execute(connection, sources, model, { dimensions: [], metrics: ['sales', 'rows', 'orders'] });
    assert.equal(inner.rows.length, 1);
    assert.equal(inner.rows[0].values.sales.value, '270.00');
    assert.equal(inner.rows[0].values.rows.value, '4');
    assert.equal(inner.rows[0].values.orders.value, '3');
    assert.deepEqual(inner.compiled.joins.map(relation => relation.id), ['r_customers']);
}));

test('筛选参数绑定、条件均值与日期粒度在相同事实范围生效', async () => withData(async (connection, sources) => {
    const model = definition();
    model.metrics.find(metric => metric.id === 'average_line').filters = [{ field: { nodeId: 'sales', fieldKey: 'status' }, operator: 'eq', value: '已确认' }];
    const result = await execute(connection, sources, model, { dimensions: ['month'], metrics: ['sales', 'average_line'], filters: [{ dimensionId: 'region', operator: 'eq', value: '北区' }] });
    assert.equal(result.rows.find(row => row.is_total).values.sales.value, '220.00');
    assert.equal(result.rows.find(row => row.is_total).values.average_line.value, '73.33');
    assert.equal(result.rows.find(row => !row.is_total).d0_label, '2026-11-01');
    const noInjection = await execute(connection, sources, model, { dimensions: [], metrics: ['sales'], filters: [{ dimensionId: 'region', operator: 'eq', value: "北区' OR 1=1 --" }] });
    assert.equal(noInjection.rows[0].values.sales.value, null);
}));

test('转换按精确十进制执行，整数键不将小数舍入，带时区时间点按业务日分组', async () => withData(async connection => {
    const money = decimalProjection('value', { precision: 18, scale: 4, allowCurrency: true, allowThousands: true, allowPercent: true });
    const parsed = (await connection.runAndReadAll(`SELECT ${money.sql} AS amount, ${money.invalidSql} AS invalid FROM (VALUES ('￥1,200.50'), ('25.555%'), ('1,20'), ('')) t(value)`)).getRowObjectsJson();
    assert.deepEqual(parsed.map(row => row.amount), ['1200.5000', '0.2556', null, null]);
    assert.deepEqual(parsed.map(row => row.invalid), [false, false, true, false]);
    const key = keyProjection('value', { type: 'integer' });
    const keys = (await connection.runAndReadAll(`SELECT ${key.sql} AS id FROM (VALUES ('001'), ('1.5'), ('1')) t(value)`)).getRowObjectsJson();
    assert.deepEqual(keys.map(row => row.id), ['1', null, '1']);
    const localDay = dimensionProjection('value', { logicalType: 'timestamp', granularity: 'day' }, 'Asia/Shanghai');
    const days = (await connection.runAndReadAll(`SELECT ${localDay} AS day FROM (VALUES ('2026-11-01T16:01:00Z'), ('2026-11-01 12:00:00')) t(value)`)).getRowObjectsJson();
    assert.deepEqual(days.map(row => row.day), ['2026-11-02', null]);
}));

test('模型编译拒绝未授权字段、用户来源路径和非法查询规模', async () => withData(async (_connection, sources) => {
    const model = definition(), query = { dimensions: ['region'], metrics: ['sales'] };
    const inaccessible = { ...sources, customers: { ...sources.customers, columns: [{ key: 'id' }] } };
    assert.throws(() => compileModelQuery(model, query, inaccessible), /不可访问/);
    assert.throws(() => compileModelQuery(model, query, { ...sources, sales: { ...sources.sales, tableName: '/secret.parquet' } }), /受控/);
    assert.throws(() => compileModelQuery(model, { ...query, limit: 5001 }, sources), /展示上限/);
    assert.throws(() => compileModelQuery(model, { ...query, filters: [{ field: { nodeId: 'sales', fieldKey: 'amount' }, operator: 'sql', value: '1=1' }] }, sources), /不受支持/);
}));

test('全量质量检查绑定事实粒度和完整关系，返回未匹配警告并阻断维度重复', async () => withData(async (connection, sources) => {
    const report = await checkModelQuality(connection, definition(), sources);
    assert.equal(report.fullScan, true);
    assert.equal(report.passed, true);
    assert.equal(report.grains.find(item => item.nodeId === 'sales').rowCount, '5');
    assert.equal(report.relations.find(item => item.relationId === 'r_customers').unmatchedLeftRows, '1');
    assert.equal(report.relations.find(item => item.relationId === 'r_customers').leftMatchRate, '0.80000000');
    assert.equal(report.warnings.length, 1);
    await connection.run('INSERT INTO bi_input_1 VALUES (?, ?)', ['C1', '重复地区']);
    const duplicate = await checkModelQuality(connection, definition(), sources);
    assert.equal(duplicate.passed, false);
    assert.ok(duplicate.blockers.some(issue => issue.code === 'ANALYSIS_MODEL_GRAIN_DUPLICATE'));
    assert.ok(duplicate.blockers.some(issue => issue.code === 'ANALYSIS_MODEL_CARDINALITY_INVALID'));
}));

test('粒度重复、无效金额和日期在检查阶段阻断，不能只提示后继续正式分析', async () => withData(async (connection, sources) => {
    const model = definition(); model.nodes[0].grainKeys = ['order_id'];
    assert.ok((await checkModelQuality(connection, model, sources)).blockers.some(issue => issue.code === 'ANALYSIS_MODEL_GRAIN_DUPLICATE'));
    await connection.run('UPDATE bi_input_0 SET amount = ?, date = ? WHERE order_id = ?', ['无效金额', '2026-02-30', 'O2']);
    const report = await checkModelQuality(connection, definition(), sources);
    assert.equal(report.passed, false);
    assert.ok(report.blockers.some(issue => issue.code === 'ANALYSIS_MODEL_NUMERIC_INVALID'));
    assert.ok(report.blockers.some(issue => issue.code === 'ANALYSIS_MODEL_DATE_INVALID'));
}));

test('流式消费仅保留 Top N，派生指标排序和总计仍基于完整分组', async () => withData(async (connection, sources) => {
    const compiled = compileModelQuery(definition(), { dimensions: ['region'], metrics: ['sales', 'orders', 'average_order'], limit: 1, orderBy: [{ metricId: 'sales', direction: 'desc' }] }, sources);
    const written = [];
    const result = await consumeModelQuery(connection, compiled, { onRow: async (row, state) => written.push({ row, state }) });
    assert.equal(result.rows.length, 1);
    assert.equal(result.rows[0].members.region.label, '北区');
    assert.equal(result.rows[0].values.sales.value, '220.00');
    assert.equal(result.total.values.sales.value, '350.00');
    assert.equal(result.total.values.orders.value, '4');
    assert.equal(result.groupCount, '3');
    assert.equal(result.truncated, true);
    assert.equal(written.filter(item => !item.state.total).length, 3);
    const average = compileModelQuery(definition(), { dimensions: ['region'], metrics: ['average_order'], limit: 2, orderBy: [{ metricId: 'average_order', direction: 'desc' }] }, sources);
    const ranked = await consumeModelQuery(connection, average);
    assert.deepEqual(ranked.rows.map(row => row.values.average_order.value), ['110.00', '80.00']);
}));

test('无维度和空数据产生明确总计，取消信号不会返回部分成功', async () => withData(async (connection, sources) => {
    let compiled = compileModelQuery(definition(), { dimensions: [], metrics: ['sales', 'rows'] }, sources);
    assert.equal((await consumeModelQuery(connection, compiled)).rows[0].values.sales.value, '350.00');
    await connection.run('DELETE FROM bi_input_0');
    const empty = await consumeModelQuery(connection, compiled);
    assert.equal(empty.total.values.sales.value, null);
    assert.equal(empty.total.values.rows.value, '0');
    const controller = new AbortController(); controller.abort();
    compiled = compileModelQuery(definition(), { dimensions: ['region'], metrics: ['sales'] }, sources);
    await assert.rejects(consumeModelQuery(connection, compiled, { signal: controller.signal }), { code: 'ANALYSIS_MODEL_QUERY_CANCELLED' });
}));

test('复合粒度去重逐字段处理，标签变更不拆分成员或改变成员标识', async () => withData(async (connection, sources) => {
    const model = definition();
    model.metrics.push({ id: 'grain_count', type: 'count_distinct', grainKey: true, scale: 0 });
    model.dimensions.push({ id: 'customer_member', nodeId: 'sales', fieldKey: 'status', memberKeyFields: ['customer_id'] });
    const first = await consumeModelQuery(connection, compileModelQuery(model, { dimensions: ['customer_member'], metrics: ['sales', 'grain_count'] }, sources));
    assert.equal(first.total.values.grain_count.value, '5'); assert.equal(first.rows.length, 3);
    const before = first.rows.find(row => row.members.customer_member.key[0] === 'C1');
    await connection.run("UPDATE bi_input_0 SET status='新标签' WHERE order_id='O4'");
    const after = await consumeModelQuery(connection, compileModelQuery(model, { dimensions: ['customer_member'], metrics: ['sales', 'grain_count'] }, sources));
    assert.equal(after.rows.length, 3);
    assert.equal(after.rows.find(row => row.members.customer_member.key[0] === 'C1').rowKey, before.rowKey);
    assert.equal(after.rows.find(row => row.rowKey === before.rowKey).values.sales.value, '220.00');
}));

test('混合币种必须隔离，分币种结果保留精确值且总计不相加不同币种', async () => withData(async (connection, sources) => {
    await connection.run("ALTER TABLE bi_input_0 ADD COLUMN currency VARCHAR DEFAULT 'CNY'");
    await connection.run("UPDATE bi_input_0 SET currency='USD' WHERE order_id='O3'");
    sources.sales.columns.push({ key: 'currency' });
    const model = definition();
    model.dimensions.push({ id: 'currency', nodeId: 'sales', fieldKey: 'currency' });
    model.metrics[0].currencyField = { nodeId: 'sales', fieldKey: 'currency' };
    assert.throws(() => compileModelQuery(model, { dimensions: [], metrics: ['sales'] }, sources), /按币种分组/);
    const grouped = await consumeModelQuery(connection, compileModelQuery(model, { dimensions: ['currency'], metrics: ['sales'] }, sources));
    assert.equal(grouped.rows.find(row => row.members.currency.label === 'CNY').values.sales.value, '270.00');
    assert.equal(grouped.rows.find(row => row.members.currency.label === 'USD').values.sales.currency, 'USD');
    assert.equal(grouped.total.values.sales.value, null); assert.equal(grouped.total.values.sales.nullReason, 'mixed_currency');
    const isolated = await consumeModelQuery(connection, compileModelQuery(model, { dimensions: [], metrics: ['sales'], filters: [{ dimensionId: 'currency', operator: 'eq', value: 'CNY' }] }, sources));
    assert.equal(isolated.total.values.sales.value, '270.00'); assert.equal(isolated.total.values.sales.currency, 'CNY');
    await connection.run("UPDATE bi_input_0 SET currency=NULL WHERE order_id='O1'");
    const invalid = await checkModelQuality(connection, model, sources);
    assert.ok(invalid.blockers.some(issue => issue.code === 'ANALYSIS_MODEL_CURRENCY_INVALID'));
}));

test('显式关联匹配率阈值和指标允许分组作为强约束执行', async () => withData(async (connection, sources) => {
    const model = definition(); model.relations[0].minMatchRate = '0.90000000';
    assert.ok((await checkModelQuality(connection, model, sources)).blockers.some(issue => issue.code === 'ANALYSIS_MODEL_MATCH_THRESHOLD'));
    model.relations[0].minMatchRate = '0.8';
    assert.equal((await checkModelQuality(connection, model, sources)).passed, true);
    model.metrics[0].allowedDimensionIds = ['month'];
    assert.throws(() => compileModelQuery(model, { dimensions: ['region'], metrics: ['sales'] }, sources), /不允许/);
}));
