const axios = require('axios');
const { db } = require('../db');
const { logger } = require('../logger');
const {
    normalizeCacheQuery,
    getFromCache,
    setToCache
} = require('./rag-cache');
const {
    recordRagRetrieval,
    recordRagIngest
} = require('../metrics');
const {
    buildRagSearchContent,
    buildRagSearchTerms
} = require('./rag-tokenizer');
const {
    getGraphContextForQuery,
    safeIndexKnowledgeGraphForChunks
} = require('./knowledge-graph');
const { EMBEDDING_MODES, getEmbeddingConfig, getRagConfig, normalizeEmbeddingMode } = require('./rag-config');
const {
    getOrCreateEmbeddingUsageModel,
    recordModelTokenUsage
} = require('./models');
const { estimateTokens } = require('../llm');
const { assertSafeOutboundUrl, createSafeHttpAgentsForUser } = require('../security');
const { estimateEmbeddingTokens } = require('./token-accounting');
const { recordSlowRagRetrieval } = require('./observability');

const MAX_DEBUG_CANDIDATE_LIMIT = 1000;
const DEFAULT_EMBEDDING_REQUEST_TIMEOUT_MS = 30000;
const DEFAULT_RAG_INDEX_EMBEDDING_TIMEOUT_MS = 120000;
const MAX_EMBEDDING_REQUEST_TIMEOUT_MS = 10 * 60 * 1000;
const KEYWORD_FALLBACK_MIN_SCORE = 0.12;

function normalizeTimeoutMs(value, fallback, min = 1000, max = MAX_EMBEDDING_REQUEST_TIMEOUT_MS) {
    const parsed = Number.parseInt(value, 10);
    const safeFallback = Math.min(Math.max(Number.parseInt(fallback, 10) || min, min), max);
    if (!Number.isSafeInteger(parsed) || parsed <= 0) return safeFallback;
    return Math.min(Math.max(parsed, min), max);
}

function getEmbeddingRequestTimeoutMs(timeoutMs = null) {
    return normalizeTimeoutMs(
        timeoutMs ?? process.env.EMBEDDING_REQUEST_TIMEOUT_MS,
        DEFAULT_EMBEDDING_REQUEST_TIMEOUT_MS
    );
}

function getRagIndexEmbeddingTimeoutMs(timeoutMs = null) {
    return normalizeTimeoutMs(
        timeoutMs ?? process.env.RAG_INDEX_EMBEDDING_TIMEOUT_MS ?? process.env.EMBEDDING_REQUEST_TIMEOUT_MS,
        DEFAULT_RAG_INDEX_EMBEDDING_TIMEOUT_MS
    );
}

function formatDurationMs(ms) {
    if (ms >= 1000 && ms % 1000 === 0) return `${ms / 1000} 秒`;
    if (ms >= 1000) return `${(ms / 1000).toFixed(1)} 秒`;
    return `${ms}ms`;
}

function wrapEmbeddingRequestError(error, timeoutMs) {
    const message = String(error?.message || '');
    const code = String(error?.code || '');
    if (code === 'ECONNABORTED' || /timeout|timed\s*out/i.test(message)) {
        const wrapped = new Error(`向量服务请求超时（已等待 ${formatDurationMs(timeoutMs)}）。请检查检索配置中的向量服务地址、模型名称和服务负载后重试。`);
        wrapped.code = 'EMBEDDING_TIMEOUT';
        wrapped.cause = error;
        return wrapped;
    }
    return error;
}

function normalizeVectorValues(vector) {
    if (!Array.isArray(vector) || vector.length === 0) {
        return null;
    }
    const normalized = vector.map(Number);
    if (normalized.some(value => !Number.isFinite(value))) {
        return null;
    }
    return normalized;
}

