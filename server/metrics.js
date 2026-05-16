const os = require('os');
const { db } = require('./db');
const { aiSemaphore } = require('./services/concurrency');
const { getGpuMonitorStatus } = require('./services/gpu-monitor');
const { getMaintenanceStatus } = require('./services/maintenance');
const { getSystemHealthSnapshot } = require('./services/system-health');

const buckets = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];
const routeStats = new Map();
const startedAt = Date.now();
const ragStats = {
    retrievals: 0,
    retrievalErrors: 0,
    cacheHits: 0,
    cacheMisses: 0,
    emptyResults: 0,
    totalRetrievalMs: 0,
    totalCandidates: 0,
    totalMatches: 0,
    topScoreSum: 0,
    topScoreCount: 0,
    ingests: 0,
    ingestErrors: 0,
    totalIngestMs: 0,
    chunksIndexed: 0
};

function normalizeRoute(req) {
    const routePath = req.route?.path;
    if (routePath) {
        const base = req.baseUrl || '';
        return `${base}${routePath}`.replace(/\/+/g, '/');
    }
    return (req.originalUrl || req.url || '').split(/[?#]/)[0] || 'unknown';
}

function ensureRouteStats(method, route, status) {
    const key = `${method}|${route}|${status}`;
    if (!routeStats.has(key)) {
        routeStats.set(key, {
            method,
            route,
            status,
            count: 0,
            sum: 0,
            buckets: buckets.map(() => 0)
        });
    }
    return routeStats.get(key);
}

function recordHttpRequest(method, route, status, durationSeconds) {
    const stat = ensureRouteStats(method, route, status);
    stat.count += 1;
    stat.sum += durationSeconds;
    buckets.forEach((bucket, index) => {
        if (durationSeconds <= bucket) stat.buckets[index] += 1;
    });
}

function recordRagRetrieval({
    status = 'unknown',
    durationMs = 0,
    candidates = 0,
    matches = 0,
    topScore = null,
    cacheHit = false
} = {}) {
    ragStats.retrievals += 1;
    ragStats.totalRetrievalMs += Math.max(Number(durationMs) || 0, 0);
    ragStats.totalCandidates += Math.max(Number(candidates) || 0, 0);
    ragStats.totalMatches += Math.max(Number(matches) || 0, 0);
    if (cacheHit || status === 'cache_hit') {
        ragStats.cacheHits += 1;
    } else {
        ragStats.cacheMisses += 1;
    }
    if (status === 'error') ragStats.retrievalErrors += 1;
    if (status === 'empty' || status === 'no_match') ragStats.emptyResults += 1;
    if (Number.isFinite(topScore)) {
        ragStats.topScoreSum += topScore;
        ragStats.topScoreCount += 1;
    }
}

function recordRagIngest({
    status = 'unknown',
    chunks = 0,
    durationMs = 0
} = {}) {
    ragStats.ingests += 1;
    ragStats.totalIngestMs += Math.max(Number(durationMs) || 0, 0);
    ragStats.chunksIndexed += Math.max(Number(chunks) || 0, 0);
    if (status === 'error') ragStats.ingestErrors += 1;
}

function getHttpMetricsSnapshot() {
    const totals = {
        requests: 0,
        errors: 0,
        durationSum: 0,
        buckets: buckets.map(() => 0)
    };
    const routes = [];

    for (const stat of routeStats.values()) {
        const isError = Number(stat.status) >= 500;
        totals.requests += stat.count;
        totals.errors += isError ? stat.count : 0;
        totals.durationSum += stat.sum;
        stat.buckets.forEach((count, index) => {
            totals.buckets[index] += count;
        });
        routes.push({
            method: stat.method,
            route: stat.route,
            status: stat.status,
            requests: stat.count,
            avgLatencyMs: stat.count > 0 ? (stat.sum / stat.count) * 1000 : 0
        });
    }

    const p95Target = totals.requests * 0.95;
    const p95Bucket = totals.buckets.findIndex(count => count >= p95Target);
    const p95LatencyMs = p95Bucket >= 0 ? buckets[p95Bucket] * 1000 : 0;

    return {
        requests: totals.requests,
        errors: totals.errors,
        errorRate: totals.requests > 0 ? totals.errors / totals.requests : 0,
        avgLatencyMs: totals.requests > 0 ? (totals.durationSum / totals.requests) * 1000 : 0,
        p95LatencyMs,
        routes: routes
            .sort((a, b) => b.requests - a.requests)
            .slice(0, 10)
    };
}

function getRagMetricsSnapshot() {
    return {
        retrievals: ragStats.retrievals,
        retrievalErrors: ragStats.retrievalErrors,
        cacheHits: ragStats.cacheHits,
        cacheMisses: ragStats.cacheMisses,
        cacheHitRate: ragStats.retrievals > 0 ? ragStats.cacheHits / ragStats.retrievals : 0,
        emptyResults: ragStats.emptyResults,
        avgRetrievalMs: ragStats.retrievals > 0 ? ragStats.totalRetrievalMs / ragStats.retrievals : 0,
        avgCandidates: ragStats.retrievals > 0 ? ragStats.totalCandidates / ragStats.retrievals : 0,
        avgMatches: ragStats.retrievals > 0 ? ragStats.totalMatches / ragStats.retrievals : 0,
        avgTopScore: ragStats.topScoreCount > 0 ? ragStats.topScoreSum / ragStats.topScoreCount : 0,
        ingests: ragStats.ingests,
        ingestErrors: ragStats.ingestErrors,
        chunksIndexed: ragStats.chunksIndexed,
        avgIngestMs: ragStats.ingests > 0 ? ragStats.totalIngestMs / ragStats.ingests : 0
    };
}

function metricsMiddleware(req, res, next) {
    if ((req.originalUrl || req.url || '').startsWith('/api/metrics')) return next();
    const start = process.hrtime.bigint();
    res.on('finish', () => {
        const durationSeconds = Number(process.hrtime.bigint() - start) / 1e9;
        recordHttpRequest(req.method, normalizeRoute(req), String(res.statusCode), durationSeconds);
    });
    next();
}

const escapeLabel = (value) => String(value ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
const line = (name, labels, value) => {
    const labelText = labels && Object.keys(labels).length
        ? `{${Object.entries(labels).map(([key, val]) => `${key}="${escapeLabel(val)}"`).join(',')}}`
        : '';
    return `${name}${labelText} ${value}`;
};

function getTokenRows() {
    return db.prepare(`
        SELECT model_id, model_name, role, SUM(tokens) AS tokens
        FROM (
            SELECT
                COALESCE(m.model_id, 0) AS model_id,
                COALESCE(md.name, 'unknown') AS model_name,
                COALESCE(m.role, 'unknown') AS role,
                COALESCE(SUM(m.token_count), 0) AS tokens
            FROM messages m
            LEFT JOIN models md ON md.id = m.model_id
            GROUP BY COALESCE(m.model_id, 0), COALESCE(md.name, 'unknown'), COALESCE(m.role, 'unknown')
            UNION ALL
            SELECT
                COALESCE(e.model_id, 0) AS model_id,
                COALESCE(md.name, 'unknown') AS model_name,
                COALESCE(e.source, 'api') AS role,
                COALESCE(SUM(e.token_count), 0) AS tokens
            FROM model_usage_events e
            LEFT JOIN models md ON md.id = e.model_id
            GROUP BY COALESCE(e.model_id, 0), COALESCE(md.name, 'unknown'), COALESCE(e.source, 'api')
        )
        GROUP BY model_id, model_name, role
    `).all();
}

function getTodayTokenRows() {
    return db.prepare(`
        SELECT model_id, model_name, role, SUM(tokens) AS tokens
        FROM (
            SELECT
                COALESCE(m.model_id, 0) AS model_id,
                COALESCE(md.name, 'unknown') AS model_name,
                COALESCE(m.role, 'unknown') AS role,
                COALESCE(SUM(m.token_count), 0) AS tokens
            FROM messages m
            LEFT JOIN models md ON md.id = m.model_id
            WHERE date(m.created_at) = date('now', '+8 hours')
            GROUP BY COALESCE(m.model_id, 0), COALESCE(md.name, 'unknown'), COALESCE(m.role, 'unknown')
            UNION ALL
            SELECT
                COALESCE(e.model_id, 0) AS model_id,
                COALESCE(md.name, 'unknown') AS model_name,
                COALESCE(e.source, 'api') AS role,
                COALESCE(SUM(e.token_count), 0) AS tokens
            FROM model_usage_events e
            LEFT JOIN models md ON md.id = e.model_id
            WHERE date(e.created_at) = date('now', '+8 hours')
            GROUP BY COALESCE(e.model_id, 0), COALESCE(md.name, 'unknown'), COALESCE(e.source, 'api')
        )
        GROUP BY model_id, model_name, role
    `).all();
}

function renderPrometheusMetrics() {
    const lines = [];
    lines.push('# HELP pivot_http_request_duration_seconds HTTP request latency histogram.');
    lines.push('# TYPE pivot_http_request_duration_seconds histogram');
    for (const stat of routeStats.values()) {
        let cumulative = 0;
        stat.buckets.forEach((count, index) => {
            cumulative += count;
            lines.push(line('pivot_http_request_duration_seconds_bucket', {
                method: stat.method,
                route: stat.route,
                status: stat.status,
                le: buckets[index]
            }, cumulative));
        });
        lines.push(line('pivot_http_request_duration_seconds_bucket', {
            method: stat.method,
            route: stat.route,
            status: stat.status,
            le: '+Inf'
        }, stat.count));
        lines.push(line('pivot_http_request_duration_seconds_sum', {
            method: stat.method,
            route: stat.route,
            status: stat.status
        }, stat.sum.toFixed(6)));
        lines.push(line('pivot_http_request_duration_seconds_count', {
            method: stat.method,
            route: stat.route,
            status: stat.status
        }, stat.count));
    }

    lines.push('# HELP pivot_tokens_total Total persisted token usage by model and role.');
    lines.push('# TYPE pivot_tokens_total counter');
    getTokenRows().forEach(row => {
        lines.push(line('pivot_tokens_total', {
            model_id: row.model_id,
            model: row.model_name,
            role: row.role
        }, row.tokens));
    });

    lines.push('# HELP pivot_tokens_today Total persisted token usage for current Beijing day.');
    lines.push('# TYPE pivot_tokens_today gauge');
    getTodayTokenRows().forEach(row => {
        lines.push(line('pivot_tokens_today', {
            model_id: row.model_id,
            model: row.model_name,
            role: row.role
        }, row.tokens));
    });

    const rag = getRagMetricsSnapshot();
    lines.push('# HELP pivot_rag_retrievals_total Total RAG retrieval attempts.');
    lines.push('# TYPE pivot_rag_retrievals_total counter');
    lines.push(line('pivot_rag_retrievals_total', {}, rag.retrievals));
    lines.push('# HELP pivot_rag_retrieval_errors_total Total failed RAG retrieval attempts.');
    lines.push('# TYPE pivot_rag_retrieval_errors_total counter');
    lines.push(line('pivot_rag_retrieval_errors_total', {}, rag.retrievalErrors));
    lines.push('# HELP pivot_rag_cache_hits_total Total RAG retrieval cache hits.');
    lines.push('# TYPE pivot_rag_cache_hits_total counter');
    lines.push(line('pivot_rag_cache_hits_total', {}, rag.cacheHits));
    lines.push('# HELP pivot_rag_cache_hit_ratio RAG retrieval cache hit ratio.');
    lines.push('# TYPE pivot_rag_cache_hit_ratio gauge');
    lines.push(line('pivot_rag_cache_hit_ratio', {}, rag.cacheHitRate.toFixed(6)));
    lines.push('# HELP pivot_rag_empty_results_total Total RAG retrievals without usable matches.');
    lines.push('# TYPE pivot_rag_empty_results_total counter');
    lines.push(line('pivot_rag_empty_results_total', {}, rag.emptyResults));
    lines.push('# HELP pivot_rag_retrieval_latency_ms Average RAG retrieval latency in milliseconds.');
    lines.push('# TYPE pivot_rag_retrieval_latency_ms gauge');
    lines.push(line('pivot_rag_retrieval_latency_ms', { stat: 'avg' }, rag.avgRetrievalMs.toFixed(3)));
    lines.push('# HELP pivot_rag_candidates Average candidate chunks considered per RAG retrieval.');
    lines.push('# TYPE pivot_rag_candidates gauge');
    lines.push(line('pivot_rag_candidates', { stat: 'avg' }, rag.avgCandidates.toFixed(3)));
    lines.push('# HELP pivot_rag_matches Average selected RAG chunks per retrieval.');
    lines.push('# TYPE pivot_rag_matches gauge');
    lines.push(line('pivot_rag_matches', { stat: 'avg' }, rag.avgMatches.toFixed(3)));
    lines.push('# HELP pivot_rag_top_score Average top RAG similarity score.');
    lines.push('# TYPE pivot_rag_top_score gauge');
    lines.push(line('pivot_rag_top_score', { stat: 'avg' }, rag.avgTopScore.toFixed(6)));
    lines.push('# HELP pivot_rag_ingests_total Total RAG document indexing attempts.');
    lines.push('# TYPE pivot_rag_ingests_total counter');
    lines.push(line('pivot_rag_ingests_total', {}, rag.ingests));
    lines.push('# HELP pivot_rag_ingest_errors_total Total failed RAG document indexing attempts.');
    lines.push('# TYPE pivot_rag_ingest_errors_total counter');
    lines.push(line('pivot_rag_ingest_errors_total', {}, rag.ingestErrors));
    lines.push('# HELP pivot_rag_chunks_indexed_total Total RAG chunks indexed during this process lifetime.');
    lines.push('# TYPE pivot_rag_chunks_indexed_total counter');
    lines.push(line('pivot_rag_chunks_indexed_total', {}, rag.chunksIndexed));
    lines.push('# HELP pivot_rag_ingest_latency_ms Average RAG document indexing latency in milliseconds.');
    lines.push('# TYPE pivot_rag_ingest_latency_ms gauge');
    lines.push(line('pivot_rag_ingest_latency_ms', { stat: 'avg' }, rag.avgIngestMs.toFixed(3)));

    const memory = process.memoryUsage();
    const cpuUsage = process.cpuUsage();
    lines.push('# HELP pivot_process_uptime_seconds Process uptime in seconds.');
    lines.push('# TYPE pivot_process_uptime_seconds gauge');
    lines.push(line('pivot_process_uptime_seconds', {}, Math.floor((Date.now() - startedAt) / 1000)));
    lines.push('# HELP pivot_process_memory_bytes Process memory usage in bytes.');
    lines.push('# TYPE pivot_process_memory_bytes gauge');
    Object.entries(memory).forEach(([type, value]) => lines.push(line('pivot_process_memory_bytes', { type }, value)));
    lines.push('# HELP pivot_process_cpu_seconds_total Process CPU usage in seconds.');
    lines.push('# TYPE pivot_process_cpu_seconds_total counter');
    lines.push(line('pivot_process_cpu_seconds_total', { type: 'user' }, (cpuUsage.user / 1e6).toFixed(6)));
    lines.push(line('pivot_process_cpu_seconds_total', { type: 'system' }, (cpuUsage.system / 1e6).toFixed(6)));
    lines.push('# HELP pivot_system_load_average System load average.');
    lines.push('# TYPE pivot_system_load_average gauge');
    os.loadavg().forEach((value, index) => lines.push(line('pivot_system_load_average', { window: ['1m', '5m', '15m'][index] }, value)));
    lines.push('# HELP pivot_system_memory_bytes System memory in bytes.');
    lines.push('# TYPE pivot_system_memory_bytes gauge');
    lines.push(line('pivot_system_memory_bytes', { type: 'total' }, os.totalmem()));
    lines.push(line('pivot_system_memory_bytes', { type: 'free' }, os.freemem()));

    const concurrency = aiSemaphore.getStatus();
    lines.push('# HELP pivot_ai_concurrency Active, queued and configured AI request concurrency.');
    lines.push('# TYPE pivot_ai_concurrency gauge');
    lines.push(line('pivot_ai_concurrency', { state: 'active' }, concurrency.active));
    lines.push(line('pivot_ai_concurrency', { state: 'queued' }, concurrency.queued));
    lines.push(line('pivot_ai_concurrency', { state: 'max' }, concurrency.max));
    lines.push(line('pivot_ai_concurrency', { state: 'max_queue' }, concurrency.maxQueue));
    lines.push('# HELP pivot_ai_queue_oldest_seconds Age of the oldest queued AI request.');
    lines.push('# TYPE pivot_ai_queue_oldest_seconds gauge');
    lines.push(line('pivot_ai_queue_oldest_seconds', {}, (concurrency.oldestQueuedMs / 1000).toFixed(3)));
    lines.push('# HELP pivot_ai_overloaded Whether AI request protection is rejecting new requests.');
    lines.push('# TYPE pivot_ai_overloaded gauge');
    lines.push(line('pivot_ai_overloaded', {}, concurrency.rejectingNewRequests ? 1 : 0));

    const gpu = getGpuMonitorStatus();
    lines.push('# HELP pivot_gpu_available Whether NVIDIA GPU metrics are available.');
    lines.push('# TYPE pivot_gpu_available gauge');
    lines.push(line('pivot_gpu_available', {}, gpu.available ? 1 : 0));
    lines.push('# HELP pivot_gpu_memory_bytes GPU memory usage.');
    lines.push('# TYPE pivot_gpu_memory_bytes gauge');
    gpu.gpus.forEach(item => {
        const labels = { index: item.index, name: item.name };
        lines.push(line('pivot_gpu_memory_bytes', { ...labels, type: 'used' }, item.usedBytes));
        lines.push(line('pivot_gpu_memory_bytes', { ...labels, type: 'total' }, item.totalBytes));
    });
    lines.push('# HELP pivot_gpu_memory_ratio GPU memory usage ratio.');
    lines.push('# TYPE pivot_gpu_memory_ratio gauge');
    gpu.gpus.forEach(item => lines.push(line('pivot_gpu_memory_ratio', { index: item.index, name: item.name }, item.ratio.toFixed(6))));
    lines.push('# HELP pivot_gpu_utilization_ratio GPU utilization ratio.');
    lines.push('# TYPE pivot_gpu_utilization_ratio gauge');
    gpu.gpus.forEach(item => lines.push(line('pivot_gpu_utilization_ratio', { index: item.index, name: item.name }, item.utilization.toFixed(6))));
    lines.push('# HELP pivot_gpu_overloaded Whether GPU monitor reports overload protection.');
    lines.push('# TYPE pivot_gpu_overloaded gauge');
    lines.push(line('pivot_gpu_overloaded', {}, gpu.overloaded ? 1 : 0));

    const health = getSystemHealthSnapshot();
    lines.push('# HELP pivot_system_health_status System health status by component (1 ok, 0 degraded/error).');
    lines.push('# TYPE pivot_system_health_status gauge');
    health.checks.forEach(item => {
        lines.push(line('pivot_system_health_status', {
            component: item.name,
            status: item.status
        }, item.status === 'ok' ? 1 : 0));
    });

    const maintenance = getMaintenanceStatus();
    lines.push('# HELP pivot_maintenance_last_success_timestamp_seconds Last successful maintenance task timestamp.');
    lines.push('# TYPE pivot_maintenance_last_success_timestamp_seconds gauge');
    [
        ['audit_cleanup', maintenance.auditCleanup?.lastSuccessAt],
        ['api_call_log_cleanup', maintenance.apiCallLogCleanup?.lastSuccessAt],
        ['refresh_token_cleanup', maintenance.refreshTokenCleanup?.lastSuccessAt],
        ['sqlite_backup', maintenance.backup?.lastSuccessAt],
        ['sqlite_optimize', maintenance.optimize?.lastSuccessAt]
    ].forEach(([task, timestamp]) => {
        lines.push(line('pivot_maintenance_last_success_timestamp_seconds', { task }, timestamp ? Math.floor(new Date(timestamp).getTime() / 1000) : 0));
    });
    lines.push('# HELP pivot_maintenance_deleted_rows_total Rows deleted by maintenance cleanup tasks.');
    lines.push('# TYPE pivot_maintenance_deleted_rows_total counter');
    lines.push(line('pivot_maintenance_deleted_rows_total', { task: 'audit_cleanup' }, maintenance.auditCleanup?.totalChanges || 0));
    lines.push(line('pivot_maintenance_deleted_rows_total', { task: 'api_call_log_cleanup' }, maintenance.apiCallLogCleanup?.totalChanges || 0));
    lines.push(line('pivot_maintenance_deleted_rows_total', { task: 'refresh_token_cleanup' }, maintenance.refreshTokenCleanup?.totalChanges || 0));
    lines.push('# HELP pivot_maintenance_backup_size_bytes Last successful SQLite backup file size in bytes.');
    lines.push('# TYPE pivot_maintenance_backup_size_bytes gauge');
    lines.push(line('pivot_maintenance_backup_size_bytes', {}, maintenance.backup?.lastSizeBytes || 0));
    lines.push('# HELP pivot_maintenance_backup_deleted_files_total Backup files deleted by rolling cleanup.');
    lines.push('# TYPE pivot_maintenance_backup_deleted_files_total counter');
    lines.push(line('pivot_maintenance_backup_deleted_files_total', {}, maintenance.backup?.totalDeletedFiles || 0));

    return `${lines.join('\n')}\n`;
}

function metricsAuthMiddleware(req, res, next) {
    const token = process.env.METRICS_TOKEN;
    if (!token) return next();
    const authHeader = req.headers.authorization || '';
    const bearer = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
    const queryToken = req.query.token;
    if (bearer === token || queryToken === token) return next();
    return res.status(401).type('text/plain').send('unauthorized\n');
}

module.exports = {
    metricsMiddleware,
    metricsAuthMiddleware,
    renderPrometheusMetrics,
    recordHttpRequest,
    getHttpMetricsSnapshot,
    recordRagRetrieval,
    recordRagIngest,
    getRagMetricsSnapshot
};
