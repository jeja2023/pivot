const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { pathToFileURL } = require('node:url');

const {
    assertAllowedUpdateFeedUrl,
    normalizeOriginList,
    normalizeUpdateFeedUrl
} = require('../desktop/update-policy');
const {
    mergeDesktopConfigs,
    normalizeAutoUpdate,
    normalizeConfig,
    normalizeUpdatePath,
    resolveUpdateUrlFromRemote
} = require('../desktop/config');
const { setupAutoUpdater } = require('../desktop/updater');
const { hardenWindowsAutoUpdater, verifyWindowsUpdateSigningConfig } = require('../desktop/updater');
const { resolveInitializedServer } = require('../desktop/local-server');
const { isTrustedRendererUrl } = require('../desktop/navigation-policy');
const { isTrustedExternalNavigation, normalizeTrustedExternalOrigins } = require('../desktop/external-navigation-policy');

test('desktop local mode waits for server initialization before resolving', async () => {
    let resolveInit;
    const server = { listening: true };
    const pending = resolveInitializedServer({
        initPromise: new Promise(resolve => { resolveInit = resolve; })
    });
    let settled = false;
    pending.finally(() => { settled = true; });

    await Promise.resolve();
    assert.equal(settled, false);
    resolveInit({ server });
    assert.equal(await pending, server);
});

test('desktop update policy supports http and https for update feeds', () => {
    assert.equal(
        normalizeUpdateFeedUrl('https://updates.example.com/pivot', { required: true }),
        'https://updates.example.com/pivot/'
    );
    assert.equal(
        normalizeUpdateFeedUrl('http://50.64.150.51:9006/downloads', { required: true }),
        'http://50.64.150.51:9006/downloads/'
    );
    assert.throws(
        () => assertAllowedUpdateFeedUrl('ftp://updates.example.com/pivot'),
        /must use http or https|必须使用 http 或 https/
    );
});

test('desktop update policy allows HTTP feeds including local development loopback and intranet', () => {
    assert.equal(
        assertAllowedUpdateFeedUrl('http://127.0.0.1:9000/releases'),
        'http://127.0.0.1:9000/releases/'
    );
    assert.equal(
        assertAllowedUpdateFeedUrl('http://50.64.150.51:9006/downloads'),
        'http://50.64.150.51:9006/downloads/'
    );
});

test('desktop update policy enforces allowed origins', () => {
    assert.deepEqual(normalizeOriginList(['https://updates.example.com/path']), ['https://updates.example.com']);
    assert.equal(
        normalizeAutoUpdate({
            enabled: true,
            url: 'https://updates.example.com/pivot',
            allowedOrigins: ['https://updates.example.com']
        }).url,
        'https://updates.example.com/pivot/'
    );
    assert.throws(
        () => normalizeAutoUpdate({
            enabled: true,
            url: 'https://evil.example.com/pivot',
            allowedOrigins: ['https://updates.example.com']
        }),
        /not in config\.autoUpdate\.allowedOrigins|未在 allowedOrigins 允许列表中|不在配置的自动更新来源白名单/
    );
});

test('desktop config can derive same-origin downloads update feed', () => {
    const config = normalizeConfig({
        mode: 'remote',
        remoteUrl: 'https://pivot.example.com/app/',
        autoUpdate: {
            enabled: true,
            url: '',
            path: 'downloads',
            allowedOrigins: ['https://pivot.example.com']
        }
    }, {}, {});

    assert.equal(config.autoUpdate.path, '/downloads');
    assert.equal(config.autoUpdate.url, 'https://pivot.example.com/downloads/');
});

test('desktop update path rejects full URLs', () => {
    assert.equal(normalizeUpdatePath('/downloads/'), '/downloads/');
    assert.equal(
        resolveUpdateUrlFromRemote('https://pivot.example.com/', '/downloads/'),
        'https://pivot.example.com/downloads/'
    );
    assert.throws(
        () => normalizeUpdatePath('https://updates.example.com/pivot/'),
        /must be a URL path|必须为 URL 相对路径|必须是 URL 路径/
    );
});

