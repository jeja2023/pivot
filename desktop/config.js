const fs = require('fs');
const path = require('path');

const DEFAULT_AUTO_UPDATE = {
    enabled: false,
    url: '',
    checkOnStart: true,
    autoDownload: true,
    allowPrerelease: false,
    installOnQuit: true
};

const DEFAULT_CONFIG = {
    mode: 'local',
    environmentName: 'Local',
    remoteUrl: '',
    partition: '',
    windowTitle: '智枢 Pivot',
    allowExternalOpen: true,
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

function candidateConfigPaths(app, argv = process.argv, env = process.env) {
    const explicitArg = normalizePath(getArgValue(argv, '--config'));
    const explicitEnv = normalizePath(env.PIVOT_DESKTOP_CONFIG);
    const executableDir = getExecutableDir(app);
    const resourceDir = getResourceDir(app);
    return [
        { source: 'cli', path: explicitArg },
        { source: 'env', path: explicitEnv },
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

function normalizeUpdateUrl(value, required) {
    const normalized = normalizeHttpUrl(value, 'config.autoUpdate.url', required);
    if (!normalized) return '';
    const url = new URL(normalized);
    if (!url.pathname.endsWith('/')) url.pathname += '/';
    return url.toString();
}

function normalizeAutoUpdate(value) {
    const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    const merged = { ...DEFAULT_AUTO_UPDATE, ...source };
    const enabled = merged.enabled === true;
    return {
        enabled,
        url: normalizeUpdateUrl(merged.url, enabled),
        checkOnStart: merged.checkOnStart !== false,
        autoDownload: merged.autoDownload !== false,
        allowPrerelease: merged.allowPrerelease === true,
        installOnQuit: merged.installOnQuit !== false
    };
}

function normalizeConfig(raw, meta = {}) {
    const input = raw || {};
    const merged = { ...DEFAULT_CONFIG, ...input };
    const mode = normalizeMode(merged.mode);
    const environmentName = typeof input.environmentName === 'string' ? input.environmentName.trim() : (mode === 'remote' ? 'Remote' : 'Local');
    const config = {
        mode,
        environmentName,
        remoteUrl: '',
        partition: normalizePartition(merged.partition, mode, environmentName),
        windowTitle: typeof merged.windowTitle === 'string' ? merged.windowTitle.trim() : '智枢 Pivot',
        allowExternalOpen: merged.allowExternalOpen !== false,
        autoUpdate: normalizeAutoUpdate(merged.autoUpdate),
        source: meta.source || 'default',
        path: meta.path || ''
    };
    if (mode === 'remote') config.remoteUrl = normalizeRemoteUrl(merged.remoteUrl);
    return config;
}

function loadDesktopConfig(app, argv = process.argv, env = process.env) {
    const candidates = candidateConfigPaths(app, argv, env);
    const selected = candidates.find(item => existingFile(item.path));
    if (!selected) return normalizeConfig(DEFAULT_CONFIG, { source: 'default', path: '' });
    const raw = readJsonFile(selected.path);
    return normalizeConfig(raw, selected);
}

module.exports = {
    DEFAULT_CONFIG,
    DEFAULT_AUTO_UPDATE,
    candidateConfigPaths,
    loadDesktopConfig,
    normalizeAutoUpdate,
    normalizeConfig,
    normalizeRemoteUrl
};
