/* 附件管理路由 Attachment Management Routes */
const crypto = require('crypto');
const express = require('express');
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const pdf = require('pdf-parse');
const { db } = require('../db');
const { asyncHandler } = require('../http');
const { removeAttachmentFiles } = require('../security');
const { getBeijingTimestamp } = require('../time');

function getSafeUploadPath(userId, sessionId, filename) {
    const uploadRoot = path.resolve(__dirname, '../../uploads');
    const safeUserId = String(userId).replace(/[^a-zA-Z0-9_-]/g, '');
    const safeSessionId = String(sessionId).replace(/[^a-zA-Z0-9_-]/g, '');
    const safeFilename = path.basename(filename);

    const target = path.resolve(uploadRoot, safeUserId, safeSessionId, safeFilename);
    if (!target.startsWith(uploadRoot + path.sep)) {
        throw new Error('非法访问路径');
    }
    return { uploadRoot, target };
}

function createAttachmentsRouter({
    authMiddleware,
    upload,
    normalizePage,
    normalizeLimit,
    logAction
}) {
    const router = express.Router();

    router.get('/uploads/:userId/:sessionId/:filename', authMiddleware, asyncHandler(async (req, res) => {
        const requestedUserId = parseInt(req.params.userId, 10);
        const { sessionId, filename } = req.params;

        if (req.user.role !== 'admin' && requestedUserId !== req.user.id) {
            return res.status(403).json({ error: '无权访问该附件' });
        }

        const expectedPath = `uploads/${requestedUserId}/${sessionId}/${filename}`;
        const attachment = db.prepare('SELECT id FROM attachments WHERE user_id = ? AND session_id = ? AND file_path = ?')
            .get(requestedUserId, sessionId, expectedPath);
        if (!attachment && req.user.role !== 'admin') {
            return res.status(403).json({ error: '附件归属校验失败' });
        }

        const { target } = getSafeUploadPath(req.params.userId, req.params.sessionId, req.params.filename);
        if (!fs.existsSync(target)) return res.status(404).json({ error: '附件文件不存在' });

        res.setHeader('Cache-Control', 'private, max-age=604800');
        res.sendFile(target);
    }));

    router.post('/api/upload', authMiddleware, upload.single('file'), asyncHandler(async (req, res) => {
        if (!req.file) return res.status(400).json({ error: '未选择文件' });

        const userId = req.user.id;
        const sessionId = req.query.sessionId || 'global';
        const originalName = Buffer.from(req.file.originalname, 'latin1').toString('utf8');
        const mimeType = req.file.mimetype;
        const targetDir = path.join('uploads', userId.toString(), sessionId);
        if (!fs.existsSync(targetDir)) {
            fs.mkdirSync(targetDir, { recursive: true });
        }

        const safeOriginalName = path.basename(originalName).replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').slice(0, 160);
        const finalFileName = Date.now() + '-' + crypto.randomUUID() + '-' + safeOriginalName;
        const finalPath = path.join(targetDir, finalFileName);
        const publicUrl = `/uploads/${userId}/${sessionId}/${finalFileName}`;
        const accessToken = crypto.randomBytes(24).toString('base64url');
        let extractedText = null;

        try {
            if (mimeType.startsWith('image/')) {
                await sharp(req.file.path)
                    .resize({ width: 1024, height: 1024, fit: 'inside', withoutEnlargement: true })
                    .jpeg({ quality: 80 })
                    .toFile(finalPath);
                fs.unlinkSync(req.file.path);
            } else {
                if (mimeType === 'application/pdf') {
                    const dataBuffer = fs.readFileSync(req.file.path);
                    const data = await pdf(dataBuffer);
                    extractedText = data.text;
                } else if (mimeType.startsWith('text/') || originalName.endsWith('.md')) {
                    extractedText = fs.readFileSync(req.file.path, 'utf8');
                }
                if (extractedText && extractedText.length > 200000) {
                    extractedText = extractedText.slice(0, 200000) + '\n\n[文档内容过长，已截断前 200000 字符]';
                }
                fs.renameSync(req.file.path, finalPath);
            }

            db.prepare(`
                INSERT INTO attachments (user_id, session_id, file_name, file_path, file_type, file_size, access_token, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            `).run(userId, sessionId, originalName, finalPath.replace(/\\/g, '/'), mimeType, req.file.size, accessToken, getBeijingTimestamp());

            logAction(req, '上传附件', `上传附件: ${originalName} (会话: ${sessionId})`);
            res.json({ url: publicUrl, name: originalName, extractedText });
        } catch (e) {
            if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
            if (fs.existsSync(finalPath)) fs.unlinkSync(finalPath);
            throw e; // 转发给全局错误处理器
        }
    }));

    router.get('/api/attachments', authMiddleware, asyncHandler(async (req, res) => {
        const page = normalizePage(req.query.page || 1);
        const limit = normalizeLimit(req.query.limit || 20);
        const keyword = String(req.query.keyword || '').trim();
        const offset = (page - 1) * limit;
        let where = 'WHERE a.user_id = ?';
        const params = [req.user.id];
        if (keyword) {
            where += ' AND a.file_name LIKE ?';
            params.push(`%${keyword}%`);
        }
        const data = db.prepare(`
            SELECT a.*, s.title AS session_title
            FROM attachments a
            LEFT JOIN sessions s ON s.id = a.session_id
            ${where}
            ORDER BY a.created_at DESC
            LIMIT ? OFFSET ?
        `).all(...params, limit, offset).map(item => ({
            ...item,
            url: '/' + String(item.file_path || '').replace(/\\/g, '/')
        }));
        const total = db.prepare(`SELECT COUNT(*) AS count FROM attachments a ${where}`).get(...params).count;
        res.json({ data, total, hasMore: offset + data.length < total });
    }));

    router.delete('/api/attachments/:id', authMiddleware, asyncHandler(async (req, res) => {
        const attachment = db.prepare('SELECT * FROM attachments WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
        if (!attachment) return res.status(404).json({ error: '附件不存在' });
        db.prepare('DELETE FROM attachments WHERE id = ? AND user_id = ?').run(req.params.id, req.user.id);
        removeAttachmentFiles([attachment]);
        logAction(req, '删除附件', `附件: ${attachment.file_name}`);
        res.json({ success: true });
    }));

    return router;
}

module.exports = { createAttachmentsRouter };