function normalizeEmbeddingVectors(data) {
    if (Array.isArray(data?.data)) {
        const vectors = data.data
            .slice()
            .sort((a, b) => (a?.index ?? 0) - (b?.index ?? 0))
            .map(item => normalizeVectorValues(item?.embedding))
            .filter(Boolean);
        if (vectors.length > 0) return vectors;
    }

    if (Array.isArray(data?.embeddings)) {
        const embeddings = data.embeddings;
        const vectors = Array.isArray(embeddings[0])
            ? embeddings.map(normalizeVectorValues).filter(Boolean)
            : [normalizeVectorValues(embeddings)].filter(Boolean);
        if (vectors.length > 0) return vectors;
    }

    const vector = data?.data?.[0]?.embedding
        || data?.embedding
        || data?.response?.embedding;
    const normalized = normalizeVectorValues(vector);
    if (normalized) return [normalized];

    throw new Error('Embedding 服务响应中未找到有效向量');
}

function normalizeEmbeddingVector(data) {
    const vectors = normalizeEmbeddingVectors(data);
    if (!vectors[0]) {
        throw new Error('Embedding 服务响应中未找到有效向量');
    }
    return vectors[0];
}

function resolveEmbeddingUrl(url) {
    const rawUrl = String(url || '').trim();
    const lowerUrl = rawUrl.toLowerCase();
    if (!rawUrl) return '';
    if (
        lowerUrl.endsWith('/embeddings') ||
        lowerUrl.endsWith('/api/embed') ||
        lowerUrl.endsWith('/api/embeddings')
    ) {
        return rawUrl;
    }
    if (lowerUrl.endsWith('/v1')) {
        return `${rawUrl.replace(/\/+$/, '')}/embeddings`;
    }
    return `${rawUrl.replace(/\/+$/, '')}/v1/embeddings`;
}

function buildEmbeddingPayload(text, model, mode, url) {
    const endpoint = String(url || '').toLowerCase();
    if (endpoint.includes('/api/embeddings')) {
        return { model, prompt: text };
    }
    if (endpoint.includes('/api/embed')) {
        return { model, input: text };
    }
    return { input: text, model };
}

function usesUserEmbeddingConfig(config = {}) {
    const source = config.source || {};
    return source.url === 'user' || source.model === 'user' || source.apiKey === 'user';
}

function getEmbeddingRuntimeGuardUser(config = null, user = null) {
    if (config && !usesUserEmbeddingConfig(config)) return { role: 'admin' };
    return user || {};
}

async function requestEmbedding(text, httpConfig, options = {}) {
    const { url, apiKey, model } = httpConfig;
    if (!url) {
        throw new Error('未配置 Embedding HTTP 服务地址');
    }
    const targetUrl = resolveEmbeddingUrl(url);
    const timeoutMs = getEmbeddingRequestTimeoutMs(options.timeoutMs);
    try {
        await assertSafeOutboundUrl(targetUrl, options.user || {});
        const agents = createSafeHttpAgentsForUser(options.user || {});
        const res = await axios.post(targetUrl, buildEmbeddingPayload(text, model || 'nomic-embed-text', EMBEDDING_MODES.http, targetUrl), {
            headers: {
                Authorization: apiKey ? `Bearer ${apiKey}` : undefined,
                'Content-Type': 'application/json'
            },
            timeout: timeoutMs,
            proxy: false,
            ...agents
        });
        return normalizeEmbeddingVector(res.data);
    } catch (e) {
        throw wrapEmbeddingRequestError(e, timeoutMs);
    }
}

