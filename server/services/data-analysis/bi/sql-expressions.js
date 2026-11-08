'use strict';

const { biError } = require('./errors');

function sqlIdentifier(value) { return `"${String(value).replace(/"/g, '""')}"`; }
function sqlLiteral(value) { return `'${String(value).replace(/'/g, "''")}'`; }
function invalid(message) { throw biError('ANALYSIS_MODEL_CONVERSION_INVALID', message); }

function decimalProjection(expression, rule = {}) {
    const precision = rule.precision ?? 18, scale = rule.scale ?? 2;
    if (!Number.isSafeInteger(precision) || precision < 1 || precision > 38 || !Number.isSafeInteger(scale) || scale < 0 || scale > precision) invalid('数值字段的十进制精度配置无效。');
    const text = `trim(CAST(${expression} AS VARCHAR))`;
    const digits = rule.allowThousands ? '(?:[0-9]+|[0-9]{1,3}(?:,[0-9]{3})+)' : '[0-9]+';
    const pattern = `[+-]?${rule.allowCurrency ? '[￥¥$]?' : ''}${digits}(?:\\.[0-9]+)?${rule.allowPercent ? '%?' : ''}`;
    const clean = `regexp_replace(${text}, ${sqlLiteral('[,￥¥$%]')}, '', 'g')`;
    const parsed = `TRY_CAST(${clean} AS DECIMAL(${precision},${scale}))`;
    // 百分数转换用十进制乘法，不进入 DuckDB 的浮点除法分支。
    const percentScale = Math.min(scale + 2, 38), percentPrecision = Math.max(precision, percentScale);
    const percent = `TRY_CAST(TRY_CAST(${clean} AS DECIMAL(${percentPrecision},${percentScale})) * CAST('0.01' AS DECIMAL(3,2)) AS DECIMAL(${precision},${scale}))`;
    const value = rule.allowPercent ? `CASE WHEN ends_with(${text}, '%') THEN ${percent} ELSE ${parsed} END` : parsed;
    const sql = `CASE WHEN regexp_full_match(${text}, ${sqlLiteral(pattern)}) THEN ${value} ELSE NULL END`;
    return { sql, invalidSql: `(${expression} IS NOT NULL AND ${text} <> '' AND (${sql}) IS NULL)`, precision, scale };
}

function keyProjection(expression, rule = {}) {
    const type = rule.type || 'text';
    let sql = `CAST(${expression} AS VARCHAR)`;
    if (rule.trim === true) sql = `trim(${sql})`;
    if (rule.emptyAsNull === true) sql = `NULLIF(${sql}, '')`;
    const text = sql;
    if (type === 'text') {
        if (rule.caseSensitive === false) sql = `lower(${sql})`;
    } else if (type === 'integer') {
        sql = `CASE WHEN regexp_full_match(${text}, '[+-]?[0-9]+') THEN TRY_CAST(${text} AS HUGEINT) ELSE NULL END`;
    } else if (type === 'decimal') {
        sql = decimalProjection(text, rule).sql;
    } else if (type === 'date') {
        if (rule.format && rule.format !== '%Y-%m-%d') invalid('关联日期键当前使用明确的年-月-日格式，请先转换来源字段。');
        sql = `CAST(TRY_STRPTIME(${text}, '%Y-%m-%d') AS DATE)`;
    } else invalid('关联键逻辑类型无效。');
    return { sql, invalidSql: `(${expression} IS NOT NULL AND ${text} IS NOT NULL AND (${sql}) IS NULL)` };
}

function dimensionProjection(expression, dimension, timezone) {
    if (!dimension.granularity) return expression;
    if (!['year', 'quarter', 'month', 'day'].includes(dimension.granularity)) invalid('日期分组粒度无效。');
    let parsed;
    if (dimension.logicalType === 'date') {
        const formats = new Set(['%Y-%m-%d', '%Y/%m/%d', '%Y%m%d']);
        const format = dimension.dateFormat || '%Y-%m-%d';
        if (!formats.has(format)) invalid('日期格式不受支持，请选择明确的年、月、日格式。');
        parsed = `TRY_STRPTIME(CAST(${expression} AS VARCHAR), ${sqlLiteral(format)})`;
    } else if (dimension.logicalType === 'timestamp') {
        try { new Intl.DateTimeFormat('zh-CN', { timeZone: timezone }).format(); }
        catch (_) { invalid('模型业务时区无效。'); }
        // 时间点必须含时区；无时区来源应先按明确来源时区准备，不能依赖服务器设置猜测。
        const text = `CAST(${expression} AS VARCHAR)`;
        parsed = `CASE WHEN regexp_matches(${text}, '(Z|[+-][0-9]{2}:[0-9]{2})$') THEN timezone(${sqlLiteral(timezone)}, TRY_CAST(${text} AS TIMESTAMPTZ)) ELSE NULL END`;
    } else invalid('日期分组必须明确使用日期或带时区的时间点。');
    return `CAST(date_trunc(${sqlLiteral(dimension.granularity)}, ${parsed}) AS DATE)`;
}

module.exports = { sqlIdentifier, sqlLiteral, decimalProjection, keyProjection, dimensionProjection };
