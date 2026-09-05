const fs = require('fs');
const path = require('path');
const { normalizeOriginList, normalizeUpdateFeedUrl } = require('./update-policy');
const { normalizeTrustedExternalOrigins } = require('./external-navigation-policy');

const DEFAULT_AUTO_UPDATE = {
    enabled: false,
    url: '',
    path: '/downloads/',
    checkOnStart: true,
    autoDownload: true,
    allowPrerelease: false,
    allowInsecureHttp: false,
    installOnQuit: true,
    allowedOrigins: []
};

const DEFAULT_CONFIG = {
    mode: 'local',
    environmentName: 'Local',
    remoteUrl: '',
    partition: '',
    windowTitle: '智枢 Pivot',
    allowExternalOpen: false,
    allowedExternalOrigins: [],
    sandbox: true,
    autoUpdate: DEFAULT_AUTO_UPDATE
};

function normalizePath(value) {
    if (!value) return '';
    return path.resolve(String(value));
}

function readJsonFile(filePath) {
    const text = fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '');
    return JSON.parse(text);
}

function getArgValue(argv, name) {
    const eqPrefix = name + '=';
    for (let index = 0; index < argv.length; index += 1) {
        const item = argv[index];
        if (item === name) return argv[index + 1] || '';
        if (item.startsWith(eqPrefix)) return item.slice(eqPrefix.length);
    }
    return '';
}

function existingFile(filePath) {
    return filePath && fs.existsSync(filePath) && fs.statSync(filePath).isFile();
}

function getExecutableDir(app) {
    if (!app.isPackaged) return path.resolve(__dirname, '..');
    return path.dirname(process.execPath);
}

function getResourceDir(app) {
    return app.isPackaged ? process.resourcesPath : path.resolve(__dirname, '..');
}

function getUserConfigPath(app) {
    if (!app) return '';
    const userDataDir = typeof app.getPath === 'function' ? app.getPath('userData') : (typeof app === 'string' ? app : '');
    return userDataDir ? path.join(userDataDir, 'user-config.json') : '';
}

function saveUserDesktopConfig(app, overrides = {}) {
    const configPath = getUserConfigPath(app);
    if (!configPath) throw new Error('无法定位用户配置目录。');
    let existing = {};
    if (existingFile(configPath)) {
        try {
            existing = readJsonFile(configPath);
        } catch (_) {
            existing = {};
        }
    }
    const merged = { ...existing, ...overrides };
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify(merged, null, 2), 'utf8');
    return merged;
}

function candidateConfigPaths(app, argv = process.argv, env = process.env) {
    const explicitArg = normalizePath(getArgValue(argv, '--config'));
    const explicitEnv = normalizePath(env.PIVOT_DESKTOP_CONFIG);
    const userConfigPath = getUserConfigPath(app);
    const executableDir = getExecutableDir(app);
    const resourceDir = getResourceDir(app);
    return [
        { source: 'cli', path: explicitArg },
        { source: 'env', path: explicitEnv },
        { source: 'user', path: userConfigPath },
        { source: 'executable', path: path.join(executableDir, 'config.json') },
        { source: 'resources', path: path.join(resourceDir, 'config.json') }
    ].filter(item => item.path);
}

function normalizeMode(value) {
    const mode = String(value || '').trim().toLowerCase();
    if (mode === 'remote' || mode === 'local') return mode;
    throw new Error('config.mode must be either "remote" or "local".');
}

function normalizePartition(value, mode, environmentName) {
    const raw = String(value || '').trim();
    if (raw) return raw.startsWith('persist:') ? raw : 'persist:' + raw;
    const safeName = String(environmentName || mode)
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, '-')
        .replace(/^-+|-+$/g, '') || mode;
    return 'persist:pivot-' + safeName;
}

function normalizeHttpUrl(value, fieldName, required) {
    const raw = String(value || '').trim();
    if (!raw) {
        if (required) throw new Error(fieldName + ' is required.');
        return '';
    }
    const url = new URL(raw);
    if (!['http:', 'https:'].includes(url.protocol)) {
        throw new Error(fieldName + ' must use http or https.');
    }
    url.hash = '';
    return url.toString();
}

function normalizeRemoteUrl(value) {
    return normalizeHttpUrl(value, 'config.remoteUrl', true);
}