test('desktop update policy supports LAN and intranet HTTP feeds', () => {
    assert.equal(
        assertAllowedUpdateFeedUrl('http://pivot.lan:3000/downloads'),
        'http://pivot.lan:3000/downloads/'
    );
});

test('Windows 更新仅接受与打包 app-update.yml 绑定的签名发布者，并禁止降级和 web installer', () => {
    const root = require('node:fs').mkdtempSync(require('node:os').tmpdir() + path.sep + 'pivot-update-signing-');
    try {
        require('node:fs').writeFileSync(path.join(root, 'app-update.yml'), 'publisherName: Pivot Release Signing\n');
        const config = { publisherName: 'Pivot Release Signing' };
        assert.equal(verifyWindowsUpdateSigningConfig(config, { platform: 'win32', resourcesPath: root }), true);
        const updater = { verifyUpdateCodeSignature() {}, disableWebInstaller: false, allowDowngrade: true };
        assert.equal(hardenWindowsAutoUpdater(updater, config, { platform: 'win32', resourcesPath: root }), true);
        assert.equal(updater.disableWebInstaller, true);
        assert.equal(updater.allowDowngrade, false);
        assert.throws(
            () => hardenWindowsAutoUpdater(updater, { publisherName: 'Unexpected Publisher' }, { platform: 'win32', resourcesPath: root }),
            /发布者与客户端配置不一致/
        );
    } finally {
        require('node:fs').rmSync(root, { recursive: true, force: true });
    }
});

test('desktop config supports HTTP feeds when automatic updates are enabled', () => {
    const config = normalizeConfig({
        mode: 'remote', remoteUrl: 'http://192.168.10.20:3000/',
        autoUpdate: { enabled: true, path: '/downloads/' }
    }, {}, {});
    assert.equal(config.autoUpdate.enabled, true);
    assert.equal(config.autoUpdate.url, 'http://192.168.10.20:3000/downloads/');
});

test('bundled desktop config preserves remote bootstrap and update settings without a secret', () => {
    const bundledConfig = require('../config.json');
    const packageManifest = require('../package.json');
    const config = normalizeConfig(bundledConfig, {}, {});

    assert.equal(config.mode, 'remote');
    assert.equal(config.environmentName, 'Development machine');
    assert.equal(config.remoteUrl, 'http://127.0.0.1:3000/');
    assert.equal(config.partition, 'persist:pivot-development');
    assert.equal(config.stealthSecret, '');
    assert.equal(config.autoUpdate.enabled, false);
    assert.equal(config.autoUpdate.url, '');
    assert.equal(config.autoUpdate.allowInsecureHttp, false);
    assert.deepEqual(config.autoUpdate.allowedOrigins, []);
    assert.equal(packageManifest.build.extraResources.some(item => item.from === 'config.json' && item.to === 'config.json'), true);
    assert.equal(packageManifest.build.extraFiles.some(item => item.from === 'config.json' && item.to === 'config.json'), false);
    assert.equal(packageManifest.build.extraResources.some(item => item.from === 'config.example.json' && item.to === 'config.example.json'), true);
});

test('desktop renderer policy supports LAN HTTP origins without trusting redirects', () => {
    assert.equal(isTrustedRendererUrl('http://192.168.10.20:9006/chat', 'http://192.168.10.20:9006/'), true);
    assert.equal(isTrustedRendererUrl('http://192.168.10.21:9006/chat', 'http://192.168.10.20:9006/'), false);
    assert.equal(isTrustedRendererUrl('https://192.168.10.20:9006/chat', 'http://192.168.10.20:9006/'), false);

    const errorPage = path.join(__dirname, '..', 'desktop', 'error.html');
    assert.equal(isTrustedRendererUrl(pathToFileURL(errorPage).toString(), 'http://192.168.10.20:9006/', {
        allowedFilePaths: [errorPage]
    }), true);
});

