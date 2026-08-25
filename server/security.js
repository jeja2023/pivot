/* Security Utilities */
const crypto = require('crypto');
const dns = require('dns');
const fs = require('fs');
const http = require('http');
const https = require('https');
const net = require('net');
const path = require('path');
const { logger } = require('./logger');
const { isAdmin } = require('./permissions');
const { clearDirSizeCache } = require('./services/dir-size-cache');
const dnsPromises = dns.promises;

const projectRoot = path.resolve(__dirname, '..');
const encryptedPrefix = 'enc:v1:';
const uploadRoot = process.env.PIVOT_UPLOAD_DIR || process.env.UPLOAD_DIR
    ? path.resolve(process.env.PIVOT_UPLOAD_DIR || process.env.UPLOAD_DIR)
    : path.join(projectRoot, 'uploads');

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
        throw new Error('密钥解密失败，请检查 DATA_ENCRYPTION_KEY 或 JWT_SECRET 是否一致。');
    }
}

function mappedIpv4Address(hostname) {
    const host = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
    const compactMatch = host.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
    if (compactMatch && net.isIP(compactMatch[1]) === 4) return compactMatch[1];

    const hexMatch = host.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (hexMatch) {
        const high = parseInt(hexMatch[1], 16);
        const low = parseInt(hexMatch[2], 16);
        return [high >>> 8, high & 0xff, low >>> 8, low & 0xff].join('.');
    }

    const fullMatch = host.match(/^(?:0{1,4}:){5}ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (fullMatch) {
        const high = parseInt(fullMatch[1], 16);
        const low = parseInt(fullMatch[2], 16);
        return [high >>> 8, high & 0xff, low >>> 8, low & 0xff].join('.');
    }
    return '';
}

function normalizeHostForPolicy(hostname) {
    const host = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
    return mappedIpv4Address(host) || host;
}

function isPrivateHost(hostname) {
    const host = normalizeHostForPolicy(hostname);
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
    const host = normalizeHostForPolicy(hostname);
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

function isLoopbackHost(hostname) {
    const host = normalizeHostForPolicy(hostname);
    if (host === 'localhost' || host === '::1') return true;
    if (net.isIP(host) === 4) {
        const parts = host.split('.').map(Number);
        return parts[0] === 127;
    }
    return false;
}

// 校验主机名（含 DNS 解析后的 IP）不指向 loopback / link-local / 云元数据等敏感目标。
// 不拦截普通局域网（RFC1918）地址，便于本机/内网模型与 MCP 服务接入。
function buildUnsafeOutboundError() {
    return new Error('出站 URL 指向敏感的本地、链路本地或云元数据地址。');
}

function assertSafeResolvedAddress(hostname, address, options = {}) {
    const blockPrivate = options.blockPrivate === true;
    const allowExplicitLoopback = options.allowExplicitLoopback === true &&
        isLoopbackHost(hostname) &&
        isLoopbackHost(address);

    if (
        (isSensitiveOutboundHost(address) && !allowExplicitLoopback) ||
        (blockPrivate && isPrivateHost(address) && !allowExplicitLoopback)
    ) {
        throw buildUnsafeOutboundError();
    }
}

function createSafeLookup(options = {}) {
    // 每个 Agent 使用独立的 pin 缓存：首次连接解析并校验通过后，后续 socket
    // 复用同一组地址，不再重新查询 DNS，从而消除校验与 TCP 连接之间的 rebinding 窗口。
    const pinnedAddresses = new Map();
    return (hostname, lookupOptions, callback) => {
        let cb = callback;
        let opts = lookupOptions;
        if (typeof lookupOptions === 'function') {
            cb = lookupOptions;
            opts = {};
        }

        const safeOptions = opts || {};
        const cacheKey = normalizeHostForPolicy(hostname);
        const family = Number(safeOptions.family) || 0;
        const fromCache = pinnedAddresses.get(cacheKey);
        const returnPinned = addresses => {
            const compatible = family
                ? addresses.filter(item => Number(item.family) === family)
                : addresses;
            if (!compatible.length) {
                const error = new Error(`无法为 ${hostname} 找到匹配 IPv${family} 的已固定地址。`);
                error.code = 'ENOTFOUND';
                return cb(error);
            }
            if (safeOptions.all) return cb(null, compatible.map(item => ({ ...item })));
            const selected = compatible[0];
            return cb(null, selected.address, selected.family);
        };
        if (fromCache?.length) return returnPinned(fromCache);

        dns.lookup(hostname, { ...safeOptions, all: true, verbatim: true }, (err, records) => {
            if (err) return cb(err);
            try {
                const addresses = (Array.isArray(records) ? records : [{ address: records, family: family || net.isIP(records) }])
                    .filter(item => item && item.address)
                    .map(item => ({ address: item.address, family: Number(item.family) || net.isIP(item.address) }));
                addresses.forEach(item => assertSafeResolvedAddress(hostname, item.address, options));
                if (!addresses.length) {
                    const error = new Error(`主机 ${hostname} 没有可用解析地址。`);
                    error.code = 'ENOTFOUND';
                    return cb(error);
                }
                pinnedAddresses.set(cacheKey, addresses);
                return returnPinned(addresses);
            } catch (safeErr) {
                return cb(safeErr);
            }
        });
    };
}

function deriveEncryptionKey(source) {
    return crypto.createHash('sha256').update(String(source || '')).digest();
}

function encryptSecretWithKey(value, source) {
    if (!value || String(value).startsWith(encryptedPrefix)) return value || '';
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', deriveEncryptionKey(source), iv);
    const encrypted = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `${encryptedPrefix}${iv.toString('base64url')}.${tag.toString('base64url')}.${encrypted.toString('base64url')}`;
}

function decryptSecretWithKey(value, source) {
    if (!value || !String(value).startsWith(encryptedPrefix)) return value || '';
    const payload = String(value).slice(encryptedPrefix.length);
    const [ivText, tagText, encryptedText] = payload.split('.');
    const decipher = crypto.createDecipheriv('aes-256-gcm', deriveEncryptionKey(source), Buffer.from(ivText, 'base64url'));
    decipher.setAuthTag(Buffer.from(tagText, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(encryptedText, 'base64url')), decipher.final()]).toString('utf8');
}

function createSafeHttpAgents(options = {}) {
    const lookup = createSafeLookup(options);
    return {
        httpAgent: new http.Agent({ keepAlive: true, lookup }),
        httpsAgent: new https.Agent({ keepAlive: true, lookup })
    };
}

async function assertSafeOutboundHost(hostname, options = {}) {
    if (process.env.ALLOW_SENSITIVE_OUTBOUND_URLS === 'true') return;
    const blockPrivate = options.blockPrivate === true;
    const allowExplicitLoopback = options.allowExplicitLoopback === true && isLoopbackHost(hostname);

    if (
        (isSensitiveOutboundHost(hostname) && !allowExplicitLoopback) ||
        (blockPrivate && isPrivateHost(hostname) && !allowExplicitLoopback)
    ) {
        throw buildUnsafeOutboundError();
    }

    if (net.isIP(hostname)) return;

    let records = [];
    try {
        records = await dnsPromises.lookup(hostname, { all: true, verbatim: true });
    } catch (e) {
        return;
    }

    try {
        records.forEach(record => assertSafeResolvedAddress(hostname, record.address, {
            blockPrivate,
            allowExplicitLoopback
        }));
    } catch (e) {
        throw new Error('出站 URL 解析到敏感的本地、链路本地或云元数据地址。');
    }
}

function getSafeOutboundOptionsForUser(user, {
    allowPrivateEnv = 'ALLOW_PRIVATE_MODEL_URLS',
    allowExplicitLoopbackForAdmin = false
} = {}) {
    const allowPrivateForAdmin = process.env[allowPrivateEnv] !== 'false' && isAdmin(user);
    return {
        blockPrivate: !allowPrivateForAdmin,
        allowExplicitLoopback: allowExplicitLoopbackForAdmin && allowPrivateForAdmin
    };
}

function createSafeHttpAgentsForUser(user, options = {}) {
    return createSafeHttpAgents(getSafeOutboundOptionsForUser(user, options));
}

async function assertSafeOutboundUrl(rawUrl, user) {
    const parsed = validateModelUrl(rawUrl, user);
    const allowPrivateForAdmin = process.env.ALLOW_PRIVATE_MODEL_URLS !== 'false' && isAdmin(user);
    await assertSafeOutboundHost(parsed.hostname, { blockPrivate: !allowPrivateForAdmin });
    return parsed;
}

// MCP / IM webhook 出站守卫：复用协议与凭据校验，并在调用时（含 DNS 解析）拦截
// 敏感目标，关闭 DNS rebinding 与云元数据 SSRF；普通用户不能访问内网目标。
async function assertSafeMcpOutboundUrl(rawUrl, user = null) {
    const parsed = validateMcpEndpointUrl(rawUrl);
    const allowPrivateForAdmin = process.env.ALLOW_PRIVATE_MCP_URLS !== 'false' && isAdmin(user);
    const allowExplicitLoopback = allowPrivateForAdmin && isLoopbackHost(parsed.hostname);
    if (isPrivateHost(parsed.hostname) && !allowPrivateForAdmin) {
        throw new Error('非管理员用户不可配置私有或本地 MCP 服务端点。');
    }
    await assertSafeOutboundHost(parsed.hostname, {
        blockPrivate: !allowPrivateForAdmin,
        allowExplicitLoopback
    });
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
        throw new Error('模型端点 URL 地址格式非法。');
    }

    if (!['http:', 'https:'].includes(parsed.protocol)) {
        throw new Error('模型端点 URL 必须使用 HTTP 或 HTTPS 协议。');
    }
    if (parsed.username || parsed.password) {
        throw new Error('模型端点 URL 不得包含用户名或密码凭据。');
    }
    if (!hostAllowedByList(parsed.hostname)) {
        throw new Error('模型端点主机未在允许白名单中。');
    }

    const allowPrivateForAdmin = process.env.ALLOW_PRIVATE_MODEL_URLS !== 'false' && isAdmin(user);
    if (isPrivateHost(parsed.hostname) && !allowPrivateForAdmin) {
        throw new Error('非管理员用户不可配置私有或本地模型端点。');
    }

    return parsed;
}