async function requestEmbeddings(inputs, httpConfig, options = {}) {
    const safeInputs = Array.isArray(inputs) ? inputs : [inputs];
    const { url, apiKey } = httpConfig;
    const model = options.model || httpConfig.model;
    if (!url) {
        throw new Error('未配置 Embedding HTTP 服务地址');
    }
    const targetUrl = resolveEmbeddingUrl(url);
    const endpoint = targetUrl.toLowerCase();
    const timeoutMs = getEmbeddingRequestTimeoutMs(options.timeoutMs);
    const requestOne = async (input) => {
        try {
            await assertSafeOutboundUrl(targetUrl, options.user || {});
            const agents = createSafeHttpAgentsForUser(options.user || {});
            const res = await axios.post(targetUrl, buildEmbeddingPayload(input, model || 'nomic-embed-text', EMBEDDING_MODES.http, targetUrl), {
                headers: {
                    Authorization: apiKey ? `Bearer ${apiKey}` : undefined,
                    'Content-Type': 'application/json'
                },
                timeout: timeoutMs,
                proxy: false,
                ...agents
            });
            return normalizeEmbeddingVector(res.data);
        } catch (e) {
            throw wrapEmbeddingRequestError(e, timeoutMs);
        }
    };

    if (safeInputs.length === 1 || endpoint.includes('/api/embeddings')) {
        const vectors = [];
        for (const input of safeInputs) {
            vectors.push(await requestOne(input));
        }
        return vectors;
    }

    let res;
    try {
        await assertSafeOutboundUrl(targetUrl, options.user || {});
        const agents = createSafeHttpAgentsForUser(options.user || {});
        res = await axios.post(targetUrl, buildEmbeddingPayload(safeInputs, model || 'nomic-embed-text', EMBEDDING_MODES.http, targetUrl), {
            headers: {
                Authorization: apiKey ? `Bearer ${apiKey}` : undefined,
                'Content-Type': 'application/json'
            },
            timeout: timeoutMs,
            proxy: false,
            ...agents
        });
    } catch (e) {
        throw wrapEmbeddingRequestError(e, timeoutMs);
    }
    const vectors = normalizeEmbeddingVectors(res.data);
    if (vectors.length !== safeInputs.length) {
        throw new Error(`Embedding 服务返回向量数量不匹配: expected ${safeInputs.length}, got ${vectors.length}`);
    }
    return vectors;
}

async function generateEmbedding(text, mode = null, embeddingConfig = null, userId = null, options = {}) {
    const config = getEmbeddingConfig(userId);
    const targetMode = normalizeEmbeddingMode(mode || config.mode);

    if (targetMode === EMBEDDING_MODES.http) {
        const targetHttpConfig = embeddingConfig || config.http || config.cloud;
        const vector = await requestEmbedding(text, targetHttpConfig, {
            timeoutMs: options.timeoutMs,
            user: getEmbeddingRuntimeGuardUser(config, options.user)
        });
        recordEmbeddingUsage({
            userId,
            config,
            httpConfig: targetHttpConfig,
            inputs: [text],
            source: options.source || 'rag_embedding'
        });
        return vector;
    }

    throw new Error(`不支持的 Embedding 模式: ${targetMode}`);
}

async function generateEmbeddings(inputs, mode = null, embeddingConfig = null, userId = null, options = {}) {
    const safeInputs = Array.isArray(inputs) ? inputs : [inputs];
    const config = getEmbeddingConfig(userId);
    const targetMode = normalizeEmbeddingMode(mode || config.mode);

    if (targetMode === EMBEDDING_MODES.http) {
        const targetHttpConfig = embeddingConfig || config.http || config.cloud;
        const vectors = await requestEmbeddings(safeInputs, targetHttpConfig, {
            timeoutMs: options.timeoutMs,
            user: getEmbeddingRuntimeGuardUser(config, options.user)
        });
        recordEmbeddingUsage({
            userId,
            config,
            httpConfig: targetHttpConfig,
            inputs: safeInputs,
            source: options.source || 'rag_embedding'
        });
        return vectors;
    }

    throw new Error(`不支持的 Embedding 模式: ${targetMode}`);
}
function cosineSimilarity(vecA, vecB) {
    if (!Array.isArray(vecA) || !Array.isArray(vecB) || vecA.length !== vecB.length) return 0;
    let dotProduct = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < vecA.length; i += 1) {
        if (!Number.isFinite(vecA[i]) || !Number.isFinite(vecB[i])) return 0;
        dotProduct += vecA[i] * vecB[i];
        normA += vecA[i] * vecA[i];
        normB += vecB[i] * vecB[i];
    }
    if (normA === 0 || normB === 0) return 0;
    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

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

