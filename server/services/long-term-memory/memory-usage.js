const { query, queryOne, transaction } = require('../../db/client');
const { getBeijingTimestamp } = require('../../time');
const { generateEmbedding, cosineSimilarity } = require('../rag-index');
const { filterMemoriesForRetrieval } = require('../memory-governance');
const {
    clamp,
    fingerprintMemory,
    normalizeScopeReference,
    MEMORY_STATUS,
    DEFAULT_MAX_INJECTED_MEMORIES
} = require('./memory-utils');
const { serializeMemory } = require('./memory-serialization');
const { parseEmbedding, keywordScore, recencyScore } = require('./memory-retrieval');
const { isLongTermMemoryEnabled } = require('./memory-gate');

function buildMemoryScopeFilter(options = {}) {
    const sessionId = normalizeScopeReference(options.sessionId || options.session_id);
    const projectId = normalizeScopeReference(options.projectId || options.project_id);
    const scopeWhere = ["scope = 'user'", "scope = 'global'"];
    const scopeParams = [];
    if (sessionId) {
        scopeWhere.push("(scope = 'session' AND (scope_reference = ? OR (scope_reference = '' AND source_session_id = ?)))");
        scopeParams.push(sessionId, sessionId);
    }
    if (projectId) {
        scopeWhere.push("(scope = 'project' AND (project_id = ? OR scope_reference = ?))");
        scopeParams.push(projectId, projectId);
    }
    return { scopeSql: `(${scopeWhere.join(' OR ')})`, scopeParams };
}

async function getMemoryRow(userId, memoryId, options = {}) {
    const id = Number.parseInt(memoryId, 10);
    if (!Number.isSafeInteger(id) || id <= 0) return null;
    const includeDeleted = options.includeDeleted === true;
    return await queryOne(`
        SELECT *
        FROM memories
        WHERE id = ? AND user_id = ?${includeDeleted ? '' : ' AND status != ?'}
    `, includeDeleted ? [id, userId] : [id, userId, MEMORY_STATUS.deleted]);
}

async function recordMemoryUsage(userId, memories = [], options = {}) {
    const selected = (Array.isArray(memories) ? memories : [])
        .filter(memory => Number.isSafeInteger(Number(memory?.id)) && Number(memory.id) > 0)
        .slice(0, 20);
    if (selected.length === 0) return { recorded: 0 };
    const now = getBeijingTimestamp();
    const eventType = ['candidate', 'injected', 'trimmed', 'adopted', 'shadow_legacy', 'shadow_candidate'].includes(options.eventType) ? options.eventType : 'injected';
    const queryFingerprint = options.queryText ? fingerprintMemory('episode', String(options.queryText).slice(0, 800)) : '';
    await transaction(async trx => {
        for (let index = 0; index < selected.length; index += 1) {
            const memory = selected[index];
            await trx.execute(`
                INSERT INTO memory_usage_events (
                    user_id, memory_id, event_type, session_id, run_id, query_fingerprint, rank, score, reason, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `, [
                Number(userId),
                Number(memory.id),
                eventType,
                normalizeScopeReference(options.sessionId || options.session_id) || null,
                String(options.runId || options.run_id || '').slice(0, 160) || null,
                queryFingerprint,
                index + 1,
                Number(memory.score || 0),
                String(memory.usageReason || options.reason || '').slice(0, 160),
                now
            ]);
        }
        if (eventType === 'injected' || eventType === 'adopted') {
            const ids = selected.map(memory => Number(memory.id));
            await trx.execute(`
                UPDATE memories SET last_used_at = ?, updated_at = updated_at
                WHERE user_id = ? AND id IN (${ids.map(() => '?').join(',')})
            `, [now, Number(userId), ...ids]);
        }
    });
    return { recorded: selected.length, eventType };
}

