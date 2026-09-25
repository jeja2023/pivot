const { query, queryOne } = require('../../db/client');
const { getBeijingTimestamp } = require('../../time');
const { logger } = require('../../logger');
const { readTypedEnv } = require('../../config/env-registry');
const { buildKeywordCandidates, generateEmbedding, cosineSimilarity } = require('../rag-index');
const { filterMemoriesForRetrieval } = require('../memory-governance');
const {
    MEMORY_STATUS,
    DEFAULT_MAX_INJECTED_MEMORIES,
    normalizeScopeReference
} = require('./memory-utils');
const { serializeMemory } = require('./memory-serialization');
const {
    parseEmbedding,
    keywordScore,
    rankIndependentMemoryCandidates
} = require('./memory-retrieval');
const { isLongTermMemoryEnabled } = require('./memory-gate');

const MEMORY_RETRIEVAL_MIN_RELEVANCE = readTypedEnv('LONG_TERM_MEMORY_MIN_RELEVANCE');

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

function memoryCandidateLimit(limit) {
    return Math.max(32, Math.min(Math.max(Number(limit || 8) * 12, 80), 500));
}

async function selectLexicalMemoryCandidates(userId, queryText, now, scopeFilter, limit) {
    const terms = buildKeywordCandidates(queryText, 24)
        .map(term => String(term || '').trim())
        .filter(Boolean)
        .slice(0, 24);
    if (!terms.length) return [];
    const content = "COALESCE(NULLIF(search_content, ''), content)";
    const matchSql = terms.map(() => `${content} ILIKE ?`).join(' OR ');
    const scoreSql = `GREATEST(${terms.map(() => `similarity(${content}, ?)`).join(', ')})`;
    const baseParams = [Number(userId), MEMORY_STATUS.active, now, now, ...scopeFilter.scopeParams];
    try {
        const rows = await query(`
            SELECT *, ${scoreSql} AS lexical_score
            FROM memories
            WHERE user_id = ? AND status = ? AND (expires_at IS NULL OR expires_at > ?)
              AND (valid_from IS NULL OR valid_from <= ?)
              AND ${scopeFilter.scopeSql} AND (${matchSql})
            ORDER BY lexical_score DESC, updated_at DESC, id DESC
            LIMIT ?
        `, [...terms, ...baseParams, ...terms.map(term => `%${term}%`), limit]);
        return rows.map(row => ({
            ...row,
            // pg_trgm 对中文 ILIKE 命中仍可能返回 0；保留数据库候选过滤，
            // 再用确定性的分词分数排序，避免中文候选在 RRF 前丢失。
            __lexical: Math.max(Number(row.lexical_score || 0), keywordScore(row, queryText))
        })).filter(row => row.__lexical > 0)
            .sort((left, right) => right.__lexical - left.__lexical || Number(right.id) - Number(left.id))
            .map((row, index) => ({ ...row, __lexicalRank: index + 1 }));
    } catch (error) {
        logger.warn({ userId, err: error.message }, '长期记忆词法候选下推失败，回退应用层词法候选');
        const rows = await query(`
            SELECT * FROM memories
            WHERE user_id = ? AND status = ? AND (expires_at IS NULL OR expires_at > ?)
              AND (valid_from IS NULL OR valid_from <= ?)
              AND ${scopeFilter.scopeSql}
            ORDER BY updated_at DESC, id DESC
            LIMIT ?
        `, [...baseParams, Math.min(limit * 5, 2000)]);
        return rows.map(row => ({ ...row, __lexical: keywordScore(row, queryText) }))
            .filter(row => row.__lexical > 0)
            .sort((left, right) => right.__lexical - left.__lexical || Number(right.id) - Number(left.id))
            .slice(0, limit)
            .map((row, index) => ({ ...row, __lexicalRank: index + 1 }));
    }
}

