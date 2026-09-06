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

test('desktop update policy requires https for remote feeds', () => {
    assert.equal(
        normalizeUpdateFeedUrl('https://updates.example.com/pivot', { required: true }),
        'https://updates.example.com/pivot/'
    );
    assert.throws(
        () => assertAllowedUpdateFeedUrl('http://updates.example.com/pivot'),
        /must use https|必须使用 HTTPS/
    );
});

test('desktop update policy allows explicit loopback dev feeds only', () => {
    assert.equal(
        assertAllowedUpdateFeedUrl('http://127.0.0.1:9000/releases', {
            env: { PIVOT_DESKTOP_ALLOW_INSECURE_UPDATE_FEED: 'true' }
        }),
        'http://127.0.0.1:9000/releases/'
    );
    assert.throws(
        () => assertAllowedUpdateFeedUrl('http://127.0.0.1:9000/releases'),
        /must use https|必须使用 HTTPS/
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

test('desktop update policy allows explicit LAN HTTP feeds with origin whitelist', () => {
    assert.equal(
        assertAllowedUpdateFeedUrl('http://pivot.lan:3000/downloads', {
            allowInsecureHttp: true,
            allowedOrigins: ['http://pivot.lan:3000']
        }),
        'http://pivot.lan:3000/downloads/'
    );
    assert.throws(
        () => assertAllowedUpdateFeedUrl('http://pivot.lan:3000/downloads', {
            allowInsecureHttp: true
        }),
        /allowedOrigins is required|必须配置 allowedOrigins/
    );
    assert.throws(
        () => assertAllowedUpdateFeedUrl('http://pivot.lan:3000/downloads', {
            allowInsecureHttp: true,
            allowedOrigins: ['http://other.lan:3000']
        }),
        /not in config\.autoUpdate\.allowedOrigins|未在 allowedOrigins 允许列表中|不在配置的自动更新来源白名单/
    );
});

test('desktop config can derive LAN HTTP downloads feed when explicitly allowed', () => {
    const config = normalizeConfig({
        mode: 'remote',
        remoteUrl: 'http://192.168.10.20:3000/',
        autoUpdate: {
            enabled: true,
            path: '/downloads/',
            url: '',
            allowInsecureHttp: true,
            allowedOrigins: ['http://192.168.10.20:3000']
        }
    }, {}, {});

    assert.equal(config.autoUpdate.url, 'http://192.168.10.20:3000/downloads/');
    assert.equal(config.autoUpdate.allowInsecureHttp, true);
});

test('bundled production desktop config enables only its allowlisted LAN update origin', () => {
    const productionConfig = require('../config.json');
    const packageManifest = require('../package.json');
    const config = normalizeConfig(productionConfig, {}, {});
    const remoteOrigin = new URL(config.remoteUrl).origin;

    assert.equal(config.autoUpdate.enabled, true);
    assert.equal(config.autoUpdate.url, `${remoteOrigin}/downloads/`);
    assert.equal(config.autoUpdate.allowInsecureHttp, true);
    assert.deepEqual(config.autoUpdate.allowedOrigins, [remoteOrigin]);
    assert.equal(packageManifest.build.extraResources.some(item => item.from === 'config.json' && item.to === 'config.json'), true);
    assert.equal(packageManifest.build.extraFiles.some(item => item.from === 'config.json' && item.to === 'config.json'), true);
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

test('mergeDesktopConfigs preserves bundled autoUpdate when user-config overrides remoteUrl', () => {
    const base = {
        mode: 'remote',
        remoteUrl: 'http://50.64.150.51:9006',
        autoUpdate: {
            enabled: true,
            path: '/downloads/',
            url: '',
            checkOnStart: true,
            checkIntervalMinutes: 30,
            allowInsecureHttp: true,
            allowedOrigins: ['http://50.64.150.51:9006']
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
    assert.equal(merged.autoUpdate.path, '/downloads/');
    assert.equal(merged.autoUpdate.checkIntervalMinutes, 30);
    assert.equal(merged.autoUpdate.allowedOrigins.includes('http://192.168.1.99:3000'), true);
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

