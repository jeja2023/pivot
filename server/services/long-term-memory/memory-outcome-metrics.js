'use strict';

const { query, queryOne } = require('../../db/client');
const { getBeijingTimestamp } = require('../../time');

const MIN_EVALUATED_SAMPLES = 30;
const THRESHOLDS = Object.freeze({
    helpfulRate: 0.75,
    conflictRate: 0.10,
    expiredHitRate: 0.01,
    revokedResidualRate: 0
});

function clampDays(value, fallback = 30) {
    return Math.min(Math.max(Number.parseInt(value, 10) || fallback, 1), 3650);
}

function ratio(numerator, denominator) {
    const total = Number(denominator || 0);
    return total > 0 ? Number(numerator || 0) / total : null;
}

function parseJson(value, fallback = {}) {
    if (value && typeof value === 'object') return value;
    try { return JSON.parse(String(value || '')); } catch (_) { return fallback; }
}

function monthBounds(date = new Date()) {
    const current = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
    const previous = new Date(Date.UTC(current.getUTCFullYear(), current.getUTCMonth() - 1, 1));
    return {
        start: previous.toISOString().slice(0, 10),
        end: current.toISOString().slice(0, 10)
    };
}

function assessMemoryOutcomeMetrics(metrics = {}) {
    const evaluated = Number(metrics.evaluatedCount || 0);
    const helpfulRate = metrics.helpfulRate;
    const conflictRate = metrics.conflictRate;
    const expiredHitRate = metrics.expiredHitRate;
    const revokedResidualRate = metrics.revokedResidualRate;
    const blockers = [];
    if (evaluated < MIN_EVALUATED_SAMPLES) blockers.push({ code: 'MEMORY_OUTCOME_SAMPLE_INSUFFICIENT', message: `已评估注入样本不足 ${MIN_EVALUATED_SAMPLES} 条。` });
    if (helpfulRate !== null && helpfulRate < THRESHOLDS.helpfulRate) blockers.push({ code: 'MEMORY_HELPFUL_RATE_LOW', message: '记忆有用率未达到阈值。' });
    if (conflictRate !== null && conflictRate > THRESHOLDS.conflictRate) blockers.push({ code: 'MEMORY_CONFLICT_RATE_HIGH', message: '记忆冲突率超过阈值。' });
    if (expiredHitRate !== null && expiredHitRate > THRESHOLDS.expiredHitRate) blockers.push({ code: 'MEMORY_EXPIRED_HIT_RATE_HIGH', message: '过期记忆命中率超过阈值。' });
    if (revokedResidualRate !== null && revokedResidualRate > THRESHOLDS.revokedResidualRate) blockers.push({ code: 'MEMORY_REVOKED_RESIDUAL_DETECTED', message: '发现撤销后残留的记忆注入。' });
    return { status: blockers.length ? (evaluated < MIN_EVALUATED_SAMPLES ? 'insufficient_data' : 'attention') : 'passing', blockers, thresholds: THRESHOLDS };
}

async function getMemoryOutcomeMetrics(userId, { days = 30, start = '', end = '' } = {}, deps = {}) {
    const safeUserId = Number.parseInt(userId, 10);
    if (!Number.isSafeInteger(safeUserId) || safeUserId <= 0) return null;
    const safeDays = clampDays(days);
    const now = new Date();
    const rangeStart = start || getBeijingTimestamp(new Date(now.getTime() - safeDays * 24 * 60 * 60 * 1000));
    // 运行期写入沿用秒级北京时间；动态查询的右边界向后扩一秒，避免同一秒
    // 新写入的注入事件因毫秒精度差而被排除。调用方明确传入 period end 时保持半开区间语义。
    const rangeEnd = end || getBeijingTimestamp(new Date(now.getTime() + 1000));
    const row = await (deps.queryOne || queryOne)(`
        WITH injected AS (
            SELECT DISTINCT ON (u.memory_id, u.run_id)
                u.memory_id, u.run_id, u.created_at, m.expires_at, m.revoked_at,
                v.outcome_status AS verification_outcome, f.outcome AS feedback_outcome,
                f.rating AS feedback_rating, COALESCE(f.correction, '') AS correction
            FROM memory_usage_events u
            JOIN memories m ON m.id = u.memory_id AND m.user_id = u.user_id
            LEFT JOIN agent_verifications v ON v.run_id = u.run_id
            LEFT JOIN agent_feedback f ON f.run_id = u.run_id AND f.user_id = u.user_id
            WHERE u.user_id = ?
              AND u.event_type IN ('injected', 'adopted')
              AND u.run_id IS NOT NULL AND u.run_id <> ''
              AND u.created_at >= ? AND u.created_at < ?
            ORDER BY u.memory_id, u.run_id, u.created_at DESC, u.id DESC
        )
        SELECT
            COUNT(*)::int AS injected_count,
            COUNT(*) FILTER (WHERE verification_outcome IS NOT NULL OR feedback_outcome IS NOT NULL OR feedback_rating IS NOT NULL)::int AS evaluated_count,
            COUNT(*) FILTER (
                WHERE verification_outcome = 'verified'
                  AND COALESCE(feedback_outcome, 'success') = 'success'
                  AND (feedback_rating IS NULL OR feedback_rating >= 4)
            )::int AS helpful_count,
            COUNT(*) FILTER (
                WHERE (verification_outcome IS NOT NULL AND verification_outcome <> 'verified')
                   OR feedback_outcome IN ('failure', 'partial')
                   OR feedback_rating <= 2
                   OR correction <> ''
            )::int AS conflict_count,
            COUNT(*) FILTER (WHERE expires_at IS NOT NULL AND expires_at <= created_at)::int AS expired_hit_count,
            COUNT(*) FILTER (WHERE revoked_at IS NOT NULL AND revoked_at <= created_at)::int AS revoked_residual_count
        FROM injected
    `, [safeUserId, rangeStart, rangeEnd]);
    const injectedCount = Number(row?.injected_count || 0);
    const evaluatedCount = Number(row?.evaluated_count || 0);
    const result = {
        days: safeDays,
        rangeStart,
        rangeEnd,
        injectedCount,
        evaluatedCount,
        helpfulCount: Number(row?.helpful_count || 0),
        conflictCount: Number(row?.conflict_count || 0),
        expiredHitCount: Number(row?.expired_hit_count || 0),
        revokedResidualCount: Number(row?.revoked_residual_count || 0)
    };
    result.helpfulRate = ratio(result.helpfulCount, evaluatedCount);
    result.conflictRate = ratio(result.conflictCount, evaluatedCount);
    result.expiredHitRate = ratio(result.expiredHitCount, injectedCount);
    result.revokedResidualRate = ratio(result.revokedResidualCount, injectedCount);
    return { ...result, ...assessMemoryOutcomeMetrics(result) };
}

