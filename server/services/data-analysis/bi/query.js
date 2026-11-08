'use strict';

const { BI_POLICY } = require('./policy');
const { canonicalJson, canonicalHash } = require('./canonical');
const { biError } = require('./errors');
const { planModelGraph, requiredModelRelations } = require('./graph');
const { validateMetricDefinitions, requiredMetrics } = require('./metrics');
const { sqlIdentifier, decimalProjection, keyProjection, dimensionProjection } = require('./sql-expressions');

function invalid(message) { throw biError('ANALYSIS_MODEL_QUERY_INVALID', message); }

function compileModelQuery(definition, query, sources, { evaluationTime = Date.now() } = {}) {
    if (Buffer.byteLength(canonicalJson(query), 'utf8') > BI_POLICY.maxRequestBytes) invalid('模型查询超过请求大小上限。');
    const limit = query.limit ?? 100;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 5000) invalid('结果展示上限必须为一至五千的整数。');
    const graph = planModelGraph(definition);
    const metricPlan = validateMetricDefinitions(definition.metrics, graph.factNodeId);
    const metrics = requiredMetrics(metricPlan, query.metrics, evaluationTime);
    if (!Array.isArray(query.dimensions) || query.dimensions.length > BI_POLICY.maxDimensions || new Set(query.dimensions).size !== query.dimensions.length) invalid('请选择最多五个不同的分组维度。');
    const dimensions = new Map();
    for (const dimension of definition.dimensions || []) {
        if (!dimension?.id || dimensions.has(dimension.id)) invalid('维度标识缺失或重复。');
        dimensions.set(dimension.id, dimension);
    }
    const selected = query.dimensions.map(id => {
        if (!dimensions.has(id)) invalid('查询引用了不存在的维度。');
        return dimensions.get(id);
    });
    for (const metric of metrics) if (metric.allowedDimensionIds && query.dimensions.some(id => !metric.allowedDimensionIds.includes(id))) invalid('当前指标口径不允许按所选维度分组。');
    const aliases = new Map(graph.nodes.map((node, index) => [node.id, `t${index}`]));
    const fields = new Map();
    for (const node of graph.nodes) {
        const source = sources[node.id];
        if (!source || !/^bi_input_[0-9]+$/.test(source.tableName) || !Array.isArray(source.columns)) invalid('来源表未由受控数据执行器准备。');
        fields.set(node.id, new Set(source.columns.map(column => column.key)));
    }
    const referenced = new Set([graph.factNodeId]);
    function field(reference) {
        if (!reference || !fields.get(reference.nodeId)?.has(reference.fieldKey)) invalid('查询引用了不存在或不可访问的字段。');
        referenced.add(reference.nodeId);
        return `${aliases.get(reference.nodeId)}.${sqlIdentifier(reference.fieldKey)}`;
    }
    function dimensionValue(dimension) {
        return dimensionProjection(field(dimension), dimension, definition.timezone || BI_POLICY.defaultTimezone);
    }
    const parameters = [];
    function parameter(value) {
        if (value !== null && !['string', 'number', 'boolean'].includes(typeof value)) invalid('筛选值必须为普通值。');
        if (typeof value === 'number' && (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER)) invalid('高精度筛选数值请使用字符串。');
        parameters.push(value);
        if (parameters.length > BI_POLICY.maxParameters) invalid('筛选参数超过上限。');
        return '?';
    }
    function filterSql(filters) {
        if (!Array.isArray(filters) || filters.length > BI_POLICY.maxFilters) invalid('筛选条件最多二十项。');
        return filters.map(filter => {
            if (!filter || typeof filter !== 'object' || Array.isArray(filter)) invalid('筛选条件结构无效。');
            const dimension = filter.dimensionId ? dimensions.get(filter.dimensionId) : null;
            if (filter.dimensionId && !dimension) invalid('筛选引用不存在的维度。');
            const value = dimension ? dimensionValue(dimension) : field(filter.field);
            if (filter.operator === 'is_null') return `(${value} IS NULL)`;
            if (filter.operator === 'is_not_null') return `(${value} IS NOT NULL)`;
            if (filter.operator === 'eq') return filter.value === null ? `(${value} IS NULL)` : `(${value} = ${parameter(filter.value)})`;
            if (filter.operator === 'in') {
                if (!Array.isArray(filter.value) || !filter.value.length || filter.value.length > BI_POLICY.maxSetValues || filter.value.includes(null)) invalid('集合筛选需要一至一千个非空值。');
                return `(${value} IN (${filter.value.map(parameter).join(',')}))`;
            }
            if (filter.operator === 'range') {
                if (!Array.isArray(filter.value) || filter.value.length !== 2 || filter.value.includes(null)) invalid('区间筛选需要非空的起止值。');
                return `(${value} >= ${parameter(filter.value[0])} AND ${value} < ${parameter(filter.value[1])})`;
            }
            if (filter.operator === 'contains') return `(contains(CAST(${value} AS VARCHAR), ${parameter(filter.value)}))`;
            invalid('筛选操作不受支持。');
        }).join(' AND ') || 'TRUE';
    }
    const groupingColumns = [];
    const projected = [];
    const dimensionColumns = [];
    for (const [index, dimension] of selected.entries()) {
        const expression = dimensionValue(dimension);
        const members = dimension.memberKeyFields || [dimension.fieldKey];
        if (!Array.isArray(members) || !members.length || members.length > 120) invalid('维度成员键无效。');
        const keys = dimension.granularity ? [expression] : members.map(fieldKey => field({ nodeId: dimension.nodeId, fieldKey }));
        const columns = keys.map((key, keyIndex) => ({ name: `d${index}_k${keyIndex}`, expression: key }));
        const node = graph.nodeById.get(dimension.nodeId);
        columns.push({ name: `d${index}_unmatched`, expression: dimension.nodeId === graph.factNodeId ? 'FALSE' : `(${field({ nodeId: node.id, fieldKey: node.grainKeys[0] })} IS NULL)` });
        for (const column of columns) { projected.push(`${column.expression} AS ${sqlIdentifier(column.name)}`); groupingColumns.push(sqlIdentifier(column.name)); }
        projected.push(`MIN(${expression}) AS ${sqlIdentifier(`d${index}_label`)}`);
        dimensionColumns.push({ id: dimension.id, keyColumns: columns.slice(0, keys.length).map(column => column.name), labelColumn: `d${index}_label`, unmatchedColumn: `d${index}_unmatched` });
    }
    const aggregateColumns = [];
    const aggregateSelect = [];
    for (const [index, metric] of metrics.filter(metric => metric.type !== 'derived').entries()) {
        const where = filterSql(metric.filters || []);
        const fact = graph.nodeById.get(graph.factNodeId);
        const raw = metric.type === 'count' ? null : metric.grainKey === true
            ? `(${fact.grainKeys.map(fieldKey => keyProjection(field({ nodeId: fact.id, fieldKey }), fact.grainNormalization?.[fieldKey]).sql).join(',')})` : field(metric.field);
        const numeric = ['sum', 'avg', 'min', 'max'].includes(metric.type) ? decimalProjection(raw, metric.numeric).sql : null;
        const sql = metric.type === 'count' ? `COUNT(*) FILTER (WHERE ${where})`
            : metric.type === 'count_nonnull' ? `COUNT(${raw}) FILTER (WHERE ${where})`
                : metric.type === 'count_distinct' ? `COUNT(DISTINCT ${raw}) FILTER (WHERE ${where})`
                    : `${metric.type === 'avg' ? 'SUM' : metric.type.toUpperCase()}(${numeric}) FILTER (WHERE ${where})`;
        const name = `m${index}`;
        aggregateSelect.push(`${sql} AS ${sqlIdentifier(name)}`);
        if (metric.type === 'avg') aggregateSelect.push(`COUNT(${numeric}) FILTER (WHERE ${filterSql(metric.filters || [])}) AS ${sqlIdentifier(`${name}_count`)}`);
        const column = { id: metric.id, valueColumn: name, countColumn: metric.type === 'avg' ? `${name}_count` : null };
        if (metric.currencyField) {
            const sameField = reference => reference?.nodeId === metric.currencyField.nodeId && reference?.fieldKey === metric.currencyField.fieldKey;
            const grouped = selected.some(dimension => sameField(dimension) && (dimension.memberKeyFields || [dimension.fieldKey]).includes(dimension.fieldKey));
            const isolated = [...(query.filters || []), ...(metric.filters || [])].some(filter => {
                const ref = filter.dimensionId ? dimensions.get(filter.dimensionId) : filter.field;
                return sameField(ref) && ((filter.operator === 'eq' && typeof filter.value === 'string' && /^[A-Z]{3}$/.test(filter.value)) || (filter.operator === 'in' && filter.value?.length === 1 && /^[A-Z]{3}$/.test(filter.value[0])));
            });
            if (!grouped && !isolated) invalid('金额包含币种字段，请按币种分组或只筛选一个币种后计算。');
            const currency = field(metric.currencyField);
            column.currencyCountColumn = `${name}_currency_count`; column.currencyCodeColumn = `${name}_currency_code`; column.currencyMissingColumn = `${name}_currency_missing`;
            aggregateSelect.push(`COUNT(DISTINCT ${currency}) FILTER (WHERE ${filterSql(metric.filters || [])}) AS ${sqlIdentifier(column.currencyCountColumn)}`,
                `MIN(${currency}) FILTER (WHERE ${filterSql(metric.filters || [])}) AS ${sqlIdentifier(column.currencyCodeColumn)}`,
                `COUNT(*) FILTER (WHERE (${filterSql(metric.filters || [])}) AND (${currency} IS NULL OR NOT regexp_full_match(CAST(${currency} AS VARCHAR), '[A-Z]{3}'))) AS ${sqlIdentifier(column.currencyMissingColumn)}`);
        }
        aggregateColumns.push(column);
    }
    const where = filterSql(query.filters || []);
    const joins = requiredModelRelations(graph, [...referenced]);
    const from = [`${sqlIdentifier(sources[graph.factNodeId].tableName)} ${aliases.get(graph.factNodeId)}`];
    for (const relation of joins) {
        const keys = relation.keyPairs.map(pair => `${keyProjection(field({ nodeId: relation.leftNodeId, fieldKey: pair.leftFieldKey }), pair.normalization).sql} = ${keyProjection(field({ nodeId: relation.rightNodeId, fieldKey: pair.rightFieldKey }), pair.normalization).sql}`);
        from.push(`${relation.joinType.toUpperCase()} JOIN ${sqlIdentifier(sources[relation.rightNodeId].tableName)} ${aliases.get(relation.rightNodeId)} ON ${keys.join(' AND ')}`);
    }
    // 分组与总计在同一事实范围重算；不先取样或限行，不把分组均值和去重结果相加。
    const groups = groupingColumns.length ? `GROUP BY GROUPING SETS ((${groupingColumns.join(',')}),())` : '';
    const total = groupingColumns.length ? `CASE WHEN GROUPING(${groupingColumns[0]}) = 1 THEN TRUE ELSE FALSE END` : 'TRUE';
    const sql = `SELECT ${[...projected, ...aggregateSelect, 'COUNT(*) AS "fact_row_count"', `${total} AS "is_total"`].join(', ')} FROM ${from.join(' ')} WHERE ${where} ${groups}`;
    const orderBy = query.orderBy?.length ? query.orderBy : selected.map(dimension => ({ dimensionId: dimension.id, direction: dimension.sort || 'asc' }));
    if (!Array.isArray(orderBy) || orderBy.length > 15) invalid('排序条件过多或无效。');
    for (const order of orderBy) {
        if (!order || !['asc', 'desc'].includes(order.direction) || Boolean(order.metricId) === Boolean(order.dimensionId)
            || (order.metricId && !query.metrics.includes(order.metricId)) || (order.dimensionId && !query.dimensions.includes(order.dimensionId))) invalid('排序必须引用已选择的维度或指标。');
    }
    return { sql, parameters, metrics, selectedMetricIds: query.metrics, dimensionColumns, aggregateColumns, joins, limit, orderBy,
        queryHash: canonicalHash(query), policy: { ...BI_POLICY }, timezone: definition.timezone || BI_POLICY.defaultTimezone };
}

module.exports = { compileModelQuery };