function validateMcpEndpointUrl(rawUrl) {
    let parsed;
    try {
        parsed = new URL(String(rawUrl || '').trim());
    } catch (e) {
        const err = new Error('MCP 服务端点 URL 格式非法。');
        err.status = 400;
        throw err;
    }

    if (!['http:', 'https:'].includes(parsed.protocol)) {
        const err = new Error('MCP 服务端点 URL 必须使用 HTTP 或 HTTPS 协议。');
        err.status = 400;
        throw err;
    }
    if (parsed.username || parsed.password) {
        const err = new Error('MCP 服务端点 URL 不得包含用户名或密码凭据。');
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
    let changed = false;
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
        const relativePath = String(filePath || '').replace(/\\/g, '/').replace(/^\/+/, '');
        const target = relativePath.startsWith('uploads/')
            ? path.resolve(uploadRoot, relativePath.slice('uploads/'.length))
            : path.resolve(projectRoot, relativePath);
        if (target === uploadRoot || !isPathInsideUploadRoot(target)) {
            result.skipped = true;
            logger.warn({ filePath }, '附件清理已跳过不安全路径');
            continue;
        }
        try {
            if (fs.existsSync(target)) {
                fs.rmSync(target, { force: true, maxRetries: 5, retryDelay: 80 });
                result.removed = true;
                changed = true;
            }
            let dir = path.dirname(target);
            while (dir.startsWith(uploadRoot + path.sep) && dir !== uploadRoot) {
                if (fs.existsSync(dir) && fs.readdirSync(dir).length === 0) {
                    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 });
                    changed = true;
                }
                dir = path.dirname(dir);
            }
        } catch (e) {
            result.ok = false;
            result.error = e.message;
            logger.warn({ filePath, err: e.message }, '附件清理删除文件失败');
        }
    }
    if (changed) clearDirSizeCache();
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
    const uploadRelative = path.relative(uploadRoot, target).replace(/\\/g, '/');
    return uploadRelative ? `uploads/${uploadRelative}` : 'uploads';
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
    encryptSecretWithKey,
    decryptSecret,
    decryptSecretWithKey,
    validateModelUrl,
    validateMcpEndpointUrl,
    assertSafeOutboundUrl,
    assertSafeMcpOutboundUrl,
    assertSafeOutboundHost,
    createSafeHttpAgents,
    createSafeHttpAgentsForUser,
    createSafeLookup,
    getSafeOutboundOptionsForUser,
    normalizeHostForPolicy,
    isPrivateHost,
    isLoopbackHost,
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
