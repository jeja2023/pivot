'use strict';

const fs = require('fs');
const path = require('path');

function assertDistributionUpdatePolicy(config) {
    const autoUpdate = config?.autoUpdate;
    if (!autoUpdate || autoUpdate.enabled !== true) return;
    let rawUrl = String(autoUpdate.url || '').trim();
    if (!rawUrl && config.remoteUrl) {
        try {
            rawUrl = new URL(
                String(autoUpdate.path || '/downloads/'),
                String(config.remoteUrl || '')
            ).toString();
        } catch (_) {
            throw new Error('正式安装包自动更新配置未能从 remoteUrl 解析出有效 URL。');
        }
    }
    if (!rawUrl) {
        throw new Error('正式安装包自动更新配置缺少有效更新源 URL（可提供 url 或配置 remoteUrl 自动推导）。');
    }
    let updateUrl;
    try {
        updateUrl = new URL(rawUrl);
    } catch (_) {
        throw new Error('正式安装包自动更新配置缺少有效 URL。');
    }
    if (!['http:', 'https:'].includes(updateUrl.protocol)) {
        throw new Error('正式安装包自动更新必须使用 HTTP 或 HTTPS 协议。');
    }
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

module.exports = { assertDistributionUpdatePolicy, loadDistributionDesktopConfig };