function recordEmbeddingUsage({ userId, config, httpConfig, inputs, source }) {
    if (!userId) return;
    try {
        const model = String(httpConfig?.model || config?.http?.model || '').trim() || 'embedding';
        const url = String(httpConfig?.url || config?.http?.url || '').trim();
        const usageModelId = getOrCreateEmbeddingUsageModel({
            userId: config?.source?.url === 'user' || config?.source?.model === 'user' || config?.source?.apiKey === 'user' ? userId : null,
            url,
            model
        });
        const inputTokens = estimateEmbeddingTokens(inputs, estimateTokens);
        recordModelTokenUsage(userId, usageModelId, inputTokens, source, inputTokens, 0);
    } catch (e) {
        logger.warn({ err: e.message }, '向量模型用量统计写入失败');
    }
}

const SENTENCE_BOUNDARY_RE = /[。！？!?；;.!?]/;

function findParagraphChunkEnd(text, start, limit) {
    const slice = text.slice(start, limit);
    const boundaryIndex = slice.lastIndexOf('\n\n');
    if (boundaryIndex < 0) return -1;
    let end = start + boundaryIndex + 2;
    while (end < limit && text[end] === '\n') end += 1;
    return end;
}

function findSentenceChunkEnd(text, start, limit) {
    for (let i = limit - 1; i >= start; i -= 1) {
        if (SENTENCE_BOUNDARY_RE.test(text[i])) return i + 1;
    }
    return -1;
}

function findLineChunkEnd(text, start, limit) {
    const newlineIndex = text.lastIndexOf('\n', limit - 1);
    return newlineIndex >= start ? newlineIndex + 1 : -1;
}

function chunkText(text, chunkSize = 500, overlap = 100) {
    const normalizedText = String(text || '').replace(/\r\n?/g, '\n').trim();
    const chunks = [];
    let i = 0;
    const step = Math.max(chunkSize - overlap, 1);
    const maxExtension = Math.max(32, Math.min(Math.max(overlap, 0), 120));
    while (i < normalizedText.length) {
        const hardEnd = Math.min(normalizedText.length, i + chunkSize);
        const searchStart = Math.min(normalizedText.length, i + step);
        const searchLimit = Math.min(normalizedText.length, i + chunkSize + maxExtension);
        let chunkEnd = findParagraphChunkEnd(normalizedText, searchStart, searchLimit);
        if (chunkEnd < 0) chunkEnd = findSentenceChunkEnd(normalizedText, searchStart, searchLimit);
        if (chunkEnd < 0) chunkEnd = findLineChunkEnd(normalizedText, searchStart, searchLimit);
        if (chunkEnd < 0 || chunkEnd <= i) chunkEnd = hardEnd;
        const chunk = normalizedText.slice(i, chunkEnd);
        if (chunk.length > 0) chunks.push(chunk);
        i += step;
    }
    return chunks;
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
            SELECT c.id, c.content, c.embedding, d.name
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
    let chunks = selectFtsCandidates(userId, keywords, candidateLimit, scope);
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

function scoreChunks(chunks, queryVector) {
    // Compute the query vector's norm once, then reuse cached chunk vectors/norms.
    const queryNorm = computeVectorNorm(queryVector);
    return chunks.map(chunk => {
        try {
            const chunkEntry = getChunkEmbedding(chunk.id, chunk.embedding, queryVector.length);
            if (!chunkEntry) return null;
            return {
                text: chunk.content,
                source: chunk.name,
                score: cosineSimilarityCached(queryVector, queryNorm, chunkEntry)
            };
        } catch (e) {
            logger.warn({ chunkId: chunk.id, err: e.message }, 'RAG 向量解析失败，已跳过分片');
            return null;
        }
    }).filter(Boolean);
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
            score
        };
    }).filter(Boolean);
}

