/**
 * server/db/statements.js
 * SQLite 预编译语句缓存层（仅在 SQLite 模式下有效）
 *
 * PG 模式请使用 server/db/client.js 的异步 query/queryOne/execute/transaction。
 */
const { isPostgres } = require('./dialect');

const defaultCache = new Map();

function normalizeSqlText(text) {
    if (typeof text !== 'string') {
        const err = new Error('SQL statement text must be a string.');
        err.status = 500;
        throw err;
    }
    if (!text.trim()) {
        const err = new Error('SQL statement text cannot be empty.');
        err.status = 500;
        throw err;
    }
    return text;
}

function prepareCached(cache, database, text) {
    const sqlText = normalizeSqlText(text);
    if (!database || typeof database.prepare !== 'function') {
        const err = new Error('A better-sqlite3 compatible database is required.');
        err.status = 500;
        throw err;
    }
    if (!cache.has(sqlText)) cache.set(sqlText, database.prepare(sqlText));
    return cache.get(sqlText);
}

function createStatementCache(database) {
    const cache = new Map();
    return {
        sql: text => prepareCached(cache, database, text),
        clear: () => cache.clear(),
        size: () => cache.size
    };
}

/**
 * 返回 SQLite 预编译语句（.get/.all/.run）。
 * 在 PG 模式下调用会抛出错误，提示使用 client.js。
 */
function sql(text) {
    if (isPostgres()) {
        throw new Error(
            `[DB] sql() 在 PostgreSQL 模式下不可用。请将调用方改为使用 server/db/client.js 的异步 API：\n` +
            `  query()、queryOne()、execute()、transaction()\n` +
            `SQL: ${String(text).slice(0, 120)}`
        );
    }
    const { db } = require('./connection');
    return prepareCached(defaultCache, db, text);
}

function clearStatementCache() {
    defaultCache.clear();
}

function getStatementCacheSize() {
    return defaultCache.size;
}

module.exports = {
    sql,
    createStatementCache,
    clearStatementCache,
    getStatementCacheSize
};
