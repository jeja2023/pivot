'use strict';

const { biError } = require('./errors');
const { validateUserSql } = require('../query-pivot');

const FLOW_SQL_BLOCKLIST = /\b(ATTACH|DETACH|COPY|INSTALL|LOAD|PRAGMA|SET|RESET|EXPORT|IMPORT|CREATE|INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE|CALL|EXECUTE|PREPARE|read_csv|read_csv_auto|read_parquet|read_json|read_json_auto|read_text|read_blob|parquet_scan|glob|system|getenv|current_setting|duckdb_\w+| pragma_\w+)\b/i;

const FLOW_BUILTIN_FUNCTIONS = [
    { category: 'math', name: 'ROUND', label: '四舍五入', template: 'ROUND(TRY_CAST("字段名" AS DOUBLE), 2)', description: '将数值保留指定小数位' },
    { category: 'math', name: 'ABS', label: '绝对值', template: 'ABS(TRY_CAST("字段名" AS DOUBLE))', description: '返回数值的非负绝对值' },
    { category: 'math', name: 'CEIL', label: '向上取整', template: 'CEIL(TRY_CAST("字段名" AS DOUBLE))', description: '返回不小于该数的最小整数' },
    { category: 'math', name: 'FLOOR', label: '向下取整', template: 'FLOOR(TRY_CAST("字段名" AS DOUBLE))', description: '返回不大于该数的最大整数' },
    { category: 'math', name: 'COALESCE', label: '空值替补', template: 'COALESCE("字段名", \'默认值\')', description: '返回第一个非空参数值' },
    { category: 'math', name: 'NULLIF', label: '相等转空', template: 'NULLIF(TRY_CAST("字段名" AS DOUBLE), 0)', description: '两值相等时返回 NULL，常用于安全除法分母' },
    { category: 'text', name: 'TRIM', label: '去除首尾空格', template: 'TRIM(CAST("字段名" AS VARCHAR))', description: '清除文本前后的空白字符' },
    { category: 'text', name: 'UPPER', label: '转大写', template: 'UPPER(CAST("字段名" AS VARCHAR))', description: '将英文字母转换为大写' },
    { category: 'text', name: 'LOWER', label: '转小写', template: 'LOWER(CAST("字段名" AS VARCHAR))', description: '将英文字母转换为小写' },
    { category: 'text', name: 'CONCAT', label: '拼接文本', template: 'CONCAT("字段A", \'-\', "字段B")', description: '将多个字段或常量拼接为一个字符串' },
    { category: 'text', name: 'SUBSTR', label: '截取子串', template: 'SUBSTR(CAST("字段名" AS VARCHAR), 1, 4)', description: '从指定位置（1 起始）截取固定长度字符' },
    { category: 'text', name: 'REPLACE', label: '文本替换', template: 'REPLACE(CAST("字段名" AS VARCHAR), \'旧词\', \'新词\')', description: '替换字符串中的指定内容' },
    { category: 'text', name: 'LENGTH', label: '字符长度', template: 'LENGTH(CAST("字段名" AS VARCHAR))', description: '计算文本字符个数' },
    { category: 'date', name: 'YEAR', label: '提取年份', template: 'YEAR(TRY_CAST("日期字段" AS DATE))', description: '从日期或时间中提取四位年份' },
    { category: 'date', name: 'MONTH', label: '提取月份', template: 'MONTH(TRY_CAST("日期字段" AS DATE))', description: '从日期或时间中提取月份（1—12）' },
    { category: 'date', name: 'DAY', label: '提取日', template: 'DAY(TRY_CAST("日期字段" AS DATE))', description: '从日期或时间中提取日（1—31）' },
    { category: 'date', name: 'DATE_TRUNC', label: '日期截断归整', template: 'DATE_TRUNC(\'month\', TRY_CAST("日期字段" AS DATE))', description: '按 year / quarter / month / day 归整日期' },
    { category: 'date', name: 'DATE_DIFF', label: '日期相差天数', template: 'DATE_DIFF(\'day\', TRY_CAST("开始日期" AS DATE), TRY_CAST("结束日期" AS DATE))', description: '计算两个日期之间的间隔单位数' },
    { category: 'date', name: 'STRFTIME', label: '日期格式化', template: 'STRFTIME(TRY_CAST("日期字段" AS DATE), \'%Y-%m\')', description: '将日期格式化为指定文本样式' },
    { category: 'logic', name: 'IF', label: '条件分支 IF', template: 'IF(TRY_CAST("字段名" AS DOUBLE) >= 60, \'达标\', \'未达标\')', description: '按条件成立与否返回不同结果' },
    { category: 'logic', name: 'CASE', label: '多级条件 CASE', template: 'CASE WHEN TRY_CAST("字段名" AS DOUBLE) >= 90 THEN \'优秀\' WHEN TRY_CAST("字段名" AS DOUBLE) >= 60 THEN \'合格\' ELSE \'待提升\' END', description: '多分支区间与分类映射' },
    { category: 'logic', name: 'TRY_CAST_NUM', label: '安全转数值', template: 'TRY_CAST("字段名" AS DOUBLE)', description: '将文本安全转换为浮点数，异常值自动转为 NULL' },
    { category: 'logic', name: 'TRY_CAST_DATE', label: '安全转日期', template: 'TRY_CAST("字段名" AS DATE)', description: '将标准日期文本安全转换为 DATE 类型' },
    { category: 'logic', name: 'TRY_CAST_TEXT', label: '转文本类型', template: 'TRY_CAST("字段名" AS VARCHAR)', description: '将任意值转换为文本字符串' }
];

