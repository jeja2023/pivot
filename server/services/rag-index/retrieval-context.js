// RAG 检索上下文和缓存范围辅助模块。
// 这里不负责召回或模型调用，只把排序结果转换成可审计、可注入的上下文。
const { query, queryOne } = require('../../db/client');
const { normalizeCacheQuery } = require('../rag-cache');
const { getHybridRetrievalConfig } = require('../rag-config');
const { calculateCitationConfidence } = require('./ranking');

async function loadRagFeedbackSignals(userId, queryText, logger = console) {
    const normalizedQuery = normalizeCacheQuery(queryText);
    const normalizedUserId = Number.parseInt(userId, 10);
    if (!normalizedQuery || !Number.isSafeInteger(normalizedUserId) || normalizedUserId <= 0) return new Map();
    try {
        const rows = await query(`
            SELECT chunk_id, doc_name, query, helpful
            FROM rag_feedback
            WHERE user_id = ?
            ORDER BY created_at DESC, id DESC
            LIMIT ?
        `, [normalizedUserId, 300]);
        const signals = new Map();
        const add = (key, helpful) => {
            if (!key) return;
            const current = signals.get(key) || { helpful: 0, unhelpful: 0 };
            if (helpful) current.helpful += 1;
            else current.unhelpful += 1;
            signals.set(key, current);
        };
        for (const row of rows || []) {
            // 仅归一化后完全相同的问题参与校正，避免相似问法互相污染。
            if (normalizeCacheQuery(row.query) !== normalizedQuery) continue;
            const helpful = row.helpful === true || Number(row.helpful) === 1 || String(row.helpful).toLowerCase() === 'true';
            const chunkId = Number.parseInt(row.chunk_id, 10);
            if (Number.isSafeInteger(chunkId) && chunkId > 0) add(`chunk:${chunkId}`, helpful);
            const documentName = String(row.doc_name || '').trim();
            if (documentName) add(`doc:${documentName}`, helpful);
        }
        return signals;
    } catch (error) {
        logger.warn?.({ err: error.message, userId: normalizedUserId }, 'RAG 反馈排序信号读取失败，继续使用基础排序');
        return new Map();
    }
}

function formatInjectedContext(topChunks, scoreThreshold = 0) {
    let injectedContext = '\n\n【参考内部知识库信息如下】：\n';
    const maxRankScore = (topChunks || []).reduce((max, chunk) => Math.max(
        max,
        Number(chunk?.rankScore ?? chunk?.fused ?? chunk?.score) || 0
    ), 0);
    (topChunks || []).forEach((chunk, index) => {
        const location = String(chunk.headingPath || '').trim() || chunk.source;
        const confidence = Number.isFinite(Number(chunk.citationConfidence))
            ? Number(chunk.citationConfidence)
            : calculateCitationConfidence(chunk, scoreThreshold, maxRankScore);
        injectedContext += `[引用 ${index + 1} | 来源: ${location} | 检索可信度: ${Math.round(confidence * 100)}%]: ${chunk.text}\n`;
    });
    injectedContext += '请基于上述参考信息回答我的问题。如果参考信息中没有答案，请告知无法在知识库中查阅到该信息。\n';
    return injectedContext;
}

