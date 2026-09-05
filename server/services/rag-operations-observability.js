const { execute, query, queryOne } = require('../db/client');
const { getBeijingTimestamp } = require('../time');
const { estimateTokens } = require('../llm');
const { logger } = require('../logger');

const DEFAULT_TREND_MINUTES = 24 * 60;
const DEFAULT_BUCKET_MINUTES = 5;
const MAX_TREND_MINUTES = 7 * 24 * 60;
const summaryCache = { expiresAt: 0, value: null, pending: null };
const liveEmbeddingStats = {
    requests: 0,
    errors: 0,
    inputCount: 0,
    inputTokens: 0,
    totalDurationMs: 0,
    maxDurationMs: 0
};

function clampInteger(value, fallback, min, max) {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isSafeInteger(parsed)) return fallback;
    return Math.min(Math.max(parsed, min), max);
}

function normalizeMetricStatus(value) {
    return ['success', 'error', 'timeout'].includes(String(value || '').toLowerCase())
        ? String(value).toLowerCase()
        : 'error';
}

function normalizeModelKey(value) {
    return String(value || 'embedding').trim().slice(0, 180) || 'embedding';
}

function minuteBucketTimestamp(now = Date.now()) {
    return getBeijingTimestamp(new Date(Math.floor(Number(now) / 60000) * 60000));
}

function toTimestampMs(value) {
    if (value instanceof Date) return value.getTime();
    const text = String(value || '').trim();
    if (!text) return 0;
    const withZone = /(?:Z|[+-]\d\d:?\d\d)$/i.test(text) ? text : `${text.replace(' ', 'T')}+08:00`;
    const parsed = Date.parse(withZone);
    return Number.isFinite(parsed) ? parsed : 0;
}

function aggregateEmbeddingLatencyBuckets(rows = [], bucketMinutes = DEFAULT_BUCKET_MINUTES) {
    const bucketMs = clampInteger(bucketMinutes, DEFAULT_BUCKET_MINUTES, 1, 60) * 60 * 1000;
    const groups = new Map();
    for (const row of rows || []) {
        const at = toTimestampMs(row.bucket_at ?? row.bucketAt);
        if (!at) continue;
        const bucketAt = Math.floor(at / bucketMs) * bucketMs;
        const key = String(bucketAt);
        const group = groups.get(key) || {
            timestamp: bucketAt,
            requestCount: 0,
            errorCount: 0,
            inputCount: 0,
            inputTokens: 0,
            totalDurationMs: 0,
            maxDurationMs: 0
        };
        group.requestCount += Number(row.request_count ?? row.requestCount ?? 0) || 0;
        group.errorCount += Number(row.error_count ?? row.errorCount ?? 0) || 0;
        group.inputCount += Number(row.input_count ?? row.inputCount ?? 0) || 0;
        group.inputTokens += Number(row.input_tokens ?? row.inputTokens ?? 0) || 0;
        group.totalDurationMs += Number(row.total_duration_ms ?? row.totalDurationMs ?? 0) || 0;
        group.maxDurationMs = Math.max(group.maxDurationMs, Number(row.max_duration_ms ?? row.maxDurationMs ?? 0) || 0);
        groups.set(key, group);
    }
    return Array.from(groups.values())
        .sort((left, right) => left.timestamp - right.timestamp)
        .map(item => ({
            ...item,
            averageDurationMs: item.requestCount > 0 ? item.totalDurationMs / item.requestCount : 0,
            errorRate: item.requestCount > 0 ? item.errorCount / item.requestCount : 0
        }));
}

function summarizeEmbeddingLatency(rows = []) {
    const totals = rows.reduce((result, row) => ({
        requestCount: result.requestCount + (Number(row.requestCount || row.request_count || 0) || 0),
        errorCount: result.errorCount + (Number(row.errorCount || row.error_count || 0) || 0),
        inputCount: result.inputCount + (Number(row.inputCount || row.input_count || 0) || 0),
        inputTokens: result.inputTokens + (Number(row.inputTokens || row.input_tokens || 0) || 0),
        totalDurationMs: result.totalDurationMs + (Number(row.totalDurationMs || row.total_duration_ms || 0) || 0),
        maxDurationMs: Math.max(result.maxDurationMs, Number(row.maxDurationMs || row.max_duration_ms || 0) || 0)
    }), { requestCount: 0, errorCount: 0, inputCount: 0, inputTokens: 0, totalDurationMs: 0, maxDurationMs: 0 });
    return {
        ...totals,
        averageDurationMs: totals.requestCount > 0 ? totals.totalDurationMs / totals.requestCount : 0,
        errorRate: totals.requestCount > 0 ? totals.errorCount / totals.requestCount : 0
    };
}

