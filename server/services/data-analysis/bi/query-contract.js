'use strict';

const { BI_POLICY } = require('./policy');
const { canonicalJson, canonicalHash } = require('./canonical');
const { normalizeFilters } = require('./definition');
const { biError } = require('./errors');

function invalid(message) { throw biError('ANALYSIS_MODEL_QUERY_INVALID', message); }
function positive(value, label) { if (!Number.isSafeInteger(value) || value < 1) invalid(`${label}必须为有效正整数。`); return value; }
function identifiers(value, label, max) {
    if (!Array.isArray(value) || value.length > max || value.some(id => typeof id !== 'string' || !/^[\p{L}\p{N}_-]{1,120}$/u.test(id)) || new Set(value).size !== value.length) invalid(`${label}格式、数量或标识无效。`);
    return value;
}
function requestKey(value) { if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{8,120}$/.test(value)) invalid('请提供八至一百二十位的请求幂等标识。'); return value; }

function normalizeModelQuery(input, { trial = false } = {}) {
    if (Buffer.byteLength(canonicalJson(input), 'utf8') > BI_POLICY.maxRequestBytes) invalid('模型分析请求超过一 MiB 上限。');
    if (!input || typeof input !== 'object' || Array.isArray(input)) invalid('模型查询必须是对象。');
    const allowed = ['dimensions', 'metrics', 'filters', 'orderBy', 'limit', 'execution', 'requestKey', 'binding', ...(trial ? ['expectedVersion', 'checkId'] : ['publishedVersion'])];
    if (Object.keys(input).some(key => !allowed.includes(key))) invalid('查询包含未支持的参数；请使用维度、指标和结构化筛选。');
    const query = { dimensions: identifiers(input.dimensions || [], '分组维度', BI_POLICY.maxDimensions), metrics: identifiers(input.metrics, '指标', BI_POLICY.maxMetrics), filters: normalizeFilters(input.filters), orderBy: [], limit: input.limit ?? 100 };
    if (!query.metrics.length) invalid('请选择至少一个指标。');
    if (!Number.isSafeInteger(query.limit) || query.limit < 1 || query.limit > 5000) invalid('展示行数必须为一至五千的整数。');
    if (!Array.isArray(input.orderBy || []) || (input.orderBy || []).length > 15) invalid('排序配置无效。');
    for (const order of input.orderBy || []) {
        if (!order || typeof order !== 'object' || Array.isArray(order) || Object.keys(order).some(key => !['metricId', 'dimensionId', 'direction'].includes(key))
            || !['asc', 'desc'].includes(order.direction) || Boolean(order.metricId) === Boolean(order.dimensionId)
            || (order.metricId && !query.metrics.includes(order.metricId)) || (order.dimensionId && !query.dimensions.includes(order.dimensionId))) invalid('排序必须引用已选择的维度或指标。');
        query.orderBy.push({ ...(order.metricId ? { metricId: order.metricId } : { dimensionId: order.dimensionId }), direction: order.direction });
    }
    const execution = input.execution || 'auto';
    if (!['auto', 'async'].includes(execution)) invalid('正式模型通过持久任务执行，请选择自动或后台执行。');
    const binding = input.binding || { strategy: 'latest' };
    if (!binding || typeof binding !== 'object' || Array.isArray(binding) || Object.keys(binding).some(key => !['strategy', 'manifestId'].includes(key)) || !['latest', 'historical'].includes(binding.strategy)
        || (binding.strategy === 'historical' && (typeof binding.manifestId !== 'string' || !/^[\w-]{1,120}$/.test(binding.manifestId)))) invalid('数据清单绑定策略无效。');
    const result = { query, execution, requestKey: requestKey(input.requestKey), binding: binding.strategy === 'latest' ? { strategy: 'latest' } : { strategy: 'historical', manifestId: binding.manifestId } };
    if (trial) { result.expectedVersion = positive(input.expectedVersion, '草稿修订号'); if (typeof input.checkId !== 'string' || !/^[\w-]{1,120}$/.test(input.checkId)) invalid('草稿试算需要明确的检查标识。'); result.checkId = input.checkId; }
    else result.publishedVersion = positive(input.publishedVersion, '模型发布版本');
    result.requestHash = canonicalHash({ query, binding: result.binding, publishedVersion: result.publishedVersion ?? null, expectedVersion: result.expectedVersion ?? null, checkId: result.checkId ?? null });
    return result;
}

module.exports = { normalizeModelQuery, requestKey };