const ALLOWED_EXPRESSION_FUNCTIONS = new Set([
    'ROUND', 'ABS', 'CEIL', 'CEILING', 'FLOOR', 'POWER', 'SQRT', 'MOD', 'GREATEST', 'LEAST', 'SIGN',
    'COALESCE', 'NULLIF', 'IFNULL',
    'TRIM', 'LTRIM', 'RTRIM', 'UPPER', 'LOWER', 'CONCAT', 'CONCAT_WS', 'SUBSTR', 'SUBSTRING',
    'LEFT', 'RIGHT', 'REPLACE', 'REGEXP_REPLACE', 'REGEXP_MATCHES', 'LENGTH', 'STRPOS', 'CONTAINS',
    'STARTS_WITH', 'ENDS_WITH', 'LPAD', 'RPAD',
    'YEAR', 'QUARTER', 'MONTH', 'DAY', 'HOUR', 'MINUTE', 'SECOND', 'DATE_TRUNC', 'DATE_DIFF', 'DATEDIFF',
    'DATE_PART', 'STRFTIME', 'TRY_STRPTIME', 'CURRENT_DATE',
    'IF', 'CASE', 'WHEN', 'THEN', 'ELSE', 'END', 'CAST', 'TRY_CAST',
    'AND', 'OR', 'NOT', 'IN', 'IS', 'NULL', 'LIKE', 'ILIKE', 'BETWEEN', 'TRUE', 'FALSE',
    'AS', 'VARCHAR', 'TEXT', 'DOUBLE', 'BIGINT', 'INTEGER', 'DECIMAL', 'DATE', 'TIMESTAMP', 'BOOLEAN'
]);

function invalidFlow(message) {
    throw biError('ANALYSIS_MODEL_FLOW_INVALID', message);
}

