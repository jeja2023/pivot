'use strict';

const crypto = require('crypto');
const path = require('path');
const jwt = require('jsonwebtoken');

const SUPPORTED_ATTACHMENT_EXTENSIONS = {
    docx: { documentType: 'word', fileType: 'docx' },
    doc: { documentType: 'word', fileType: 'doc' },
    xlsx: { documentType: 'cell', fileType: 'xlsx' },
    xls: { documentType: 'cell', fileType: 'xls' },
    csv: { documentType: 'cell', fileType: 'csv' },
    pptx: { documentType: 'slide', fileType: 'pptx' },
    ppt: { documentType: 'slide', fileType: 'ppt' }
};

function getAttachmentDocumentType(filename = '') {
    const ext = path.extname(filename || '').toLowerCase().replace(/^\./, '');
    return SUPPORTED_ATTACHMENT_EXTENSIONS[ext] || null;
}

function configuration(env = process.env) {
    const prefix = String(env.PIVOT_ONLYOFFICE_PATH || '').trim();
    if (!prefix) return null;
    if (!/^\/[a-zA-Z0-9_-]+$/.test(prefix)) throw new Error('ONLYOFFICE 代理路径必须是单级同源路径，例如 /onlyoffice。');
    const secret = String(env.PIVOT_ONLYOFFICE_JWT_SECRET || '');
    if (secret.length < 32) throw new Error('ONLYOFFICE JWT 密钥至少需要 32 个字符。');
    let base;
    try { base = new URL(env.PIVOT_ONLYOFFICE_PIVOT_URL); } catch (_) { throw new Error('请配置 ONLYOFFICE 访问 Pivot 的内部地址。'); }
    if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.pathname !== '/' || base.search || base.hash) throw new Error('ONLYOFFICE 的 Pivot 内部地址必须为 HTTP 来源地址。');
    return { prefix, secret, base: base.origin };
}

function ticketKey(secret) {
    return crypto.createHmac('sha256', secret).update('pivot-onlyoffice-read-ticket-v1').digest();
}

function createPreviewConfig(rendition, user, options = {}) {
    const config = options.config || configuration();
    if (!config) return null;
    if (rendition.format !== 'docx' || rendition.status !== 'ready') throw new Error('当前文件不支持 ONLYOFFICE 文档预览。');
    const ticket = jwt.sign({ purpose: 'onlyoffice-read', userId: user.id, renditionId: rendition.id, tokenVersion: Number(user.token_version || 0) }, ticketKey(config.secret), { algorithm: 'HS256', expiresIn: 300, audience: 'pivot-onlyoffice' });
    // 每次会话使用不同 key，避免服务端复用旧的授权文件缓存。
    const key = crypto.randomBytes(24).toString('hex');
    const editor = { documentType: 'word', document: { fileType: 'docx', key, title: '文档预览.docx',
        url: `${config.base}/api/agents/onlyoffice/file?token=${encodeURIComponent(ticket)}`,
        permissions: { edit: false, download: false, print: false, copy: false, review: false } },
    editorConfig: { mode: 'view', lang: 'zh-CN', user: { id: String(user.id) }, customization: { autosave: false, forcesave: false } },
    height: '100%', width: '100%', type: 'desktop' };
    editor.token = jwt.sign(editor, config.secret, { algorithm: 'HS256' });
    return { scriptUrl: `${config.prefix}/web-apps/apps/api/documents/api.js`, editor };
}

function verifyReadTicket(ticket, options = {}) {
    const config = options.config || configuration();
    if (!config) throw new Error('ONLYOFFICE 未配置。');
    const claims = jwt.verify(String(ticket || ''), ticketKey(config.secret), { algorithms: ['HS256'], audience: 'pivot-onlyoffice' });
    if (claims.purpose !== 'onlyoffice-read' || !Number.isSafeInteger(Number(claims.userId)) || !Number.isSafeInteger(Number(claims.renditionId))) throw new Error('预览凭据无效。');
    return claims;
}

function createAttachmentPreviewConfig(attachment, user, options = {}) {
    const config = options.config || configuration();
    if (!config) return null;
    const docMeta = getAttachmentDocumentType(attachment.file_name || attachment.file_path);
    if (!docMeta) throw new Error('当前附件格式不支持 ONLYOFFICE 在线预览。');
    const ticket = jwt.sign(
        { purpose: 'onlyoffice-attachment-read', userId: user.id, attachmentId: Number(attachment.id), tokenVersion: Number(user.token_version || 0) },
        ticketKey(config.secret),
        { algorithm: 'HS256', expiresIn: 300, audience: 'pivot-onlyoffice' }
    );
    const key = crypto.randomBytes(24).toString('hex');
    const title = path.basename(attachment.file_name || '附件预览.' + docMeta.fileType);
    const editor = {
        documentType: docMeta.documentType,
        document: {
            fileType: docMeta.fileType,
            key,
            title,
            url: `${config.base}/api/attachments/onlyoffice/file?token=${encodeURIComponent(ticket)}`,
            permissions: { edit: false, download: false, print: false, copy: true, review: false }
        },
        editorConfig: {
            mode: 'view',
            lang: 'zh-CN',
            user: { id: String(user.id) },
            customization: { autosave: false, forcesave: false }
        },
        height: '100%',
        width: '100%',
        type: 'desktop'
    };
    editor.token = jwt.sign(editor, config.secret, { algorithm: 'HS256' });
    return { scriptUrl: `${config.prefix}/web-apps/apps/api/documents/api.js`, editor };
}

function verifyAttachmentReadTicket(ticket, options = {}) {
    const config = options.config || configuration();
    if (!config) throw new Error('ONLYOFFICE 未配置。');
    const claims = jwt.verify(String(ticket || ''), ticketKey(config.secret), { algorithms: ['HS256'], audience: 'pivot-onlyoffice' });
    if (claims.purpose !== 'onlyoffice-attachment-read' || !Number.isSafeInteger(Number(claims.userId)) || !Number.isSafeInteger(Number(claims.attachmentId))) {
        throw new Error('附件预览凭据无效。');
    }
    return claims;
}

module.exports = {
    configuration,
    createPreviewConfig,
    verifyReadTicket,
    createAttachmentPreviewConfig,
    verifyAttachmentReadTicket,
    getAttachmentDocumentType,
    SUPPORTED_ATTACHMENT_EXTENSIONS
};
