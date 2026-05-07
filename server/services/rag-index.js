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

const RAG_CANDIDATE_LIMIT = Math.max(parseInt(process.env.RAG_CANDIDATE_LIMIT || '300', 10) || 300, 20);
const RAG_SCORE_THRESHOLD = Number.isFinite(parseFloat(process.env.RAG_SCORE_THRESHOLD))
    ? parseFloat(process.env.RAG_SCORE_THRESHOLD)
    : 0.4;

async function initLocalExtractor() {
    logger.warn('RAG 本地向量引擎当前未启用');
    throw new Error('RAG 本地向量引擎当前未启用');
}

function getEmbeddingConfig() {
    const mode = process.env.EMBEDDING_MODE || (process.env.EMBEDDING_API_URL ? 'cloud' : 'local');
    return {
        mode,
        cloud: {
            url: process.env.EMBEDDING_API_URL,
            apiKey: process.env.EMBEDDING_API_KEY || '',
            model: process.env.EMBEDDING_MODEL || 'nomic-embed-text'
        }
    };
}

async function generateEmbedding(text, mode = null, cloudConfig = null) {
    const config = getEmbeddingConfig();
    const targetMode = mode || config.mode;
    const targetCloudConfig = cloudConfig || config.cloud;

    if (targetMode === 'cloud') {
        const { url, apiKey, model } = targetCloudConfig;
        if (!url) throw new Error('未配置 EMBEDDING_API_URL');
        const res = await axios.post(url, {
            input: text,
            model: model || 'nomic-embed-text'
        }, {
            headers: {
                Authorization: apiKey ? `Bearer ${apiKey}` : undefined,
                'Content-Type': 'application/json'
            },
            timeout: 30000,
            proxy: false
        });
        return res.data.data[0].embedding;
    }

    if (targetMode === 'local') {
        const getExtractor = await initLocalExtractor();
        const output = await getExtractor(text, { pooling: 'mean', normalize: true });
        return Array.from(output.data);
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
        WHERE d.user_id = ? AND d.status = 'ready' AND (${keywordWhere})
        ORDER BY c.id DESC
        LIMIT ?
    `).all(userId, ...keywords.map(k => `%${k}%`), limit);
}

function selectRecentCandidates(userId, limit) {
    return db.prepare(`
        SELECT c.id, c.content, c.embedding, d.name
        FROM knowledge_chunks c
        JOIN knowledge_docs d ON c.doc_id = d.id
        WHERE d.user_id = ? AND d.status = 'ready'
        ORDER BY c.id DESC
        LIMIT ?
    `).all(userId, limit);
}

function selectRetrievalCandidates(userId, query, topK) {
    const keywords = buildKeywordCandidates(query);
    let chunks = selectFtsCandidates(userId, keywords, RAG_CANDIDATE_LIMIT);
    if (chunks.length < topK) {
        chunks = selectLikeCandidates(userId, keywords, RAG_CANDIDATE_LIMIT);
    }
    if (chunks.length < topK) {
        chunks = selectRecentCandidates(userId, RAG_CANDIDATE_LIMIT);
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

async function retrieveContext(userId, query, topK = 3) {
    const startedAt = Date.now();
    const normalizedQuery = normalizeCacheQuery(query);
    if (!normalizedQuery) return '';

    const cachedResult = getFromCache(userId, normalizedQuery, topK);
    if (cachedResult !== null) {
        recordRagRetrieval({ status: 'cache_hit', durationMs: Date.now() - startedAt, cacheHit: true });
        return cachedResult;
    }

    try {
        const queryVector = await generateEmbedding(normalizedQuery);
        const chunks = selectRetrievalCandidates(userId, normalizedQuery, topK);

        if (chunks.length === 0) {
            setToCache(userId, normalizedQuery, topK, '');
            recordRagRetrieval({ status: 'empty', durationMs: Date.now() - startedAt, candidates: 0, matches: 0 });
            return '';
        }

        const scoredChunks = scoreChunks(chunks, queryVector).sort((a, b) => b.score - a.score);
        const topChunks = scoredChunks.filter(chunk => chunk.score > RAG_SCORE_THRESHOLD).slice(0, topK);
        const topScore = scoredChunks.length > 0 ? scoredChunks[0].score : 0;

        if (topChunks.length === 0) {
            setToCache(userId, normalizedQuery, topK, '');
            recordRagRetrieval({
                status: 'no_match',
                durationMs: Date.now() - startedAt,
                candidates: chunks.length,
                matches: 0,
                topScore
            });
            return '';
        }

        const injectedContext = formatInjectedContext(topChunks);
        setToCache(userId, normalizedQuery, topK, injectedContext);
        recordRagRetrieval({
            status: 'hit',
            durationMs: Date.now() - startedAt,
            candidates: chunks.length,
            matches: topChunks.length,
            topScore
        });
        return injectedContext;
    } catch (e) {
        logger.error({ err: e.message }, 'RAG 检索失败');
        recordRagRetrieval({ status: 'error', durationMs: Date.now() - startedAt });
        return '';
    }
}

async function indexDocumentChunks(docId, text) {
    const startedAt = Date.now();
    const chunks = chunkText(text);
    try {
        for (const chunk of chunks) {
            const vector = await generateEmbedding(chunk);
            db.prepare('INSERT INTO knowledge_chunks (doc_id, content, search_content, embedding) VALUES (?, ?, ?, ?)')
                .run(docId, chunk, buildRagSearchContent(chunk), JSON.stringify(vector));
        }
        recordRagIngest({ status: 'ready', chunks: chunks.length, durationMs: Date.now() - startedAt });
        return chunks.length;
    } catch (e) {
        recordRagIngest({ status: 'error', chunks: 0, durationMs: Date.now() - startedAt });
        throw e;
    }
}

module.exports = {
    getEmbeddingConfig,
    generateEmbedding,
    cosineSimilarity,
    chunkText,
    buildKeywordCandidates,
    buildFtsOrQuery,
    buildRagSearchContent,
    buildRagSearchTerms,
    retrieveContext,
    indexDocumentChunks
};
