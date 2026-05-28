/* Security Utilities */
const crypto = require('crypto');
const dns = require('dns').promises;
const fs = require('fs');
const net = require('net');
const path = require('path');
const { logger } = require('./logger');

const encryptedPrefix = 'enc:v1:';
const uploadRoot = path.resolve(__dirname, '../uploads');
const projectRoot = path.resolve(__dirname, '..');

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
        throw new Error('Secret decryption failed. Check DATA_ENCRYPTION_KEY or JWT_SECRET consistency.');
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

function isSensitiveOutboundHost(hostname) {
    const host = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
    if (['localhost', 'metadata.google.internal'].includes(host)) return true;

    const ipType = net.isIP(host);
    if (ipType === 4) {
        const parts = host.split('.').map(Number);
        return parts[0] === 0 ||
            parts[0] === 127 ||
            (parts[0] === 169 && parts[1] === 254);
    }
    if (ipType === 6) {
        return host === '::1' || host.startsWith('fe80');
    }
    return false;
}

async function assertSafeOutboundUrl(rawUrl, user) {
    const parsed = validateModelUrl(rawUrl, user);
    if (process.env.ALLOW_SENSITIVE_OUTBOUND_URLS === 'true') return parsed;

    if (isSensitiveOutboundHost(parsed.hostname)) {
        throw new Error('Outbound URL points to a sensitive local, link-local, or metadata target.');
    }

    if (net.isIP(parsed.hostname)) return parsed;

    let records = [];
    try {
        records = await dns.lookup(parsed.hostname, { all: true, verbatim: true });
    } catch (e) {
        return parsed;
    }

    if (records.some(record => isSensitiveOutboundHost(record.address))) {
        throw new Error('Outbound URL resolves to a sensitive local, link-local, or metadata target.');
    }
    return parsed;
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
        throw new Error('Model endpoint URL is invalid.');
    }

    if (!['http:', 'https:'].includes(parsed.protocol)) {
        throw new Error('Model endpoint URL must use HTTP or HTTPS.');
    }
    if (parsed.username || parsed.password) {
        throw new Error('Model endpoint URL must not include username or password.');
    }
    if (!hostAllowedByList(parsed.hostname)) {
        throw new Error('Model endpoint host is not in the allowlist.');
    }

    const allowPrivateForAdmin = process.env.ALLOW_PRIVATE_MODEL_URLS !== 'false' && user?.role === 'admin';
    if (isPrivateHost(parsed.hostname) && !allowPrivateForAdmin) {
        throw new Error('Non-admin users cannot configure private or local model endpoints.');
    }

    return parsed;
}

