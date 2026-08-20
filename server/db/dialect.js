const SQLITE_DIALECT = 'sqlite';
const POSTGRES_DIALECT = 'postgres';

function getDialect() {
    return POSTGRES_DIALECT;
}

function isPostgres() {
    return true;
}

function nowExpr() {
    return "now() AT TIME ZONE 'Asia/Shanghai'";
}

/**
 * 相对当前时间的偏移表达式（PostgreSQL）。
 * @param {string} offset 偏移修饰符，如 '-180 days' / '+1 hour' / '1 day'
 */
function nowOffsetExpr(offset) {
    const normalized = String(offset || '').trim();
    if (!normalized) return nowExpr();
    const signed = /^[+-]/.test(normalized) ? normalized : `+${normalized}`;
    const sign = signed.startsWith('-') ? '-' : '+';
    const interval = signed.slice(1).trim();
    return `((now() AT TIME ZONE 'Asia/Shanghai') ${sign} INTERVAL '${interval.replace(/'/g, "''")}')`;
}

function jsonPathToPostgres(path = '$') {
    const source = String(path || '$').trim();
    const normalized = source.replace(/^\$\.?/, '');
    if (!normalized) return '';
    const parts = [];
    const matcher = /(?:^|\.)([^.\[\]]+)|\[(?:"([^"]+)"|'([^']+)'|(\d+))\]/g;
    let match;
    while ((match = matcher.exec(normalized))) {
        const part = match[1] ?? match[2] ?? match[3] ?? match[4];
        if (part) parts.push(part.trim());
    }
    return parts.join(',');
}

/**
 * JSON 字段提取（PostgreSQL）。
 * 统一走 pivot_json_extract()：内建异常捕获，非法 JSON 返回 NULL。
 */
function jsonExtract(column, path = '$') {
    const pgPath = jsonPathToPostgres(path);
    return pgPath ? `pivot_json_extract(${column}::text, '{${pgPath}}')` : `(${column}::text)`;
}

/**
 * JSON 合法性判定（PostgreSQL 下恒为 TRUE，因为 pivot_json_extract 已内建容错）。
 */
function jsonValid(_column) {
    return 'TRUE';
}

/**
 * 大小写不敏感的模糊匹配运算符（PostgreSQL ILIKE）。
 */
function likeOperator() {
    return 'ILIKE';
}

/**
 * 大小写不敏感排序表达式（PostgreSQL lower()）。
 */
function orderNocase(column) {
    return `lower(${column})`;
}

function fullTextMatch(table, _queryParam = '?') {
    return `to_tsvector('simple', ${table}) @@ plainto_tsquery('simple', ?)`;
}

function upsertConflict(conflictCols = [], updateCols = []) {
    const conflicts = conflictCols.map(col => String(col || '').trim()).filter(Boolean);
    const updates = updateCols.map(col => String(col || '').trim()).filter(Boolean);
    if (!conflicts.length) throw new Error('upsertConflict 必须指定冲突主键或唯一约束列。');
    if (!updates.length) return `ON CONFLICT(${conflicts.join(', ')}) DO NOTHING`;
    const assignments = updates.map(col => `${col} = excluded.${col}`).join(', ');
    return `ON CONFLICT(${conflicts.join(', ')}) DO UPDATE SET ${assignments}`;
}

function groupConcat(column, separator = ',') {
    const sep = String(separator).replace(/'/g, "''");
    return `string_agg(${column}, '${sep}')`;
}

module.exports = {
    SQLITE_DIALECT,
    POSTGRES_DIALECT,
    getDialect,
    isPostgres,
    nowExpr,
    nowOffsetExpr,
    jsonExtract,
    jsonValid,
    likeOperator,
    orderNocase,
    fullTextMatch,
    upsertConflict,
    groupConcat
};
