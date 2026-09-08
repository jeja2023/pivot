const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { loadDistributionDesktopConfig } = require('../scripts/desktop_distribution_config');

test('正式桌面构建必须使用独立分发配置，而开发构建可使用仓库配置', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pivot-distribution-config-'));
    const configPath = path.join(root, 'production-client.json');
    try {
        fs.writeFileSync(configPath, JSON.stringify({
            mode: 'remote',
            remoteUrl: 'https://pivot.example.com/',
            stealthSecret: 'must-not-be-used',
            autoUpdate: { enabled: true }
        }));
        assert.deepEqual(loadDistributionDesktopConfig(root, {}, { required: false }), { config: null, sourcePath: '' });
        assert.throws(() => loadDistributionDesktopConfig(root, {}, { required: true }), /PIVOT_DISTRIBUTION_CONFIG/);
        const result = loadDistributionDesktopConfig(root, { PIVOT_DISTRIBUTION_CONFIG: 'production-client.json' }, { required: true });
        assert.equal(result.sourcePath, configPath);
        assert.equal(result.config.remoteUrl, 'https://pivot.example.com/');
        assert.equal(Object.hasOwn(result.config, 'stealthSecret'), false);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('正式分发配置允许 HTTP 业务地址，但自动更新必须使用 HTTPS', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pivot-distribution-update-policy-'));
    const configPath = path.join(root, 'production-client.json');
    try {
        const write = autoUpdate => fs.writeFileSync(configPath, JSON.stringify({
            mode: 'remote', remoteUrl: 'http://pivot.lan:3000/', autoUpdate
        }));
        write({ enabled: true, url: 'https://updates.example.com/pivot/', allowedOrigins: ['https://updates.example.com'] });
        assert.equal(loadDistributionDesktopConfig(root, { PIVOT_DISTRIBUTION_CONFIG: 'production-client.json' }, { required: true }).config.autoUpdate.url, 'https://updates.example.com/pivot/');
        write({ enabled: true, path: '/downloads/', allowInsecureHttp: true, allowedOrigins: ['http://pivot.lan:3000'] });
        assert.throws(
            () => loadDistributionDesktopConfig(root, { PIVOT_DISTRIBUTION_CONFIG: 'production-client.json' }, { required: true }),
            /禁止 allowInsecureHttp/
        );
        write({ enabled: true, url: 'http://updates.example.com/pivot/' });
        assert.throws(
            () => loadDistributionDesktopConfig(root, { PIVOT_DISTRIBUTION_CONFIG: 'production-client.json' }, { required: true }),
            /必须使用 HTTPS/
        );
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});
