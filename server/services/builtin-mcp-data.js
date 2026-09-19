/* 内置 MCP 能力 - 数据处理 Built-in Data Processing MCP
 *
 * 对表格行做画像、筛选、分组汇总和字段规整。
 * 由 builtin-mcp.js 拆分而来，逻辑保持不变。
 */
const {
    toFiniteNumber,
    normalizeInputRows,
    inferValueKind,
    buildInlineDataSource
} = require('./builtin-mcp-common');

function listDataProcessingTools() {
    return [
        {
            name: 'data.profile_rows',
            title: '数据画像分析',
            description: '分析表格数据行结构，生成字段名、类型分布、填充率及样本值画像。',
            inputSchema: {
                type: 'object',
                properties: {
                    rows: { type: 'array', items: { type: 'object' } },
                    limit: { type: 'number', minimum: 1, maximum: 5000 }
                },
                required: ['rows']
            }
        },
        {
            name: 'data.filter_rows',
            title: '筛选表格行',
            description: '使用精确匹配或包含匹配规则筛选表格数据行。',
            inputSchema: {
                type: 'object',
                properties: {
                    rows: { type: 'array', items: { type: 'object' } },
                    filters: { type: 'object' },
                    matchMode: { type: 'string', enum: ['contains', 'exact'] },
                    limit: { type: 'number', minimum: 1, maximum: 5000 }
                },
                required: ['rows']
            }
        },
        {
            name: 'data.aggregate',
            title: '数据汇总',
            description: '对全部表格行执行整体计数、求和、均值、最小值或最大值，不进行分组。',
            inputSchema: {
                type: 'object',
                properties: {
                    rows: { type: 'array', items: { type: 'object' } },
                    metrics: {
                        type: 'array',
                        maxItems: 20,
                        items: {
                            type: 'object',
                            properties: {
                                field: { type: 'string' },
                                aggregation: { type: 'string', enum: ['count', 'sum', 'avg', 'min', 'max'] },
                                alias: { type: 'string' }
                            }
                        },
                        description: '可同时配置多个统计指标；计数指标可以不填写 field。'
                    },
                    valueField: { type: 'string', description: '兼容旧版的单个指标字段。' },
                    aggregation: { type: 'string', enum: ['count', 'sum', 'avg', 'min', 'max'] },
                    limit: { type: 'number', minimum: 1, maximum: 5000, description: '最多参与计算的输入行数。' }
                },
                required: ['rows']
            }
        },
        {
            name: 'data.group_summary',
            title: '表格分组汇总',
            description: '对上游表格行按指定字段分组，并计算一个或多个计数、求和、均值、最小值或最大值指标。',
            inputSchema: {
                type: 'object',
                properties: {
                    rows: { type: 'array', items: { type: 'object' } },
                    groupBy: {
                        type: ['string', 'array'],
                        items: { type: 'string' },
                        minItems: 1,
                        description: '一个或多个分组字段；兼容旧版单个字段字符串。'
                    },
                    metrics: {
                        type: 'array',
                        maxItems: 20,
                        items: {
                            type: 'object',
                            properties: {
                                field: { type: 'string' },
                                aggregation: { type: 'string', enum: ['count', 'sum', 'avg', 'min', 'max'] },
                                alias: { type: 'string' }
                            }
                        },
                        description: '可同时配置多个统计指标；计数指标可以不填写 field。'
                    },
                    valueField: { type: 'string' },
                    aggregation: { type: 'string', enum: ['count', 'sum', 'avg', 'min', 'max'] },
                    limit: { type: 'number', minimum: 1, maximum: 5000, description: '最多参与计算的输入行数。' },
                    outputLimit: { type: 'number', minimum: 1, maximum: 5000, description: '最多返回的分组数。' }
                },
                required: ['rows', 'groupBy']
            }
        },
        {
            name: 'data.normalize_fields',
            title: '标准化字段',
            description: '重命名表格字段名称并去除字符串首尾空白字符。',
            inputSchema: {
                type: 'object',
                properties: {
                    rows: { type: 'array', items: { type: 'object' } },
                    renameMap: { type: 'object' },
                    trimStrings: { type: 'boolean' },
                    limit: { type: 'number', minimum: 1, maximum: 5000 }
                },
                required: ['rows']
            }
        }
    ];
}

