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
const { EMBEDDING_MODES, getEmbeddingConfig, getRagConfig, normalizeEmbeddingMode } = require('./rag-config');
const {
    getOrCreateEmbeddingUsageModel,
    recordModelTokenUsage
} = require('./models');
const { estimateTokens } = require('../llm');
const { estimateEmbeddingTokens } = require('./token-accounting');
const { recordSlowRagRetrieval } = require('./observability');

const MAX_DEBUG_CANDIDATE_LIMIT = 1000;

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

async function requestEmbedding(text, httpConfig) {
    const { url, apiKey, model } = httpConfig;
    if (!url) {
        throw new Error('未配置 Embedding HTTP 服务地址');
    }
    const targetUrl = resolveEmbeddingUrl(url);
    const res = await axios.post(targetUrl, buildEmbeddingPayload(text, model || 'nomic-embed-text', EMBEDDING_MODES.http, targetUrl), {
        headers: {
            Authorization: apiKey ? `Bearer ${apiKey}` : undefined,
            'Content-Type': 'application/json'
        },
        timeout: 30000,
        proxy: false
    });
    return normalizeEmbeddingVector(res.data);
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
    const requestOne = async (input) => {
        const res = await axios.post(targetUrl, buildEmbeddingPayload(input, model || 'nomic-embed-text', EMBEDDING_MODES.http, targetUrl), {
            headers: {
                Authorization: apiKey ? `Bearer ${apiKey}` : undefined,
                'Content-Type': 'application/json'
            },
            timeout: options.timeoutMs || 30000,
            proxy: false
        });
        return normalizeEmbeddingVector(res.data);
    };

    if (safeInputs.length === 1 || endpoint.includes('/api/embeddings')) {
        const vectors = [];
        for (const input of safeInputs) {
            vectors.push(await requestOne(input));
        }
        return vectors;
    }

    const res = await axios.post(targetUrl, buildEmbeddingPayload(safeInputs, model || 'nomic-embed-text', EMBEDDING_MODES.http, targetUrl), {
        headers: {
            Authorization: apiKey ? `Bearer ${apiKey}` : undefined,
            'Content-Type': 'application/json'
        },
        timeout: options.timeoutMs || 30000,
        proxy: false
    });
    const vectors = normalizeEmbeddingVectors(res.data);
    if (vectors.length !== safeInputs.length) {
        throw new Error(`Embedding 服务返回向量数量不匹配: expected ${safeInputs.length}, got ${vectors.length}`);
    }
    return vectors;
}