function normalizeUpdateUrl(value, required, allowedOrigins = [], env = process.env, allowInsecureHttp = false) {
    return normalizeUpdateFeedUrl(value, {
        required,
        allowedOrigins,
        allowInsecureHttp,
        env
    });
}

function normalizeUpdatePath(value) {
    const raw = String(value || DEFAULT_AUTO_UPDATE.path).trim() || DEFAULT_AUTO_UPDATE.path;
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(raw)) {
        throw new Error('config.autoUpdate.path 必须为 URL 相对路径，而非完整 URL。');
    }
    return raw.startsWith('/') ? raw : '/' + raw;
}

function resolveUpdateUrlFromRemote(remoteUrl, updatePath) {
    if (!remoteUrl) return '';
    const url = new URL(updatePath || DEFAULT_AUTO_UPDATE.path, remoteUrl);
    url.hash = '';
    if (!url.pathname.endsWith('/')) url.pathname += '/';
    return url.toString();
}

function normalizeAutoUpdate(value, env = process.env, options = {}) {
    const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    const merged = { ...DEFAULT_AUTO_UPDATE, ...source };
    const enabled = merged.enabled === true;
    const allowedOrigins = normalizeOriginList(merged.allowedOrigins);
    const updatePath = normalizeUpdatePath(merged.path);
    const allowInsecureHttp = merged.allowInsecureHttp === true;
    const explicitUrl = String(merged.url || '').trim();
    const derivedUrl = explicitUrl || (enabled ? resolveUpdateUrlFromRemote(options.remoteUrl, updatePath) : '');
    return {
        enabled,
        url: normalizeUpdateUrl(derivedUrl, enabled, allowedOrigins, env, allowInsecureHttp),
        path: updatePath,
        checkOnStart: merged.checkOnStart !== false,
        autoDownload: merged.autoDownload !== false,
        allowPrerelease: merged.allowPrerelease === true,
        allowInsecureHttp,
        installOnQuit: merged.installOnQuit !== false,
        allowedOrigins
    };
}

function normalizeConfig(raw, meta = {}, env = process.env) {
    const input = raw || {};
    const merged = { ...DEFAULT_CONFIG, ...input };
    const mode = normalizeMode(merged.mode);
    const environmentName = typeof input.environmentName === 'string' ? input.environmentName.trim() : (mode === 'remote' ? 'Remote' : 'Local');
    const remoteUrl = mode === 'remote' ? normalizeRemoteUrl(merged.remoteUrl) : '';
    return {
        mode,
        environmentName,
        remoteUrl,
        partition: normalizePartition(merged.partition, mode, environmentName),
        windowTitle: typeof merged.windowTitle === 'string' ? merged.windowTitle.trim() : '智枢 Pivot',
        // External navigation is opt-in and origin-scoped. A legacy config that
        // only had allowExternalOpen=true is migrated safely to disabled until
        // the administrator explicitly names the destinations it trusts.
        allowExternalOpen: merged.allowExternalOpen === true && normalizeTrustedExternalOrigins(merged.allowedExternalOrigins).length > 0,
        allowedExternalOrigins: normalizeTrustedExternalOrigins(merged.allowedExternalOrigins),
        sandbox: merged.sandbox !== false,
        stealthSecret: typeof merged.stealthSecret === 'string' ? merged.stealthSecret.trim() : (env.PIVOT_STEALTH_SECRET || ''),
        autoUpdate: normalizeAutoUpdate(merged.autoUpdate, env, { remoteUrl }),
        source: meta.source || 'default',
        path: meta.path || ''
    };
}

function loadDesktopConfig(app, argv = process.argv, env = process.env) {
    const candidates = candidateConfigPaths(app, argv, env);
    const selected = candidates.find(item => existingFile(item.path));
    if (!selected) return normalizeConfig(DEFAULT_CONFIG, { source: 'default', path: '' }, env);
    const raw = readJsonFile(selected.path);
    return normalizeConfig(raw, selected, env);
}

module.exports = {
    DEFAULT_CONFIG,
    DEFAULT_AUTO_UPDATE,
    candidateConfigPaths,
    getUserConfigPath,
    loadDesktopConfig,
    normalizeAutoUpdate,
    normalizeConfig,
    normalizeRemoteUrl,
    normalizeTrustedExternalOrigins,
    normalizeUpdatePath,
    resolveUpdateUrlFromRemote,
    saveUserDesktopConfig
};