function normalizeAggregationMetrics(input = {}) {
    const legacyValueField = String(input.valueField || input.value_field || '').trim();
    const legacyAggregation = String(input.aggregation || (legacyValueField ? 'sum' : 'count')).toLowerCase();
    const rawMetrics = Array.isArray(input.metrics) && input.metrics.length
        ? input.metrics
        : [{ field: legacyValueField, aggregation: legacyAggregation }];
    const usedAliases = new Set();
    return rawMetrics.slice(0, 20).map((metric, index) => {
        const field = String(metric?.field || metric?.valueField || '').trim();
        const aggregation = ['count', 'sum', 'avg', 'min', 'max'].includes(String(metric?.aggregation || '').toLowerCase())
            ? String(metric.aggregation).toLowerCase()
            : 'count';
        const defaultAlias = aggregation === 'count' ? 'count' : aggregation + '_' + (field || 'value');
        let alias = String(metric?.alias || '').trim() || defaultAlias;
        alias = alias.replace(/[^\u3400-\u9fffA-Za-z0-9_-]/gu, '_').replace(/^_+|_+$/g, '') || ('metric_' + (index + 1));
        const baseAlias = alias;
        let suffix = 2;
        while (usedAliases.has(alias)) alias = baseAlias + '_' + suffix++;
        usedAliases.add(alias);
        return { field, aggregation, alias };
    });
}

function calculateAggregationMetric(groupRows, metric) {
    if (metric.aggregation === 'count') return groupRows.length;
    const values = groupRows
        .map(item => toFiniteNumber(item?.row?.[metric.field]))
        .filter(Number.isFinite);
    if (metric.aggregation === 'sum') return values.reduce((sum, item) => sum + item, 0);
    if (metric.aggregation === 'avg') return values.length ? values.reduce((sum, item) => sum + item, 0) / values.length : 0;
    if (metric.aggregation === 'min') return values.length ? Math.min(...values) : 0;
    if (metric.aggregation === 'max') return values.length ? Math.max(...values) : 0;
    return groupRows.length;
}

function metricOutputValues(groupRows, metrics) {
    return Object.fromEntries(metrics.map(metric => [metric.alias, calculateAggregationMetric(groupRows, metric)]));
}

function validateAggregationMetrics(input = {}) {
    if (!Array.isArray(input.metrics) || !input.metrics.length) return;
    const invalid = normalizeAggregationMetrics(input).find(metric => metric.aggregation !== 'count' && !metric.field);
    if (!invalid) return;
    const err = new Error(`聚合方式 ${invalid.aggregation} 需要指定指标字段。`);
    err.status = 400;
    throw err;
}