async function generateEmbedding(text, mode = null, embeddingConfig = null, userId = null) {
    const config = getEmbeddingConfig(userId);
    const targetMode = normalizeEmbeddingMode(mode || config.mode);

    if (targetMode === EMBEDDING_MODES.http) {
        const targetHttpConfig = embeddingConfig || config.http || config.cloud;
        const vector = await requestEmbedding(text, targetHttpConfig);
        recordEmbeddingUsage({
            userId,
            config,
            httpConfig: targetHttpConfig,
            inputs: [text],
            source: 'rag_embedding'
        });
        return vector;
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

function chunkText(text, chunkSize = 500, overlap = 100) {
    const normalizedText = String(text || '').replace(/\n+/g, ' ').trim();
    const chunks = [];
    let i = 0;
    const step = Math.max(chunkSize - overlap, 1);
    while (i < normalizedText.length) {
        const chunk = normalizedText.slice(i, i + chunkSize);
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

function selectFtsCandidates(userId, keywords, limit) {
    if (keywords.length === 0) return [];
    const ftsQuery = buildFtsOrQuery(keywords);
    if (!ftsQuery) return [];

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
            ORDER BY bm25(knowledge_chunks_fts)
            LIMIT ?
        `).all(ftsQuery, userId, limit);
    } catch (e) {
        logger.warn({ err: e.message }, 'RAG FTS 候选召回失败，已回退到 LIKE 扫描');
        return [];
    }
}

function selectLikeCandidates(userId, keywords, limit) {
    if (keywords.length === 0) return [];
    const keywordWhere = keywords.map(() => 'LOWER(c.content) LIKE ?').join(' OR ');
    return db.prepare(`
        SELECT c.id, c.content, c.embedding, d.name
        FROM knowledge_chunks c
        JOIN knowledge_docs d ON c.doc_id = d.id
        WHERE d.user_id = ? AND d.status = 'ready' AND d.deleted_at IS NULL AND COALESCE(d.is_enabled, 1) = 1 AND (${keywordWhere})
        ORDER BY c.id DESC
        LIMIT ?
    `).all(userId, ...keywords.map(k => `%${k}%`), limit);
}

function selectRecentCandidates(userId, limit) {
    return db.prepare(`
        SELECT c.id, c.content, c.embedding, d.name
        FROM knowledge_chunks c
        JOIN knowledge_docs d ON c.doc_id = d.id
        WHERE d.user_id = ? AND d.status = 'ready' AND d.deleted_at IS NULL AND COALESCE(d.is_enabled, 1) = 1
        ORDER BY c.id DESC
        LIMIT ?
    `).all(userId, limit);
}

function selectRetrievalCandidates(userId, query, topK, candidateLimit) {
    const keywords = buildKeywordCandidates(query);
    let chunks = selectFtsCandidates(userId, keywords, candidateLimit);
    if (chunks.length < topK) {
        chunks = selectLikeCandidates(userId, keywords, candidateLimit);
    }
    if (chunks.length < topK) {
        chunks = selectRecentCandidates(userId, candidateLimit);
    }
    return chunks;
}

function scoreChunks(chunks, queryVector) {
    return chunks.map(chunk => {
        try {
            if (!chunk.embedding) return null;
            const docVec = JSON.parse(chunk.embedding);
            if (!Array.isArray(docVec) || docVec.length !== queryVector.length) return null;
            return {
                text: chunk.content,
                source: chunk.name,
                score: cosineSimilarity(queryVector, docVec)
            };
        } catch (e) {
            logger.warn({ chunkId: chunk.id, err: e.message }, 'RAG 向量解析失败，已跳过分片');
            return null;
        }
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
    queryVector = null
} = {}) {
    const config = getRagConfig({ topK, candidateLimit, scoreThreshold });
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
    const keywords = buildKeywordCandidates(normalizedQuery);
    const vector = Array.isArray(queryVector) ? queryVector : await generateEmbedding(normalizedQuery, null, null, userId);
    const candidates = selectRetrievalCandidates(userId, normalizedQuery, safeTopK, safeCandidateLimit).slice(0, safeCandidateLimit);
    const scoredChunks = candidates.map(chunk => {
        try {
            if (!chunk.embedding) return null;
            const docVec = JSON.parse(chunk.embedding);
            if (!Array.isArray(docVec) || docVec.length !== vector.length) return null;
            return {
                chunkId: chunk.id,
                text: chunk.content,
                source: chunk.name,
                score: cosineSimilarity(vector, docVec)
            };
        } catch (e) {
            logger.warn({ chunkId: chunk.id, err: e.message }, 'RAG 调试向量解析失败，已跳过分片');
            return null;
        }
    }).filter(Boolean).sort((a, b) => b.score - a.score);
    const matches = scoredChunks.map(match => normalizeRetrievalDebugMatch(match, config.scoreThreshold));

    return {
        query: normalizedQuery,
        keywords,
        threshold: config.scoreThreshold,
        topK: safeTopK,
        candidateCount: candidates.length,
        matches,
        injectedContext: formatInjectedContext(
            scoredChunks.filter(chunk => chunk.score > config.scoreThreshold).slice(0, safeTopK)
        )
    };
}

async function retrieveContext(userId, query, topK = null) {
    const startedAt = Date.now();
    const normalizedQuery = normalizeCacheQuery(query);
    if (!normalizedQuery) return '';
    const config = getRagConfig({ topK });
    const recordRetrieval = (payload) => {
        recordRagRetrieval(payload);
        recordSlowRagRetrieval({
            ...payload,
            userId,
            query: normalizedQuery,
            topK: config.topK
        });
    };

    const cachedResult = getFromCache(userId, normalizedQuery, config.topK);
    if (cachedResult !== null) {
        recordRetrieval({ status: 'cache_hit', durationMs: Date.now() - startedAt, cacheHit: true });
        return cachedResult;
    }

    try {
        const queryVector = await generateEmbedding(normalizedQuery, null, null, userId);
        const chunks = selectRetrievalCandidates(userId, normalizedQuery, config.topK, config.candidateLimit);

        if (chunks.length === 0) {
            setToCache(userId, normalizedQuery, config.topK, '');
            recordRetrieval({ status: 'empty', durationMs: Date.now() - startedAt, candidates: 0, matches: 0 });
            return '';
        }

        const scoredChunks = scoreChunks(chunks, queryVector).sort((a, b) => b.score - a.score);
        const topChunks = scoredChunks.filter(chunk => chunk.score > config.scoreThreshold).slice(0, config.topK);
        const topScore = scoredChunks.length > 0 ? scoredChunks[0].score : 0;

        if (topChunks.length === 0) {
            setToCache(userId, normalizedQuery, config.topK, '');
            recordRetrieval({
                status: 'no_match',
                durationMs: Date.now() - startedAt,
                candidates: chunks.length,
                matches: 0,
                topScore
            });
            return '';
        }

        const injectedContext = formatInjectedContext(topChunks);
        setToCache(userId, normalizedQuery, config.topK, injectedContext);
        recordRetrieval({
            status: 'hit',
            durationMs: Date.now() - startedAt,
            candidates: chunks.length,
            matches: topChunks.length,
            topScore
        });
        return injectedContext;
    } catch (e) {
        logger.error({ err: e.message }, 'RAG 检索失败');
        recordRetrieval({ status: 'error', durationMs: Date.now() - startedAt });
        return '';
    }
}

async function indexDocumentChunks(docId, text, { onProgress, userId = null } = {}) {
    const startedAt = Date.now();
    const ragConfig = getRagConfig();
    const chunks = chunkText(text, ragConfig.chunkSize, ragConfig.chunkOverlap);
    const batchSize = 5; // 限制并发数，防止 OOM 或 API 限流
    try {
        for (let i = 0; i < chunks.length; i += batchSize) {
            const batch = chunks.slice(i, i + batchSize);
            const results = await Promise.all(batch.map(async (chunk) => {
                const vector = await generateEmbedding(chunk, null, null, userId);
                return { chunk, vector };
            }));
            
            const insert = db.prepare('INSERT INTO knowledge_chunks (doc_id, content, search_content, embedding) VALUES (?, ?, ?, ?)');
            const transaction = db.transaction((items) => {
                for (const item of items) {
                    insert.run(docId, item.chunk, buildRagSearchContent(item.chunk), JSON.stringify(item.vector));
                }
            });
            transaction(results);
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

async function testEmbeddingConnection(config = {}) {
    const startedAt = Date.now();
    try {
        const httpConfig = {
            url: config.apiUrl || '',
            model: config.model || '',
            apiKey: config.apiKey || ''
        };
        const vector = await requestEmbedding('测试向量生成 (智枢 Test Connection)', httpConfig);

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
    requestEmbedding,
    requestEmbeddings,
    testEmbeddingConnection,
    normalizeEmbeddingVector,
    normalizeEmbeddingVectors,
    resolveEmbeddingUrl,
    buildEmbeddingPayload,
    cosineSimilarity,
    chunkText,
    buildKeywordCandidates,
    buildFtsOrQuery,
    buildRagSearchContent,
    buildRagSearchTerms,
    debugRetrieveContext,
    retrieveContext,
    indexDocumentChunks
};
