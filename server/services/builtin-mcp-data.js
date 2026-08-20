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
            description: 'Profile tabular rows, including field names, types, fill rates, and sample values.',
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
            description: 'Filter rows using exact or contains matching.',
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
            name: 'data.group_summary',
            description: 'Group rows and calculate count, sum, average, min, or max.',
            inputSchema: {
                type: 'object',
                properties: {
                    rows: { type: 'array', items: { type: 'object' } },
                    groupBy: { type: 'string' },
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
            description: 'Rename fields and trim string values in tabular rows.',
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
    if (name === 'data.group_summary') {
        const requestedRows = Array.isArray(input.rows) ? input.rows.length : 0;
        const rows = normalizeInputRows(input.rows, input.limit || 1000);
        const groupBy = String(input.groupBy || input.group_by || '').trim();
        if (!groupBy) {
            const err = new Error('分组字段 groupBy 不能为空。');
            err.status = 400;
            throw err;
        }
        const valueField = String(input.valueField || input.value_field || '').trim();
        const aggregation = String(input.aggregation || (valueField ? 'sum' : 'count')).toLowerCase();
        const grouped = new Map();
        rows.forEach(row => {
            const key = String(row[groupBy] ?? '');
            const bucket = grouped.get(key) || [];
            bucket.push(row);
            grouped.set(key, bucket);
        });
        const items = Array.from(grouped.entries()).map(([key, groupRows]) => {
            const values = valueField ? groupRows.map(row => toFiniteNumber(row[valueField])).filter(Number.isFinite) : [];
            let value = groupRows.length;
            if (aggregation === 'sum') value = values.reduce((sum, item) => sum + item, 0);
            if (aggregation === 'avg') value = values.length ? values.reduce((sum, item) => sum + item, 0) / values.length : 0;
            if (aggregation === 'min') value = values.length ? Math.min(...values) : 0;
            if (aggregation === 'max') value = values.length ? Math.max(...values) : 0;
            return { [groupBy]: key, value, count: groupRows.length };
        });
        const outputLimit = Math.min(Math.max(Number(input.outputLimit || input.output_limit) || 5000, 1), 5000);
        return {
            type: 'data_group_summary', source: buildInlineDataSource(), groupBy, valueField, aggregation,
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
