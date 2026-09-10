'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
    autoProvisionDesktopEnvironment,
    ensureDefaultDistributionConfig
} = require('../scripts/desktop_auto_sign_profile');

test('ensureDefaultDistributionConfig 生成包含 autoUpdate 开启的生产默认配置', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pivot-auto-dist-config-'));
    try {
        const configPath = ensureDefaultDistributionConfig(root);
        assert.equal(fs.existsSync(configPath), true);
        const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        assert.equal(parsed.mode, 'remote');
        assert.equal(parsed.autoUpdate?.enabled, true);
        assert.equal(parsed.autoUpdate?.url, '');
        assert.equal(parsed.autoUpdate?.path, '/downloads/');
        assert.equal(parsed.remoteUrl, 'http://50.64.150.51:9006/');
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('autoProvisionDesktopEnvironment 总会补全默认分发配置，并保留可被 electron-builder 识别的证书资料', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pivot-auto-provision-'));
    try {
        const mockEnv = {
            PIVOT_WINDOWS_UPDATE_PUBLISHER: 'Test Signing Publisher',
            PIVOT_WINDOWS_CERTIFICATE_SHA1: 'B1ACD270210B82E9ADD6CB0953373E81ABD80FFC'
        };
        autoProvisionDesktopEnvironment(root, mockEnv, { platform: 'win32', isDirBuild: false });
        assert.equal(Boolean(mockEnv.PIVOT_DISTRIBUTION_CONFIG), true);
        const distFile = path.resolve(root, mockEnv.PIVOT_DISTRIBUTION_CONFIG);
        assert.equal(fs.existsSync(distFile), true);
        assert.equal(mockEnv.PIVOT_WINDOWS_UPDATE_PUBLISHER, 'Test Signing Publisher');
        assert.equal(mockEnv.PIVOT_WINDOWS_CERTIFICATE_SHA1, 'B1ACD270210B82E9ADD6CB0953373E81ABD80FFC');
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('正式 Windows 更新包拒绝开发机自签名自动兜底', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pivot-auto-prod-signing-'));
    try {
        assert.throws(
            () => autoProvisionDesktopEnvironment(root, {}, { platform: 'win32', isDirBuild: false, requireTrustedSigning: true }),
            /必须显式提供 PIVOT_WINDOWS_UPDATE_PUBLISHER/
        );
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('autoProvisionDesktopEnvironment 保留用户显式传入的环境变量', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pivot-auto-preserve-'));
    try {
        const mockEnv = {
            PIVOT_WINDOWS_UPDATE_PUBLISHER: 'Custom Corp',
            CSC_LINK: 'custom-cert.pfx',
            PIVOT_DISTRIBUTION_CONFIG: 'custom-dist.json'
        };
        autoProvisionDesktopEnvironment(root, mockEnv, { platform: 'win32', isDirBuild: false });
        assert.equal(mockEnv.PIVOT_WINDOWS_UPDATE_PUBLISHER, 'Custom Corp');
        assert.equal(mockEnv.CSC_LINK, 'custom-cert.pfx');
        assert.equal(mockEnv.PIVOT_DISTRIBUTION_CONFIG, 'custom-dist.json');
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});
