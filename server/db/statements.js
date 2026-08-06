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

function sql(text) {
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