function recordLiveEmbeddingMetric(metric = {}) {
    const requestCount = Math.max(Number(metric.requestCount || 1) || 1, 1);
    const durationMs = Math.max(Number(metric.durationMs || 0) || 0, 0);
    const inputCount = Math.max(Number(metric.inputCount || 0) || 0, 0);
    const inputTokens = Math.max(Number(metric.inputTokens || 0) || 0, 0);
    liveEmbeddingStats.requests += requestCount;
    liveEmbeddingStats.errors += normalizeMetricStatus(metric.status) === 'success' ? 0 : requestCount;
    liveEmbeddingStats.inputCount += inputCount;
    liveEmbeddingStats.inputTokens += inputTokens;
    liveEmbeddingStats.totalDurationMs += durationMs;
    liveEmbeddingStats.maxDurationMs = Math.max(liveEmbeddingStats.maxDurationMs, durationMs);
}

async function persistEmbeddingLatencyMetric(metric = {}, deps = {}) {
    const executeFn = deps.execute || execute;
    const now = Number(metric.now || Date.now());
    const inputs = Array.isArray(metric.inputs) ? metric.inputs : [metric.inputs].filter(value => value !== undefined);
    const inputTokens = Math.max(Number(metric.inputTokens ?? inputs.reduce((sum, value) => sum + estimateTokens(String(value || '')), 0)) || 0, 0);
    const status = normalizeMetricStatus(metric.status);
    const params = [
        minuteBucketTimestamp(now),
        normalizeModelKey(metric.modelKey || metric.model || metric.modelName),
        String(metric.source || 'rag_embedding').slice(0, 80) || 'rag_embedding',
        status,
        Math.max(Number(metric.requestCount || 1) || 1, 1),
        Math.max(Number(metric.inputCount ?? inputs.length) || 0, 0),
        inputTokens,
        Math.max(Math.round(Number(metric.durationMs || 0) || 0), 0),
        Math.max(Math.round(Number(metric.durationMs || 0) || 0), 0),
        status === 'success' ? 0 : 1,
        getBeijingTimestamp(new Date(now))
    ];
    await executeFn(`
        INSERT INTO rag_embedding_latency_buckets (
            bucket_at, model_key, source, status, request_count, input_count,
            input_tokens, total_duration_ms, max_duration_ms, error_count, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (bucket_at, model_key, source, status) DO UPDATE SET
            request_count = rag_embedding_latency_buckets.request_count + EXCLUDED.request_count,
            input_count = rag_embedding_latency_buckets.input_count + EXCLUDED.input_count,
            input_tokens = rag_embedding_latency_buckets.input_tokens + EXCLUDED.input_tokens,
            total_duration_ms = rag_embedding_latency_buckets.total_duration_ms + EXCLUDED.total_duration_ms,
            max_duration_ms = CASE
                WHEN rag_embedding_latency_buckets.max_duration_ms > EXCLUDED.max_duration_ms
                    THEN rag_embedding_latency_buckets.max_duration_ms
                ELSE EXCLUDED.max_duration_ms
            END,
            error_count = rag_embedding_latency_buckets.error_count + EXCLUDED.error_count,
            updated_at = EXCLUDED.updated_at
    `, params);
}

function recordEmbeddingLatencyMetric(metric = {}) {
    recordLiveEmbeddingMetric(metric);
    summaryCache.expiresAt = 0;
    if (!String(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL || '').trim()) return;
    setImmediate(() => {
        persistEmbeddingLatencyMetric(metric).catch(error => {
            logger.warn({ err: error.message, source: metric.source || 'rag_embedding' }, 'Embedding 延迟指标持久化失败');
        });
    });
}