function validateMcpEndpointUrl(rawUrl) {
    let parsed;
    try {
        parsed = new URL(String(rawUrl || '').trim());
    } catch (e) {
        const err = new Error('MCP endpoint URL is invalid.');
        err.status = 400;
        throw err;
    }

    if (!['http:', 'https:'].includes(parsed.protocol)) {
        const err = new Error('MCP endpoint URL must use HTTP or HTTPS.');
        err.status = 400;
        throw err;
    }
    if (parsed.username || parsed.password) {
        const err = new Error('MCP endpoint URL must not include username or password.');
        err.status = 400;
        throw err;
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
    const results = [];
    for (const attachment of attachments) {
        const filePath = attachment.file_path;
        const result = {
            id: attachment.id,
            filePath,
            ok: true,
            removed: false,
            skipped: false,
            error: ''
        };
        results.push(result);

        if (!filePath) continue;
        const target = path.resolve(__dirname, '..', filePath);
        if (target === uploadRoot || !isPathInsideUploadRoot(target)) {
            result.skipped = true;
            logger.warn({ filePath }, 'Attachment cleanup skipped unsafe path');
            continue;
        }
        try {
            if (fs.existsSync(target)) {
                fs.unlinkSync(target);
                result.removed = true;
            }
            let dir = path.dirname(target);
            while (dir.startsWith(uploadRoot + path.sep) && dir !== uploadRoot) {
                if (fs.existsSync(dir) && fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
                dir = path.dirname(dir);
            }
        } catch (e) {
            result.ok = false;
            result.error = e.message;
            logger.warn({ filePath, err: e.message }, 'Attachment cleanup failed to remove file');
        }
    }
    return results;
}

function isPathInsideUploadRoot(targetPath) {
    const target = path.resolve(targetPath);
    return target === uploadRoot || target.startsWith(uploadRoot + path.sep);
}

function encodeUrlPathSegment(segment) {
    return encodeURIComponent(String(segment)).replace(/[!'()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

function encodeAttachmentUrl(filePath, token = '') {
    const normalizedPath = String(filePath || '').replace(/\\/g, '/').replace(/^\/+/, '');
    if (!normalizedPath.startsWith('uploads/') || normalizedPath.includes('\0')) return '';
    const parts = normalizedPath.split('/');
    if (parts.some(part => !part || part === '.' || part === '..')) return '';

    const encodedPath = '/' + parts.map(encodeUrlPathSegment).join('/');
    const cleanToken = String(token || '').trim();
    return cleanToken ? `${encodedPath}?token=${encodeURIComponent(cleanToken)}` : encodedPath;
}

function resolveUploadUrlPath(uploadUrl) {
    const cleanUrl = String(uploadUrl || '').split(/[?#]/)[0];
    let decodedUrl;
    try {
        decodedUrl = decodeURIComponent(cleanUrl);
    } catch (e) {
        return null;
    }
    if (!decodedUrl.startsWith('/uploads/') || decodedUrl.includes('\0')) return null;

    const relativePath = decodedUrl.slice('/uploads/'.length);
    if (!relativePath || relativePath.split(/[\\/]/).some(part => part === '..')) return null;

    const target = path.resolve(uploadRoot, relativePath);
    if (!isPathInsideUploadRoot(target)) return null;
    return target;
}

function toProjectRelativePath(targetPath) {
    const target = path.resolve(targetPath);
    if (!isPathInsideUploadRoot(target)) return '';
    return path.relative(projectRoot, target).replace(/\\/g, '/');
}

// 常见密钥字段名称（统一小写比较）
const SECRET_FIELD_NAMES = new Set([
    'api_key', 'apikey', 'api-key',
    'authorization', 'auth', 'token', 'access_token', 'refresh_token', 'id_token',
    'secret', 'client_secret', 'password', 'passwd', 'pwd',
    'cookie', 'session', 'set-cookie',
    'private_key', 'privatekey'
]);

const SECRET_VALUE_PATTERNS = [
    /sk-[a-zA-Z0-9_-]{16,}/g,
    /(Bearer\s+)[a-zA-Z0-9_\-\.]{16,}/gi,
    /enc:v1:[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+/g,
    /eyJ[a-zA-Z0-9_\-]{10,}\.[a-zA-Z0-9_\-]{10,}\.[a-zA-Z0-9_\-]{5,}/g
];

const SECRET_PLACEHOLDER = '[REDACTED]';

function maskSecretString(text) {
    let output = String(text || '');
    for (const pattern of SECRET_VALUE_PATTERNS) {
        output = output.replace(pattern, (match, prefix) => {
            if (prefix) return `${prefix}${SECRET_PLACEHOLDER}`;
            return SECRET_PLACEHOLDER;
        });
    }
    return output;
}

// 递归脱敏对象 / 数组中的密钥字段；不会修改原对象
function redactSecrets(value, depth = 0) {
    if (depth > 6) return value;
    if (value === null || value === undefined) return value;
    if (typeof value === 'string') return maskSecretString(value);
    if (typeof value !== 'object') return value;
    if (Array.isArray(value)) {
        return value.map(item => redactSecrets(item, depth + 1));
    }
    const result = {};
    for (const [key, val] of Object.entries(value)) {
        const lowered = String(key).toLowerCase();
        if (SECRET_FIELD_NAMES.has(lowered) || lowered.includes('secret') || lowered.includes('token') || lowered.endsWith('_key')) {
            result[key] = val ? SECRET_PLACEHOLDER : val;
        } else {
            result[key] = redactSecrets(val, depth + 1);
        }
    }
    return result;
}

module.exports = {
    encryptSecret,
    decryptSecret,
    validateModelUrl,
    validateMcpEndpointUrl,
    assertSafeOutboundUrl,
    isPrivateHost,
    isSensitiveOutboundHost,
    escapeCsvCell,
    parseCsvLine,
    removeAttachmentFiles,
    encodeAttachmentUrl,
    resolveUploadUrlPath,
    toProjectRelativePath,
    isPathInsideUploadRoot,
    redactSecrets,
    maskSecretString
};
