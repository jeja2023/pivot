'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { canonicalJson, canonicalHash } = require('../server/services/data-analysis/bi/canonical');
const { BI_POLICY } = require('../server/services/data-analysis/bi/policy');
const { parseDecimal, formatDecimal, rescaleDecimal, decimalAdd, decimalSubtract, decimalMultiply, decimalDivide, compareDecimals } = require('../server/services/data-analysis/bi/decimal');
const { planModelGraph, requiredModelRelations } = require('../server/services/data-analysis/bi/graph');
const fixture = require('./fixtures/bi-modeling/orders-v1.json');

test('语义指纹对属性顺序稳定，保留数组、中文和原始文本差异', () => {
    assert.equal(canonicalJson({ z: 1, a: '中文\r\n' }), '{"a":"中文\\r\\n","z":1}');
    assert.equal(canonicalHash({ a: { x: 1, y: 2 }, b: [2, 1] }), canonicalHash({ b: [2, 1], a: { y: 2, x: 1 } }));
    assert.notEqual(canonicalHash({ a: [1, 2] }), canonicalHash({ a: [2, 1] }));
    assert.notEqual(canonicalHash('e\u0301'), canonicalHash('é'));
    assert.throws(() => canonicalHash({ a: Infinity }), { code: 'ANALYSIS_MODEL_CANONICAL_NUMBER' });
    assert.throws(() => canonicalHash({ a: Number.MAX_SAFE_INTEGER + 1 }), { code: 'ANALYSIS_MODEL_CANONICAL_NUMBER' });
    const cyclic = {}; cyclic.self = cyclic;
    assert.throws(() => canonicalHash(cyclic), { code: 'ANALYSIS_MODEL_CANONICAL_INVALID' });
    assert.throws(() => canonicalHash(new Date()), { code: 'ANALYSIS_MODEL_CANONICAL_INVALID' });
    assert.throws(() => canonicalHash([, 1]), { code: 'ANALYSIS_MODEL_CANONICAL_INVALID' });
});

test('金额运算精确处理同额记录、大整数、半值舍入与溢出', () => {
    const decimal = value => parseDecimal(value);
    assert.equal(formatDecimal(decimalAdd(decimal('0.10'), decimal('0.20'))), '0.30');
    assert.equal(formatDecimal(decimalAdd(decimal('100'), decimal('100'))), '200');
    assert.equal(formatDecimal(decimalAdd(decimal('9007199254740993.01'), decimal('0.02'))), '9007199254740993.03');
    assert.equal(formatDecimal(decimalSubtract(decimal('1.10'), decimal('2.20'))), '-1.10');
    assert.equal(formatDecimal(decimalMultiply(decimal('2.5'), decimal('-4'))), '-10.0');
    assert.equal(formatDecimal(rescaleDecimal(decimal('-1.005'), 2)), '-1.01');
    assert.equal(formatDecimal(rescaleDecimal(decimal('1.005'), 2)), '1.01');
    assert.equal(formatDecimal(decimalDivide(decimal('1'), decimal('8'), 2)), '0.13');
    assert.equal(formatDecimal(decimalDivide(decimal('-1'), decimal('8'), 2)), '-0.13');
    assert.equal(decimalDivide(decimal('1'), decimal('0')), null);
    assert.equal(decimalAdd(null, decimal('1')), null);
    assert.equal(compareDecimals(decimal('0.001'), decimal('0.01')), -1);
    assert.equal(compareDecimals(decimal('1'), decimal('1.00')), 0);
    assert.throws(() => decimalAdd(decimal('9'.repeat(38)), decimal('1')), { code: 'ANALYSIS_MODEL_NUMERIC_OVERFLOW' });
    assert.throws(() => parseDecimal(0.1), { code: 'ANALYSIS_MODEL_NUMERIC_INVALID' });
});

test('数值转换规则显式开启货币、千分位及百分号，拒绝无效格式', () => {
    assert.equal(formatDecimal(parseDecimal('￥1,200.50', { allowCurrency: true, allowThousands: true })), '1200.50');
    assert.equal(formatDecimal(parseDecimal('25%', { allowPercent: true })), '0.25');
    assert.equal(parseDecimal(''), null);
    for (const input of ['NaN', 'Infinity', '1e3', '1,20', '12.3.4', '￥20', '25%']) {
        assert.throws(() => parseDecimal(input, { allowThousands: true }), { code: 'ANALYSIS_MODEL_NUMERIC_INVALID' });
    }
    assert.equal(formatDecimal(parseDecimal('12.345', { scale: 2, precision: 4 })), '12.35');
    assert.throws(() => parseDecimal('123.45', { scale: 2, precision: 4 }), { code: 'ANALYSIS_MODEL_NUMERIC_OVERFLOW' });
});

