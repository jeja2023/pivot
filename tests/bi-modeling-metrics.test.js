'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { validateMetricDefinitions, requiredMetricClosure, requiredMetrics, evaluateMetricValues } = require('../server/services/data-analysis/bi/metrics');

const field = fieldKey => ({ nodeId: 'fact', fieldKey });
const reference = metricId => ({ metricId });
const operation = (op, left, right) => ({ op, args: [left, right] });
const metrics = [
    { id: 'sales', type: 'sum', field: field('amount'), scale: 2 },
    { id: 'orders', type: 'count_distinct', field: field('order_id'), scale: 0 },
    { id: 'rows', type: 'count', scale: 0 },
    { id: 'average_line', type: 'avg', field: field('amount'), scale: 2 },
    { id: 'average_order', type: 'derived', scale: 2, expression: operation('divide', reference('sales'), reference('orders')) }
];

test('历史授权的指标闭包保留到期依赖，新计算仍按有效期拒绝且不允许未知引用', () => {
    const plan = validateMetricDefinitions(metrics.map(metric => metric.id === 'sales' ? { ...metric, validTo: '2026-01-01T00:00:00Z' } : metric), 'fact');
    assert.deepEqual(requiredMetricClosure(plan, ['average_order']).map(metric => metric.id), ['sales', 'orders', 'average_order']);
    assert.throws(() => requiredMetrics(plan, ['average_order'], Date.parse('2026-11-07T00:00:00Z')), error => error.code === 'ANALYSIS_METRIC_EXPIRED');
    assert.throws(() => requiredMetricClosure(plan, ['missing']), error => error.code === 'ANALYSIS_MODEL_METRIC_INVALID');
});

test('指标依赖闭包覆盖未直接选择的分子分母，计数及平均值精确返回字符串', () => {
    const plan = validateMetricDefinitions(metrics, 'fact');
    const selected = requiredMetrics(plan, ['average_order', 'average_line', 'rows']);
    const result = evaluateMetricValues(selected, { sales: '350.00', orders: '4', rows: '5', average_line: { sum: '350.00', count: '5' } });
    assert.equal(result.sales.value, '350.00');
    assert.equal(result.average_order.value, '87.50');
    assert.equal(result.average_line.value, '70.00');
    assert.equal(result.rows.value, '5');
    assert.equal(result.rows.type, 'integer');
    assert.equal(result.average_order.nullReason, null);
    assert.deepEqual(requiredMetrics(plan, ['rows']).map(metric => metric.id), ['rows']);
});

test('表达式及依赖指标之间均不按显示精度提前舍入', () => {
    const tiny = { id: 'tiny', type: 'derived', scale: 2, expression: operation('divide', { constant: '1' }, { constant: '1000000000' }) };
    const restored = { id: 'restored', type: 'derived', scale: 2, expression: operation('multiply', reference('tiny'), { constant: '1000000000' }) };
    const result = evaluateMetricValues(requiredMetrics(validateMetricDefinitions([tiny, restored], 'fact'), ['restored']), {});
    assert.equal(result.tiny.value, '0.00');
    assert.equal(result.restored.value, '1.00');
    const third = { id: 'third', type: 'derived', scale: 8, expression: operation('divide', { constant: '1' }, { constant: '3' }) };
    const whole = { id: 'whole', type: 'derived', scale: 8, expression: operation('multiply', reference('third'), { constant: '3' }) };
    const exact = evaluateMetricValues(requiredMetrics(validateMetricDefinitions([third, whole], 'fact'), ['whole']), {});
    assert.equal(exact.whole.value, '1.00000000');
});

test('指标空集、空值与零分母保留原因，不显示伪造的零比率', () => {
    const selected = requiredMetrics(validateMetricDefinitions(metrics, 'fact'), ['average_order', 'average_line']);
    let result = evaluateMetricValues(selected, { sales: '0.00', orders: '0', average_line: { sum: null, count: '0' } });
    assert.equal(result.average_order.value, null);
    assert.equal(result.average_order.nullReason, 'zero_denominator');
    assert.equal(result.average_line.nullReason, 'no_valid_values');
    result = evaluateMetricValues(selected, { sales: null, orders: '0', average_line: { sum: null, count: '0' } });
    assert.equal(result.sales.value, null);
    assert.equal(result.average_order.nullReason, 'no_valid_values');
    assert.throws(() => evaluateMetricValues(selected, { sales: '1', orders: '-1', average_line: { sum: '1', count: '1' } }), /非负整数/);
});

test('指标阻断维度聚合、未知引用、循环依赖、过深表达式及任意执行语言', () => {
    assert.throws(() => validateMetricDefinitions([{ id: 'bad', type: 'sum', scale: 2, field: { nodeId: 'dimension', fieldKey: 'amount' } }], 'fact'), /事实表/);
    const derived = (id, expression) => ({ id, type: 'derived', scale: 2, expression });
    assert.throws(() => validateMetricDefinitions([derived('bad', reference('outside'))], 'fact'), /不存在/);
    assert.throws(() => validateMetricDefinitions([derived('a', reference('b')), derived('b', reference('a'))], 'fact'), /循环/);
    assert.throws(() => validateMetricDefinitions([derived('a', { constant: '1' }), derived('b', reference('a')), derived('c', reference('b')), derived('d', reference('c'))], 'fact'), /三层/);
    assert.throws(() => validateMetricDefinitions([derived('bad', { sql: 'SELECT 1' })], 'fact'), /加减乘除/);
    let expression = { constant: '1' };
    for (let index = 0; index < 60; index++) expression = operation('add', expression, { constant: '1' });
    assert.throws(() => validateMetricDefinitions([derived('bad', expression)], 'fact'), /复杂度/);
});

test('到期和未生效指标在依赖闭包中检查，不能通过派生指标绕过', () => {
    const expired = { id: 'old', type: 'count', scale: 0, validTo: '2026-11-01T00:00:00+08:00' };
    const wrapped = { id: 'wrapped', type: 'derived', scale: 0, expression: reference('old') };
    const plan = validateMetricDefinitions([expired, wrapped], 'fact');
    assert.throws(() => requiredMetrics(plan, ['wrapped'], Date.parse('2026-11-07T00:00:00+08:00')), { code: 'ANALYSIS_METRIC_EXPIRED' });
    const future = validateMetricDefinitions([{ ...expired, validTo: null, validFrom: '2026-12-01T00:00:00+08:00' }], 'fact');
    assert.throws(() => requiredMetrics(future, ['old'], Date.parse('2026-11-07T00:00:00+08:00')), { code: 'ANALYSIS_METRIC_NOT_ACTIVE' });
});

test('公式拒绝相加不同单位或币种，受控除法继承分子的金额币种', () => {
    const money = { ...metrics[0], currency: 'CNY' };
    const dollar = { ...metrics[0], id: 'dollar', currency: 'USD' };
    const sum = { id: 'sum', type: 'derived', scale: 2, expression: operation('add', reference('sales'), reference('dollar')) };
    assert.throws(() => validateMetricDefinitions([money, dollar, sum], 'fact'), error => error.code === 'ANALYSIS_MODEL_UNIT_INVALID');
    const plan = validateMetricDefinitions([money, metrics[1], metrics[4]], 'fact');
    const value = evaluateMetricValues(plan.ordered, { sales: '350.00', orders: '4' });
    assert.equal(value.average_order.currency, 'CNY');
    const metres = { ...metrics[0], id: 'distance', unit: '米' };
    assert.throws(() => validateMetricDefinitions([money, metres, { ...sum, expression: operation('add', reference('sales'), reference('distance')) }], 'fact'), /单位或币种/);
});
