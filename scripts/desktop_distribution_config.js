'use strict';

const fs = require('fs');
const path = require('path');

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

function resolveDistributionUpdateUrl(config = {}) {
    const autoUpdate = config?.autoUpdate || {};
    let rawUrl = String(autoUpdate.url || '').trim();
    if (!rawUrl && config.remoteUrl) {
        rawUrl = new URL(
            String(autoUpdate.path || '/downloads/'),
            String(config.remoteUrl || '')
        ).toString();
    }
    if (!rawUrl) throw new Error('正式安装包自动更新配置缺少有效更新源 URL（可提供 url 或配置 remoteUrl 自动推导）。');
    const updateUrl = new URL(rawUrl);
    if (!['http:', 'https:'].includes(updateUrl.protocol)) {
        throw new Error('正式安装包自动更新必须使用 HTTP 或 HTTPS 协议。');
    }
    updateUrl.hash = '';
    if (!updateUrl.pathname.endsWith('/')) updateUrl.pathname += '/';
    return updateUrl;
}

function assertDistributionUpdatePolicy(config) {
    const autoUpdate = config?.autoUpdate;
    if (!autoUpdate || autoUpdate.enabled !== true) return;
    resolveDistributionUpdateUrl(config);
}

function assertProductionUpdateReleasePolicy(config = {}) {
    if (config?.autoUpdate?.enabled !== true) {
        throw new Error('Windows 自动更新发布必须在分发配置中显式设置 autoUpdate.enabled=true。离线包请使用 --offline-release。');
    }
    const updateUrl = resolveDistributionUpdateUrl(config);
    if (LOOPBACK_HOSTS.has(updateUrl.hostname.toLowerCase())) {
        throw new Error('Windows 自动更新发布不能使用 localhost 或回环地址作为更新源。');
    }
    const allowedOrigins = Array.isArray(config.autoUpdate.allowedOrigins)
        ? config.autoUpdate.allowedOrigins
        : [];
    const normalizedOrigins = allowedOrigins.map(value => {
        try { return new URL(String(value || '')).origin; } catch (_) { return ''; }
    }).filter(Boolean);
    if (!normalizedOrigins.includes(updateUrl.origin)) {
        throw new Error('Windows 自动更新发布必须在 autoUpdate.allowedOrigins 中显式允许更新源 Origin。');
    }
    return updateUrl.toString();
}

function loadDistributionDesktopConfig(rootDir, env = process.env, { required = false } = {}) {
    const root = path.resolve(rootDir || path.resolve(__dirname, '..'));
    const configuredPath = String(env.PIVOT_DISTRIBUTION_CONFIG || '').trim();
    if (!configuredPath) {
        if (required) throw new Error('正式桌面发布包必须提供 PIVOT_DISTRIBUTION_CONFIG，避免把开发机地址打入安装器。');
        return { config: null, sourcePath: '' };
    }
    const sourcePath = path.resolve(root, configuredPath);
    if (!fs.existsSync(sourcePath) || !fs.statSync(sourcePath).isFile()) {
        throw new Error(`PIVOT_DISTRIBUTION_CONFIG 不存在或不是文件：${sourcePath}`);
    }
    let config;
    try {
        config = JSON.parse(fs.readFileSync(sourcePath, 'utf8').replace(/^\uFEFF/, ''));
    } catch (error) {
        throw new Error(`PIVOT_DISTRIBUTION_CONFIG 不是有效 JSON：${error.message}`);
    }
    if (!config || typeof config !== 'object' || Array.isArray(config)) {
        throw new Error('PIVOT_DISTRIBUTION_CONFIG 必须是 JSON 对象。');
    }
    // 分发密钥由独立的受控环境变量注入，外置配置文件不能成为密钥来源。
    delete config.stealthSecret;
    assertDistributionUpdatePolicy(config);
    return { config, sourcePath };
}

module.exports = {
    assertDistributionUpdatePolicy,
    assertProductionUpdateReleasePolicy,
    loadDistributionDesktopConfig,
    resolveDistributionUpdateUrl
};
