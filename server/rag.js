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

// --- 模型全局单例配置 ---
let extractor = null;
let isExtractorLoading = false;

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
    let dotProduct = 0, normA = 0, normB = 0;
    for (let i = 0; i < vecA.length; i++) {
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
    res.json({ success: true });
});

// 上传并解析文档
ragRouter.post('/upload', authMiddleware, upload.single('file'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: '请上传文件' });

    const fileInfo = db.prepare('INSERT INTO knowledge_docs (user_id, name, status, created_at) VALUES (?, ?, ?, ?)')
        .run(req.user.id, req.file.originalname, 'processing', getBeijingTimestamp());
    const docId = fileInfo.lastInsertRowid;
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

// --- RAG 检索核心暴露给 Chat 模块 ---
async function retrieveContext(userId, query, topK = 3) {
    try {
        // 将用户的查询请求也转为向量
        const queryVector = await generateEmbedding(query);

        // 提取该用户所有的知识库 Chunks
        // 在生产级应用中，这里应该用专门的向量数据库。SQLite 中我们通过内存计算 (适合小知识库)
        const chunks = db.prepare(`
            SELECT c.content, c.embedding, d.name 
            FROM knowledge_chunks c 
            JOIN knowledge_docs d ON c.doc_id = d.id 
            WHERE d.user_id = ? AND d.status = 'ready'
        `).all(userId);

        if (chunks.length === 0) return '';

        // 内存计算相似度并排序
        const scoredChunks = chunks.map(c => {
            const docVec = JSON.parse(c.embedding);
            return {
                text: c.content,
                source: c.name,
                score: cosineSimilarity(queryVector, docVec)
            };
        });

        // 取前 Top K 且得分超过 0.5 的块
        scoredChunks.sort((a, b) => b.score - a.score);
        const topChunks = scoredChunks.filter(c => c.score > 0.4).slice(0, topK);

        if (topChunks.length === 0) return '';

        let injectedContext = '\n\n【参考内部知识库信息如下】：\n';
        topChunks.forEach((c, idx) => {
            injectedContext += `[引用 ${idx + 1} | 来源: ${c.source}]: ${c.text}\n`;
        });
        injectedContext += '请基于上述参考信息回答我的问题，如果没有在参考信息中找到答案，请告知无法在知识库中查阅到该信息。\n';

        return injectedContext;
    } catch (e) {
        logger.error({ err: e.message }, 'RAG 检索异常');
        return '';
    }
}

module.exports = { ragRouter, retrieveContext };
