'use strict';

// 双向渠道只接收 webhook 内联二进制；拒绝把平台 URL 交给工具或模型抓取。
// 成功后复用现有附件表、访问令牌和会话 ACL，因此删除会话/附件会立即切断引用。
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execute } = require('../db/client');
const { getBeijingTimestamp } = require('../time');
const { normalizeUploadedOriginalName } = require('../upload');
const { normalizeUploadedImage } = require('../image-safety');
const { encodeAttachmentUrl, toProjectRelativePath } = require('../security');
const { clearDirSizeCache } = require('./dir-size-cache');

const MAX_INBOUND_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const ALLOWED_TYPES = new Map([
    ['image/jpeg', '.jpg'], ['image/png', '.png'], ['image/webp', '.webp'],
    ['application/pdf', '.pdf'], ['text/plain', '.txt'], ['text/csv', '.csv'],
    ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', '.docx'],
    ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '.xlsx']
]);
const projectRoot = path.resolve(__dirname, '../..');
const uploadRoot = process.env.PIVOT_UPLOAD_DIR || process.env.UPLOAD_DIR
    ? path.resolve(process.env.PIVOT_UPLOAD_DIR || process.env.UPLOAD_DIR)
    : path.join(projectRoot, 'uploads');

function safeAttachmentName(value, extension) {
    const base = path.basename(normalizeUploadedOriginalName(value || `渠道附件${extension}`)).replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').slice(0, 150) || `渠道附件${extension}`;
    return path.extname(base).toLowerCase() === extension ? base : `${base.replace(/\.[^.]+$/, '')}${extension}`;
}
function decodeBase64(value) {
    const raw = String(value || '').replace(/^data:[^;,]+;base64,/i, '').replace(/\s/g, '');
    if (!raw || !/^[A-Za-z0-9+/_-]+={0,2}$/.test(raw)) throw Object.assign(new Error('渠道附件必须为有效 base64 数据。'), { code: 'CHANNEL_INBOUND_ATTACHMENT_INVALID' });
    const data = Buffer.from(raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
    if (!data.length || data.length > MAX_INBOUND_ATTACHMENT_BYTES) throw Object.assign(new Error('渠道附件为空或超过 10MB 限制。'), { code: 'CHANNEL_INBOUND_ATTACHMENT_TOO_LARGE', status: 413 });
    return data;
}
function normalizeInboundAttachmentPayload(value) {
    const items = Array.isArray(value) ? value : [];
    if (items.length > 20) throw Object.assign(new Error('单条渠道消息最多包含 20 个附件。'), { code: 'CHANNEL_INBOUND_ATTACHMENT_COUNT' });
    return items.map(item => {
        if (item?.url && !item?.contentBase64 && !item?.content_base64 && !item?.data) throw Object.assign(new Error('渠道附件不接受外部 URL，请由适配器提供受控内联数据。'), { code: 'CHANNEL_INBOUND_ATTACHMENT_EXTERNAL_URL_REJECTED' });
        const contentType = String(item?.contentType || item?.content_type || item?.mimeType || item?.mime_type || '').toLowerCase().split(';')[0].trim();
        const extension = ALLOWED_TYPES.get(contentType);
        if (!extension) throw Object.assign(new Error('渠道附件类型不受支持。'), { code: 'CHANNEL_INBOUND_ATTACHMENT_TYPE_REJECTED' });
        const data = decodeBase64(item?.contentBase64 || item?.content_base64 || item?.data);
        return { name: safeAttachmentName(item?.name || item?.filename, extension), contentType, extension, data };
    });
}
async function persistInboundAttachments({ userId, sessionId, attachments = [] }) {
    const values = normalizeInboundAttachmentPayload(attachments);
    if (!values.length) return [];
    const targetDir = path.resolve(uploadRoot, String(userId), String(sessionId));
    if (!targetDir.startsWith(uploadRoot + path.sep)) throw new Error('渠道附件路径无效。');
    await fs.promises.mkdir(targetDir, { recursive: true });
    const now = getBeijingTimestamp();
    const expiresAt = getBeijingTimestamp(Date.now() + 7 * 24 * 60 * 60 * 1000);
    const stored = [];
    for (const item of values) {
        const tempName = `.channel-${crypto.randomUUID()}.upload`;
        const tempPath = path.join(targetDir, tempName);
        const outputName = `${Date.now()}-${crypto.randomUUID()}-${item.name}`;
        const outputPath = path.join(targetDir, outputName);
        try {
            await fs.promises.writeFile(tempPath, item.data, { flag: 'wx' });
            let fileName = outputName;
            let fileType = item.contentType;
            if (item.contentType.startsWith('image/')) {
                fileName = outputName.replace(/\.[^.]+$/, '.jpg');
                const imagePath = path.join(targetDir, fileName);
                await normalizeUploadedImage(tempPath, imagePath);
                await fs.promises.rm(tempPath, { force: true });
                fileType = 'image/jpeg';
            } else {
                await fs.promises.rename(tempPath, outputPath);
            }
            const finalPath = path.join(targetDir, fileName);
            const relativePath = toProjectRelativePath(finalPath);
            const token = crypto.randomBytes(24).toString('base64url');
            await execute('INSERT INTO attachments (user_id, session_id, file_name, file_path, file_type, file_size, access_token, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', [userId, sessionId, item.name, relativePath, fileType, item.data.length, token, expiresAt, now]);
            const url = encodeAttachmentUrl(relativePath, token);
            stored.push({ name: item.name, contentType: fileType, bytes: item.data.length, url, sha256: crypto.createHash('sha256').update(item.data).digest('hex') });
        } catch (error) {
            await fs.promises.rm(tempPath, { force: true }).catch(() => {});
            await fs.promises.rm(outputPath, { force: true }).catch(() => {});
            throw error;
        }
    }
    clearDirSizeCache();
    return stored;
}
function attachmentMessageReferences(items = []) {
    return items.map(item => item.contentType.startsWith('image/') ? `![${item.name}](${item.url})` : `[附件: ${item.name}](${item.url})`).join('\n');
}
module.exports = { attachmentMessageReferences, normalizeInboundAttachmentPayload, persistInboundAttachments };