async function buildRagCacheScope(userId, config = {}, scope = {}, user = null, buildScopeSql) {
    if (typeof buildScopeSql !== 'function') throw new TypeError('RAG cache scope requires a scope SQL builder');
    const hybrid = getHybridRetrievalConfig();
    const scopeFilter = buildScopeSql(scope, 'knowledge_docs', user);
    const ownerFilter = user ? '' : 'AND knowledge_docs.user_id = ?';
    const accessFilter = user ? scopeFilter.accessSql : '';
    const accessJoin = user ? ' LEFT JOIN knowledge_collections c_access ON c_access.id = knowledge_docs.collection_id AND c_access.deleted_at IS NULL' : '';
    const docs = (await queryOne(`
        SELECT
            COUNT(*) AS doc_count,
            COALESCE(SUM(knowledge_docs.chunk_count), 0) AS chunk_count,
            COALESCE(MAX(COALESCE(knowledge_docs.updated_at, knowledge_docs.processed_at, knowledge_docs.created_at))::text, '') AS doc_version
        FROM knowledge_docs
        ${accessJoin}
        WHERE 1 = 1 ${ownerFilter}
          AND knowledge_docs.deleted_at IS NULL
          AND knowledge_docs.status = 'ready'
          AND COALESCE(knowledge_docs.is_enabled, 1) = 1
          ${scopeFilter.sql}
          ${accessFilter}
    `, (user ? [...scopeFilter.params, ...scopeFilter.accessParams] : [userId, ...scopeFilter.params]))) || {};
    const entityVersionRow = await queryOne('SELECT COALESCE(MAX(updated_at)::text, \'\') AS entity_version FROM knowledge_entities WHERE user_id = ? AND deleted_at IS NULL', [userId]);
    const relationVersionRow = await queryOne('SELECT COALESCE(MAX(updated_at)::text, \'\') AS relation_version FROM knowledge_relations WHERE user_id = ? AND status = \'active\'', [userId]);
    const feedbackVersionRow = await queryOne(
        'SELECT COALESCE(MAX(created_at)::text, \'\') AS feedback_version FROM rag_feedback WHERE user_id = ?',
        [userId]
    );

    return [
        'algo=dual_rrf_v2',
        `k=${Number(config.topK || 0)}`,
        `c=${Number(config.candidateLimit || 0)}`,
        `s=${Number(config.scoreThreshold || 0).toFixed(3)}`,
        `rrf=${hybrid.rrfK}:${hybrid.wDense}:${hybrid.wFts}`,
        `mmr=${hybrid.mmrLambda}:${hybrid.ftsRankFloor}`,
        `scope=${scopeFilter.normalized.cacheKey}|unit=${String(user?.unit || '')}|shared=${user ? '1' : '0'}`,
        `d=${Number(docs.doc_count || 0)}`,
        `h=${Number(docs.chunk_count || 0)}`,
        `dv=${docs.doc_version || ''}`,
        `ge=${entityVersionRow?.entity_version || ''}`,
        `gr=${relationVersionRow?.relation_version || ''}`,
        `fb=${feedbackVersionRow?.feedback_version || ''}`
    ].join('|');
}

function roundDebugScore(value) {
    const num = Number(value);
    return Number.isFinite(num) ? Number(num.toFixed(6)) : 0;
}

function normalizeRetrievalDebugMatch(match, scoreThreshold, rank = 0, selectedIds = new Set(), maxRankScore = null) {
    const denseScore = match.denseScore != null ? match.denseScore : match.score;
    const fusedScore = match.fused != null ? match.fused : denseScore;
    const selected = selectedIds.has(match.chunkId);
    const citationConfidence = match.citationConfidence ?? calculateCitationConfidence(match, scoreThreshold, maxRankScore);
    return {
        chunkId: match.chunkId,
        source: match.source,
        documentName: match.documentName || match.source,
        score: roundDebugScore(denseScore),
        fusedScore: roundDebugScore(fusedScore),
        rankScore: roundDebugScore(match.rankScore ?? fusedScore),
        citationConfidence: roundDebugScore(citationConfidence),
        feedback: match.feedback ? {
            helpful: Number(match.feedback.helpful || 0),
            unhelpful: Number(match.feedback.unhelpful || 0),
            total: Number(match.feedback.total || 0),
            helpfulRate: roundDebugScore(match.feedback.helpfulRate || 0),
            scope: match.feedback.scope || 'query'
        } : null,
        matched: Number(denseScore || 0) > scoreThreshold,
        selected,
        rank: rank + 1,
        scores: {
            dense: roundDebugScore(denseScore),
            fused: roundDebugScore(fusedScore),
            rank: roundDebugScore(match.rankScore ?? fusedScore),
            denseRank: Number.isInteger(match.denseRank) ? match.denseRank + 1 : null,
            ftsRank: Number.isInteger(match.ftsRank) ? match.ftsRank + 1 : null,
            mmrSelected: selected
        },
        text: String(match.text || '').slice(0, 800)
    };
}

module.exports = {
    buildRagCacheScope,
    formatInjectedContext,
    loadRagFeedbackSignals,
    normalizeRetrievalDebugMatch
};