function stripQuotedLiteralsAndIdents(raw) {
    let index = 0;
    let depth = 0;
    let stripped = '';
    while (index < raw.length) {
        const ch = raw[index];
        if (ch === "'" || ch === '"') {
            const quote = ch;
            index += 1;
            while (index < raw.length) {
                if (raw[index] === quote) {
                    if (raw[index + 1] === quote) {
                        index += 2;
                        continue;
                    }
                    break;
                }
                index += 1;
            }
            if (index >= raw.length) invalidFlow('函数表达式中的引号未闭合，请检查单引号或双引号配对。');
            index += 1;
            stripped += quote === '"' ? ' __ident__ ' : ' __str__ ';
            continue;
        }
        if (ch === '(') depth += 1;
        if (ch === ')') {
            depth -= 1;
            if (depth < 0) invalidFlow('函数表达式中的括号不匹配，请检查右括号数量。');
        }
        stripped += ch;
        index += 1;
    }
    if (depth !== 0) invalidFlow('函数表达式中的括号未闭合，请补全右括号。');
    return stripped;
}

function validateFlowExpression(rawExpression, knownColumns = null) {
    const raw = String(rawExpression ?? '').trim();
    if (!raw) invalidFlow('请填写计算字段的函数表达式。');
    if (raw.length > 2000) invalidFlow('单个计算表达式不能超过 2000 个字符。');
    if (/[\u0000;\\]|--|\/\*|\*\//.test(raw)) {
        invalidFlow('计算表达式不能包含分号、注释符或转义反斜杠。');
    }

    // 支持 {{字段名}} 语法自动转为标准双引号列引用，同时原生支持 "字段名" 写法。
    const normalized = raw.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_match, colName) => {
        const clean = String(colName || '').trim();
        if (!clean) invalidFlow('字段占位符不能为空。');
        return `"${clean.replace(/"/g, '""')}"`;
    });

    if (knownColumns instanceof Set) {
        const quotedMatches = normalized.matchAll(/"((?:[^"]|"")*)"/g);
        for (const match of quotedMatches) {
            const col = match[1].replace(/""/g, '"');
            if (!knownColumns.has(col)) {
                invalidFlow(`表达式引用的字段「${col}」在上游节点输出中不存在。`);
            }
        }
    }

    const stripped = stripQuotedLiteralsAndIdents(normalized);
    if (FLOW_SQL_BLOCKLIST.test(stripped)) {
        invalidFlow('表达式包含不允许的系统关键字或外部读取函数。');
    }
    if (/\bSELECT\b|\bFROM\b|\bJOIN\b|\bUNION\b/i.test(stripped)) {
        invalidFlow('计算字段表达式仅支持标量函数与四则/条件运算；如需多表子查询请使用「自定义 SQL」算子。');
    }

    const tokens = stripped.match(/[A-Za-z_\p{L}][A-Za-z0-9_\p{L}\p{N}]*/gu) || [];
    for (const token of tokens) {
        if (token === '__ident__' || token === '__str__') continue;
        const upper = token.toUpperCase();
        if (ALLOWED_EXPRESSION_FUNCTIONS.has(upper)) continue;
        if (knownColumns instanceof Set && knownColumns.has(token)) continue;
        invalidFlow(`表达式包含未加双引号的字段或不受支持的函数「${token}」。字段名请使用双引号包裹（如 "${token}"）。`);
    }

    // 将未加引号但已知存在的纯标识符字段包裹为安全标识符。
    if (knownColumns instanceof Set && knownColumns.size > 0) {
        return normalized;
    }
    return normalized;
}

function validateFlowCustomSql(rawSql) {
    try {
        const validated = validateUserSql(rawSql);
        const stripped = stripQuotedLiteralsAndIdents(validated);
        if (FLOW_SQL_BLOCKLIST.test(stripped)) {
            invalidFlow('自定义 SQL 包含不允许的关键字，仅支持对上游输入表的只读 SELECT / WITH 查询。');
        }
        return validated;
    } catch (error) {
        if (error.code === 'ANALYSIS_MODEL_FLOW_INVALID') throw error;
        invalidFlow(error.message || '自定义 SQL 语法校验未通过。');
    }
}

module.exports = {
    FLOW_BUILTIN_FUNCTIONS,
    validateFlowExpression,
    validateFlowCustomSql,
    invalidFlow
};

