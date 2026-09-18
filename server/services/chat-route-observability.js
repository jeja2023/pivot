const { execute, query } = require('../db/client');
const { getBeijingTimestamp } = require('../time');
const { logger } = require('../logger');

const live = new Map();
const pending = new Map();
const FLUSH_INTERVAL_MS = 1000;
let flushTimer = null;
let flushInFlight = null;

function minuteBucket(now = Date.now()) {
    return getBeijingTimestamp(new Date(Math.floor(Number(now) / 60000) * 60000));
}

function normalizeAction(value, fallback = 'skip') {
    const text = String(value || '').trim().toLowerCase();
    return /^[a-z_]{2,24}$/.test(text) ? text : fallback;
}

function normalizeMode(value) {
    const text = String(value || '').trim().toLowerCase();
    return ['auto', 'explicit', 'disabled', 'shadow', 'legacy'].includes(text) ? text : 'legacy';
}

function metricKey(metric = {}) {
    return [
        minuteBucket(metric.now),
        normalizeMode(metric.routeMode),
        normalizeAction(metric.ragAction),
        normalizeAction(metric.toolAction)
    ].join('|');
}

function emptyMetric() {
    return {
        requestCount: 0,
        errorCount: 0,
        totalRouteDurationMs: 0,
        totalEmbeddingDurationMs: 0,
        totalRagCandidates: 0,
        totalToolCandidates: 0
    };
}

function mergeMetric(target, metric = {}) {
    target.requestCount += Number(metric.requestCount || 1) || 0;
    target.errorCount += metric.error ? 1 : Number(metric.errorCount || 0) || 0;
    target.totalRouteDurationMs += Math.max(0, Math.round(Number(metric.routeDurationMs ?? metric.totalRouteDurationMs ?? 0)));
    target.totalEmbeddingDurationMs += Math.max(0, Math.round(Number(metric.embeddingDurationMs ?? metric.totalEmbeddingDurationMs ?? 0)));
    target.totalRagCandidates += Math.max(0, Number(metric.ragCandidates ?? metric.totalRagCandidates ?? 0));
    target.totalToolCandidates += Math.max(0, Number(metric.toolCandidates ?? metric.totalToolCandidates ?? 0));
    return target;
}

function metricParams(key, metric, now = getBeijingTimestamp()) {
    const [bucketAt, routeMode, ragAction, toolAction] = key.split('|');
    return [
        bucketAt,
        routeMode,
        ragAction,
        toolAction,
        metric.requestCount,
        metric.errorCount,
        metric.totalRouteDurationMs,
        metric.totalEmbeddingDurationMs,
        metric.totalRagCandidates,
        metric.totalToolCandidates,
        now
    ];
}

const UPSERT_SQL = `
    INSERT INTO chat_route_metrics_buckets (
        bucket_at, route_mode, rag_action, tool_action, request_count, error_count,
        total_route_duration_ms, total_embedding_duration_ms,
        total_rag_candidates, total_tool_candidates, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (bucket_at, route_mode, rag_action, tool_action) DO UPDATE SET
        request_count = chat_route_metrics_buckets.request_count + EXCLUDED.request_count,
        error_count = chat_route_metrics_buckets.error_count + EXCLUDED.error_count,
        total_route_duration_ms = chat_route_metrics_buckets.total_route_duration_ms + EXCLUDED.total_route_duration_ms,
        total_embedding_duration_ms = chat_route_metrics_buckets.total_embedding_duration_ms + EXCLUDED.total_embedding_duration_ms,
        total_rag_candidates = chat_route_metrics_buckets.total_rag_candidates + EXCLUDED.total_rag_candidates,
        total_tool_candidates = chat_route_metrics_buckets.total_tool_candidates + EXCLUDED.total_tool_candidates,
        updated_at = EXCLUDED.updated_at
`;

function scheduleFlush() {
    if (flushTimer || flushInFlight || pending.size === 0) return;
    flushTimer = setTimeout(() => {
        flushTimer = null;
        flushPendingChatRouteMetrics().catch(error => logger.warn({ err: error.message }, '聊天路由指标批量写入失败'));
    }, FLUSH_INTERVAL_MS);
    flushTimer.unref?.();
}

async function flushPendingChatRouteMetrics(deps = {}) {
    if (flushInFlight) return await flushInFlight;
    if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
    }
    const items = Array.from(pending.entries());
    pending.clear();
    if (!items.length) return 0;
    const executeFn = deps.execute || execute;
    const work = (async () => {
        let persisted = 0;
        for (const [key, metric] of items) {
            try {
                await executeFn(UPSERT_SQL, metricParams(key, metric));
                persisted += 1;
            } catch (error) {
                const restored = pending.get(key) || emptyMetric();
                mergeMetric(restored, metric);
                pending.set(key, restored);
                logger.warn({ err: error.message, routeMetricKey: key }, '聊天路由指标持久化失败，已保留待重试聚合数据');
            }
        }
        return persisted;
    })();
    flushInFlight = work;
    try {
        return await work;
    } finally {
        flushInFlight = null;
        scheduleFlush();
    }
}

function recordChatRouteMetric(metric = {}, deps = {}) {
    const key = metricKey(metric);
    const state = mergeMetric(live.get(key) || emptyMetric(), metric);
    live.set(key, state);

    // SQLite 与 PostgreSQL 都需要保留路由审计聚合。异步写入避免将
    // 可观测性持久化放到聊天关键路径；测试可显式传入 persist:false。
    if (deps.persist === false) return;
    const queued = mergeMetric(pending.get(key) || emptyMetric(), metric);
    pending.set(key, queued);
    scheduleFlush();
}

function getLiveChatRouteMetrics() {
    return Array.from(live.entries()).map(([key, value]) => ({ key, ...value }));
}

async function getChatRouteMetricBuckets({ minutes = 1440 } = {}, deps = {}) {
    const queryFn = deps.query || query;
    const safeMinutes = Math.min(Math.max(Number.parseInt(minutes, 10) || 1440, 5), 10080);
    const rows = await queryFn(`
        SELECT bucket_at, route_mode, rag_action, tool_action, request_count, error_count,
               total_route_duration_ms, total_embedding_duration_ms,
               total_rag_candidates, total_tool_candidates
        FROM chat_route_metrics_buckets
        WHERE bucket_at >= CURRENT_TIMESTAMP - (?::integer * INTERVAL '1 minute')
        ORDER BY bucket_at ASC
    `, [safeMinutes]);
    return { minutes: safeMinutes, rows: rows || [], live: getLiveChatRouteMetrics() };
}

module.exports = {
    flushPendingChatRouteMetrics,
    getChatRouteMetricBuckets,
    recordChatRouteMetric
};