async function snapshotMemoryOutcomePeriod(userId, options = {}, deps = {}) {
    const bounds = options.periodStart && options.periodEnd
        ? { start: String(options.periodStart), end: String(options.periodEnd) }
        : monthBounds(options.now instanceof Date ? options.now : new Date());
    const metrics = await getMemoryOutcomeMetrics(userId, { start: bounds.start, end: bounds.end, days: 31 }, deps);
    if (!metrics) return null;
    const now = getBeijingTimestamp();
    const row = await (deps.queryOne || queryOne)(`
        INSERT INTO memory_quality_periods (user_id, period_start, period_end, metrics, evaluated_count, status, computed_at)
        VALUES (?, ?::date, ?::date, ?::jsonb, ?, ?, ?)
        ON CONFLICT(user_id, period_start, period_end) DO UPDATE SET
            metrics = EXCLUDED.metrics, evaluated_count = EXCLUDED.evaluated_count,
            status = EXCLUDED.status, computed_at = EXCLUDED.computed_at
        RETURNING *
    `, [Number(userId), bounds.start, bounds.end, JSON.stringify(metrics), metrics.evaluatedCount, metrics.status, now]);
    return { ...row, metrics: parseJson(row?.metrics, metrics) };
}

async function listMemoryOutcomePeriods(userId, { limit = 12 } = {}, deps = {}) {
    const safeLimit = Math.min(Math.max(Number.parseInt(limit, 10) || 12, 1), 60);
    const rows = await (deps.query || query)(`
        SELECT period_start, period_end, metrics, evaluated_count, status, computed_at
        FROM memory_quality_periods WHERE user_id = ?
        ORDER BY period_end DESC LIMIT ?
    `, [Number(userId), safeLimit]);
    return rows.map(row => ({
        periodStart: row.period_start, periodEnd: row.period_end, metrics: parseJson(row.metrics, {}),
        evaluatedCount: Number(row.evaluated_count || 0), status: row.status || 'insufficient_data', computedAt: row.computed_at || null
    }));
}

async function getMemoryOutcomeReadiness(userId, deps = {}) {
    const periods = await listMemoryOutcomePeriods(userId, { limit: 3 }, deps);
    const twoLatest = periods.slice(0, 2);
    return {
        requiredCompletedPeriods: 2,
        qualifyingPeriods: twoLatest.filter(item => item.status === 'passing').length,
        passed: twoLatest.length === 2 && twoLatest.every(item => item.status === 'passing'),
        periods: twoLatest
    };
}

async function refreshMemoryOutcomePeriods(deps = {}) {
    const users = await (deps.query || query)(`
        SELECT DISTINCT user_id FROM memory_usage_events
        WHERE event_type IN ('injected', 'adopted')
          AND created_at >= CURRENT_TIMESTAMP - INTERVAL '90 days'
    `);
    const results = [];
    for (const row of users) results.push(await snapshotMemoryOutcomePeriod(row.user_id, {}, deps));
    return { users: results.filter(Boolean).length, periods: results };
}

function createMemoryOutcomeMetricsRunner({ pollIntervalMs = 6 * 60 * 60 * 1000, logger = console, deps = {} } = {}) {
    const interval = Math.min(Math.max(Number.parseInt(pollIntervalMs, 10) || 6 * 60 * 60 * 1000, 60000), 24 * 60 * 60 * 1000);
    let timer = null;
    const runOnce = async () => {
        try { return await refreshMemoryOutcomePeriods(deps); }
        catch (error) { logger.warn?.({ err: error.message }, '长期记忆效用周期指标刷新失败'); return null; }
    };
    return {
        start() { if (!timer) { timer = setInterval(() => { void runOnce(); }, interval); timer.unref?.(); void runOnce(); } return { started: true, intervalMs: interval }; },
        stop() { if (timer) clearInterval(timer); timer = null; },
        runOnce,
        getRuntimeStatus: () => ({ started: Boolean(timer), intervalMs: interval })
    };
}

module.exports = {

    assessMemoryOutcomeMetrics,
    createMemoryOutcomeMetricsRunner,
    getMemoryOutcomeMetrics,
    getMemoryOutcomeReadiness,
    listMemoryOutcomePeriods,

    snapshotMemoryOutcomePeriod
};