function executeDataProcessingTool(_server, name, input = {}) {
    if (name === 'data.profile_rows') {
        const requestedRows = Array.isArray(input.rows) ? input.rows.length : 0;
        const rows = normalizeInputRows(input.rows, input.limit || 1000);
        const fields = rows.reduce((cols, row) => {
            Object.keys(row || {}).forEach(key => {
                if (!cols.includes(key)) cols.push(key);
            });
            return cols;
        }, []);
        const profile = fields.map(field => {
            const values = rows.map(row => row[field]).filter(value => value !== undefined && value !== null && String(value).trim() !== '');
            const typeCounts = values.reduce((acc, value) => {
                const kind = inferValueKind(value);
                acc[kind] = (acc[kind] || 0) + 1;
                return acc;
            }, {});
            const topType = Object.entries(typeCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || 'empty';
            return {
                field,
                type: topType,
                filled: values.length,
                fillRate: rows.length ? values.length / rows.length : 0,
                samples: Array.from(new Set(values.map(value => String(value)).filter(Boolean))).slice(0, 5)
            };
        });
        return { type: 'data_profile', source: buildInlineDataSource(), rowCount: rows.length, originalRowCount: requestedRows, limitApplied: rows.length < requestedRows, warnings: rows.length < requestedRows ? ['输入行数超过工具上限，已截断。'] : [], fields: profile };
    }
    if (name === 'data.filter_rows') {
        const requestedRows = Array.isArray(input.rows) ? input.rows.length : 0;
        const rows = normalizeInputRows(input.rows, input.limit || 1000);
        const filters = input.filters && typeof input.filters === 'object' ? input.filters : {};
        const exact = String(input.matchMode || input.match_mode || 'contains').toLowerCase() === 'exact';
        const filtered = rows.filter(row => Object.entries(filters).every(([key, expected]) => {
            const actual = String(row[key] ?? '').toLowerCase();
            const needle = String(expected ?? '').toLowerCase();
            return exact ? actual === needle : actual.includes(needle);
        }));
        return { type: 'data_filter', source: buildInlineDataSource(), rowCount: filtered.length, originalRowCount: requestedRows, limitApplied: rows.length < requestedRows, warnings: rows.length < requestedRows ? ['输入行数超过工具上限，已截断。'] : [], rows: filtered };
    }
    if (name === 'data.aggregate') {
        const requestedRows = Array.isArray(input.rows) ? input.rows.length : 0;
        const rows = normalizeInputRows(input.rows, input.limit || 1000);
        validateAggregationMetrics(input);
        const metrics = normalizeAggregationMetrics(input);
        const groupRows = rows.map(row => ({ row, groupValues: [] }));
        const values = metricOutputValues(groupRows, metrics);
        const firstMetric = metrics[0] || { field: '', aggregation: 'count' };
        const resultRow = {
            ...values,
            value: values[firstMetric.alias],
            count: groupRows.length,
            group: {}
        };
        return {
            type: 'data_aggregate', source: buildInlineDataSource(),
            metrics,
            valueField: firstMetric.field,
            aggregation: firstMetric.aggregation,
            rowCount: 1,
            originalRowCount: requestedRows,
            limitApplied: rows.length < requestedRows,
            warnings: rows.length < requestedRows ? ['输入行数超过工具上限，已截断。'] : [],
            rows: [resultRow]
        };
    }
    if (name === 'data.group_summary') {
        const requestedRows = Array.isArray(input.rows) ? input.rows.length : 0;
        const rows = normalizeInputRows(input.rows, input.limit || 1000);
        const rawGroupBy = input.groupBy ?? input.group_by;
        const groupByFields = (Array.isArray(rawGroupBy) ? rawGroupBy : [rawGroupBy])
            .flatMap(value => typeof value === 'string' ? value.split(',') : [value])
            .map(value => String(value || '').trim())
            .filter(Boolean)
            .filter((field, index, items) => items.indexOf(field) === index)
            .slice(0, 12);
        if (!groupByFields.length) {
            const err = new Error('分组字段 groupBy 不能为空。');
            err.status = 400;
            throw err;
        }
        if (Array.isArray(input.metrics) && input.metrics.length) {
            validateAggregationMetrics(input);
            const metrics = normalizeAggregationMetrics(input);
            const grouped = new Map();
            rows.forEach(row => {
                const groupValues = groupByFields.map(field => row[field] ?? '');
                const key = JSON.stringify(groupValues);
                const bucket = grouped.get(key) || [];
                bucket.push({ row, groupValues });
                grouped.set(key, bucket);
            });
            const items = Array.from(grouped.values()).map(groupRows => {
                const group = Object.fromEntries(groupByFields.map((field, index) => [field, groupRows[0]?.groupValues[index] ?? '']));
                const values = metricOutputValues(groupRows, metrics);
                const firstMetric = metrics[0] || { field: '', aggregation: 'count' };
                return {
                    ...group,
                    ...values,
                    value: values[firstMetric.alias],
                    count: groupRows.length,
                    group
                };
            });
            const outputLimit = Math.min(Math.max(Number(input.outputLimit || input.output_limit) || 5000, 1), 5000);
            const firstMetric = metrics[0] || { field: '', aggregation: 'count' };
            return {
                type: 'data_group_summary', source: buildInlineDataSource(),
                groupBy: groupByFields.length === 1 ? groupByFields[0] : groupByFields,
                groupByFields,
                metrics,
                valueField: firstMetric.field,
                aggregation: firstMetric.aggregation,
                rowCount: Math.min(items.length, outputLimit),
                originalRowCount: requestedRows,
                limitApplied: rows.length < requestedRows || items.length > outputLimit,
                warnings: rows.length < requestedRows || items.length > outputLimit ? ['结果受输入或输出行数上限限制。'] : [],
                rows: items.slice(0, outputLimit)
            };
        }
        const valueField = String(input.valueField || input.value_field || '').trim();
        const aggregation = String(input.aggregation || (valueField ? 'sum' : 'count')).toLowerCase();
        const grouped = new Map();
        rows.forEach(row => {
            const groupValues = groupByFields.map(field => row[field] ?? '');
            const key = JSON.stringify(groupValues);
            const bucket = grouped.get(key) || [];
            bucket.push({ row, groupValues });
            grouped.set(key, bucket);
        });
        const items = Array.from(grouped.values()).map(groupRows => {
            const values = valueField ? groupRows.map(item => toFiniteNumber(item.row[valueField])).filter(Number.isFinite) : [];
            let value = groupRows.length;
            if (aggregation === 'sum') value = values.reduce((sum, item) => sum + item, 0);
            if (aggregation === 'avg') value = values.length ? values.reduce((sum, item) => sum + item, 0) / values.length : 0;
            if (aggregation === 'min') value = values.length ? Math.min(...values) : 0;
            if (aggregation === 'max') value = values.length ? Math.max(...values) : 0;
            const group = Object.fromEntries(groupByFields.map((field, index) => [field, groupRows[0]?.groupValues[index] ?? '']));
            return { ...group, value, count: groupRows.length, group };
        });
        const outputLimit = Math.min(Math.max(Number(input.outputLimit || input.output_limit) || 5000, 1), 5000);
        return {
            type: 'data_group_summary', source: buildInlineDataSource(),
            groupBy: groupByFields.length === 1 ? groupByFields[0] : groupByFields,
            groupByFields,
            valueField, aggregation,
            rowCount: Math.min(items.length, outputLimit),
            originalRowCount: requestedRows,
            limitApplied: rows.length < requestedRows || items.length > outputLimit,
            warnings: rows.length < requestedRows || items.length > outputLimit ? ['结果受输入或输出行数上限限制。'] : [],
            rows: items.slice(0, outputLimit)
        };
    }
    if (name === 'data.normalize_fields') {
        const requestedRows = Array.isArray(input.rows) ? input.rows.length : 0;
        const rows = normalizeInputRows(input.rows, input.limit || 1000);
        const renameMap = input.renameMap && typeof input.renameMap === 'object' ? input.renameMap : {};
        const trimStrings = input.trimStrings !== false;
        const normalized = rows.map(row => Object.entries(row || {}).reduce((acc, [key, value]) => {
            const nextKey = String(renameMap[key] || key);
            acc[nextKey] = trimStrings && typeof value === 'string' ? value.trim() : value;
            return acc;
        }, {}));
        return {
            type: 'data_normalized_rows', source: buildInlineDataSource(), rowCount: normalized.length,
            originalRowCount: requestedRows, limitApplied: rows.length < requestedRows,
            warnings: rows.length < requestedRows ? ['输入行数超过工具上限，已截断。'] : [], rows: normalized
        };
    }
    throw new Error(`不支持的数据工具操作: ${name}`);
}

module.exports = {
    listDataProcessingTools,
    executeDataProcessingTool
};
