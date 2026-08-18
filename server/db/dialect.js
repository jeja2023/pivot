const SQLITE_DIALECT = 'sqlite';
const POSTGRES_DIALECT = 'postgres';

function getDialect() {
    const explicit = String(
        process.env.PIVOT_DB_DIALECT ||
        process.env.DB_CLIENT ||
        (process.env.DATABASE_URL && (process.env.DATABASE_URL.startsWith('postgres://') || process.env.DATABASE_URL.startsWith('postgresql://')) ? POSTGRES_DIALECT : '') ||
        SQLITE_DIALECT
    ).trim().toLowerCase();
    return ['postgres', 'postgresql', 'pg'].includes(explicit) ? POSTGRES_DIALECT : SQLITE_DIALECT;
}

function isPostgres() {
    return getDialect() === POSTGRES_DIALECT;
}

function nowExpr() {
    return isPostgres() ? "now() AT TIME ZONE 'Asia/Shanghai'" : "datetime('now', '+8 hours')";
}

/**
 * 相对当前时间的偏移表达式。
 * @param {string} offset SQLite 修饰符语法，如 '-180 days' / '+1 hour'
 */
function nowOffsetExpr(offset) {
    const normalized = String(offset || '').trim();
    if (!normalized) return nowExpr();
    if (!isPostgres()) return `datetime('now', '+8 hours', '${normalized.replace(/'/g, "''")}')`;
    const signed = /^[+-]/.test(normalized) ? normalized : `+${normalized}`;
    const sign = signed.startsWith('-') ? '-' : '+';
    const interval = signed.slice(1).trim();
    return `((now() AT TIME ZONE 'Asia/Shanghai') ${sign} INTERVAL '${interval.replace(/'/g, "''")}')`;
}

function jsonPathToPostgres(path = '$') {
    return String(path || '$')
        .replace(/^\$\.?/, '')
        .split('.')
        .map(part => part.trim())
        .filter(Boolean)
        .join(',');
}

/**
 * JSON 字段提取。
 *
 * 两侧都要容忍「列里存的不是合法 JSON」——SQLite 的 json_extract 对非法输入会
 * 抛错（故调用方历史上配合 json_valid 使用），PG 的 ::jsonb 转换同样会抛错。
 * PG 侧统一走 pivot_json_extract()：内建异常捕获，非法 JSON 返回 NULL，
 * 因此调用方无需再写 jsonValid() 前置守卫。
 */
function jsonExtract(column, path = '$') {
    if (isPostgres()) {
        const pgPath = jsonPathToPostgres(path);
        return pgPath ? `pivot_json_extract(${column}, '{${pgPath}}')` : `(${column}::text)`;
    }
    return `json_extract(${column}, '${String(path || '$').replace(/'/g, "''")}')`;
}

/**
 * JSON 合法性判定。PG 侧恒真——pivot_json_extract 已内建容错，
 * 保留此 helper 只为让调用方 SQL 在两种方言下结构一致。
 */
function jsonValid(column) {
    return isPostgres() ? 'TRUE' : `json_valid(${column})`;
}

/**
 * 大小写不敏感的模糊匹配运算符。
 * SQLite 的 LIKE 对 ASCII 默认不区分大小写，PG 的 LIKE 区分，故 PG 用 ILIKE。
 */
function likeOperator() {
    return isPostgres() ? 'ILIKE' : 'LIKE';
}

/**
 * 大小写不敏感排序表达式。
 * SQLite 用 COLLATE NOCASE，PG 无该 collation，改用 lower()。
 */
function orderNocase(column) {
    return isPostgres() ? `lower(${column})` : `${column} COLLATE NOCASE`;
}

function fullTextMatch(table, _queryParam = '?') {
    return isPostgres() ? `to_tsvector('simple', ${table}) @@ plainto_tsquery('simple', ?)` : `${table} MATCH ?`;
}

function upsertConflict(conflictCols = [], updateCols = []) {
    const conflicts = conflictCols.map(col => String(col || '').trim()).filter(Boolean);
    const updates = updateCols.map(col => String(col || '').trim()).filter(Boolean);
    if (!conflicts.length) throw new Error('upsertConflict requires conflict columns.');
    if (!updates.length) return `ON CONFLICT(${conflicts.join(', ')}) DO NOTHING`;
    const assignments = updates.map(col => `${col} = excluded.${col}`).join(', ');
    return `ON CONFLICT(${conflicts.join(', ')}) DO UPDATE SET ${assignments}`;
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
    upsertConflict
};
