/* 系统配置校验模块 System Config Validation */
const crypto = require('crypto');

const weakSecrets = new Set([
    'lite-chat-secret-key-123',
    'change-me',
    'change-me-generate-with-openssl-rand-hex-32',
    'please-replace-with-a-random-64-character-secret-before-starting'
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

function validateConfig() {
    validateSecret('JWT_SECRET', process.env.JWT_SECRET);
    validateSecret('DATA_ENCRYPTION_KEY', process.env.DATA_ENCRYPTION_KEY, { required: false });

    const port = parsePort(process.env.PORT);
    const cookieSecure = process.env.COOKIE_SECURE === 'true';

    const { logger } = require('./logger');
    if (process.env.NODE_ENV === 'production' && !cookieSecure) {
        logger.warn('配置提醒: 生产环境建议在 HTTPS 部署时设置 COOKIE_SECURE=true');
    }
    if (!process.env.DATA_ENCRYPTION_KEY) {
        logger.warn('配置提醒: 未配置 DATA_ENCRYPTION_KEY，将从 JWT_SECRET 派生加密密钥');
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

module.exports = { validateConfig, weakSecrets };