async function compareMemoryRetrievalShadow(userId, queryText, candidateMemories = [], options = {}) {
    const normalizedQuery = String(queryText || '').trim();
    if (!normalizedQuery || !(await isLongTermMemoryEnabled(userId))) return { compared: false, reason: 'disabled_or_empty' };
    const now = getBeijingTimestamp();
    const scopeFilter = buildMemoryScopeFilter(options);
    const legacyRows = await filterMemoriesForRetrieval(userId, await query(`
        SELECT * FROM memories
        WHERE user_id = ? AND status = ? AND (expires_at IS NULL OR expires_at > ?)
          AND (valid_from IS NULL OR valid_from <= ?)
          AND ${scopeFilter.scopeSql}
        ORDER BY salience DESC, confidence DESC, updated_at DESC
        LIMIT 200
    `, [Number(userId), MEMORY_STATUS.active, now, now, ...scopeFilter.scopeParams]));
    let queryVector = null;
    if (legacyRows.some(row => row.embedding)) {
        try {
            queryVector = await generateEmbedding(normalizedQuery, null, null, userId, { user: options.user || null, source: 'memory_shadow_embedding' });
        } catch (_) {
            // 影子遥测绝不能影响实时回答路径。
        }
    }
    const legacy = legacyRows.map(row => {
        const vector = queryVector ? parseEmbedding(row.embedding) : null;
        const semantic = vector && vector.length === queryVector.length ? Math.max(0, cosineSimilarity(queryVector, vector)) : 0;
        const lexical = keywordScore(row, normalizedQuery);
        const relevance = queryVector ? Math.max(semantic, lexical * 0.75) : lexical;
        const score = relevance * 0.52
            + clamp(row.salience, 0, 1, 0.5) * 0.22
            + clamp(row.confidence, 0, 1, 0.6) * 0.16
            + recencyScore(row) * 0.10;
        return { ...serializeMemory(row), score, relevance, usageReason: '旧排序影子候选' };
    }).filter(item => item.relevance > 0 || item.salience >= 0.75)
        .sort((left, right) => right.score - left.score)
        .slice(0, Math.max(1, Math.min(Number(options.limit) || DEFAULT_MAX_INJECTED_MEMORIES, 20)));
    await Promise.all([
        recordMemoryUsage(userId, legacy, { eventType: 'shadow_legacy', sessionId: options.sessionId, runId: options.runId, queryText: normalizedQuery, reason: 'shadow_legacy' }),
        recordMemoryUsage(userId, candidateMemories, { eventType: 'shadow_candidate', sessionId: options.sessionId, runId: options.runId, queryText: normalizedQuery, reason: 'shadow_candidate' })
    ]);
    const legacyIds = legacy.map(item => Number(item.id));
    const candidateIds = (Array.isArray(candidateMemories) ? candidateMemories : []).map(item => Number(item.id)).filter(Number.isSafeInteger);
    return {
        compared: true,
        legacyIds,
        candidateIds,
        addedIds: candidateIds.filter(id => !legacyIds.includes(id)),
        removedIds: legacyIds.filter(id => !candidateIds.includes(id))
    };
}

async function getMemoryUsage(userId, memoryId, options = {}) {
    const memory = await getMemoryRow(userId, memoryId);
    if (!memory) return null;
    const rows = await query(`
        SELECT event_type, session_id, run_id, rank, score, reason, created_at
        FROM memory_usage_events
        WHERE user_id = ? AND memory_id = ?
        ORDER BY created_at DESC, id DESC
        LIMIT ?
    `, [Number(userId), Number(memoryId), Math.max(1, Math.min(Number.parseInt(options.limit, 10) || 20, 100))]);
    return { memory: serializeMemory(memory), events: rows.map(row => ({
        eventType: row.event_type,
        sessionId: row.session_id || null,
        runId: row.run_id || null,
        rank: row.rank === null ? null : Number(row.rank),
        score: row.score === null ? null : Number(row.score),
        reason: row.reason || '',
        createdAt: row.created_at || null
    })) };
}

module.exports = {
    buildMemoryScopeFilter,
    recordMemoryUsage,
    compareMemoryRetrievalShadow,
    getMemoryUsage
};
