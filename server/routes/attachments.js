/* 附件管理路由 Attachment Management Routes */
const crypto = require('crypto');
const express = require('express');
const fs = require('fs');
const path = require('path');
const { db } = require('../db');
const { asyncHandler } = require('../http');
const { getBeijingTimestamp } = require('../time');
const { extractDocumentText, isPasswordError, renderPdfPages, truncateExtractedText } = require('../document-text');
const { isLikelyImageMime, normalizeUploadedImage } = require('../image-safety');
const { logger } = require('../logger');

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
    uploadLimiter,
    upload,
    normalizePage,
    normalizeLimit,
    logAction
}) {
    const router = express.Router();
    const isSuperAdmin = (user) => user?.username === 'admin';

    router.get('/uploads/:userId/:sessionId/:filename', (req, res, next) => {
        const token = req.query.token;
        if (token) {
            // 尝试通过 URL 中的 token 参数验证 (且校验过期时间)
            const requestedUserId = parseInt(req.params.userId, 10);
            const expectedPath = `uploads/${requestedUserId}/${req.params.sessionId}/${req.params.filename}`;
            const attachment = db.prepare(`
                SELECT user_id FROM attachments
                WHERE access_token = ?
                  AND user_id = ?
                  AND session_id = ?
                  AND file_path = ?
                  AND deleted_at IS NULL
                  AND (expires_at IS NULL OR expires_at > ?)
            `).get(token, requestedUserId, req.params.sessionId, expectedPath, getBeijingTimestamp());
            if (attachment) {
                const user = db.prepare('SELECT * FROM users WHERE id = ?').get(attachment.user_id);
                if (user && user.status !== 'disabled') {
                    req.user = user; // 临时赋予权限
                    return next();
                }
            }
        }

        // 如果没有 token 或 token 验证失败，尝试通过 Cookie/Header 验证 (例如管理员访问)
        authMiddleware(req, res, next);
    }, asyncHandler(async (req, res) => {
        const requestedUserId = parseInt(req.params.userId, 10);
        const { sessionId, filename } = req.params;

        if (!isSuperAdmin(req.user) && requestedUserId !== req.user.id) {
            return res.status(403).json({ error: '无权访问该附件' });
        }

        const expectedPath = `uploads/${requestedUserId}/${sessionId}/${filename}`;
        const attachment = db.prepare('SELECT id, deleted_at FROM attachments WHERE user_id = ? AND session_id = ? AND file_path = ?')
            .get(requestedUserId, sessionId, expectedPath);
        if (!attachment || (attachment.deleted_at && !isSuperAdmin(req.user))) {
            return res.status(403).json({ error: '附件归属校验失败' });
        }

        const { target } = getSafeUploadPath(req.params.userId, req.params.sessionId, req.params.filename);
        if (!fs.existsSync(target)) return res.status(404).json({ error: '附件文件不存在' });

        res.setHeader('Cache-Control', 'private, max-age=604800');
        res.sendFile(target);
    }));

    router.post('/api/upload', authMiddleware, uploadLimiter, upload.single('file'), asyncHandler(async (req, res) => {
        if (!req.file) return res.status(400).json({ error: '未选择文件' });

        const userId = req.user.id;
        const sessionId = req.query.sessionId || 'global';
        const originalName = Buffer.from(req.file.originalname, 'latin1').toString('utf8');
        const mimeType = req.file.mimetype;
        const password = String(req.body?.password || '').trim() || undefined;
        const targetDir = path.join('uploads', userId.toString(), sessionId);
        if (!fs.existsSync(targetDir)) {
            fs.mkdirSync(targetDir, { recursive: true });
        }

        const safeOriginalName = path.basename(originalName).replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').slice(0, 160);
        const imageOutput = isLikelyImageMime(mimeType);
        const outputOriginalName = imageOutput
            ? safeOriginalName.replace(/\.[^.]*$/, '') + '.jpg'
            : safeOriginalName;
        const finalFileName = Date.now() + '-' + crypto.randomUUID() + '-' + outputOriginalName;
        const finalPath = path.join(targetDir, finalFileName);
        const publicUrl = `/uploads/${userId}/${sessionId}/${finalFileName}`;
        const accessToken = crypto.randomBytes(24).toString('base64url');
        let extractedText = null;
        const visionAttachments = [];

        try {
            if (imageOutput) {
                await normalizeUploadedImage(req.file.path, finalPath);
                fs.unlinkSync(req.file.path);
            } else {
                try {
                    extractedText = truncateExtractedText(await extractDocumentText(req.file.path, mimeType, originalName, { password }));
                } catch (readErr) {
                    logger.error({ err: readErr.message, path: req.file.path, originalName }, 'Read attachment text failed');
                    if (isPasswordError(readErr) || readErr.code === 'PASSWORD_UNSUPPORTED') {
                        if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
                        return res.status(422).json({
                            error: password ? '文档密码不正确或当前格式不支持密码解密' : '该文档已加密，请输入密码后重试',
                            code: 'DOCUMENT_PASSWORD_REQUIRED',
                            passwordRequired: true
                        });
                    }
                    if (path.extname(originalName).toLowerCase() === '.pdf') {
                        throw new Error(`PDF text extraction failed: ${readErr.message}`);
                    }
                    extractedText = '';
                }
                fs.renameSync(req.file.path, finalPath);

                if (path.extname(originalName).toLowerCase() === '.pdf' && !String(extractedText || '').trim()) {
                    try {
                        const pages = await renderPdfPages(finalPath, { password, maxPages: 1, desiredWidth: 1400 });
                        for (const page of pages) {
                            const pageToken = crypto.randomBytes(24).toString('base64url');
                            const pageFileName = `${Date.now()}-${crypto.randomUUID()}-${path.basename(safeOriginalName, path.extname(safeOriginalName))}-page-${page.page}.png`;
                            const pagePath = path.join(targetDir, pageFileName);
                            fs.writeFileSync(pagePath, page.data);
                            const pageUrl = `/uploads/${userId}/${sessionId}/${pageFileName}?token=${pageToken}`;
                            db.prepare(`
                                INSERT INTO attachments (user_id, session_id, file_name, file_path, file_type, file_size, access_token, expires_at, created_at)
                                VALUES (?, ?, ?, ?, ?, ?, ?, datetime(?, '+7 days'), ?)
                            `).run(userId, sessionId, `${originalName} 第 ${page.page} 页`, pagePath.replace(/\\/g, '/'), page.mimeType, page.data.length, pageToken, getBeijingTimestamp(), getBeijingTimestamp());
                            visionAttachments.push({
                                name: `${originalName} 第 ${page.page} 页`,
                                url: pageUrl,
                                markdown: `![${originalName} 第 ${page.page} 页](${pageUrl})`
                            });
                        }
                    } catch (ocrErr) {
                        logger.error({ err: ocrErr.message, originalName }, 'Render scanned PDF pages failed');
                    }
                }
            }

            db.prepare(`
                INSERT INTO attachments (user_id, session_id, file_name, file_path, file_type, file_size, access_token, expires_at, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, datetime(?, '+7 days'), ?)
            `).run(userId, sessionId, originalName, finalPath.replace(/\\/g, '/'), imageOutput ? 'image/jpeg' : mimeType, req.file.size, accessToken, getBeijingTimestamp(), getBeijingTimestamp());

            logAction(req, '上传附件', `上传附件: ${originalName} (会话: ${sessionId})`);
            res.json({ url: `${publicUrl}?token=${accessToken}`, name: originalName, extractedText, visionAttachments });
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
        const ownerId = parseInt(req.query.userId, 10);
        const includeDeleted = req.query.includeDeleted === 'true' && isSuperAdmin(req.user);
        let where = '';
        const params = [];
        if (isSuperAdmin(req.user) && ownerId) {
            where = 'WHERE a.user_id = ?';
            params.push(ownerId);
        } else if (!isSuperAdmin(req.user)) {
            where = 'WHERE a.user_id = ?';
            params.push(req.user.id);
        } else {
            where = 'WHERE 1 = 1';
        }
        if (!includeDeleted) {
            where += ' AND a.deleted_at IS NULL';
        }
        if (keyword) {
            where += ' AND a.file_name LIKE ?';
            params.push(`%${keyword}%`);
        }
        const data = db.prepare(`
            SELECT a.*, s.title AS session_title, u.username, u.nickname
            FROM attachments a
            LEFT JOIN sessions s ON s.id = a.session_id
            LEFT JOIN users u ON u.id = a.user_id
            ${where}
            ORDER BY a.created_at DESC
            LIMIT ? OFFSET ?
        `).all(...params, limit, offset).map(item => ({
            ...item,
            url: item.file_path
                ? '/' + String(item.file_path).replace(/\\/g, '/') + (item.access_token ? '?token=' + item.access_token : '')
                : ''
        }));
        const total = db.prepare(`SELECT COUNT(*) AS count FROM attachments a ${where}`).get(...params).count;
        res.json({ data, total, hasMore: offset + data.length < total, isSuperAdmin: isSuperAdmin(req.user) });
    }));

    router.delete('/api/attachments/:id', authMiddleware, asyncHandler(async (req, res) => {
        const attachment = db.prepare('SELECT * FROM attachments WHERE id = ? AND user_id = ? AND deleted_at IS NULL').get(req.params.id, req.user.id);
        if (!attachment) return res.status(404).json({ error: '附件不存在' });
        db.prepare('UPDATE attachments SET deleted_at = ?, deleted_by_user = 1 WHERE id = ? AND user_id = ?').run(getBeijingTimestamp(), req.params.id, req.user.id);
        logAction(req, '删除附件', `附件: ${attachment.file_name}`);
        res.json({ success: true });
    }));

    return router;
}

module.exports = { createAttachmentsRouter };