async function getEmbeddingLatencyTrend(options = {}, deps = {}) {
    const queryFn = deps.query || query;
    const minutes = clampInteger(options.minutes, DEFAULT_TREND_MINUTES, 5, MAX_TREND_MINUTES);
    const bucketMinutes = clampInteger(options.bucketMinutes, DEFAULT_BUCKET_MINUTES, 1, 60);
    const rows = await queryFn(`
        SELECT bucket_at, model_key, source, status, request_count, input_count,
               input_tokens, total_duration_ms, max_duration_ms, error_count
        FROM rag_embedding_latency_buckets
        WHERE bucket_at >= CURRENT_TIMESTAMP - (?::integer * INTERVAL '1 minute')
        ORDER BY bucket_at ASC
    `, [minutes]);
    const trend = aggregateEmbeddingLatencyBuckets(rows, bucketMinutes);
    return {
        minutes,
        bucketMinutes,
        trend,
        summary: summarizeEmbeddingLatency(trend)
    };
}

async function getRagOperationsOverview(options = {}, deps = {}) {
    const now = Date.now();
    const cacheMs = clampInteger(options.cacheMs, 10_000, 0, 60_000);
    if (!deps.query && !deps.queryOne && summaryCache.value && now < summaryCache.expiresAt) return summaryCache.value;
    if (!deps.query && !deps.queryOne && summaryCache.pending) return summaryCache.pending;
    const queryFn = deps.query || query;
    const queryOneFn = deps.queryOne || queryOne;
    const load = async () => {
        const embedding = await getEmbeddingLatencyTrend(options, { query: queryFn }).catch(error => {
            logger.warn({ err: error.message }, '读取 Embedding 延迟趋势失败');
            return { minutes: DEFAULT_TREND_MINUTES, bucketMinutes: DEFAULT_BUCKET_MINUTES, trend: [], summary: summarizeEmbeddingLatency([]) };
        });
        const diagnostics = await queryOneFn(`
            SELECT
                COUNT(*) AS query_count,
                COALESCE(AVG(elapsed_ms), 0) AS average_elapsed_ms,
                COALESCE(MAX(elapsed_ms), 0) AS max_elapsed_ms,
                COALESCE(AVG(candidate_count), 0) AS average_candidates,
                COALESCE(AVG(matched_count), 0) AS average_matches
            FROM rag_debug_queries
            WHERE created_at >= CURRENT_TIMESTAMP - (?::integer * INTERVAL '1 minute')
        `, [clampInteger(options.diagnosticMinutes, DEFAULT_TREND_MINUTES, 5, MAX_TREND_MINUTES)]).catch(() => ({}));
        return {
            embedding: {
                ...embedding,
                live: {
                    requestCount: liveEmbeddingStats.requests,
                    errorCount: liveEmbeddingStats.errors,
                    inputCount: liveEmbeddingStats.inputCount,
                    inputTokens: liveEmbeddingStats.inputTokens,
                    totalDurationMs: liveEmbeddingStats.totalDurationMs,
                    maxDurationMs: liveEmbeddingStats.maxDurationMs,
                    averageDurationMs: liveEmbeddingStats.requests > 0 ? liveEmbeddingStats.totalDurationMs / liveEmbeddingStats.requests : 0,
                    errorRate: liveEmbeddingStats.requests > 0 ? liveEmbeddingStats.errors / liveEmbeddingStats.requests : 0
                }
            },
            diagnostics: {
                queryCount: Number(diagnostics?.query_count || 0),
                averageElapsedMs: Number(diagnostics?.average_elapsed_ms || 0),
                maxElapsedMs: Number(diagnostics?.max_elapsed_ms || 0),
                averageCandidates: Number(diagnostics?.average_candidates || 0),
                averageMatches: Number(diagnostics?.average_matches || 0)
            }
        };
    };
    if (deps.query || deps.queryOne) return load();
    summaryCache.pending = load()
        .then(value => {
            summaryCache.value = value;
            summaryCache.expiresAt = Date.now() + cacheMs;
            return value;
        })
        .finally(() => { summaryCache.pending = null; });
    return summaryCache.pending;
}

module.exports = {
    aggregateEmbeddingLatencyBuckets,
    getEmbeddingLatencyTrend,
    getRagOperationsOverview,
    normalizeMetricStatus,
    persistEmbeddingLatencyMetric,
    recordEmbeddingLatencyMetric,
    summarizeEmbeddingLatency
};
