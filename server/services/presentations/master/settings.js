'use strict';

const crypto = require('node:crypto');
const { encryptSecret, decryptSecret, hasSecretEncryptionKey, assertSafeMcpOutboundUrl } = require('../../../security');
const KEY = 'ppt_master_secret_config', PURPOSE = 'presentation.master_service_configuration';
const error = (message, code = 'PPT_MASTER_SETTINGS_INVALID', status = 400) => Object.assign(new Error(message), { code, status, statusCode: status, expose: true });
function normalizeEndpoint(value) {
    if (typeof value !== 'string' || value.length > 2048 || /[\u0000-\u0020]/.test(value)) throw error('请填写有效的PPT服务根地址。');
    if (!value) return '';
    let url;
    try { url = new URL(value); } catch (_) { throw error('请填写完整的HTTP/HTTPS服务地址。'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash || url.search || url.pathname !== '/') throw error('PPT服务只支持不含凭据、查询参数和额外路径的HTTP/HTTPS根地址。');
    return url.origin;
}
async function validatePptMasterSettings(patch, previous, { checkEndpoint = endpoint => assertSafeMcpOutboundUrl(endpoint, { role: 'admin', username: 'admin' }) } = {}) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch) || Object.keys(patch).some(key => !['revision', 'enabled', 'endpoint', 'token', 'clearToken'].includes(key))) throw error('PPT服务配置包含未支持的字段。');
    for (const key of ['enabled', 'clearToken']) if (patch[key] !== undefined && typeof patch[key] !== 'boolean') throw error('PPT服务开关必须为布尔值。');
    if (patch.token !== undefined && (typeof patch.token !== 'string' || patch.token.length > 256 || /[\u0000-\u0020]/.test(patch.token))) throw error('服务密钥格式无效。');
    if (patch.endpoint !== undefined && typeof patch.endpoint !== 'string') throw error('PPT服务地址必须是文本。');
    const next = { enabled: patch.enabled ?? previous.enabled, endpoint: normalizeEndpoint((patch.endpoint ?? previous.endpoint).trim()), token: previous.token };
    if (patch.clearToken && patch.token) throw error('不能同时清除原密钥和填写新密钥。');
    if (patch.clearToken) next.token = '';
    else if (patch.token) next.token = patch.token;
    else if (next.endpoint !== previous.endpoint && previous.token) throw error('更换PPT服务地址时，请填写新服务的密钥或明确清除原密钥，避免原密钥发往新地址。');
    if (next.token && !/^[A-Za-z0-9_-]{32,256}$/.test(next.token)) throw error('PPT服务密钥须为32至256位字母、数字、横杠或下划线。');
    if (next.enabled && (!next.endpoint || !next.token)) throw error('启用PPT服务前请填写服务地址和访问密钥。');
    if (next.endpoint) {
        try { await checkEndpoint(next.endpoint); } catch (_) { throw error('服务地址被出站安全策略拒绝，请检查内网地址或服务器允许范围。'); }
    }
    return next;
}
function createSettings({ readValue = async key => (await require('../../app-settings').getAppSettingRowAsync(key))?.value ?? null,
    replace = (...args) => require('../../../repositories/presentation-master-settings').replace(...args),
    readEnv = () => ({ enabled: Boolean(String(process.env.PIVOT_PPT_MASTER_SERVICE_URL || '').trim()), endpoint: String(process.env.PIVOT_PPT_MASTER_SERVICE_URL || '').trim().replace(/\/+$/, ''), token: String(process.env.PIVOT_PPT_MASTER_SERVICE_TOKEN || '').trim() }),
    encrypt = encryptSecret, decrypt = decryptSecret, canEncrypt = hasSecretEncryptionKey, validator = validatePptMasterSettings } = {}) {
    function decode(raw) {
        if (raw == null) return { ...readEnv(), source: 'environment', revision: 'environment' };
        try {
            const stored = JSON.parse(decrypt(raw, PURPOSE));
            if (stored.version !== 1 || typeof stored.revision !== 'string' || typeof stored.values?.enabled !== 'boolean' || typeof stored.values?.endpoint !== 'string' || typeof stored.values?.token !== 'string') throw new Error();
            return { ...stored.values, source: 'settings', revision: stored.revision };
        } catch (_) { throw error('保存的PPT服务配置无法解密，请联系管理员检查数据加密密钥。', 'PPT_MASTER_SETTINGS_UNREADABLE', 503); }
    }
    async function effectivePptMasterConfiguration() { return decode(await readValue(KEY)); }
    async function publicConfig({ administrator = false } = {}) {
        try {
            const { token, endpoint, ...safe } = await effectivePptMasterConfiguration();
            return { ...safe, endpoint: administrator ? endpoint : endpoint ? '********' : '', hasToken: Boolean(token), configured: Boolean(endpoint && token), canManage: administrator };
        } catch (_) { return { enabled: false, source: 'settings', revision: 'unreadable', endpoint: '', hasToken: false, configured: false, canManage: administrator, error: '保存的PPT服务配置无法读取，请检查服务器加密密钥。' }; }
    }
    async function prepare(patch) {
        const previous = await effectivePptMasterConfiguration();
        if (patch?.revision !== previous.revision) throw error('PPT服务配置已变化，请重新加载后再操作。', 'PPT_MASTER_SETTINGS_CONFLICT', 409);
        return { ...await validator(patch, previous), revision: previous.revision };
    }
    async function save(patch, { userId } = {}) {
        const raw = await readValue(KEY), previous = decode(raw);
        if (patch?.revision !== previous.revision) throw error('PPT服务配置已被其他操作更新，请重新加载。', 'PPT_MASTER_SETTINGS_CONFLICT', 409);
        const values = await validator(patch, previous);
        if (!canEncrypt()) throw error('服务器缺少数据加密密钥，不能安全保存PPT服务配置。', 'PPT_MASTER_SETTINGS_ENCRYPTION_REQUIRED', 409);
        if (previous.source === 'settings' && Object.keys(values).every(key => values[key] === previous[key])) return publicConfig({ administrator: true });
        const stored = encrypt(JSON.stringify({ version: 1, revision: crypto.randomUUID(), values }), PURPOSE);
        const result = await replace(KEY, raw, stored, userId);
        if (result.conflict) throw error('PPT服务配置已被其他操作更新，请重新加载。', 'PPT_MASTER_SETTINGS_CONFLICT', 409);
        if (result.busy) throw error('已有PPT任务正在执行或等待确认，请结束任务后再切换服务配置。', 'PPT_MASTER_SETTINGS_BUSY', 409);
        return publicConfig({ administrator: true });
    }
    return { effective: effectivePptMasterConfiguration, publicConfig, prepare, save };
}
const pptMasterSettings = createSettings();
module.exports = { pptMasterSettings, createSettings, validate: validatePptMasterSettings, normalizeEndpoint, error };
