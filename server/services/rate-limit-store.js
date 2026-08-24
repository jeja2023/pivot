const { query, execute } = require('../db/client');
const { logger } = require('../logger');

// Shared PostgreSQL-backed store for express-rate-limit. A small local fallback
// keeps the limiter fail-safe during a transient database outage without making
// the process depend on an unbounded in-memory map.
function createRateLimitStore(prefix = 'default') {
    let windowMs = 60_000;
    const fallback = new Map();
    let warned = false;

    function init(options = {}) {
        const configured = Number(options.windowMs);
        if (Number.isFinite(configured) && configured > 0) windowMs = configured;
    }

    function keyFor(key) {
        return `${String(prefix).slice(0, 40)}:${String(key).slice(0, 240)}`;
    }

    function localIncrement(key) {
        const now = Date.now();
        const windowStart = Math.floor(now / windowMs) * windowMs;
        const resetAt = windowStart + windowMs;
        const current = fallback.get(key);
        const next = !current || current.resetAt <= now
            ? { hits: 1, resetAt }
            : { hits: current.hits + 1, resetAt: current.resetAt };
        fallback.set(key, next);
        if (fallback.size > 10000) {
            for (const [entryKey, entry] of fallback) {
                if (entry.resetAt <= now) fallback.delete(entryKey);
                if (fallback.size <= 8000) break;
            }
        }
        return { totalHits: next.hits, resetTime: new Date(next.resetAt) };
    }

    async function increment(key) {
        const scopedKey = keyFor(key);
        const now = Date.now();
        const windowStart = Math.floor(now / windowMs) * windowMs;
        const resetAt = windowStart + windowMs;
        try {
            const rows = await query(`
                INSERT INTO rate_limit_counters (key, window_start_ms, reset_at_ms, hits, updated_at)
                VALUES (?, ?, ?, 1, NOW())
                ON CONFLICT (key) DO UPDATE SET
                    window_start_ms = CASE WHEN rate_limit_counters.reset_at_ms <= EXCLUDED.window_start_ms THEN EXCLUDED.window_start_ms ELSE rate_limit_counters.window_start_ms END,
                    reset_at_ms = CASE WHEN rate_limit_counters.reset_at_ms <= EXCLUDED.window_start_ms THEN EXCLUDED.reset_at_ms ELSE rate_limit_counters.reset_at_ms END,
                    hits = CASE WHEN rate_limit_counters.reset_at_ms <= EXCLUDED.window_start_ms THEN 1 ELSE rate_limit_counters.hits + 1 END,
                    updated_at = NOW()
                RETURNING hits, reset_at_ms
            `, [scopedKey, windowStart, resetAt]);
            warned = false;
            const row = rows[0] || { hits: 1, reset_at_ms: resetAt };
            return { totalHits: Number(row.hits || 0), resetTime: new Date(Number(row.reset_at_ms || resetAt)) };
        } catch (error) {
            if (!warned) {
                warned = true;
                logger.warn({ err: error.message, prefix }, '共享限流存储不可用，暂时回退到受限本地计数');
            }
            return localIncrement(scopedKey);
        }
    }

    async function decrement(key) {
        try {
            await query('UPDATE rate_limit_counters SET hits = GREATEST(hits - 1, 0), updated_at = NOW() WHERE key = ?', [keyFor(key)]);
        } catch (_) {}
    }

    async function resetKey(key) {
        fallback.delete(keyFor(key));
        try { await query('DELETE FROM rate_limit_counters WHERE key = ?', [keyFor(key)]); } catch (_) {}
    }

    return { init, increment, decrement, resetKey, localKeys: fallback };
}

module.exports = { createRateLimitStore };

async function cleanupRateLimitCounters({ olderThanMs = 24 * 60 * 60 * 1000 } = {}) {
    return execute('DELETE FROM rate_limit_counters WHERE reset_at_ms < ?', [Date.now() - Math.max(60_000, olderThanMs)]);
}

module.exports.cleanupRateLimitCounters = cleanupRateLimitCounters;
