function tokenUsageAggregateSubquery(groupExpr, innerWhere = '') {
    const whereClause = innerWhere ? `WHERE ${innerWhere}` : '';
    return `
        SELECT ${groupExpr} AS group_key, SUM(token_count) AS tokens
        FROM messages ${whereClause}
        GROUP BY ${groupExpr}
        UNION ALL
        SELECT ${groupExpr} AS group_key, SUM(token_count) AS tokens
        FROM model_usage_events ${whereClause}
        GROUP BY ${groupExpr}
    `;
}

const MAX_USER_STATS_CACHE_ENTRIES = 256;

function setBoundedStatsCache(cache, key, value) {
    if (!cache.has(key) && cache.size >= MAX_USER_STATS_CACHE_ENTRIES) {
        const oldestKey = cache.keys().next().value;
        if (oldestKey !== undefined) cache.delete(oldestKey);
    }
    cache.set(key, value);
}

const DATABASE_SIZE_TTL_MS = 5 * 60 * 1000;
let databaseSize = 0;
let databaseSizeExpiresAt = 0;
let databaseSizeRefresh = null;

function getCachedDatabaseSize() {
    const now = Date.now();
    if (databaseSizeExpiresAt <= now && !databaseSizeRefresh) {
        databaseSizeRefresh = require('../db/client').queryOne('SELECT pg_database_size(current_database()) AS db_size')
            .then(row => {
                databaseSize = Number(row?.db_size || 0) || 0;
                databaseSizeExpiresAt = Date.now() + DATABASE_SIZE_TTL_MS;
            })
            .catch(() => {
                databaseSizeExpiresAt = Date.now() + Math.min(DATABASE_SIZE_TTL_MS, 30000);
            })
            .finally(() => { databaseSizeRefresh = null; });
    }
    return databaseSize;
}

module.exports = { getCachedDatabaseSize, setBoundedStatsCache, tokenUsageAggregateSubquery };
