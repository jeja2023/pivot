const { query, queryOne } = require('../../db/client');
const { getBeijingTimestamp } = require('../../time');
const {
    MEMORY_JOB_STATUS,
    MEMORY_STATUS,
    MEMORY_TYPES,
    normalizeMemoryType
} = require('./memory-utils');
const { serializeMemory } = require('./memory-serialization');
const { prepareMemoryFeature, fastMemoryFeatureSimilarity } = require('./memory-merge');

const memoryQualityCache = new Map();
const MEMORY_QUALITY_CACHE_TTL_MS = 30000;

function getCachedMemoryQuality(userId) {
    const entry = memoryQualityCache.get(String(userId));
    if (entry && entry.expiresAt > Date.now()) {
        return entry.data;
    }
    return null;
}

function setCachedMemoryQuality(userId, data) {
    memoryQualityCache.set(String(userId), {
        data,
        expiresAt: Date.now() + MEMORY_QUALITY_CACHE_TTL_MS
    });
    if (memoryQualityCache.size > 200) {
        const now = Date.now();
        for (const [k, v] of memoryQualityCache.entries()) {
            if (v.expiresAt <= now) memoryQualityCache.delete(k);
        }
    }
}

function invalidateMemoryQualityCache(userId) {
    if (userId) {
        memoryQualityCache.delete(String(userId));
    } else {
        memoryQualityCache.clear();
    }
}

async function getMemorySummary(userId, isLongTermMemoryEnabled) {
    const rows = await query(`
        SELECT type, status, COUNT(*) AS count
        FROM memories
        WHERE user_id = ?
        GROUP BY type, status
    `, [userId]);
    const enabled = typeof isLongTermMemoryEnabled === 'function'
        ? await isLongTermMemoryEnabled(userId)
        : true;
    const summary = {
        enabled,
        active: 0,
        deleted: 0,
        disabled: 0,
        byType: Object.fromEntries(Object.values(MEMORY_TYPES).map(type => [type, 0]))
    };
    rows.forEach(row => {
        const count = Number(row.count || 0);
        if (row.status === MEMORY_STATUS.active) {
            summary.active += count;
            summary.byType[normalizeMemoryType(row.type)] = (summary.byType[normalizeMemoryType(row.type)] || 0) + count;
        } else if (row.status === MEMORY_STATUS.deleted) {
            summary.deleted += count;
        } else if (row.status === MEMORY_STATUS.disabled) {
            summary.disabled += count;
        }
    });
    return summary;
}

async function getMemoryJobSummary(userId) {
    const rows = await query(`
        SELECT status, COUNT(*) AS count
        FROM memory_extraction_jobs
        WHERE user_id = ?
        GROUP BY status
    `, [userId]);
    const byStatus = Object.fromEntries(Object.values(MEMORY_JOB_STATUS).map(status => [status, 0]));
    rows.forEach(row => {
        byStatus[row.status] = Number(row.count || 0);
    });
    const recentRows = await query(`
        SELECT status
        FROM memory_extraction_jobs
        WHERE user_id = ?
        ORDER BY id DESC
        LIMIT 50
    `, [userId]);
    const completed = recentRows.filter(row => [MEMORY_JOB_STATUS.succeeded, MEMORY_JOB_STATUS.failed, MEMORY_JOB_STATUS.skipped].includes(row.status));
    const succeeded = completed.filter(row => row.status === MEMORY_JOB_STATUS.succeeded).length;
    return {
        byStatus,
        queued: byStatus[MEMORY_JOB_STATUS.queued] || 0,
        running: byStatus[MEMORY_JOB_STATUS.running] || 0,
        failed: byStatus[MEMORY_JOB_STATUS.failed] || 0,
        recentSuccessRate: completed.length ? succeeded / completed.length : 1
    };
}