function model() {
    return {
        nodes: [
            { id: 'sales', datasetId: 'ds_sales', role: 'fact', grainKeys: ['order_id', 'line_id'] },
            { id: 'customers', datasetId: 'ds_customers', role: 'dimension', grainKeys: ['id'] },
            { id: 'products', datasetId: 'ds_products', role: 'dimension', grainKeys: ['id'] }
        ],
        relations: [
            { id: 'r_customers', leftNodeId: 'sales', rightNodeId: 'customers', joinType: 'left', cardinality: 'many_to_one', keyPairs: [{ leftFieldKey: 'customer_id', rightFieldKey: 'id' }] },
            { id: 'r_products', leftNodeId: 'sales', rightNodeId: 'products', joinType: 'left', cardinality: 'many_to_one', keyPairs: [{ leftFieldKey: 'product_id', rightFieldKey: 'id' }] }
        ]
    };
}

test('事实根规划支持单表和星型，内关联保持范围且无关左关联可裁剪', () => {
    const input = model();
    assert.equal(planModelGraph({ nodes: [input.nodes[0]], relations: [] }).factNodeId, 'sales');
    const plan = planModelGraph(input);
    assert.equal(plan.relations.length, 2);
    assert.deepEqual(requiredModelRelations(plan, ['sales']), []);
    assert.deepEqual(requiredModelRelations(plan, ['products']).map(relation => relation.id), ['r_products']);
    input.relations[0].joinType = 'inner';
    assert.deepEqual(requiredModelRelations(planModelGraph(input), ['sales']).map(relation => relation.id), ['r_customers']);
    assert.throws(() => requiredModelRelations(plan, ['outside']), { code: 'ANALYSIS_MODEL_GRAPH_INVALID' });
    assert.equal(BI_POLICY.maxRelations, 8);
});

test('关系规划阻断重复表、缺失粒度、多路径、非连通和多对多', () => {
    const input = model();
    const copy = () => JSON.parse(JSON.stringify(input));
    let changed = copy(); changed.nodes[0].grainKeys = [];
    assert.throws(() => planModelGraph(changed), { code: 'ANALYSIS_MODEL_GRAIN_REQUIRED' });
    changed = copy(); changed.nodes[2].datasetId = 'ds_customers';
    assert.throws(() => planModelGraph(changed), /数据集重复/);
    changed = copy(); changed.relations.pop();
    assert.throws(() => planModelGraph(changed), /连通/);
    changed = copy(); changed.relations[0].cardinality = 'many_to_many';
    assert.throws(() => planModelGraph(changed), { code: 'ANALYSIS_MODEL_CARDINALITY_INVALID' });
    changed = copy(); changed.relations.push({ ...changed.relations[0], id: 'r_duplicate' });
    assert.throws(() => planModelGraph(changed), /父关系/);
    changed = copy(); changed.nodes[1].grainKeys = ['id', 'tenant_id'];
    assert.throws(() => planModelGraph(changed), /完整覆盖/);
});

test('业务黄金集独立核算金额、订单去重、均值、比率及内关联范围', () => {
    const sum = rows => rows.reduce((total, row) => decimalAdd(total, parseDecimal(row.amount)), parseDecimal('0.00'));
    const total = sum(fixture.fact);
    assert.equal(formatDecimal(total), fixture.expected.total.sales);
    assert.equal(String(new Set(fixture.fact.map(row => row.order_id)).size), fixture.expected.total.orders);
    assert.equal(formatDecimal(decimalDivide(total, parseDecimal('5'), 2)), fixture.expected.total.average_line);
    assert.equal(formatDecimal(decimalDivide(total, parseDecimal('4'), 2)), fixture.expected.total.average_order);
    const known = new Set(fixture.customers.map(customer => customer.id));
    assert.equal(formatDecimal(sum(fixture.fact.filter(row => known.has(row.customer_id)))), fixture.expected.customer_inner.sales);
    assert.equal(formatDecimal(decimalDivide(parseDecimal('4'), parseDecimal('5'), 4)), fixture.expected.total.confirmation_rate);
    assert.equal(formatDecimal(sum([...fixture.fact].reverse())), fixture.expected.total.sales);
});
