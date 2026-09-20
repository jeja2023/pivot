/**
 * server/db/statements.js
 * PostgreSQL 测试夹具的同步 statement facade。
 * 生产代码请使用 server/db/client.js 的异步 query/queryOne/execute/transaction。
 */
const { isPostgres } = require('./dialect');

const defaultCache = new Map();

function normalizeSqlText(text) {
    if (typeof text !== 'string') {
        const err = new Error('SQL 语句文本必须为字符串类型。');
        err.status = 500;
        throw err;
    }
    if (!text.trim()) {
        const err = new Error('SQL 语句文本不能为空。');
        err.status = 500;
        throw err;
    }
    return text;
}

function prepareCached(cache, database, text) {
    const sqlText = normalizeSqlText(text);
    if (!database || typeof database.prepare !== 'function') {
        const err = new Error('需要 PostgreSQL 测试同步 facade。');
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
 * 返回测试用同步预编译语句（.get/.all/.run）。生产环境调用会拒绝，提示
 * 使用 client.js 的异步接口。
 */
function sql(text) {
    if (isPostgres() && process.env.PIVOT_TEST_PG_SYNC !== 'true') {
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
