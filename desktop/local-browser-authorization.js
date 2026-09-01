/** 本机浏览器授权选择与脱敏展示；可执行路径始终只保存在桌面端授权文件。 */
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const LOCAL_BROWSER_ENGINES = new Set(['chromium', 'firefox']);

function normalizeLocalBrowserAllowedOrigins(value) {
    const entries = Array.isArray(value) ? value : String(value || '').split(/[\n,]/);
    const origins = [];
    for (const entry of entries) {
        if (origins.length >= 32) break;
        try {
            const parsed = new URL(String(entry || '').trim());
            if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) continue;
            const origin = parsed.origin.toLowerCase();
            if (!origins.includes(origin)) origins.push(origin);
        } catch (_) {}
    }
    return origins;
}

function resolveMacBrowserExecutable(selectedPath, platform = process.platform) {
    if (platform !== 'darwin' || !String(selectedPath).toLowerCase().endsWith('.app')) return selectedPath;
    const appName = path.basename(selectedPath, '.app');
    const candidates = [
        path.join(selectedPath, 'Contents', 'MacOS', appName),
        path.join(selectedPath, 'Contents', 'MacOS', 'Google Chrome'),
        path.join(selectedPath, 'Contents', 'MacOS', 'Microsoft Edge'),
        path.join(selectedPath, 'Contents', 'MacOS', 'Brave Browser'),
        path.join(selectedPath, 'Contents', 'MacOS', 'firefox')
    ];
    return candidates.find(candidate => { try { return fs.statSync(candidate).isFile(); } catch (_) { return false; } }) || '';
}

function browserEngineForExecutable(executablePath) {
    return /firefox/i.test(path.basename(executablePath || '')) ? 'firefox' : 'chromium';
}

function normalizeAuthorizedBrowser(executablePath, platform = process.platform) {
    const resolved = path.resolve(resolveMacBrowserExecutable(executablePath, platform));
    let stat;
    try { stat = fs.statSync(resolved); } catch (_) { return null; }
    if (!stat.isFile() || (platform === 'win32' && path.extname(resolved).toLowerCase() !== '.exe')) return null;
    const engine = browserEngineForExecutable(resolved);
    const base = path.basename(resolved, path.extname(resolved));
    const id = `browser-${engine}-${crypto.createHash('sha256').update(resolved.toLowerCase()).digest('hex').slice(0, 16)}`;
    return { id, label: base.slice(0, 120) || (engine === 'firefox' ? 'Firefox' : 'Chromium 浏览器'), engine, executablePath: resolved };
}

function sanitizeLocalBrowserGrant(grant, deviceName = os.hostname()) {
    if (!grant || typeof grant !== 'object') return { type: 'local_browser', authorized: false };
    const browsers = Array.isArray(grant.browsers) ? grant.browsers.slice(0, 12).map(browser => ({
        id: String(browser?.id || '').slice(0, 80),
        label: String(browser?.label || '').slice(0, 120),
        engine: String(browser?.engine || '').slice(0, 20)
    })).filter(browser => browser.id && browser.label && LOCAL_BROWSER_ENGINES.has(browser.engine)) : [];
    return {
        type: 'local_browser',
        authorized: browsers.length > 0,
        resourceKind: 'browser_automation',
        label: grant.label || `${browsers.length} 个已授权浏览器`,
        pathHint: '',
        browsers,
        allowedOrigins: normalizeLocalBrowserAllowedOrigins(grant.allowedOrigins),
        provider: grant.provider || 'desktop',
        deviceName: grant.deviceName || deviceName,
        grantedAt: grant.grantedAt || '',
        updatedAt: grant.updatedAt || grant.grantedAt || ''
    };
}

async function chooseLocalBrowserAuthorization(options = {}, deps = {}) {
    const allowedOrigins = normalizeLocalBrowserAllowedOrigins(options.allowedOrigins || options.allowed_origins);
    if (!allowedOrigins.length) {
        const error = new Error('本机浏览器授权至少需要填写一个允许访问的站点 Origin。');
        error.code = 'LOCAL_BROWSER_ORIGIN_REQUIRED';
        throw error;
    }
    if (typeof deps.showDialog !== 'function' || typeof deps.readStore !== 'function') {
        throw new Error('本机浏览器授权依赖未就绪。');
    }
    const platform = deps.platform || process.platform;
    const result = await deps.showDialog({
        title: '选择允许 Pivot 自动化的浏览器（可多选）',
        properties: platform === 'darwin' ? ['openFile', 'openDirectory', 'multiSelections'] : ['openFile', 'multiSelections'],
        filters: platform === 'win32' ? [{ name: '浏览器程序', extensions: ['exe'] }] : undefined
    });
    if (result.canceled || !result.filePaths?.length) return null;
    const selected = result.filePaths.map(item => normalizeAuthorizedBrowser(item, platform)).filter(Boolean);
    if (!selected.length) {
        const error = new Error('未选择可用的浏览器可执行文件。');
        error.code = 'LOCAL_BROWSER_EXECUTABLE_INVALID';
        throw error;
    }
    const existing = deps.readStore().grants?.local_browser;
    const known = Array.isArray(existing?.browsers) ? existing.browsers : [];
    const browsers = [...known, ...selected]
        .filter((browser, index, list) => browser?.id && list.findIndex(item => item?.id === browser.id) === index)
        .slice(0, 12);
    const now = new Date().toISOString();
    return {
        resourceKind: 'browser_automation',
        label: `${browsers.length} 个已授权浏览器`,
        browsers,
        allowedOrigins,
        provider: 'desktop',
        deviceName: deps.deviceName || os.hostname(),
        grantedAt: existing?.grantedAt || now,
        updatedAt: now
    };
}

module.exports = {
    LOCAL_BROWSER_ENGINES,
    chooseLocalBrowserAuthorization,
    normalizeAuthorizedBrowser,
    normalizeLocalBrowserAllowedOrigins,
    sanitizeLocalBrowserGrant
};
