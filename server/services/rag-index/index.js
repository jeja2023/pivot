const { db } = require('../../db');
const { logger } = require('../../logger');
const {
    normalizeCacheQuery,
    getFromCache,
    setToCache
} = require('../rag-cache');
const {
    recordRagRetrieval,
    recordRagIngest
} = require('../../metrics');
const {
    buildRagSearchContent,
    buildRagSearchTerms
} = require('../rag-tokenizer');
const {
    getGraphContextForQuery,
    safeIndexKnowledgeGraphForChunks
} = require('../knowledge-graph');
const {
    getEmbeddingConfig,
    getRagConfig,
    getHybridRetrievalConfig,
    getChunkSizeForDocType
} = require('../rag-config');
const { chunkText, chunkDocument, detectDocType } = require('../rag-chunker');
const { recordSlowRagRetrieval } = require('../observability');

const MAX_DEBUG_CANDIDATE_LIMIT = 1000;
const {
    KEYWORD_FALLBACK_MIN_SCORE,
    getEmbeddingRequestTimeoutMs,
    getRagIndexEmbeddingTimeoutMs,
    normalizeEmbeddingVector,
    normalizeEmbeddingVectors,
    resolveEmbeddingUrl,
    buildEmbeddingPayload,
    getEmbeddingRuntimeGuardUser,
    requestEmbedding,
    requestEmbeddings,
    generateEmbedding,
    generateEmbeddings,
    cosineSimilarity
} = require('./embedding-client');

// Bounded cache for parsed chunk embeddings on the chat hot path: re-parsing the
// same TEXT-JSON vectors (and recomputing their L2 norm) on every query is costly.
// Keyed by knowledge_chunks.id -> { vec: Float64Array, norm }. Chunk ids come from
// an AUTOINCREMENT PK and are never reused, and embeddings are never UPDATEd in
// place (reindex = DELETE + re-INSERT with fresh ids), so a cached id can never map
// to a different embedding. Cache is still invalidated on reindex for defensiveness.
const CHUNK_EMBEDDING_CACHE_MAX = 2000;
const chunkEmbeddingCache = new Map();

// Parse + norm a chunk's embedding, caching the result. Returns null when the
// embedding is missing/invalid or its dimension does not match the expected length.
function getChunkEmbedding(chunkId, rawEmbedding, expectedLength) {
    if (chunkId != null) {
        const cached = chunkEmbeddingCache.get(chunkId);
        if (cached) {
            return cached.vec.length === expectedLength ? cached : null;
        }
    }
    if (!rawEmbedding) return null;
    let parsed;
    try {
        parsed = JSON.parse(rawEmbedding);
    } catch (e) {
        return null;
    }
    if (!Array.isArray(parsed) || parsed.length === 0) return null;
    const vec = new Float64Array(parsed.length);
    let norm = 0;
    for (let i = 0; i < parsed.length; i += 1) {
        const value = Number(parsed[i]);
        if (!Number.isFinite(value)) return null;
        vec[i] = value;
        norm += value * value;
    }
    const entry = { vec, norm: Math.sqrt(norm) };
    if (chunkId != null) {
        if (chunkEmbeddingCache.size >= CHUNK_EMBEDDING_CACHE_MAX) {
            // Evict oldest (Map preserves insertion order).
            const oldestKey = chunkEmbeddingCache.keys().next().value;
            chunkEmbeddingCache.delete(oldestKey);
        }
        chunkEmbeddingCache.set(chunkId, entry);
    }
    return entry.vec.length === expectedLength ? entry : null;
}

// Cosine similarity against a cached chunk vector using a precomputed query norm.
function cosineSimilarityCached(queryVector, queryNorm, chunkEntry) {
    if (queryNorm === 0 || chunkEntry.norm === 0) return 0;
    const vec = chunkEntry.vec;
    let dotProduct = 0;
    for (let i = 0; i < queryVector.length; i += 1) {
        dotProduct += queryVector[i] * vec[i];
    }
    return dotProduct / (queryNorm * chunkEntry.norm);
}

