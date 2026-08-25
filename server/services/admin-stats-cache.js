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

module.exports = { setBoundedStatsCache, tokenUsageAggregateSubquery };