function formatInjectedContext(topChunks) {
    let injectedContext = '\n\n【参考内部知识库信息如下】：\n';
    topChunks.forEach((chunk, index) => {
        injectedContext += `[引用 ${index + 1} | 来源: ${chunk.source}]: ${chunk.text}\n`;
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
    let scoredChunks = [];
    try {
        const vector = Array.isArray(queryVector) ? queryVector : await generateEmbedding(normalizedQuery, null, null, userId, { user });
        // Compute the query vector's norm once, then reuse cached chunk vectors/norms.
        const queryNorm = computeVectorNorm(vector);
        scoredChunks = candidates.map(chunk => {
            try {
                const chunkEntry = getChunkEmbedding(chunk.id, chunk.embedding, vector.length);
                if (!chunkEntry) return null;
                return {
                    chunkId: chunk.id,
                    text: chunk.content,
                    source: chunk.name,
                    score: cosineSimilarityCached(vector, queryNorm, chunkEntry)
                };
            } catch (e) {
                logger.warn({ chunkId: chunk.id, err: e.message }, 'RAG 调试向量解析失败，已跳过分片');
                return null;
            }
        }).filter(Boolean).sort((a, b) => b.score - a.score);
    } catch (e) {
        logger.warn({ err: e.message }, 'RAG 调试向量生成失败，已回退到关键词检索');
        scoredChunks = scoreKeywordChunks(candidates, normalizedQuery)
            .map(chunk => ({ ...chunk, chunkId: candidates.find(item => item.content === chunk.text && item.name === chunk.source)?.id }))
            .sort((a, b) => b.score - a.score);
    }
    const matches = scoredChunks.map(match => normalizeRetrievalDebugMatch(match, config.scoreThreshold));

    return {
        query: normalizedQuery,
        keywords,
        threshold: config.scoreThreshold,
        topK: safeTopK,
        candidateCount: candidates.length,
        matches,
        graph: graphContext,
        scope: normalizedScope,
        injectedContext: formatInjectedContext(
            scoredChunks.filter(chunk => chunk.score > config.scoreThreshold).slice(0, safeTopK)
        ) + (graphContext.context || '')
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

        let scoredChunks = [];
        let usedKeywordFallback = false;
        try {
            const queryVector = await generateEmbedding(normalizedQuery, null, null, userId, { user: options.user || null });
            scoredChunks = scoreChunks(chunks, queryVector).sort((a, b) => b.score - a.score);
        } catch (e) {
            usedKeywordFallback = true;
            logger.warn({ err: e.message }, 'RAG 查询向量生成失败，已回退到关键词检索');
            scoredChunks = scoreKeywordChunks(chunks, normalizedQuery).sort((a, b) => b.score - a.score);
        }
        const topChunks = (usedKeywordFallback
            ? scoredChunks
            : scoredChunks.filter(chunk => chunk.score > config.scoreThreshold)
        ).slice(0, config.topK);
        const topScore = scoredChunks.length > 0 ? scoredChunks[0].score : 0;

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

async function indexDocumentChunks(docId, text, { onProgress, userId = null, user = null, embeddingTimeoutMs = null } = {}) {
    const startedAt = Date.now();
    const ragConfig = getRagConfig({}, userId);
    const chunks = chunkText(text, ragConfig.chunkSize, ragConfig.chunkOverlap);
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
            let vectors = null;
            try {
                vectors = await generateEmbeddings(batch, null, null, userId, {
                    timeoutMs: indexEmbeddingTimeoutMs,
                    source: 'rag_ingest_embedding',
                    user
                });
            } catch (e) {
                logger.warn({ err: e.message, docId }, 'RAG 分片向量生成失败，已按关键词索引继续');
            }
            const results = batch.map((chunk, index) => ({
                chunk,
                vector: Array.isArray(vectors) ? vectors[index] : null
            }));
            
            const insert = db.prepare('INSERT INTO knowledge_chunks (doc_id, content, search_content, embedding) VALUES (?, ?, ?, ?)');
            const insertedChunks = [];
            const transaction = db.transaction((items) => {
                for (const item of items) {
                    const embedding = Array.isArray(item.vector) ? JSON.stringify(item.vector) : null;
                    const result = insert.run(docId, item.chunk, buildRagSearchContent(item.chunk), embedding);
                    insertedChunks.push({ chunkId: result.lastInsertRowid, content: item.chunk });
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
