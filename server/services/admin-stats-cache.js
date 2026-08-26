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

// ── 全库总量统计（全表扫描，必须缓存 + 串行 + SWR）────────────────────────────
// COUNT(*) 与无 WHERE 的 SUM(token_count) 在 PostgreSQL 下一定是全表扫描，耗时随
// messages / model_usage_events 增长而单调上升。而这些查询原先是用 Promise.all 并发
// 发出的：一个管理员打开运维面板就会同时占用 7 个池连接（默认池上限只有 10），
// 池被占满后所有接口——包括每个请求都要查一次 users 表的鉴权中间件——都拿不到连接。
//
// 这里的三重约束都是必要的：
//   1. 串行执行：一次刷新只占 1 个池连接，而不是 7 个；
//   2. 长 TTL：仪表盘上的「全库总量」允许分钟级陈旧，不需要每 8 秒重算；
//   3. SWR：有历史值时立刻返回并后台刷新，请求链路永不等待全表扫描。
const GLOBAL_COUNTS_TTL_MS = Math.max(
    30_000,
    Number.parseInt(process.env.ADMIN_STATS_GLOBAL_COUNTS_TTL_MS, 10) || 5 * 60 * 1000
);
const GLOBAL_COUNTS_ERROR_TTL_MS = 30_000;

const EMPTY_GLOBAL_COUNTS = {
    users: 0,
    activeUsers: 0,
    sessions: 0,
    messages: 0,
    attachments: 0,
    models: 0,
    tokens: 0,
    stale: true,
    computedAt: null
};

let globalCounts = null;
let globalCountsExpiresAt = 0;
let globalCountsRefresh = null;

async function computeGlobalCounts() {
    const { queryOne } = require('../db/client');
    // 逐条串行：全表扫描本就昂贵，并发只会放大对连接池的占用。
    const users = await queryOne('SELECT COUNT(*) AS count FROM users');
    const activeUsers = await queryOne("SELECT COUNT(*) AS count FROM users WHERE status != 'disabled' AND deleted_at IS NULL");
    const sessions = await queryOne('SELECT COUNT(*) AS count FROM sessions');
    const messages = await queryOne('SELECT COUNT(*) AS count FROM messages');
    const attachments = await queryOne('SELECT COUNT(*) AS count FROM attachments');
    const models = await queryOne('SELECT COUNT(*) AS count FROM models');
    const tokens = await queryOne('SELECT ((SELECT COALESCE(SUM(token_count), 0) FROM messages) + (SELECT COALESCE(SUM(token_count), 0) FROM model_usage_events)) AS total');
    return {
        users: Number(users?.count || 0),
        activeUsers: Number(activeUsers?.count || 0),
        sessions: Number(sessions?.count || 0),
        messages: Number(messages?.count || 0),
        attachments: Number(attachments?.count || 0),
        models: Number(models?.count || 0),
        tokens: Number(tokens?.total || 0),
        stale: false,
        computedAt: new Date().toISOString()
    };
}

function refreshGlobalCounts() {
    if (globalCountsRefresh) return globalCountsRefresh;
    globalCountsRefresh = computeGlobalCounts()
        .then(next => {
            globalCounts = next;
            globalCountsExpiresAt = Date.now() + GLOBAL_COUNTS_TTL_MS;
            return next;
        })
        .catch(() => {
            // 失败时短退避重试，同时保留上一次的可用数值，避免面板直接归零
            globalCountsExpiresAt = Date.now() + GLOBAL_COUNTS_ERROR_TTL_MS;
            return globalCounts || EMPTY_GLOBAL_COUNTS;
        })
        .finally(() => { globalCountsRefresh = null; });
    return globalCountsRefresh;
}

/**
 * 取全库总量统计。首次调用会等待一次计算，之后永远立即返回缓存值并在后台刷新。
 * @returns {Promise<{users:number,activeUsers:number,sessions:number,messages:number,attachments:number,models:number,tokens:number,stale:boolean,computedAt:string|null}>}
 */
async function getCachedGlobalCounts() {
    const expired = globalCountsExpiresAt <= Date.now();
    if (!globalCounts) return refreshGlobalCounts();
    if (expired) refreshGlobalCounts().catch(() => {});
    return globalCounts;
}

function invalidateGlobalCountsCache() {
    globalCountsExpiresAt = 0;
}

function resetGlobalCountsCacheForTests() {
    globalCounts = null;
    globalCountsExpiresAt = 0;
    globalCountsRefresh = null;
}

module.exports.GLOBAL_COUNTS_TTL_MS = GLOBAL_COUNTS_TTL_MS;
module.exports.getCachedGlobalCounts = getCachedGlobalCounts;
module.exports.invalidateGlobalCountsCache = invalidateGlobalCountsCache;
module.exports.resetGlobalCountsCacheForTests = resetGlobalCountsCacheForTests;
