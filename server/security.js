/* 安全工具模块 Security Utilities */
const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const path = require('path');
const logger = require('./logger');

const encryptedPrefix = 'enc:v1:';
const uploadRoot = path.resolve(__dirname, '../uploads');

function getEncryptionKey() {
    const source = process.env.DATA_ENCRYPTION_KEY || process.env.JWT_SECRET;
    return crypto.createHash('sha256').update(source || '').digest();
}

function encryptSecret(value) {
    if (!value || String(value).startsWith(encryptedPrefix)) return value || '';
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', getEncryptionKey(), iv);
    const encrypted = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `${encryptedPrefix}${iv.toString('base64url')}.${tag.toString('base64url')}.${encrypted.toString('base64url')}`;
}

function decryptSecret(value) {
    if (!value || !String(value).startsWith(encryptedPrefix)) return value || '';
    try {
        const payload = String(value).slice(encryptedPrefix.length);
        const [ivText, tagText, encryptedText] = payload.split('.');
        const decipher = crypto.createDecipheriv('aes-256-gcm', getEncryptionKey(), Buffer.from(ivText, 'base64url'));
        decipher.setAuthTag(Buffer.from(tagText, 'base64url'));
        return Buffer.concat([
            decipher.update(Buffer.from(encryptedText, 'base64url')),
            decipher.final()
        ]).toString('utf8');
    } catch (e) {
        throw new Error('密钥解密失败，请检查 DATA_ENCRYPTION_KEY 或 JWT_SECRET 是否一致');
    }
}

function isPrivateHost(hostname) {
    const host = String(hostname || '').toLowerCase();
    if (['localhost', '127.0.0.1', '::1', '0.0.0.0'].includes(host)) return true;
    if (host.endsWith('.local') || host.endsWith('.internal')) return true;

    const ipType = net.isIP(host);
    if (ipType === 4) {
        const parts = host.split('.').map(Number);
        return parts[0] === 10 ||
            parts[0] === 127 ||
            (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
            (parts[0] === 192 && parts[1] === 168) ||
            (parts[0] === 169 && parts[1] === 254) ||
            parts[0] === 0;
    }
    if (ipType === 6) {
        return host === '::1' || host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80');
    }
    return false;
}

function hostAllowedByList(hostname) {
    const allowList = (process.env.MODEL_URL_ALLOWLIST || '').split(',').map(v => v.trim().toLowerCase()).filter(Boolean);
    if (allowList.length === 0) return true;
    const host = String(hostname || '').toLowerCase();
    return allowList.some(item => host === item || host.endsWith(`.${item}`));
}

function validateModelUrl(rawUrl, user) {
    let parsed;
    try {
        parsed = new URL(String(rawUrl || '').trim());
    } catch (e) {
        throw new Error('模型接口地址格式无效');
    }

    if (!['http:', 'https:'].includes(parsed.protocol)) {
        throw new Error('模型接口仅允许使用 HTTP 或 HTTPS');
    }
    if (parsed.username || parsed.password) {
        throw new Error('模型接口地址中不允许包含用户名或密码');
    }
    if (!hostAllowedByList(parsed.hostname)) {
        throw new Error('模型接口域名不在企业白名单内');
    }

    const allowPrivateForAdmin = process.env.ALLOW_PRIVATE_MODEL_URLS !== 'false' && user?.role === 'admin';
    if (isPrivateHost(parsed.hostname) && !allowPrivateForAdmin) {
        throw new Error('普通用户不允许配置内网或本机模型地址');
    }

    return parsed;
}

function escapeCsvCell(value) {
    let text = value === undefined || value === null ? '' : String(value);
    if (/^[=+\-@]/.test(text)) text = `'${text}`;
    return `"${text.replace(/"/g, '""')}"`;
}

function parseCsvLine(line) {
    const cells = [];
    let current = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
        const char = line[i];
        const next = line[i + 1];
        if (char === '"' && inQuotes && next === '"') {
            current += '"';
            i++;
        } else if (char === '"') {
            inQuotes = !inQuotes;
        } else if (char === ',' && !inQuotes) {
            cells.push(current.trim());
            current = '';
        } else {
            current += char;
        }
    }
    cells.push(current.trim());
    return cells;
}

function removeAttachmentFiles(attachments) {
    for (const attachment of attachments) {
        const filePath = attachment.file_path;
        if (!filePath) continue;
        const target = path.resolve(__dirname, '..', filePath);
        if (!target.startsWith(uploadRoot + path.sep)) continue;
        try {
            if (fs.existsSync(target)) fs.unlinkSync(target);
            let dir = path.dirname(target);
            while (dir.startsWith(uploadRoot + path.sep) && dir !== uploadRoot) {
                if (fs.existsSync(dir) && fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
                dir = path.dirname(dir);
            }
        } catch (e) {
            logger.warn({ filePath, err: e.message }, '附件清理：删除失败');
        }
    }
}

module.exports = {
    encryptSecret,
    decryptSecret,
    validateModelUrl,
    escapeCsvCell,
    parseCsvLine,
    removeAttachmentFiles
};
