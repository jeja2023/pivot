/* 知识库与 RAG 核心处理模块 Knowledge Base & RAG Engine */
const express = require('express');
const multer = require('multer');
const fs = require('fs');
const pdf = require('pdf-parse');
const axios = require('axios');
const { db } = require('./db');
const { authMiddleware } = require('./auth');
const { getBeijingTimestamp } = require('./time');
const { logger } = require('./logger');

const ragRouter = express.Router();
const upload = multer({
    dest: 'uploads/docs/',
    limits: { fileSize: 20 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        if (/\.(txt|md|pdf)$/i.test(file.originalname || '')) return cb(null, true);
        cb(new Error('仅支持 txt、md、pdf 文档'));
    }
});

// 初始化本地 Transformer Embedding 模型 (注：当前版本已按需禁用)
async function initLocalExtractor() {
    logger.warn('系统提示: RAG 向量引擎已关闭。');
    throw new Error('RAG 功能未开启。');
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

// --- 统一 Embedding 生成接口 ---
// 模式: 'local' (Transformers.js) | 'cloud' (云端 API 兼容)
async function generateEmbedding(text, mode = null, cloudConfig = null) {
    const config = getEmbeddingConfig();
    const targetMode = mode || config.mode;
    const targetCloudConfig = cloudConfig || config.cloud;

    if (targetMode === 'cloud') {
        try {
            const { url, apiKey, model } = targetCloudConfig;
            if (!url) throw new Error('未配置 EMBEDDING_API_URL');
            const res = await axios.post(url, {
                input: text,
                model: model || 'nomic-embed-text'
            }, {
                headers: {
                    'Authorization': apiKey ? `Bearer ${apiKey}` : undefined,
                    'Content-Type': 'application/json'
                },
                timeout: 30000,
                proxy: false
            });
            return res.data.data[0].embedding;
        } catch (e) {
            logger.warn({ err: e.message }, '云端向量化失败');
            throw e;
        }
    }

    if (targetMode === 'local') {
        // 尝试加载本地模型
        const getExtractor = await initLocalExtractor();
        const output = await getExtractor(text, { pooling: 'mean', normalize: true });
        return Array.from(output.data);
    }
    throw new Error(`不支持的 Embedding 模式: ${targetMode}`);
}

// 余弦相似度计算算法
function cosineSimilarity(vecA, vecB) {
    if (!Array.isArray(vecA) || !Array.isArray(vecB) || vecA.length !== vecB.length) return 0;
    let dotProduct = 0, normA = 0, normB = 0;
    for (let i = 0; i < vecA.length; i++) {
        if (!Number.isFinite(vecA[i]) || !Number.isFinite(vecB[i])) return 0;
        dotProduct += vecA[i] * vecB[i];
        normA += vecA[i] * vecA[i];
        normB += vecB[i] * vecB[i];
    }
    if (normA === 0 || normB === 0) return 0;
    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

// 智能文本切分 (滑动窗口)
function chunkText(text, chunkSize = 500, overlap = 100) {
    text = text.replace(/\n+/g, ' ').trim();
    const chunks = [];
    let i = 0;
    while (i < text.length) {
        let chunk = text.slice(i, i + chunkSize);
        if (chunk.length > 0) chunks.push(chunk);
        i += (chunkSize - overlap);
    }
    return chunks;
}

// --- API 路由定义 ---

// 获取当前用户的文档列表
ragRouter.get('/docs', authMiddleware, (req, res) => {
    const docs = db.prepare('SELECT * FROM knowledge_docs WHERE user_id = ? ORDER BY created_at DESC').all(req.user.id);
    res.json(docs);
});

// 删除文档
ragRouter.delete('/docs/:id', authMiddleware, (req, res) => {
    db.prepare('DELETE FROM knowledge_docs WHERE id = ? AND user_id = ?').run(req.params.id, req.user.id);
    clearRagCacheForUser(req.user.id);
    res.json({ success: true });
});

// 上传并解析文档
ragRouter.post('/upload', authMiddleware, upload.single('file'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: '请上传文件' });

    const fileInfo = db.prepare('INSERT INTO knowledge_docs (user_id, name, status, created_at) VALUES (?, ?, ?, ?)')
        .run(req.user.id, req.file.originalname, 'processing', getBeijingTimestamp());
    const docId = fileInfo.lastInsertRowid;
    clearRagCacheForUser(req.user.id);
    res.json({ success: true, docId, message: '后台处理中' });

    // 异步执行耗时极高的向量化任务
    try {
        let text = '';
        if (req.file.originalname.endsWith('.pdf')) {
            const dataBuffer = fs.readFileSync(req.file.path);
            const data = await pdf(dataBuffer);
            text = data.text;
        } else {
            text = fs.readFileSync(req.file.path, 'utf8');
        }

        const chunks = chunkText(text);

        // 自动根据配置选择向量引擎
        for (const chunk of chunks) {
            const vector = await generateEmbedding(chunk);
            db.prepare('INSERT INTO knowledge_chunks (doc_id, content, embedding) VALUES (?, ?, ?)')
                .run(docId, chunk, JSON.stringify(vector));
        }

        db.prepare('UPDATE knowledge_docs SET status = ? WHERE id = ?').run('ready', docId);
    } catch (e) {
        logger.error({ err: e.message }, 'RAG 解析失败');
        db.prepare('UPDATE knowledge_docs SET status = ? WHERE id = ?').run('error', docId);
    } finally {
        // 清理本地临时文件
        if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
    }
});

