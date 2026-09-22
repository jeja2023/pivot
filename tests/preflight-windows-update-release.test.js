'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { preflightWindowsUpdateRelease } = require('../scripts/preflight_windows_update_release');

test('Windows automatic-update release preflight requires explicit trusted release inputs', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pivot-update-preflight-'));
    try {
        const configPath = path.join(root, 'production-client.json');
        fs.writeFileSync(configPath, JSON.stringify({
            mode: 'remote',
            remoteUrl: 'https://pivot.example.com/',
            autoUpdate: { enabled: true, path: '/downloads/', allowedOrigins: ['https://pivot.example.com'] }
        }));
        const env = {
            PIVOT_DISTRIBUTION_CONFIG: 'production-client.json',
            PIVOT_DISTRIBUTION_STEALTH_SECRET: 'release-only-secret',
            PIVOT_WINDOWS_UPDATE_PUBLISHER: 'Pivot Production Signing',
            WIN_CSC_LINK: 'trusted.pfx'
        };
        assert.deepEqual(preflightWindowsUpdateRelease(root, env), {
            feedUrl: 'https://pivot.example.com/downloads/',
            publisherName: 'Pivot Production Signing',
            distributionConfig: configPath
        });
        assert.throws(
            () => preflightWindowsUpdateRelease(root, { ...env, PIVOT_WINDOWS_UPDATE_PUBLISHER: 'Pivot Local Dev' }),
            /不能使用 Pivot Local Dev/
        );
        assert.throws(
            () => preflightWindowsUpdateRelease(root, { ...env, WIN_CSC_LINK: '' }),
            /缺少代码签名凭据/
        );
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});
