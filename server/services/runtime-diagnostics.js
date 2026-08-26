/**
 * server/services/runtime-diagnostics.js
 * 运行时健康探针：事件循环延迟、PostgreSQL 连接池水位、在途 HTTP 请求数、堆内存。
 *
 * 定位问题：单进程 Node 服务出现「所有接口一起卡住」时，唯一能区分成因的观测点是
 *   1. 事件循环是否被同步操作阻塞（延迟飙高）；
 *   2. PG 连接池是否被慢查询占满（waiting > 0 且 idle = 0）；
 *   3. 在途请求是否堆积（socket 未释放）；
 *   4. 堆是否逼近上限（GC 抖动）。
 * 这些指标不落库、无外部依赖，仅在进程内累计，供 /api/health/details 与监控面板读取。
 */
const { monitorEventLoopDelay } = require('node:perf_hooks');
const { logger } = require('../logger');
const { isApiRequestPath } = require('../http');

const NS_PER_MS = 1e6;
const SAMPLE_RESOLUTION_MS = 20;

let loopDelayHistogram = null;
try {
    loopDelayHistogram = monitorEventLoopDelay({ resolution: SAMPLE_RESOLUTION_MS });
    loopDelayHistogram.enable();
} catch (_err) {
    // 极少数运行环境不支持该 API，降级为不采样
    loopDelayHistogram = null;
}

let inFlightRequests = 0;
let peakInFlightRequests = 0;
const inFlightByRoute = new Map();
const MAX_TRACKED_ROUTES = 128;

function routeKeyOf(req) {
    const method = req.method || 'GET';
    const path = String(req.path || req.url || '').split('?')[0];
    return `${method} ${path.slice(0, 120)}`;
}

/** 统计在途请求：请求进入时 +1，响应结束或连接关闭时 -1。 */
function inFlightRequestMiddleware(req, res, next) {
    const key = routeKeyOf(req);
    inFlightRequests += 1;
    if (inFlightRequests > peakInFlightRequests) peakInFlightRequests = inFlightRequests;
    if (inFlightByRoute.size < MAX_TRACKED_ROUTES || inFlightByRoute.has(key)) {
        inFlightByRoute.set(key, (inFlightByRoute.get(key) || 0) + 1);
    }
    let settled = false;
    const done = () => {
        if (settled) return;
        settled = true;
        inFlightRequests = Math.max(0, inFlightRequests - 1);
        const remaining = (inFlightByRoute.get(key) || 1) - 1;
        if (remaining > 0) inFlightByRoute.set(key, remaining);
        else inFlightByRoute.delete(key);
    };
    res.once('finish', done);
    res.once('close', done);
    next();
}

function getEventLoopDelay() {
    if (!loopDelayHistogram) return { supported: false, meanMs: 0, p99Ms: 0, maxMs: 0 };
    return {
        supported: true,
        meanMs: Number((loopDelayHistogram.mean / NS_PER_MS).toFixed(2)) || 0,
        p99Ms: Number((loopDelayHistogram.percentile(99) / NS_PER_MS).toFixed(2)) || 0,
        maxMs: Number((loopDelayHistogram.max / NS_PER_MS).toFixed(2)) || 0
    };
}

/** 重置直方图，使采样窗口反映「最近一段时间」而非进程全生命周期。 */
function resetEventLoopDelay() {
    loopDelayHistogram?.reset();
}

function getPgPoolSnapshot() {
    try {
        const { peekPgPool } = require('../db/pg-connection');
        // 用 peek 而非 getPgPool：观测动作本身绝不能把连接池建起来。
        const pool = peekPgPool();
        if (!pool) {
            return { available: false, max: 0, total: 0, idle: 0, busy: 0, waiting: 0, saturated: false };
        }
        const max = Number(pool.options?.max || 0) || 0;
        const total = Number(pool.totalCount || 0);
        const idle = Number(pool.idleCount || 0);
        const waiting = Number(pool.waitingCount || 0);
        return {
            available: true,
            max,
            total,
            idle,
            busy: Math.max(0, total - idle),
            waiting,
            saturated: max > 0 && waiting > 0 && idle === 0
        };
    } catch (err) {
        return { available: false, error: err.message, max: 0, total: 0, idle: 0, busy: 0, waiting: 0, saturated: false };
    }
}

