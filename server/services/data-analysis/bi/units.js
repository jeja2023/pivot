'use strict';

const { biError } = require('./errors');

function signature(value) { return JSON.stringify(Object.entries(value).filter(([, power]) => power !== 0).sort(([left], [right]) => left < right ? -1 : 1)); }
function inferMetricUnits(ordered) {
    const units = new Map();
    function invalid() { throw biError('ANALYSIS_MODEL_UNIT_INVALID', '指标公式的单位或币种不兼容，请核对加减两侧的业务口径。'); }
    function expression(node) {
        if (Object.hasOwn(node, 'metricId')) return units.get(node.metricId);
        if (Object.hasOwn(node, 'constant')) return {};
        const left = expression(node.args[0]), right = expression(node.args[1]);
        if (['add', 'subtract'].includes(node.op)) { if (signature(left) !== signature(right)) invalid(); return left; }
        const result = { ...left };
        for (const [key, power] of Object.entries(right)) result[key] = (result[key] || 0) + (node.op === 'divide' ? -power : power);
        return Object.fromEntries(Object.entries(result).filter(([, power]) => power !== 0));
    }
    for (const metric of ordered) {
        let value;
        if (metric.type === 'derived') value = expression(metric.expression);
        else if (metric.currency) value = { [`currency:${metric.currency}`]: 1 };
        else if (metric.currencyField) value = { [`currency-field:${metric.currencyField.nodeId}:${metric.currencyField.fieldKey}`]: 1 };
        else value = metric.unit && metric.unit !== '%' ? { [`unit:${metric.unit}`]: 1 } : {};
        units.set(metric.id, value);
    }
    return units;
}

module.exports = { inferMetricUnits };
