const SQLITE_DIALECT = 'sqlite';
const POSTGRES_DIALECT = 'postgres';

function getDialect() {
    const value = String(process.env.PIVOT_DB_DIALECT || SQLITE_DIALECT).trim().toLowerCase();
    return value === POSTGRES_DIALECT ? POSTGRES_DIALECT : SQLITE_DIALECT;
}

function isPostgres() {
    return getDialect() === POSTGRES_DIALECT;
}

function nowExpr() {
    return isPostgres() ? "now() AT TIME ZONE 'Asia/Shanghai'" : "datetime('now', '+8 hours')";
}

function jsonPathToPostgres(path = '$') {
    return String(path || '$')
        .replace(/^\$\.?/, '')
        .split('.')
        .map(part => part.trim())
        .filter(Boolean)
        .join(',');
}

function jsonExtract(column, path = '$') {
    if (isPostgres()) {
        const pgPath = jsonPathToPostgres(path);
        return pgPath ? `(${column} #>> '{${pgPath}}')` : `(${column}::text)`;
    }
    return `json_extract(${column}, '${String(path || '$').replace(/'/g, "''")}')`;
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
    jsonExtract,
    fullTextMatch,
    upsertConflict
};