function getInFlightRequestSnapshot() {
    const routes = [...inFlightByRoute.entries()]
        .map(([route, count]) => ({ route, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 10);
    return { current: inFlightRequests, peak: peakInFlightRequests, routes };
}

function getHeapSnapshot() {
    const memory = process.memoryUsage();
    let heapLimit = 0;
    try {
        heapLimit = Number(require('node:v8').getHeapStatistics().heap_size_limit || 0) || 0;
    } catch (_err) {
        heapLimit = 0;
    }
    const usedRatio = heapLimit > 0 ? memory.heapUsed / heapLimit : 0;
    return {
        heapUsed: memory.heapUsed,
        heapTotal: memory.heapTotal,
        rss: memory.rss,
        external: memory.external,
        heapLimit,
        usedRatio: Number(usedRatio.toFixed(4))
    };
}

const LOOP_DELAY_WARN_MS = Math.max(50, Number.parseInt(process.env.RUNTIME_LOOP_DELAY_WARN_MS || '500', 10) || 500);
const HEAP_WARN_RATIO = Math.min(0.99, Math.max(0.5, Number(process.env.RUNTIME_HEAP_WARN_RATIO || '0.85') || 0.85));

function getRuntimeDiagnostics() {
    const loop = getEventLoopDelay();
    const pool = getPgPoolSnapshot();
    const requests = getInFlightRequestSnapshot();
    const heap = getHeapSnapshot();
    const degraded = loop.p99Ms >= LOOP_DELAY_WARN_MS || pool.saturated || heap.usedRatio >= HEAP_WARN_RATIO;
    return {
        status: degraded ? 'degraded' : 'ok',
        eventLoop: loop,
        pgPool: pool,
        requests,
        heap,
        thresholds: { loopDelayWarnMs: LOOP_DELAY_WARN_MS, heapWarnRatio: HEAP_WARN_RATIO },
        message: degraded
            ? `运行时压力异常：事件循环 p99 ${loop.p99Ms}ms，连接池 ${pool.busy}/${pool.max} 忙、${pool.waiting} 等待，堆占用 ${Math.round(heap.usedRatio * 100)}%`
            : `事件循环 p99 ${loop.p99Ms}ms，连接池 ${pool.busy}/${pool.max} 忙，在途请求 ${requests.current}`
    };
}

const SAMPLER_INTERVAL_MS = Math.max(10_000, Number.parseInt(process.env.RUNTIME_DIAGNOSTICS_INTERVAL_MS || '60000', 10) || 60_000);
let samplerTimer = null;

/**
 * 周期性把运行时压力写进日志。故障发生时不再需要「事后猜」：
 * 日志里会留下事件循环延迟与连接池水位的时间序列。
 */
function startRuntimeDiagnostics() {
    if (samplerTimer) return samplerTimer;
    samplerTimer = setInterval(() => {
        const snapshot = getRuntimeDiagnostics();
        if (snapshot.status === 'degraded') {
            logger.warn({
                eventLoop: snapshot.eventLoop,
                pgPool: snapshot.pgPool,
                requests: snapshot.requests,
                heapUsedRatio: snapshot.heap.usedRatio
            }, '[运行时] 压力异常');
        } else {
            logger.debug({
                eventLoop: snapshot.eventLoop,
                pgPool: snapshot.pgPool,
                inFlight: snapshot.requests.current
            }, '[运行时] 采样');
        }
        resetEventLoopDelay();
    }, SAMPLER_INTERVAL_MS);
    samplerTimer.unref?.();
    return samplerTimer;
}

function stopRuntimeDiagnostics() {
    if (samplerTimer) clearInterval(samplerTimer);
    samplerTimer = null;
}

// ── 接口悬挂兜底 ──────────────────────────────────────────────────────────
// 没有这道兜底时，任何一处资源饥饿（连接池占满、libuv 线程池占满、事件循环被同步
// 操作拖住）都会让请求一直悬着，直到浏览器自己在 30 秒后 abort。对用户就是「一直
// 加载中 → 请求超时 → 所有页面都点不动」，而服务端日志里连一条错误都没有。
// 到期后主动回 503，可以做到三件事：立刻释放 socket、给出可诊断的错误码、
// 在日志里留下当时的事件循环延迟与连接池水位。
const DEFAULT_WATCHDOG_MS = 20000;

// 每次判定时读取环境变量：便于灰度调整与测试注入，代价只是一次 parseInt。
function resolveWatchdogMs() {
    const raw = process.env.API_REQUEST_WATCHDOG_MS;
    if (raw === undefined || raw === '') return DEFAULT_WATCHDOG_MS;
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) return 0; // 显式 0 / 非法值 => 关闭兜底
    return parsed;
}

// 长连接与长耗时下载不能被兜底掐断：SSE 已经先发头（headersSent 会挡住），
// 但本机执行器长轮询（最长 30 秒）与导出/下载类接口需要显式放行。
const WATCHDOG_SKIP_PATTERNS = [
    '/api/events',
    '/api/mcp/local-device/tasks/next',
    '/export',
    '/download'
];

function shouldWatchRequest(req, watchdogMs) {
    if (watchdogMs <= 0) return false;
    if (req.method !== 'GET' && req.method !== 'HEAD') return false;
    const requestPath = req.path || '';
    if (!isApiRequestPath(requestPath)) return false;
    return !WATCHDOG_SKIP_PATTERNS.some(pattern => requestPath.includes(pattern));
}

function apiRequestWatchdog(req, res, next) {
    const watchdogMs = resolveWatchdogMs();
    if (!shouldWatchRequest(req, watchdogMs)) return next();
    const timer = setTimeout(() => {
        // 已经开始写响应（SSE / 流式）的请求交给各自的生命周期管理，不介入。
        if (res.headersSent || res.writableEnded) return;
        const snapshot = getRuntimeDiagnostics();
        if (res.locals) res.locals.watchdogTripped = true;
        (req.log || logger).error({
            method: req.method,
            url: req.originalUrl || req.url,
            waitedMs: watchdogMs,
            eventLoop: snapshot.eventLoop,
            pgPool: snapshot.pgPool,
            inFlight: snapshot.requests,
            heapUsedRatio: snapshot.heap.usedRatio
        }, '[运行时] 接口处理超时，已主动返回 503');
        try {
            res.status(503).json({
                error: '服务器繁忙，请稍后重试',
                code: 'SERVER_BUSY_TIMEOUT',
                diagnostics: {
                    eventLoopP99Ms: snapshot.eventLoop.p99Ms,
                    pgPoolBusy: snapshot.pgPool.busy,
                    pgPoolMax: snapshot.pgPool.max,
                    pgPoolWaiting: snapshot.pgPool.waiting
                }
            });
        } catch (_err) {
            try { res.end(); } catch (_ignored) {}
        }
    }, watchdogMs);
    timer.unref?.();
    const clear = () => clearTimeout(timer);
    res.once('finish', clear);
    res.once('close', clear);
    next();
}

module.exports = {
    apiRequestWatchdog,
    getEventLoopDelay,
    getHeapSnapshot,
    getInFlightRequestSnapshot,
    getPgPoolSnapshot,
    getRuntimeDiagnostics,
    inFlightRequestMiddleware,
    resetEventLoopDelay,
    resolveWatchdogMs,
    shouldWatchRequest,
    startRuntimeDiagnostics,
    stopRuntimeDiagnostics
};