test('desktop external navigation requires explicit origin-scoped trust', () => {
    assert.deepEqual(
        normalizeTrustedExternalOrigins(['https://docs.example.com', 'https://docs.example.com']),
        ['https://docs.example.com']
    );
    assert.throws(
        () => normalizeTrustedExternalOrigins(['https://docs.example.com/path']),
        /Origin|路径/
    );
    assert.throws(
        () => normalizeTrustedExternalOrigins(['https://user:password@docs.example.com']),
        /账号|HTTP\/HTTPS/
    );
    assert.equal(isTrustedExternalNavigation('https://docs.example.com/guide', 'https://pivot.example.com/', {
        allowExternalOpen: true,
        allowedExternalOrigins: ['https://docs.example.com']
    }), true);
    assert.equal(isTrustedExternalNavigation('https://evil.example.com/', 'https://pivot.example.com/', {
        allowExternalOpen: true,
        allowedExternalOrigins: ['https://docs.example.com']
    }), false);
    assert.equal(isTrustedExternalNavigation('https://docs.example.com/', 'https://pivot.example.com/', {
        allowExternalOpen: true,
        allowedExternalOrigins: []
    }), false);
    assert.equal(normalizeConfig({ mode: 'remote', remoteUrl: 'https://pivot.example.com', allowExternalOpen: true }, {}, {}).allowExternalOpen, false);
});

test('desktop autoUpdate supports configurable checkIntervalMinutes', () => {
    const defaultAutoUpdate = normalizeAutoUpdate({});
    assert.equal(defaultAutoUpdate.checkIntervalMinutes, 30);

    const customAutoUpdate = normalizeAutoUpdate({ checkIntervalMinutes: 45 });
    assert.equal(customAutoUpdate.checkIntervalMinutes, 45);

    const disabledInterval = normalizeAutoUpdate({ checkIntervalMinutes: 0 });
    assert.equal(disabledInterval.checkIntervalMinutes, 0);

    const stringInterval = normalizeAutoUpdate({ checkIntervalMinutes: '60' });
    assert.equal(stringInterval.checkIntervalMinutes, 60);
});

test('mergeDesktopConfigs preserves HTTPS update policy without promoting an HTTP business origin', () => {
    const base = {
        mode: 'remote',
        remoteUrl: 'https://updates.example.com',
        autoUpdate: {
            enabled: true,
            path: '/pivot/',
            url: 'https://updates.example.com/pivot/',
            checkOnStart: true,
            checkIntervalMinutes: 30,
            allowedOrigins: ['https://updates.example.com']
        }
    };
    const user = {
        mode: 'remote',
        remoteUrl: 'http://192.168.1.99:3000',
        stealthSecret: 'custom-secret'
    };
    const merged = mergeDesktopConfigs(base, user);
    assert.equal(merged.remoteUrl, 'http://192.168.1.99:3000');
    assert.equal(merged.autoUpdate.enabled, true);
    assert.equal(merged.autoUpdate.path, '/pivot/');
    assert.equal(merged.autoUpdate.checkIntervalMinutes, 30);
    assert.equal(merged.autoUpdate.allowedOrigins.includes('http://192.168.1.99:3000'), false);
    assert.equal(merged.stealthSecret, 'custom-secret');
});

test('setupAutoUpdater provides lifecycle controls and initial state', () => {
    const mockApp = {
        getVersion: () => '0.1.85',
        isPackaged: false
    };
    const mockConfig = {
        autoUpdate: {
            enabled: false,
            checkIntervalMinutes: 30
        }
    };
    const controller = setupAutoUpdater({
        app: mockApp,
        mainWindow: null,
        config: mockConfig,
        authorizeIpc: () => true
    });
    assert.equal(typeof controller.getState, 'function');
    assert.equal(typeof controller.checkForUpdates, 'function');
    assert.equal(typeof controller.destroy, 'function');
    const state = controller.getState();
    assert.equal(state.enabled, false);
    assert.equal(state.status, 'disabled');
    assert.equal(state.checkIntervalMinutes, 30);
    controller.destroy();
});
