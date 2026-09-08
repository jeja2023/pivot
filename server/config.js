/* 系统配置校验模块 System Config Validation */
const crypto = require('crypto');
const { logger } = require('./logger');
const { getPasswordValidationMessage } = require('./password-policy');

const weakSecrets = new Set([
    'lite-chat-secret-key-123',
    'change-me',
    'change-me-generate-with-openssl-rand-hex-32',
    'please-replace-with-a-random-64-character-secret-before-starting',
    'your_random_jwt_secret_key_at_least_32_chars',
    'your_random_secret_key_for_encryption',
    'your-32-chars-ultra-secure-jwt-secret-key-2026',
    'your-32-chars-ultra-secure-data-encryption-key-2026'
]);

const parsePort = (value) => {
    const port = parseInt(value || '3000', 10);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error('PORT 必须是 1-65535 之间的整数');
    }
    return port;
};

const parseNonNegativeInteger = (name, value, fallback) => {
    const parsed = parseInt(value || String(fallback), 10);
    if (!Number.isInteger(parsed) || parsed < 0) {
        throw new Error(`${name} 必须是 0 或正整数`);
    }
    return parsed;
};

function validateSecret(name, value, { required = true } = {}) {
    if (!value) {
        if (required) throw new Error(`${name} 未配置`);
        return;
    }
    if (value.length < 32 || weakSecrets.has(value) || value.includes('please-replace')) {
        throw new Error(`${name} 必须是 32 位以上的高强度随机字符串`);
    }
}

function validateDatabaseUrl(value, { enforce = process.env.NODE_ENV === 'production' && !process.env.PG_TEST_SCHEMA } = {}) {
    const text = String(value || '').trim();
    if (!text) return 'DATABASE_URL 未配置';
    let parsed;
    try {
        parsed = new URL(text);
    } catch (_) {
        return 'DATABASE_URL 格式无效，请使用 PostgreSQL 连接 URL（用户名、密码、主机和数据库名均不可缺失）';
    }
    if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) return 'DATABASE_URL 必须使用 postgres 或 postgresql 协议';
    // PostgreSQL 密码策略由数据库、网络边界和运维流程负责；应用只校验
    // 连接串格式，不因既有账户密码复杂度阻断启动，避免升级后无法启动旧环境。
    void enforce;
    return '';
}

function validateConfig() {
    const configurationErrors = [];
    try { validateSecret('JWT_SECRET', process.env.JWT_SECRET); } catch (error) { configurationErrors.push(error.message); }
    try { validateSecret('DATA_ENCRYPTION_KEY', process.env.DATA_ENCRYPTION_KEY); } catch (error) { configurationErrors.push(error.message); }
    if (process.env.JWT_SECRET && process.env.DATA_ENCRYPTION_KEY && process.env.JWT_SECRET === process.env.DATA_ENCRYPTION_KEY) {
        configurationErrors.push('JWT_SECRET 与 DATA_ENCRYPTION_KEY 必须使用不同的随机密钥');
    }
    const databaseError = validateDatabaseUrl(process.env.DATABASE_URL);
    if (databaseError) configurationErrors.push(databaseError);
    if (configurationErrors.length) throw new Error(`启动配置无效：\n- ${configurationErrors.join('\n- ')}`);

    const port = parsePort(process.env.PORT);
    const cookieSecure = process.env.COOKIE_SECURE === 'true';

    if (process.env.NODE_ENV === 'production' && !cookieSecure) {
        logger.warn('配置提醒: 当前使用 HTTP Cookie；仅适用于访问受控的隔离局域网，请通过防火墙限制服务端口');
    }
    if (!process.env.METRICS_TOKEN && process.env.METRICS_ALLOW_UNAUTHENTICATED_LAN !== 'true') {
        logger.warn('配置提醒: 未配置 METRICS_TOKEN，/api/metrics 将保持关闭');
    }
    const configuredAdminPassword = String(process.env.DEFAULT_ADMIN_PASSWORD || '').trim();
    const initialPasswordError = getPasswordValidationMessage(configuredAdminPassword);
    if (configuredAdminPassword && initialPasswordError) {
        throw new Error(`DEFAULT_ADMIN_PASSWORD ${initialPasswordError}`);
    }
    if (configuredAdminPassword) {
        logger.warn('配置提醒: DEFAULT_ADMIN_PASSWORD 仅用于空数据库首次初始化；初始化后请删除该配置并在界面中轮换管理员密码');
    }

    return {
        port,
        compressionEnabled: process.env.ENABLE_COMPRESSION !== 'false',
        staticMaxAge: process.env.STATIC_MAX_AGE || '1d',
        vendorMaxAge: process.env.VENDOR_STATIC_MAX_AGE || '30d',
        directorySizeCacheMs: Math.max(parseInt(process.env.DIR_SIZE_CACHE_MS || '60000', 10), 0),
        maintenanceStartDelayMs: parseNonNegativeInteger('MAINTENANCE_START_DELAY_MS', process.env.MAINTENANCE_START_DELAY_MS, 10000),
        instanceId: crypto.randomUUID().slice(0, 8),
        publicUrl: (process.env.PUBLIC_URL || '').replace(/\/+$/, '')
    };
}

module.exports = { validateConfig, validateDatabaseUrl, weakSecrets };
