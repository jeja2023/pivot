'use strict';

const cp = require('child_process');
const fs = require('fs');
const path = require('path');
const { hasWindowsSigningCredential, normalizeWindowsCertificateSha1 } = require('./desktop_update_signing');

const DEFAULT_LOCAL_PUBLISHER = 'Pivot Local Dev';

function ensureWindowsSelfSignedCertificate(publisher = DEFAULT_LOCAL_PUBLISHER) {
    if (process.platform !== 'win32') return false;
    try {
        const checkCmd = `Get-ChildItem Cert:\\CurrentUser\\My -CodeSigningCert | Where-Object { $_.Subject -like '*${publisher}*' } | Select-Object -First 1 -ExpandProperty Thumbprint`;
        const existing = cp.execSync(`powershell -NoProfile -Command "${checkCmd}"`, {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore']
        }).trim();
        if (existing) return normalizeWindowsCertificateSha1(existing) || false;

        console.log(`[desktop-sign] 未检测到代码签名凭据，正在自动创建本地自签名开发证书: CN=${publisher}...`);
        const createCmd = `New-SelfSignedCertificate -Type CodeSigningCert -Subject 'CN=${publisher}' -CertStoreLocation Cert:\\CurrentUser\\My`;
        cp.execSync(`powershell -NoProfile -Command "${createCmd}"`, {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore']
        });
        const created = cp.execSync(`powershell -NoProfile -Command "${checkCmd}"`, {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore']
        }).trim();
        const thumbprint = normalizeWindowsCertificateSha1(created);
        if (!thumbprint) throw new Error('本地自签名证书创建后未读取到 SHA-1 指纹。');
        console.log(`[desktop-sign] 本地自签名证书创建成功: CN=${publisher}`);
        return thumbprint;
    } catch (err) {
        console.warn(`[desktop-sign] 自动创建自签名证书失败 (可手动指定证书): ${err.message}`);
        return false;
    }
}

function ensureDefaultDistributionConfig(rootDir) {
    const root = path.resolve(rootDir || path.resolve(__dirname, '..'));
    const tmpDir = path.join(root, '.tmp');
    fs.mkdirSync(tmpDir, { recursive: true });
    const configPath = path.join(tmpDir, 'dist-config.json');

    if (!fs.existsSync(configPath)) {
        const devConfigPath = path.join(root, 'config.json');
        let baseConfig = {};
        try {
            baseConfig = JSON.parse(fs.readFileSync(devConfigPath, 'utf8'));
        } catch (_) {}

        const distConfig = {
            mode: baseConfig.mode || 'remote',
            environmentName: 'Pivot Production',
            remoteUrl: 'http://50.64.150.51:9006/',
            partition: 'persist:pivot-client',
            windowTitle: baseConfig.windowTitle || 'Pivot 智枢',
            allowExternalOpen: false,
            allowedExternalOrigins: [],
            sandbox: true,
            lockServerConfig: false,
            autoUpdate: {
                enabled: true,
                url: '',
                path: '/downloads/',
                checkOnStart: true,
                checkIntervalMinutes: 30,
                autoDownload: true,
                installOnQuit: false,
                publisherName: DEFAULT_LOCAL_PUBLISHER
            }
        };
        fs.writeFileSync(configPath, JSON.stringify(distConfig, null, 2) + '\n', 'utf8');
    }
    return configPath;
}

function autoProvisionDesktopEnvironment(rootDir, env = process.env, options = {}) {
    const root = path.resolve(rootDir || path.resolve(__dirname, '..'));
    const isWindowsTarget = options.platform === 'win32' || (process.platform === 'win32' && !options.platform);

    if (isWindowsTarget && !options.isDirBuild) {
        const hasSigning = hasWindowsSigningCredential(env);
        const hasPublisher = Boolean(String(env.PIVOT_WINDOWS_UPDATE_PUBLISHER || '').trim());

        if (options.requireTrustedSigning === true && (!hasSigning || !hasPublisher)) {
            throw new Error('Windows 正式更新包必须显式提供 PIVOT_WINDOWS_UPDATE_PUBLISHER，以及 CSC_LINK、WIN_CSC_LINK、PIVOT_WINDOWS_CERTIFICATE_SHA1 或 PIVOT_WINDOWS_CERTIFICATE_SUBJECT。开发机自签名证书不能用于生产自动更新。');
        }

        // 未发布的本机联调包仍可使用当前用户证书库中的自签名证书；正式包不会走此分支。
        if (!options.requireTrustedSigning && (!hasSigning || !hasPublisher)) {
            const thumbprint = ensureWindowsSelfSignedCertificate(DEFAULT_LOCAL_PUBLISHER);
            if (thumbprint) {
                if (!hasPublisher) env.PIVOT_WINDOWS_UPDATE_PUBLISHER = DEFAULT_LOCAL_PUBLISHER;
                if (!hasSigning) env.PIVOT_WINDOWS_CERTIFICATE_SHA1 = thumbprint;
            }
        }

        if (!String(env.PIVOT_DISTRIBUTION_CONFIG || '').trim()) {
            const autoConfigPath = ensureDefaultDistributionConfig(root);
            env.PIVOT_DISTRIBUTION_CONFIG = path.relative(root, autoConfigPath);
            console.log(`[desktop-config] 未显式配置 PIVOT_DISTRIBUTION_CONFIG，自动使用默认分发配置: ${env.PIVOT_DISTRIBUTION_CONFIG}`);
        }
    }
}

module.exports = {
    DEFAULT_LOCAL_PUBLISHER,
    autoProvisionDesktopEnvironment,
    ensureDefaultDistributionConfig,
    ensureWindowsSelfSignedCertificate
};