async function getMemoryMergeSuggestions(userId, options = {}) {
    const limit = Math.max(1, Math.min(Number.parseInt(options.limit, 10) || 20, 100));
    const candidateLimit = Math.max(limit * 3, 60);
    const rows = await query(`
        SELECT *
        FROM memories
        WHERE user_id = ?
          AND status = ?
        ORDER BY type ASC, salience DESC, COALESCE(last_used_at, updated_at, created_at) DESC
        LIMIT ?
    `, [userId, MEMORY_STATUS.active, candidateLimit]);
    if (!rows.length) return [];

    const features = rows.map(prepareMemoryFeature);
    const suggestions = [];

    const byType = new Map();
    for (const f of features) {
        if (!byType.has(f.type)) byType.set(f.type, []);
        byType.get(f.type).push(f);
    }

    for (const group of byType.values()) {
        for (let i = 0; i < group.length; i += 1) {
            const first = group[i];
            for (let j = i + 1; j < group.length; j += 1) {
                const second = group[j];
                let hasCommonTerm = false;
                if (first.terms.size > 0 && second.terms.size > 0) {
                    for (const t of first.terms) {
                        if (second.terms.has(t)) {
                            hasCommonTerm = true;
                            break;
                        }
                    }
                }
                if (!hasCommonTerm && Math.abs(first.text.length - second.text.length) > 30) {
                    continue;
                }
                const score = fastMemoryFeatureSimilarity(first, second);
                if (score < 0.52) continue;
                const primary = Number(first.salience || 0) >= Number(second.salience || 0) ? first.raw : second.raw;
                const duplicate = primary.id === first.id ? second.raw : first.raw;
                suggestions.push({
                    score,
                    reason: score >= 0.9 ? 'overlap' : 'similar_terms',
                    primary: serializeMemory(primary),
                    duplicate: serializeMemory(duplicate)
                });
            }
        }
    }
    return suggestions.sort((a, b) => b.score - a.score).slice(0, limit);
}

async function getMemoryQualitySummary(userId, isLongTermMemoryEnabled) {
    const cached = getCachedMemoryQuality(userId);
    if (cached) return cached;

    const now = getBeijingTimestamp();
    const unusedCutoff = getBeijingTimestamp(new Date(Date.now() - 30 * 24 * 60 * 60 * 1000));

    const [base, countsRow, mergeSuggestions, jobSummary] = await Promise.all([
        getMemorySummary(userId, isLongTermMemoryEnabled),
        queryOne(`
            SELECT
                COUNT(CASE WHEN confidence < 0.55 THEN 1 END) AS low_confidence,
                COUNT(CASE WHEN expires_at IS NOT NULL AND expires_at <= ? THEN 1 END) AS expired,
                COUNT(CASE WHEN last_used_at IS NULL AND created_at < ? THEN 1 END) AS unused
            FROM memories
            WHERE user_id = ? AND status = ?
        `, [now, unusedCutoff, userId, MEMORY_STATUS.active]),
        getMemoryMergeSuggestions(userId, { limit: 20 }),
        getMemoryJobSummary(userId)
    ]);

    const lowConfidence = Number(countsRow?.low_confidence || 0);
    const expired = Number(countsRow?.expired || 0);
    const unused = Number(countsRow?.unused || 0);

    const risks = [];
    if (lowConfidence > 0) risks.push({ type: 'low_confidence', count: lowConfidence });
    if (expired > 0) risks.push({ type: 'expired', count: expired });
    if (mergeSuggestions.length > 0) risks.push({ type: 'duplicates', count: mergeSuggestions.length });
    if (jobSummary.failed > 0) risks.push({ type: 'failed_jobs', count: jobSummary.failed });
    if (jobSummary.queued + jobSummary.running > 20) risks.push({ type: 'backlog', count: jobSummary.queued + jobSummary.running });

    const result = {
        ...base,
        quality: {
            lowConfidence,
            expired,
            unused,
            duplicateSuggestions: mergeSuggestions.length,
            jobSummary,
            risks,
            status: risks.length === 0 ? 'healthy' : risks.some(risk => ['failed_jobs', 'backlog'].includes(risk.type)) ? 'attention' : 'review'
        }
    };
    setCachedMemoryQuality(userId, result);
    return result;
}

module.exports = {
    getMemorySummary,
    getMemoryJobSummary,
    getMemoryMergeSuggestions,
    getMemoryQualitySummary,
    invalidateMemoryQualityCache
};