async function selectDenseMemoryCandidates(userId, queryVector, now, scopeFilter, limit) {
    if (!Array.isArray(queryVector) || queryVector.length === 0) return [];
    const baseParams = [Number(userId), MEMORY_STATUS.active, now, now, ...scopeFilter.scopeParams];
    try {
        const rows = await query(`
            SELECT *, 1 - (embedding <=> ?::vector) AS dense_score
            FROM memories
            WHERE user_id = ? AND status = ? AND (expires_at IS NULL OR expires_at > ?)
              AND (valid_from IS NULL OR valid_from <= ?)
              AND ${scopeFilter.scopeSql}
              AND embedding IS NOT NULL AND embedding_dimensions = ?
            ORDER BY embedding <=> ?::vector ASC, id ASC
            LIMIT ?
        `, [JSON.stringify(queryVector), ...baseParams, queryVector.length, JSON.stringify(queryVector), limit]);
        return rows.map((row, index) => ({ ...row, __semantic: Math.max(0, Number(row.dense_score || 0)), __semanticRank: index + 1 }));
    } catch (error) {
        logger.warn({ userId, err: error.message }, '长期记忆向量候选下推失败，回退应用层语义候选');
        const rows = await query(`
            SELECT * FROM memories
            WHERE user_id = ? AND status = ? AND (expires_at IS NULL OR expires_at > ?)
              AND (valid_from IS NULL OR valid_from <= ?)
              AND ${scopeFilter.scopeSql} AND embedding IS NOT NULL
            ORDER BY updated_at DESC, id DESC LIMIT ?
        `, [...baseParams, Math.min(limit * 5, 2000)]);
        return rows.map(row => {
            const vector = parseEmbedding(row.embedding);
            return { ...row, __semantic: vector && vector.length === queryVector.length ? Math.max(0, cosineSimilarity(queryVector, vector)) : 0 };
        }).filter(row => row.__semantic > 0)
            .sort((left, right) => right.__semantic - left.__semantic || Number(right.id) - Number(left.id))
            .slice(0, limit)
            .map((row, index) => ({ ...row, __semanticRank: index + 1 }));
    }
}

async function retrieveLongTermMemories(userId, queryText, options = {}) {
    if (!(await isLongTermMemoryEnabled(userId))) return [];
    const normalizedQuery = String(queryText || '').trim();
    if (!normalizedQuery) return [];
    const now = getBeijingTimestamp();
    const limit = Math.max(1, Math.min(Number.parseInt(options.limit, 10) || DEFAULT_MAX_INJECTED_MEMORIES, 20));
    const scopeFilter = buildMemoryScopeFilter(options);
    const candidateLimit = memoryCandidateLimit(limit);
    let hasEmbeddings = false;
    try {
        hasEmbeddings = Boolean(await queryOne(`
            SELECT 1 AS found FROM memories
            WHERE user_id = ? AND status = ? AND embedding IS NOT NULL
              AND (expires_at IS NULL OR expires_at > ?) AND (valid_from IS NULL OR valid_from <= ?)
              AND ${scopeFilter.scopeSql}
            LIMIT 1
        `, [Number(userId), MEMORY_STATUS.active, now, now, ...scopeFilter.scopeParams]));
    } catch (error) {
        logger.warn({ userId, err: error.message }, '长期记忆向量候选可用性检查失败，按词法候选继续');
    }
    let queryVector = null;
    if (hasEmbeddings) {
        try {
            queryVector = await generateEmbedding(normalizedQuery, null, null, userId, {
                user: options.user || null,
                source: 'memory_embedding'
            });
        } catch (err) {
            logger.warn({ userId, err: err.message }, '长期记忆查询向量生成失败，已回退关键词排序');
        }
    }

    const [lexicalRows, denseRows] = await Promise.all([
        selectLexicalMemoryCandidates(userId, normalizedQuery, now, scopeFilter, candidateLimit),
        queryVector ? selectDenseMemoryCandidates(userId, queryVector, now, scopeFilter, candidateLimit) : Promise.resolve([])
    ]);
    const merged = new Map();
    for (const row of [...lexicalRows, ...denseRows]) {
        const id = Number(row?.id);
        if (!Number.isSafeInteger(id) || id <= 0) continue;
        merged.set(id, { ...(merged.get(id) || {}), ...row, id });
    }
    const rows = await filterMemoriesForRetrieval(userId, [...merged.values()]);
    if (!rows.length) return [];
    const ranked = rankIndependentMemoryCandidates(rows, normalizedQuery, queryVector, {
        limit,
        candidateLimit,
        minRelevance: MEMORY_RETRIEVAL_MIN_RELEVANCE
    });
    return ranked.map(item => ({
        ...serializeMemory(item),
        score: item.score,
        relevance: item.relevance,
        recent: item.recent,
        lexical: item.lexical,
        semantic: item.semantic,
        rrf: item.rrf,
        usageReason: item.usageReason
    }));
}

module.exports = {
    retrieveLongTermMemories
};
