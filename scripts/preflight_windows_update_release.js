'use strict';

const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');
const {
    assertProductionUpdateReleasePolicy,
    loadDistributionDesktopConfig
} = require('./desktop_distribution_config');
const {
    hasWindowsSigningCredential,
    normalizeWindowsUpdatePublisher
} = require('./desktop_update_signing');
const { DEFAULT_LOCAL_PUBLISHER } = require('./desktop_auto_sign_profile');

function resolveStealthSecret(root, env = process.env) {
    const envPath = path.join(root, '.env');
    const fileEnv = fs.existsSync(envPath) ? dotenv.parse(fs.readFileSync(envPath, 'utf8')) : {};
    return String(env.PIVOT_DISTRIBUTION_STEALTH_SECRET || env.PIVOT_STEALTH_SECRET || fileEnv.PIVOT_STEALTH_SECRET || '').trim();
}

function preflightWindowsUpdateRelease(rootDir, env = process.env) {
    const root = path.resolve(rootDir || path.resolve(__dirname, '..'));
    const distribution = loadDistributionDesktopConfig(root, env, { required: true });
    const feedUrl = assertProductionUpdateReleasePolicy(distribution.config);
    const publisherName = normalizeWindowsUpdatePublisher(env.PIVOT_WINDOWS_UPDATE_PUBLISHER);
    if (!publisherName || publisherName === DEFAULT_LOCAL_PUBLISHER) {
        throw new Error('Windows 自动更新发布必须提供受信任的 PIVOT_WINDOWS_UPDATE_PUBLISHER，不能使用 Pivot Local Dev。');
    }
    if (!hasWindowsSigningCredential(env)) {
        throw new Error('Windows 自动更新发布缺少代码签名凭据：WIN_CSC_LINK、CSC_LINK、PIVOT_WINDOWS_CERTIFICATE_SHA1 或 PIVOT_WINDOWS_CERTIFICATE_SUBJECT。');
    }
    if (!resolveStealthSecret(root, env)) {
        throw new Error('Windows 自动更新发布缺少 PIVOT_DISTRIBUTION_STEALTH_SECRET 或 PIVOT_STEALTH_SECRET。');
    }
    return { feedUrl, publisherName, distributionConfig: distribution.sourcePath };
}

if (require.main === module) {
    try {
        const result = preflightWindowsUpdateRelease();
        console.log(`Windows 自动更新发布预检通过：${result.publisherName} → ${result.feedUrl}`);
    } catch (error) {
        console.error(error?.stack || error?.message || String(error));
        process.exitCode = 1;
    }
}

module.exports = { preflightWindowsUpdateRelease, resolveStealthSecret };
