'use strict';

const { BI_POLICY } = require('./policy');
const { biError } = require('./errors');
const { parseDecimal, formatDecimal, decimalFromRatio } = require('./decimal');
const { inferMetricUnits } = require('./units');

const ATOMIC_TYPES = new Set(['count', 'count_nonnull', 'count_distinct', 'sum', 'avg', 'min', 'max']);
const ID_PATTERN = /^[\p{L}\p{N}_-]{1,120}$/u;

function invalid(message) { throw biError('ANALYSIS_MODEL_METRIC_INVALID', message); }

function validateMetricDefinitions(metrics, factNodeId) {
    if (!Array.isArray(metrics) || !metrics.length || metrics.length > 1000) invalid('模型需要定义指标，指标数量不能超过一千个。');
    const byId = new Map();
    for (const metric of metrics) {
        if (!metric || !ID_PATTERN.test(metric.id || '') || byId.has(metric.id)) invalid('指标标识无效或重复。');
        if (!ATOMIC_TYPES.has(metric.type) && metric.type !== 'derived') invalid('指标类型不受支持。');
        if (!Number.isSafeInteger(metric.scale) || metric.scale < 0 || metric.scale > BI_POLICY.maxDecimalPrecision) invalid('指标小数位配置无效。');
        if (metric.type.startsWith('count') && metric.scale !== 0) invalid('计数指标必须使用整数精度。');
        if (metric.additivity && !['additive', 'non_additive'].includes(metric.additivity)) invalid('当前不支持未明确实现规则的半可加指标。');
        if (ATOMIC_TYPES.has(metric.type) && metric.type !== 'count' && !(metric.type === 'count_distinct' && metric.grainKey === true)) {
            if (metric.field?.nodeId !== factNodeId || !ID_PATTERN.test(metric.field?.fieldKey || '')) invalid('基础指标只能引用事实表的有效字段。');
        }
        if (metric.type === 'derived' && !metric.expression) invalid('派生指标需要受控表达式。');
        if (metric.validFrom && !Number.isFinite(Date.parse(metric.validFrom))) invalid('指标生效时间无效。');
        if (metric.validTo && !Number.isFinite(Date.parse(metric.validTo))) invalid('指标到期时间无效。');
        if (metric.validFrom && metric.validTo && Date.parse(metric.validFrom) >= Date.parse(metric.validTo)) invalid('指标生效时间必须早于到期时间。');
        byId.set(metric.id, metric);
    }
    const dependencies = new Map();
    for (const metric of metrics) {
        const refs = new Set();
        let count = 0;
        const ancestors = new Set();
        function walk(expression, depth) {
            if (++count > BI_POLICY.maxExpressionNodes || depth > BI_POLICY.maxExpressionNodes) invalid('指标表达式超过复杂度上限。');
            if (!expression || typeof expression !== 'object' || Array.isArray(expression) || ancestors.has(expression)) invalid('指标表达式结构无效。');
            if (Object.hasOwn(expression, 'metricId')) {
                if (Object.keys(expression).length !== 1 || !byId.has(expression.metricId)) invalid('指标表达式引用不存在的指标。');
                refs.add(expression.metricId); return;
            }
            if (Object.hasOwn(expression, 'constant')) {
                if (Object.keys(expression).length !== 1 || typeof expression.constant !== 'string' || parseDecimal(expression.constant) === null) invalid('指标常量必须是有效十进制字符串。');
                return;
            }
            if (!['add', 'subtract', 'multiply', 'divide'].includes(expression.op) || Object.keys(expression).some(key => !['op', 'args'].includes(key)) || !Array.isArray(expression.args) || expression.args.length !== 2) invalid('指标表达式只支持两个操作数的加减乘除。');
            ancestors.add(expression);
            try { expression.args.forEach(arg => walk(arg, depth + 1)); }
            finally { ancestors.delete(expression); }
        }
        if (metric.type === 'derived') walk(metric.expression, 0);
        dependencies.set(metric.id, refs);
    }
    const ordered = [], depths = new Map(), active = new Set();
    function traverseMetricPlan(id) {
        if (active.has(id)) invalid('指标存在循环依赖。');
        if (depths.has(id)) return depths.get(id);
        active.add(id);
        let depth = 0;
        for (const ref of dependencies.get(id)) depth = Math.max(depth, traverseMetricPlan(ref));
        if (byId.get(id).type === 'derived') depth++;
        if (depth > BI_POLICY.maxDerivedDepth) invalid('派生指标依赖最多三层。');
        active.delete(id); depths.set(id, depth); ordered.push(byId.get(id));
        return depth;
    }
    for (const id of byId.keys()) traverseMetricPlan(id);
    return { byId, ordered, dependencies, units: inferMetricUnits(ordered) };
}

function requiredMetricClosure(plan, metricIds) {
    if (!Array.isArray(metricIds) || !metricIds.length || metricIds.length > BI_POLICY.maxMetrics || new Set(metricIds).size !== metricIds.length) invalid('请选择一至十个不同的指标。');
    const needed = new Set();
    function traverseMetricPlan(id) {
        if (needed.has(id)) return;
        const metric = plan.byId.get(id);
        if (!metric) invalid('查询引用了不存在的指标。');
        needed.add(id);
        for (const ref of plan.dependencies.get(id)) traverseMetricPlan(ref);
    }
    metricIds.forEach(traverseMetricPlan);
    return plan.ordered.filter(metric => needed.has(metric.id));
}