// --- RAG 检索核心缓存 (性能优化) ---
const ragCache = new Map();
const RAG_CACHE_TTL = Math.max(parseInt(process.env.RAG_CACHE_TTL_MS || String(5 * 60 * 1000), 10) || 0, 0);
const RAG_CACHE_MAX = Math.max(parseInt(process.env.RAG_CACHE_MAX || '1000', 10) || 1000, 1);
const RAG_CANDIDATE_LIMIT = Math.max(parseInt(process.env.RAG_CANDIDATE_LIMIT || '300', 10) || 300, 20);

function normalizeCacheQuery(query) {
    return String(query || '').trim().replace(/\s+/g, ' ').slice(0, 1000);
}

function getCacheKey(userId, query, topK) {
    return `${userId}:${topK}:${normalizeCacheQuery(query)}`;
}

function getFromCache(userId, query, topK) {
    if (RAG_CACHE_TTL === 0) return null;
    const key = getCacheKey(userId, query, topK);
    const cached = ragCache.get(key);
    if (cached && Date.now() - cached.at < RAG_CACHE_TTL) return cached.value;
    if (cached) ragCache.delete(key);
    return null;
}

function setToCache(userId, query, topK, value) {
    if (RAG_CACHE_TTL === 0) return;
    const key = getCacheKey(userId, query, topK);
    // 简单的容量控制：超过 1000 条清理最早的
    while (ragCache.size >= RAG_CACHE_MAX) {
        const firstKey = ragCache.keys().next().value;
        ragCache.delete(firstKey);
    }
    ragCache.set(key, { value, at: Date.now() });
}

function clearRagCacheForUser(userId) {
    const prefix = `${userId}:`;
    for (const key of ragCache.keys()) {
        if (key.startsWith(prefix)) ragCache.delete(key);
    }
}

function buildKeywordCandidates(query, limit = 8) {
    return [...new Set(String(query || '')
        .toLowerCase()
        .split(/[^\p{L}\p{N}\u4e00-\u9fa5]+/u)
        .map(item => item.trim())
        .filter(item => item.length >= 2)
        .sort((a, b) => b.length - a.length)
        .slice(0, limit))];
}

// --- RAG 检索核心暴露给 Chat 模块 ---
async function retrieveContext(userId, query, topK = 3) {
    const normalizedQuery = normalizeCacheQuery(query);
    if (!normalizedQuery) return '';
    const cachedResult = getFromCache(userId, normalizedQuery, topK);
    if (cachedResult !== null) return cachedResult;

    try {
        // 将用户的查询请求也转为向量
        const queryVector = await generateEmbedding(normalizedQuery);

        const keywords = buildKeywordCandidates(normalizedQuery);
        let chunks;
        if (keywords.length > 0) {
            const keywordWhere = keywords.map(() => 'LOWER(c.content) LIKE ?').join(' OR ');
            chunks = db.prepare(`
                SELECT c.id, c.content, c.embedding, d.name
                FROM knowledge_chunks c
                JOIN knowledge_docs d ON c.doc_id = d.id
                WHERE d.user_id = ? AND d.status = 'ready' AND (${keywordWhere})
                ORDER BY c.id DESC
                LIMIT ?
            `).all(userId, ...keywords.map(k => `%${k}%`), RAG_CANDIDATE_LIMIT);
        }

        if (!chunks || chunks.length < topK) {
            chunks = db.prepare(`
            SELECT c.id, c.content, c.embedding, d.name 
            FROM knowledge_chunks c 
            JOIN knowledge_docs d ON c.doc_id = d.id 
            WHERE d.user_id = ? AND d.status = 'ready'
            ORDER BY c.id DESC
            LIMIT ?
        `).all(userId, RAG_CANDIDATE_LIMIT);
        }

        if (chunks.length === 0) {
            setToCache(userId, normalizedQuery, topK, '');
            return '';
        }

        // 内存计算相似度并排序
        const scoredChunks = chunks.map(c => {
            try {
                if (!c.embedding) return null;
                const docVec = JSON.parse(c.embedding);
                if (!Array.isArray(docVec) || docVec.length !== queryVector.length) return null;
                
                return {
                    text: c.content,
                    source: c.name,
                    score: cosineSimilarity(queryVector, docVec)
                };
            } catch (e) {
                logger.warn({ doc_id: c.id, err: e.message }, '解析向量失败，跳过该分片');
                return null;
            }
        }).filter(Boolean);

        // 取前 Top K 且得分超过 0.5 的块
        scoredChunks.sort((a, b) => b.score - a.score);
        const topChunks = scoredChunks.filter(c => c.score > 0.4).slice(0, topK);

        if (topChunks.length === 0) {
            setToCache(userId, normalizedQuery, topK, '');
            return '';
        }

        let injectedContext = '\n\n【参考内部知识库信息如下】：\n';
        topChunks.forEach((c, idx) => {
            injectedContext += `[引用 ${idx + 1} | 来源: ${c.source}]: ${c.text}\n`;
        });
        injectedContext += '请基于上述参考信息回答我的问题，如果没有在参考信息中找到答案，请告知无法在知识库中查阅到该信息。\n';

        setToCache(userId, normalizedQuery, topK, injectedContext);
        return injectedContext;
    } catch (e) {
        logger.error({ err: e.message }, 'RAG 检索异常');
        return '';
    }
}

module.exports = { ragRouter, retrieveContext, cosineSimilarity, clearRagCacheForUser };
