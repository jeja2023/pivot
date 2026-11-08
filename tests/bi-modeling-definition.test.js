'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeModelDefinition, normalizeFilters } = require('../server/services/data-analysis/bi/definition');

function example() {
    return { grainDescription: '一条订单商品明细', nodes: [{ id: 'orders', datasetId: 'dataset_orders', role: 'fact', grainKeys: ['order', 'line'] }],
        dimensions: [{ id: 'month', nodeId: 'orders', fieldKey: 'date', logicalType: 'date', granularity: 'month' }],
        metrics: [{ id: 'amount', type: 'sum', field: { nodeId: 'orders', fieldKey: 'amount' }, currency: 'CNY', unit: '元', description: '订单实付金额' }] };
}

test('模型合同显式固定规则和时区，集合排序产生跨客户端一致的语义哈希', () => {
    const input = example();
    input.metrics.push({ id: 'count', type: 'count' });
    const first = normalizeModelDefinition(input);
    assert.equal(first.definition.timezone, 'Asia/Shanghai');
    assert.equal(first.definition.metrics[0].numeric.precision, 18);
    assert.equal(first.definition.metrics[0].numeric.scale, 2);
    assert.equal(first.definition.freshnessPolicy, 'strict');
    assert.equal(first.definition.engineVersion, 'duckdb-1.5');
    input.metrics.reverse();
    assert.equal(normalizeModelDefinition(input).semanticHash, first.semanticHash);
    assert.equal(normalizeModelDefinition(first.definition).semanticHash, first.semanticHash);
    assert.deepEqual(first.issues, []);
});

test('草稿允许不完整口径，正式检查要求粒度说明、主键和至少一个指标', () => {
    const input = { nodes: [{ id: 'fact', datasetId: 'data', role: 'fact' }] };
    const draft = normalizeModelDefinition(input, { complete: false });
    assert.ok(draft.issues.length >= 3);
    assert.throws(() => normalizeModelDefinition(input), /业务事件/);
    input.grainDescription = '一条记录';
    assert.throws(() => normalizeModelDefinition(input), /粒度/);
    assert.throws(() => normalizeModelDefinition({ ...input, sql: 'SELECT 1' }, { complete: false }), /未支持/);
});

test('合同拒绝不兼容编译器、猜测时区、半可加规则与非法币种策略', () => {
    assert.throws(() => normalizeModelDefinition({ ...example(), compilerVersion: 'future' }), error => error.status === 409);
    assert.throws(() => normalizeModelDefinition({ ...example(), timezone: 'invalid/zone' }), /时区/);
    const input = example();
    input.metrics[0].additivity = 'semi_additive';
    assert.throws(() => normalizeModelDefinition(input), /半可加/);
    delete input.metrics[0].additivity;
    input.metrics[0].invalidValuePolicy = 'ignore';
    assert.throws(() => normalizeModelDefinition(input), /金额转换/);
    input.metrics[0].invalidValuePolicy = 'block'; input.metrics[0].validTo = '2026-11-30';
    assert.throws(() => normalizeModelDefinition(input), /时区/);
    input.metrics[0].validTo = '2026-02-30T00:00:00+08:00';
    assert.throws(() => normalizeModelDefinition(input), /无效日期/);
    input.metrics[0].validTo = '2028-02-29T23:59:59+08:00';
    assert.equal(normalizeModelDefinition(input).definition.metrics[0].validTo, '2028-02-29T15:59:59.000Z');
});

test('结构化筛选有数量、类型和精度边界，不接受可执行片段', () => {
    assert.deepEqual(normalizeFilters([{ dimensionId: 'month', operator: 'range', value: ['2026-11-01', '2026-12-01'] }])[0].value, ['2026-11-01', '2026-12-01']);
    assert.throws(() => normalizeFilters([{ field: { nodeId: 'fact', fieldKey: 'amount' }, operator: 'eq', value: Number.MAX_SAFE_INTEGER + 1 }]), /字符串/);
    assert.throws(() => normalizeFilters([{ dimensionId: 'month', operator: 'in', value: Array(1001).fill('x') }]), /上限/);
    assert.throws(() => normalizeFilters([{ dimensionId: 'month', operator: 'eq', value: { sql: '1' } }]), /普通值/);
    assert.throws(() => normalizeFilters([{ dimensionId: 'month', operator: 'contains', value: 1 }]), /文本/);
});

test('模型维度、币种字段与指标允许分组必须引用确定的模型对象', () => {
    const input = example(); input.metrics[0].allowedDimensionIds = ['deleted'];
    assert.throws(() => normalizeModelDefinition(input), /不存在/);
    input.metrics[0].allowedDimensionIds = ['month'];
    input.dimensions[0].nodeId = 'other';
    assert.throws(() => normalizeModelDefinition(input), /节点不存在/);
    input.dimensions[0].nodeId = 'orders'; input.dimensions[0].memberKeyFields = ['date', 'date'];
    assert.throws(() => normalizeModelDefinition(input), /重复/);
});