function requiredMetrics(plan, metricIds, evaluationTime = Date.now()) {
    if (!Number.isFinite(evaluationTime)) invalid('指标计算时间无效。');
    const metrics = requiredMetricClosure(plan, metricIds);
    for (const metric of metrics) {
        if (metric.validFrom && Date.parse(metric.validFrom) > evaluationTime) throw biError('ANALYSIS_METRIC_NOT_ACTIVE', '当前指标尚未生效。', 409);
        if (metric.validTo && Date.parse(metric.validTo) <= evaluationTime) throw biError('ANALYSIS_METRIC_EXPIRED', '当前指标已过期，请选择有效口径。', 409);
    }
    return metrics;
}

// 原子聚合的值必须来自同一事实范围；均值传回精确的分子与有效值数量。
function evaluateMetricValues(orderedMetrics, aggregates, { currencyValues = {} } = {}) {
    const fieldCurrencies = new Map();
    for (const metric of orderedMetrics) if (metric.currencyField && currencyValues[metric.id]?.code) fieldCurrencies.set(`${metric.currencyField.nodeId}:${metric.currencyField.fieldKey}`, currencyValues[metric.id].code);
    const runtimeUnits = inferMetricUnits(orderedMetrics.map(metric => {
        const code = metric.currencyField && (currencyValues[metric.id]?.code || fieldCurrencies.get(`${metric.currencyField.nodeId}:${metric.currencyField.fieldKey}`));
        return code ? { ...metric, currencyField: undefined, currency: code } : metric;
    }));
    const exact = new Map();
    const result = Object.create(null);
    function ratio(numerator, denominator, nullReason = null) {
        if (numerator === null) return { numerator: null, denominator: 1n, nullReason };
        let left = numerator < 0n ? -numerator : numerator, right = denominator < 0n ? -denominator : denominator;
        while (right) { const remainder = left % right; left = right; right = remainder; }
        const divisor = left || 1n;
        const sign = denominator < 0n ? -1n : 1n;
        numerator = numerator / divisor * sign; denominator = denominator / divisor * sign;
        if (numerator.toString(2).length > 65536 || denominator.toString(2).length > 65536) invalid('指标中间计算超过允许的复杂度，请简化表达式。');
        return { numerator, denominator, nullReason: null };
    }
    function fromDecimal(value, nullReason = 'no_valid_values') {
        return value === null ? ratio(null, 1n, nullReason) : ratio(value.coefficient, 10n ** BigInt(value.scale));
    }
    function calculateRatio(operation, left, right) {
        if (left.numerator === null || right.numerator === null) return ratio(null, 1n, left.nullReason || right.nullReason);
        if (operation === 'divide') return right.numerator === 0n ? ratio(null, 1n, 'zero_denominator') : ratio(left.numerator * right.denominator, left.denominator * right.numerator);
        if (operation === 'multiply') return ratio(left.numerator * right.numerator, left.denominator * right.denominator);
        const signedRight = operation === 'subtract' ? -right.numerator : right.numerator;
        return ratio(left.numerator * right.denominator + signedRight * left.denominator, left.denominator * right.denominator);
    }
    function expressionValue(expression) {
        if (Object.hasOwn(expression, 'metricId')) return exact.get(expression.metricId);
        if (Object.hasOwn(expression, 'constant')) return fromDecimal(parseDecimal(expression.constant));
        return calculateRatio(expression.op, expressionValue(expression.args[0]), expressionValue(expression.args[1]));
    }
    for (const metric of orderedMetrics) {
        let evaluated;
        const currency = currencyValues[metric.id];
        if (metric.currencyField && !currency) invalid('金额聚合缺少币种验证信息。');
        if (currency && BigInt(currency.missingCount || '0') > 0n) throw biError('ANALYSIS_MODEL_CURRENCY_INVALID', '金额存在无效或缺失币种，请先修复来源。');
        if (currency && BigInt(currency.distinctCount) > 1n) evaluated = ratio(null, 1n, 'mixed_currency');
        else if (metric.type === 'derived') evaluated = expressionValue(metric.expression);
        else if (metric.type === 'avg') {
            const aggregate = aggregates[metric.id];
            if (!aggregate || !Object.hasOwn(aggregate, 'sum') || !Object.hasOwn(aggregate, 'count')) invalid('平均值缺少聚合分子或有效值数量。');
            const sum = parseDecimal(aggregate.sum), count = parseDecimal(aggregate.count);
            if (count === null || count.scale !== 0 || count.coefficient < 0n) invalid('平均值的有效值数量必须为非负整数。');
            evaluated = sum === null || count.coefficient === 0n ? ratio(null, 1n, 'no_valid_values') : calculateRatio('divide', fromDecimal(sum), fromDecimal(count));
        } else {
            if (!Object.hasOwn(aggregates, metric.id)) invalid('指标缺少对应的聚合结果。');
            const value = parseDecimal(aggregates[metric.id]);
            if (metric.type.startsWith('count') && (value === null || value.scale !== 0 || value.coefficient < 0n)) invalid('计数聚合结果必须为非负整数。');
            evaluated = fromDecimal(value);
        }
        exact.set(metric.id, evaluated);
        const currencies = Object.entries(runtimeUnits.get(metric.id)).filter(([key, power]) => key.startsWith('currency:') && power === 1);
        result[metric.id] = { value: evaluated.numerator === null ? null : formatDecimal(decimalFromRatio(evaluated.numerator, evaluated.denominator, metric.scale)),
            type: metric.type.startsWith('count') ? 'integer' : 'decimal', scale: metric.scale, unit: metric.unit || '', currency: evaluated.nullReason === 'mixed_currency' ? null : (currencies.length === 1 ? currencies[0][0].slice(9) : null), nullReason: evaluated.nullReason };
    }
    return result;
}

module.exports = { validateMetricDefinitions, requiredMetricClosure, requiredMetrics, evaluateMetricValues };
