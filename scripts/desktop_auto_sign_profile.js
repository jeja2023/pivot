'use strict';

const cp = require('child_process');
const fs = require('fs');
const path = require('path');
const { hasWindowsSigningCredential } = require('./desktop_update_signing');

const DEFAULT_LOCAL_PUBLISHER = 'Pivot Local Dev';

function ensureWindowsSelfSignedCertificate(publisher = DEFAULT_LOCAL_PUBLISHER) {
    if (process.platform !== 'win32') return false;
    try {
        const checkCmd = `Get-ChildItem Cert:\\CurrentUser\\My -CodeSigningCert | Where-Object { $_.Subject -like '*${publisher}*' } | Select-Object -First 1 -ExpandProperty Thumbprint`;
        const existing = cp.execSync(`powershell -NoProfile -Command "${checkCmd}"`, {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore']
        }).trim();
        if (existing) {
            return true;
        }

        console.log(`[desktop-sign] 未检测到代码签名凭据，正在自动创建本地自签名开发证书: CN=${publisher}...`);
        const createCmd = `New-SelfSignedCertificate -Type CodeSigningCert -Subject 'CN=${publisher}' -CertStoreLocation Cert:\\CurrentUser\\My`;
        cp.execSync(`powershell -NoProfile -Command "${createCmd}"`, {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore']
        });
        console.log(`[desktop-sign] 本地自签名证书创建成功: CN=${publisher}`);
        return true;
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

        if (!hasSigning || !hasPublisher) {
            const certOk = ensureWindowsSelfSignedCertificate(DEFAULT_LOCAL_PUBLISHER);
            if (certOk) {
                if (!hasPublisher) {
                    env.PIVOT_WINDOWS_UPDATE_PUBLISHER = DEFAULT_LOCAL_PUBLISHER;
                }
                if (!hasSigning) {
                    env.CSC_NAME = DEFAULT_LOCAL_PUBLISHER;
                }
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
