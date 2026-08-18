const { query, queryOne } = require('../db/client');
const { logger } = require('../logger');
const { getBeijingTimestamp } = require('../time');

function safeJson(value, fallback) {
    try {
        return JSON.stringify(value === undefined ? fallback : value);
    } catch (_err) {
        return JSON.stringify(fallback);
    }
}

function parseJson(value, fallback) {
    try {
        return JSON.parse(value || '');
    } catch (_err) {
        return fallback;
    }
}

function normalizeLimit(value, fallback = 20, max = 100) {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
    return Math.min(parsed, max);
}

function normalizeDebugScores(matches = []) {
    return (Array.isArray(matches) ? matches : []).slice(0, 40).map((item, index) => ({
        rank: Number(item.rank || index + 1),
        chunkId: item.chunkId || null,
        source: String(item.source || '').slice(0, 240),
        score: Number(item.score || 0),
        fusedScore: Number(item.fusedScore ?? item.scores?.fused ?? item.score ?? 0),
        matched: item.matched === true,
        selected: item.selected === true,
        denseRank: item.scores?.denseRank || null,
        ftsRank: item.scores?.ftsRank || null
    }));
}

async function recordRagDebugQuery(input = {}) {
    const userId = Number(input.userId || input.user_id || 0);
    const queryStr = String(input.query || '').trim();
    if (!userId || !queryStr) return null;

    const result = input.result || {};
    const matches = Array.isArray(result.matches) ? result.matches : [];
    const scores = normalizeDebugScores(matches);
    const selectedChunkIds = scores
        .filter(item => item.selected || item.matched)
        .map(item => item.chunkId)
        .filter(Boolean);
    const matchedCount = scores.filter(item => item.matched).length;

    const params = [
        userId,
        queryStr.slice(0, 1000),
        safeJson(input.scope || result.scope || {}, {}),
        Math.max(0, Number.parseInt(input.topK ?? input.top_k ?? result.topK ?? 0, 10) || 0),
        Math.max(0, Number.parseInt(input.candidateLimit ?? input.candidate_limit ?? result.candidateLimit ?? 0, 10) || 0),
        Number(input.scoreThreshold ?? input.score_threshold ?? result.threshold ?? 0) || 0,
        Math.max(0, Number.parseInt(result.candidateCount ?? input.candidateCount ?? 0, 10) || 0),
        matchedCount,
        safeJson(selectedChunkIds, []),
        safeJson(scores, []),
        safeJson(input.queue || {}, {}),
        Math.max(0, Math.round(Number(input.elapsedMs ?? input.elapsed_ms ?? 0) || 0)),
        getBeijingTimestamp()
    ];

    try {
        const row = await queryOne(`
            INSERT INTO rag_debug_queries (
                user_id, query, scope_json, top_k, candidate_limit, score_threshold,
                candidate_count, matched_count, selected_chunk_ids, scores_json,
                queue_json, elapsed_ms, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            RETURNING *
        `, params);
        return row || null;
    } catch (err) {
        logger.warn({ err: err.message, userId }, 'RAG 调试历史写入失败');
        return null;
    }
}

function mapRagDebugRow(row) {
    if (!row) return null;
    return {
        id: row.id,
        userId: row.user_id,
        query: row.query,
        scope: parseJson(row.scope_json, {}),
        topK: row.top_k,
        candidateLimit: row.candidate_limit,
        scoreThreshold: row.score_threshold,
        candidateCount: row.candidate_count,
        matchedCount: row.matched_count,
        selectedChunkIds: parseJson(row.selected_chunk_ids, []),
        scores: parseJson(row.scores_json, []),
        queue: parseJson(row.queue_json, {}),
        elapsedMs: row.elapsed_ms,
        createdAt: row.created_at
    };
}

async function listRagDebugQueries(userId, options = {}) {
    const safeUserId = Number(userId || 0);
    if (!safeUserId) return [];
    const limit = normalizeLimit(options.limit, 20, 100);
    const rows = await query(`
        SELECT *
        FROM rag_debug_queries
        WHERE user_id = ?
        ORDER BY created_at DESC, id DESC
        LIMIT ?
    `, [safeUserId, limit]);
    return (rows || []).map(mapRagDebugRow);
}

module.exports = {
    listRagDebugQueries,
    mapRagDebugRow,
    recordRagDebugQuery
};
