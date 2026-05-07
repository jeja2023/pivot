/* Knowledge base and RAG API facade */
const express = require('express');
const multer = require('multer');
const fs = require('fs');
const pdf = require('pdf-parse');
const { db } = require('./db');
const { authMiddleware } = require('./auth');
const { getBeijingTimestamp } = require('./time');
const { logger } = require('./logger');
const { clearRagCacheForUser } = require('./services/rag-cache');
const {
    retrieveContext,
    cosineSimilarity,
    chunkText,
    indexDocumentChunks
} = require('./services/rag-index');

const ragRouter = express.Router();
const upload = multer({
    dest: 'uploads/docs/',
    limits: { fileSize: 20 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        if (/\.(txt|md|pdf)$/i.test(file.originalname || '')) return cb(null, true);
        cb(new Error('仅支持 txt、md、pdf 文档'));
    }
});

async function readKnowledgeDocument(file) {
    if (file.originalname.endsWith('.pdf')) {
        const dataBuffer = fs.readFileSync(file.path);
        const data = await pdf(dataBuffer);
        return data.text;
    }
    return fs.readFileSync(file.path, 'utf8');
}

ragRouter.get('/docs', authMiddleware, (req, res) => {
    const docs = db.prepare('SELECT * FROM knowledge_docs WHERE user_id = ? ORDER BY created_at DESC').all(req.user.id);
    res.json(docs);
});

ragRouter.delete('/docs/:id', authMiddleware, (req, res) => {
    db.prepare('DELETE FROM knowledge_docs WHERE id = ? AND user_id = ?').run(req.params.id, req.user.id);
    clearRagCacheForUser(req.user.id);
    res.json({ success: true });
});

ragRouter.post('/upload', authMiddleware, upload.single('file'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: '请上传文件' });

    const fileInfo = db.prepare('INSERT INTO knowledge_docs (user_id, name, status, created_at) VALUES (?, ?, ?, ?)')
        .run(req.user.id, req.file.originalname, 'processing', getBeijingTimestamp());
    const docId = fileInfo.lastInsertRowid;
    clearRagCacheForUser(req.user.id);
    res.json({ success: true, docId, message: '后台处理中' });

    try {
        const text = await readKnowledgeDocument(req.file);
        await indexDocumentChunks(docId, text);
        db.prepare('UPDATE knowledge_docs SET status = ? WHERE id = ?').run('ready', docId);
        clearRagCacheForUser(req.user.id);
    } catch (e) {
        logger.error({ err: e.message, docId }, 'RAG 文档索引失败');
        db.prepare('UPDATE knowledge_docs SET status = ? WHERE id = ?').run('error', docId);
    } finally {
        if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
    }
});

module.exports = {
    ragRouter,
    retrieveContext,
    cosineSimilarity,
    chunkText,
    clearRagCacheForUser
};