function computeVectorNorm(vector) {
    let norm = 0;
    for (let i = 0; i < vector.length; i += 1) {
        norm += vector[i] * vector[i];
    }
    return Math.sqrt(norm);
}

function clearChunkEmbeddingCache() {
    chunkEmbeddingCache.clear();
}

function buildKeywordCandidates(query, limit = 8) {
    return buildRagSearchTerms(query, limit);
}

function buildFtsOrQuery(keywords) {
    return keywords
        .map(term => `"${String(term).replace(/"/g, '""')}"`)
        .join(' OR ');
}

function normalizeScopeIdList(value, max = 50) {
    const values = Array.isArray(value) ? value : [value];
    return [...new Set(values
        .map(item => Number.parseInt(item, 10))
        .filter(item => Number.isSafeInteger(item) && item > 0))]
        .slice(0, max);
}

function normalizeScopeTagList(value, max = 20) {
    const values = Array.isArray(value) ? value : [value];
    return [...new Set(values
        .flatMap(item => String(item || '').split(/[,，;；\s\n]+/))
        .map(item => item.trim().replace(/^#+/, '').replace(/\s+/g, ' ').slice(0, 40))
        .filter(Boolean))]
        .slice(0, max);
}

function normalizeRetrievalScope(scope = {}) {
    const raw = scope && typeof scope === 'object' ? scope : {};
    const collectionIds = normalizeScopeIdList(raw.collectionIds ?? raw.collectionId);
    const tagNames = normalizeScopeTagList(raw.tagNames ?? raw.tagName ?? raw.tag);
    const parts = [];
    if (collectionIds.length) parts.push(`collections:${collectionIds.join(',')}`);
    if (tagNames.length) parts.push(`tags:${tagNames.join(',')}`);
    return {
        collectionIds,
        tagNames,
        cacheKey: parts.length ? parts.join(';') : 'all'
    };
}

function buildRetrievalScopeSql(scope, docAlias = 'd') {
    const normalized = normalizeRetrievalScope(scope);
    const clauses = [];
    const params = [];
    if (normalized.collectionIds.length) {
        clauses.push(`${docAlias}.collection_id IN (${normalized.collectionIds.map(() => '?').join(',')})`);
        params.push(...normalized.collectionIds);
    }
    if (normalized.tagNames.length) {
        clauses.push(`EXISTS (
            SELECT 1
            FROM knowledge_doc_tags tag_scope
            WHERE tag_scope.doc_id = ${docAlias}.id
              AND tag_scope.user_id = ${docAlias}.user_id
              AND tag_scope.tag IN (${normalized.tagNames.map(() => '?').join(',')})
        )`);
        params.push(...normalized.tagNames);
    }
    return {
        sql: clauses.length ? ` AND ${clauses.join(' AND ')}` : '',
        params,
        normalized
    };
}

function selectFtsCandidates(userId, keywords, limit, scope = {}) {
    if (keywords.length === 0) return [];
    const ftsQuery = buildFtsOrQuery(keywords);
    if (!ftsQuery) return [];
    const scopeFilter = buildRetrievalScopeSql(scope, 'd');

    try {
        return db.prepare(`
            SELECT c.id, c.content, c.embedding, c.heading_path, d.name
            FROM knowledge_chunks_fts
            JOIN knowledge_chunks c ON c.id = knowledge_chunks_fts.rowid
            JOIN knowledge_docs d ON c.doc_id = d.id
            WHERE knowledge_chunks_fts MATCH ?
              AND d.user_id = ?
              AND d.status = 'ready'
              AND d.deleted_at IS NULL
              AND COALESCE(d.is_enabled, 1) = 1
              ${scopeFilter.sql}
            ORDER BY bm25(knowledge_chunks_fts)
            LIMIT ?
        `).all(ftsQuery, userId, ...scopeFilter.params, limit);
    } catch (e) {
        logger.warn({ err: e.message }, 'RAG FTS 候选召回失败，已回退到 LIKE 扫描');
        return [];
    }
}

function selectLikeCandidates(userId, keywords, limit, scope = {}) {
    if (keywords.length === 0) return [];
    const keywordWhere = keywords.map(() => 'LOWER(c.content) LIKE ?').join(' OR ');
    const scopeFilter = buildRetrievalScopeSql(scope, 'd');
    return db.prepare(`
        SELECT c.id, c.content, c.embedding, d.name
        FROM knowledge_chunks c
        JOIN knowledge_docs d ON c.doc_id = d.id
        WHERE d.user_id = ? AND d.status = 'ready' AND d.deleted_at IS NULL AND COALESCE(d.is_enabled, 1) = 1${scopeFilter.sql} AND (${keywordWhere})
        ORDER BY c.id DESC
        LIMIT ?
    `).all(userId, ...scopeFilter.params, ...keywords.map(k => `%${k}%`), limit);
}

function selectRecentCandidates(userId, limit, scope = {}) {
    const scopeFilter = buildRetrievalScopeSql(scope, 'd');
    return db.prepare(`
        SELECT c.id, c.content, c.embedding, d.name
        FROM knowledge_chunks c
        JOIN knowledge_docs d ON c.doc_id = d.id
        WHERE d.user_id = ? AND d.status = 'ready' AND d.deleted_at IS NULL AND COALESCE(d.is_enabled, 1) = 1${scopeFilter.sql}
        ORDER BY c.id DESC
        LIMIT ?
    `).all(userId, ...scopeFilter.params, limit);
}

function selectRetrievalCandidates(userId, query, topK, candidateLimit, scope = {}) {
    const keywords = buildKeywordCandidates(query);
    const ftsChunks = selectFtsCandidates(userId, keywords, candidateLimit, scope);
    // 记录 FTS(BM25) 名次，供后续 RRF 融合与精确匹配软门控使用。
    ftsChunks.forEach((chunk, idx) => { chunk.__ftsRank = idx; });
    let chunks = ftsChunks;
    if (chunks.length < topK) {
        const existingIds = new Set(chunks.map(chunk => chunk.id));
        const likeChunks = selectLikeCandidates(userId, keywords, candidateLimit, scope)
            .filter(chunk => !existingIds.has(chunk.id));
        chunks = chunks.concat(likeChunks).slice(0, candidateLimit);
    }
    if (chunks.length < topK) {
        const existingIds = new Set(chunks.map(chunk => chunk.id));
        const recentChunks = selectRecentCandidates(userId, candidateLimit, scope)
            .filter(chunk => !existingIds.has(chunk.id));
        chunks = chunks.concat(recentChunks).slice(0, candidateLimit);
    }
    return chunks;
}

function selectChunksByIds(userId, chunkIds, limit, scope = {}) {
    const ids = [...new Set((chunkIds || []).map(id => Number.parseInt(id, 10)).filter(id => Number.isSafeInteger(id) && id > 0))];
    if (ids.length === 0) return [];
    const placeholders = ids.slice(0, limit).map(() => '?').join(',');
    const scopeFilter = buildRetrievalScopeSql(scope, 'd');
    return db.prepare(`
        SELECT c.id, c.content, c.embedding, d.name
        FROM knowledge_chunks c
        JOIN knowledge_docs d ON c.doc_id = d.id
        WHERE c.id IN (${placeholders})
          AND d.user_id = ?
          AND d.status = 'ready'
          AND d.deleted_at IS NULL
          AND COALESCE(d.is_enabled, 1) = 1
          ${scopeFilter.sql}
        LIMIT ?
    `).all(...ids.slice(0, limit), userId, ...scopeFilter.params, limit);
}

function mergeRetrievalCandidates(candidates, graphChunkIds, userId, candidateLimit, scope = {}) {
    const existingIds = new Set(candidates.map(chunk => chunk.id));
    const graphChunks = selectChunksByIds(userId, graphChunkIds, candidateLimit, scope)
        .filter(chunk => !existingIds.has(chunk.id));
    return candidates.concat(graphChunks).slice(0, candidateLimit);
}

// 两个已解析向量(含范数)之间的余弦相似度，用于 MMR 多样性度量。
function cosineEntries(a, b) {
    if (!a || !b || a.norm === 0 || b.norm === 0) return 0;
    const va = a.vec;
    const vb = b.vec;
    const len = Math.min(va.length, vb.length);
    let dot = 0;
    for (let i = 0; i < len; i += 1) dot += va[i] * vb[i];
    return dot / (a.norm * b.norm);
}

// 混合打分：稠密余弦 + FTS(BM25) 名次做 RRF 融合。返回全部候选（不做门控），
// 按融合分降序排列；每项含 denseScore / ftsRank / denseRank / fused / entry(向量)。
function scoreCandidatesHybrid(chunks, queryVector, hybrid) {
    const queryNorm = computeVectorNorm(queryVector);
    const scored = chunks.map(chunk => {
        let entry = null;
        let denseScore = null;
        try {
            entry = getChunkEmbedding(chunk.id, chunk.embedding, queryVector.length);
            if (entry) denseScore = cosineSimilarityCached(queryVector, queryNorm, entry);
        } catch (e) {
            logger.warn({ chunkId: chunk.id, err: e.message }, 'RAG 向量解析失败，已跳过分片');
        }
        return {
            chunkId: chunk.id,
            text: chunk.content,
            source: chunk.name,
            headingPath: chunk.heading_path || '',
            denseScore,
            ftsRank: Number.isInteger(chunk.__ftsRank) ? chunk.__ftsRank : null,
            entry
        };
    });

    // 稠密名次（按余弦降序），缺向量者不参与稠密通道。
    const denseSorted = scored.filter(item => item.denseScore != null).sort((a, b) => b.denseScore - a.denseScore);
    const denseRankById = new Map();
    denseSorted.forEach((item, idx) => denseRankById.set(item.chunkId, idx));

    scored.forEach(item => {
        const denseRank = denseRankById.has(item.chunkId) ? denseRankById.get(item.chunkId) : null;
        let fused = 0;
        if (denseRank != null) fused += hybrid.wDense / (hybrid.rrfK + denseRank);
        if (item.ftsRank != null) fused += hybrid.wFts / (hybrid.rrfK + item.ftsRank);
        item.denseRank = denseRank;
        item.fused = fused;
    });

    return scored.sort((a, b) => b.fused - a.fused);
}

// 软门控：保留稠密分达阈值（语义相关）或命中 FTS 前列（精确匹配，稠密分可能偏低）的候选。
// 皆不满足者视为无关；整体落空时返回空，保持"无匹配"语义，不向上下文注入噪声。
function gateHybridPool(scored, hybrid, scoreThreshold) {
    return scored.filter(item =>
        (item.denseScore != null && item.denseScore > scoreThreshold) ||
        (item.ftsRank != null && item.ftsRank < hybrid.ftsRankFloor)
    );
}

// MMR 去重：在融合相关性与结果多样性之间平衡，剔除近重复片段。
function applyMMR(ranked, topK, lambda) {
    if (ranked.length <= 1) return ranked.slice(0, topK);
    const maxFused = ranked[0].fused || 1;
    const remaining = ranked.slice();
    const selected = [];
    while (selected.length < topK && remaining.length) {
        let bestIdx = 0;
        let bestScore = -Infinity;
        for (let i = 0; i < remaining.length; i += 1) {
            const cand = remaining[i];
            const relevance = (cand.fused || 0) / maxFused;
            let maxSim = 0;
            if (cand.entry) {
                for (const sel of selected) {
                    if (sel.entry) {
                        const sim = cosineEntries(cand.entry, sel.entry);
                        if (sim > maxSim) maxSim = sim;
                    }
                }
            }
            const mmrScore = lambda * relevance - (1 - lambda) * maxSim;
            if (mmrScore > bestScore) {
                bestScore = mmrScore;
                bestIdx = i;
            }
        }
        selected.push(remaining.splice(bestIdx, 1)[0]);
    }
    return selected;
}

function scoreKeywordChunks(chunks, query, minScore = KEYWORD_FALLBACK_MIN_SCORE) {
    const keywords = buildKeywordCandidates(query, 32);
    if (!keywords.length) return [];
    const totalWeight = keywords.reduce((sum, term) => sum + Math.min(String(term).length, 8), 0) || 1;
    return chunks.map(chunk => {
        const haystack = `${chunk.content || ''}\n${chunk.name || ''}`.toLowerCase();
        let matchedWeight = 0;
        keywords.forEach(term => {
            const normalizedTerm = String(term || '').toLowerCase();
            if (normalizedTerm && haystack.includes(normalizedTerm)) {
                matchedWeight += Math.min(normalizedTerm.length, 8);
            }
        });
        const score = matchedWeight / totalWeight;
        if (score <= minScore) return null;
        return {
            text: chunk.content,
            source: chunk.name,
            headingPath: chunk.heading_path || '',
            score
        };
    }).filter(Boolean);
}

function formatInjectedContext(topChunks) {
    let injectedContext = '\n\n【参考内部知识库信息如下】：\n';
    topChunks.forEach((chunk, index) => {
        // 优先用面包屑（已含文档标题/章节/条），无则退回文件名。
        const location = String(chunk.headingPath || '').trim() || chunk.source;
        injectedContext += `[引用 ${index + 1} | 来源: ${location}]: ${chunk.text}\n`;
    });
    injectedContext += '请基于上述参考信息回答我的问题。如果参考信息中没有答案，请告知无法在知识库中查阅到该信息。\n';
    return injectedContext;
}

function buildRagCacheScope(userId, config = {}, scope = {}) {
    const scopeFilter = buildRetrievalScopeSql(scope, 'knowledge_docs');
    const docs = db.prepare(`
        SELECT
            COUNT(*) AS doc_count,
            COALESCE(SUM(chunk_count), 0) AS chunk_count,
            COALESCE(MAX(COALESCE(updated_at, processed_at, created_at)), '') AS doc_version
        FROM knowledge_docs
        WHERE user_id = ?
          AND deleted_at IS NULL
          AND status = 'ready'
          AND COALESCE(is_enabled, 1) = 1
          ${scopeFilter.sql}
    `).get(userId, ...scopeFilter.params) || {};
    const graph = db.prepare(`
        SELECT
            COALESCE((SELECT MAX(updated_at) FROM knowledge_entities WHERE user_id = ? AND deleted_at IS NULL), '') AS entity_version,
            COALESCE((SELECT MAX(updated_at) FROM knowledge_relations WHERE user_id = ? AND status = 'active'), '') AS relation_version
    `).get(userId, userId) || {};

    return [
        `k=${Number(config.topK || 0)}`,
        `c=${Number(config.candidateLimit || 0)}`,
        `s=${Number(config.scoreThreshold || 0).toFixed(3)}`,
        `scope=${scopeFilter.normalized.cacheKey}`,
        `d=${Number(docs.doc_count || 0)}`,
        `h=${Number(docs.chunk_count || 0)}`,
        `dv=${docs.doc_version || ''}`,
        `ge=${graph.entity_version || ''}`,
        `gr=${graph.relation_version || ''}`
    ].join('|');
}

function normalizeRetrievalDebugMatch(match, scoreThreshold) {
    return {
        chunkId: match.chunkId,
        source: match.source,
        score: Number(match.score.toFixed(6)),
        matched: match.score > scoreThreshold,
        text: String(match.text || '').slice(0, 800)
    };
}

async function debugRetrieveContext(userId, query, {
    topK = null,
    candidateLimit = null,
    scoreThreshold = null,
    queryVector = null,
    scope = {},
    user = null
} = {}) {
    const config = getRagConfig({ topK, candidateLimit, scoreThreshold }, userId);
    const normalizedQuery = normalizeCacheQuery(query);
    if (!normalizedQuery) {
        return {
            query: '',
            keywords: [],
            threshold: config.scoreThreshold,
            topK: config.topK,
            candidateCount: 0,
            matches: []
        };
    }

    const safeTopK = config.topK;
    const safeCandidateLimit = Math.min(config.candidateLimit, MAX_DEBUG_CANDIDATE_LIMIT);
    const normalizedScope = normalizeRetrievalScope(scope);
    const keywords = buildKeywordCandidates(normalizedQuery);
    const graphContext = getGraphContextForQuery(userId, normalizedQuery, { scope: normalizedScope });
    const candidates = mergeRetrievalCandidates(
        selectRetrievalCandidates(userId, normalizedQuery, safeTopK, safeCandidateLimit, normalizedScope).slice(0, safeCandidateLimit),
        graphContext.chunkIds,
        userId,
        safeCandidateLimit,
        normalizedScope
    );
    if (candidates.length === 0) {
        return {
            query: normalizedQuery,
            keywords,
            threshold: config.scoreThreshold,
            topK: safeTopK,
            candidateCount: 0,
            matches: [],
            graph: graphContext,
            scope: normalizedScope,
            injectedContext: formatInjectedContext([])
        };
    }
    const hybrid = getHybridRetrievalConfig();
    let scored = [];
    let gated = [];
    try {
        const vector = Array.isArray(queryVector) ? queryVector : await generateEmbedding(normalizedQuery, null, null, userId, { user });
        scored = scoreCandidatesHybrid(candidates, vector, hybrid);
        gated = gateHybridPool(scored, hybrid, config.scoreThreshold);
    } catch (e) {
        logger.warn({ err: e.message }, 'RAG 调试向量生成失败，已回退到关键词检索');
        scored = scoreKeywordChunks(candidates, normalizedQuery)
            .sort((a, b) => b.score - a.score)
            .map(chunk => ({
                chunkId: candidates.find(item => item.content === chunk.text && item.name === chunk.source)?.id,
                text: chunk.text,
                source: chunk.source,
                headingPath: chunk.headingPath || '',
                denseScore: chunk.score,
                fused: chunk.score,
                ftsRank: null,
                entry: null
            }));
        gated = scored.filter(item => item.denseScore > config.scoreThreshold);
    }
    // matches 展示全部候选评分（便于调参）；注入上下文只取门控+MMR 结果。
    const selected = applyMMR(gated, safeTopK, hybrid.mmrLambda);
    const matches = scored.map(match => normalizeRetrievalDebugMatch({
        chunkId: match.chunkId,
        source: match.headingPath || match.source,
        score: match.denseScore != null ? match.denseScore : (match.fused || 0),
        text: match.text
    }, config.scoreThreshold));

    return {
        query: normalizedQuery,
        keywords,
        threshold: config.scoreThreshold,
        topK: safeTopK,
        candidateCount: candidates.length,
        matches,
        graph: graphContext,
        scope: normalizedScope,
        injectedContext: formatInjectedContext(selected) + (graphContext.context || '')
    };
}

async function retrieveContext(userId, query, topK = null, options = {}) {
    const startedAt = Date.now();
    const normalizedQuery = normalizeCacheQuery(query);
    if (!normalizedQuery) return '';
    const config = getRagConfig({ topK }, userId);
    const retrievalScope = normalizeRetrievalScope(options.scope || {});
    const cacheScope = buildRagCacheScope(userId, config, retrievalScope);
    const recordRetrieval = (payload) => {
        recordRagRetrieval(payload);
        recordSlowRagRetrieval({
            ...payload,
            userId,
            query: normalizedQuery,
            topK: config.topK
        });
    };

    const cachedResult = getFromCache(userId, normalizedQuery, config.topK, cacheScope);
    if (cachedResult !== null) {
        const cachedMatches = cachedResult ? Math.max(1, (String(cachedResult).match(/\[引用\s+\d+/g) || []).length) : 0;
        recordRetrieval({
            status: 'cache_hit',
            durationMs: Date.now() - startedAt,
            cacheHit: true,
            matches: cachedMatches
        });
        return cachedResult;
    }

    try {
        const graphContext = getGraphContextForQuery(userId, normalizedQuery, { scope: retrievalScope });
        const chunks = mergeRetrievalCandidates(
            selectRetrievalCandidates(userId, normalizedQuery, config.topK, config.candidateLimit, retrievalScope),
            graphContext.chunkIds,
            userId,
            config.candidateLimit,
            retrievalScope
        );

        if (chunks.length === 0 && !graphContext.context) {
            setToCache(userId, normalizedQuery, config.topK, '', cacheScope);
            recordRetrieval({ status: 'empty', durationMs: Date.now() - startedAt, candidates: 0, matches: 0 });
            return '';
        }

        if (chunks.length === 0 && graphContext.context) {
            setToCache(userId, normalizedQuery, config.topK, graphContext.context, cacheScope);
            recordRetrieval({
                status: 'graph_hit',
                durationMs: Date.now() - startedAt,
                candidates: 0,
                matches: 0,
                graphMatches: graphContext.relations.length
            });
            return graphContext.context;
        }

        const hybrid = getHybridRetrievalConfig();
        let topChunks = [];
        let topScore = 0;
        let usedKeywordFallback = false;
        try {
            const queryVector = await generateEmbedding(normalizedQuery, null, null, userId, { user: options.user || null });
            const scored = scoreCandidatesHybrid(chunks, queryVector, hybrid);
            topScore = scored.reduce((max, item) => Math.max(max, item.denseScore || 0), 0);
            // 软门控筛选后做 MMR 去重，取最终 topK。
            const gated = gateHybridPool(scored, hybrid, config.scoreThreshold);
            topChunks = applyMMR(gated, config.topK, hybrid.mmrLambda);
        } catch (e) {
            usedKeywordFallback = true;
            logger.warn({ err: e.message }, 'RAG 查询向量生成失败，已回退到关键词检索');
            topChunks = scoreKeywordChunks(chunks, normalizedQuery)
                .sort((a, b) => b.score - a.score)
                .slice(0, config.topK);
            topScore = topChunks.length > 0 ? topChunks[0].score : 0;
        }

        if (topChunks.length === 0 && !graphContext.context) {
            setToCache(userId, normalizedQuery, config.topK, '', cacheScope);
            recordRetrieval({
                status: 'no_match',
                durationMs: Date.now() - startedAt,
                candidates: chunks.length,
                matches: 0,
                topScore
            });
            return '';
        }

        const injectedContext = formatInjectedContext(topChunks) + (graphContext.context || '');
        setToCache(userId, normalizedQuery, config.topK, injectedContext, cacheScope);
        recordRetrieval({
            status: usedKeywordFallback ? 'keyword_fallback_hit' : 'hit',
            durationMs: Date.now() - startedAt,
            candidates: chunks.length,
            matches: topChunks.length,
            graphMatches: graphContext.relations.length,
            topScore
        });
        return injectedContext;
    } catch (e) {
        logger.error({ err: e.message }, 'RAG 检索失败');
        recordRetrieval({ status: 'error', durationMs: Date.now() - startedAt });
        return '';
    }
}

// 富文本 = 面包屑(出处/章节) + 原文。用于向量化与 FTS，使切片自带上下文。
function buildEnrichedChunkText(content, headingPath) {
    const path = String(headingPath || '').trim();
    const body = String(content || '');
    return path ? `${path}\n${body}` : body;
}

async function indexDocumentChunks(docId, text, { onProgress, userId = null, user = null, embeddingTimeoutMs = null } = {}) {
    const startedAt = Date.now();
    const ragConfig = getRagConfig({}, userId);
    const docRow = db.prepare('SELECT name FROM knowledge_docs WHERE id = ?').get(docId) || {};
    const docName = docRow.name || '';
    const docType = detectDocType(docName, text);
    const typedChunkSize = getChunkSizeForDocType(docType, ragConfig.chunkSize, userId);
    // 结构感知切片：返回 [{ content(原文), headingPath(面包屑) }]。
    const chunks = chunkDocument(text, {
        docName,
        docType,
        chunkSize: typedChunkSize,
        overlap: ragConfig.chunkOverlap
    });
    const indexEmbeddingTimeoutMs = getRagIndexEmbeddingTimeoutMs(embeddingTimeoutMs);
    const batchSize = 5; // 限制并发数，防止 OOM 或 API 限流
    try {
        if (chunks.length === 0) {
            throw new Error('文档未解析出可索引文本，请检查文件内容后重新上传。');
        }
        // A (re)index for this doc may have deleted/replaced chunk rows elsewhere
        // (rag-documents delete path). Clear the embedding cache so no stale entry
        // can be served; correctness over precision (a full clear is cheap here).
        clearChunkEmbeddingCache();
        for (let i = 0; i < chunks.length; i += batchSize) {
            const batch = chunks.slice(i, i + batchSize);
            // 向量化与 FTS 用富文本（面包屑+正文）；展示与图谱仍用原文。
            const enrichedBatch = batch.map(item => buildEnrichedChunkText(item.content, item.headingPath));
            let vectors = null;
            try {
                vectors = await generateEmbeddings(enrichedBatch, null, null, userId, {
                    timeoutMs: indexEmbeddingTimeoutMs,
                    source: 'rag_ingest_embedding',
                    user
                });
            } catch (e) {
                logger.warn({ err: e.message, docId }, 'RAG 分片向量生成失败，已按关键词索引继续');
            }
            const results = batch.map((chunk, index) => ({
                content: chunk.content,
                headingPath: chunk.headingPath || '',
                enriched: enrichedBatch[index],
                vector: Array.isArray(vectors) ? vectors[index] : null
            }));

            const insert = db.prepare('INSERT INTO knowledge_chunks (doc_id, content, search_content, heading_path, embedding) VALUES (?, ?, ?, ?, ?)');
            const insertedChunks = [];
            const transaction = db.transaction((items) => {
                for (const item of items) {
                    const embedding = Array.isArray(item.vector) ? JSON.stringify(item.vector) : null;
                    const result = insert.run(
                        docId,
                        item.content,
                        buildRagSearchContent(item.enriched),
                        item.headingPath || null,
                        embedding
                    );
                    insertedChunks.push({ chunkId: result.lastInsertRowid, content: item.content });
                }
            });
            transaction(results);
            safeIndexKnowledgeGraphForChunks({ userId, docId, chunks: insertedChunks });
            if (typeof onProgress === 'function') {
                onProgress({
                    indexed: Math.min(i + batch.length, chunks.length),
                    total: chunks.length
                });
            }
        }
        recordRagIngest({ status: 'ready', chunks: chunks.length, durationMs: Date.now() - startedAt });
        return chunks.length;
    } catch (e) {
        recordRagIngest({ status: 'error', chunks: 0, durationMs: Date.now() - startedAt });
        throw e;
    }
}

async function testEmbeddingConnection(config = {}, user = null) {
    const startedAt = Date.now();
    try {
        const httpConfig = {
            url: config.apiUrl || '',
            model: config.model || '',
            apiKey: config.apiKey || ''
        };
        const vector = await requestEmbedding('测试向量生成 (智枢 Test Connection)', httpConfig, { user });

        if (!Array.isArray(vector) || vector.length === 0) {
            throw new Error('生成的向量数据无效');
        }

        return {
            success: true,
            dimension: vector.length,
            durationMs: Date.now() - startedAt
        };
    } catch (e) {
        logger.error({ err: e.message, config: { ...config, apiKey: config.apiKey ? '***' : '' } }, '向量模型连接测试失败');
        return {
            success: false,
            error: e.message,
            durationMs: Date.now() - startedAt
        };
    }
}
module.exports = {
    getEmbeddingConfig,
    generateEmbedding,
    generateEmbeddings,
    requestEmbedding,
    requestEmbeddings,
    getEmbeddingRuntimeGuardUser,
    testEmbeddingConnection,
    getEmbeddingRequestTimeoutMs,
    getRagIndexEmbeddingTimeoutMs,
    normalizeEmbeddingVector,
    normalizeEmbeddingVectors,
    resolveEmbeddingUrl,
    buildEmbeddingPayload,
    cosineSimilarity,
    chunkText,
    chunkDocument,
    detectDocType,
    applyMMR,
    buildKeywordCandidates,
    buildFtsOrQuery,
    normalizeRetrievalScope,
    buildRagCacheScope,
    buildRagSearchContent,
    buildRagSearchTerms,
    debugRetrieveContext,
    retrieveContext,
    indexDocumentChunks
};
