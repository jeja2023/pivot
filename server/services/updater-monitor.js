const { logger } = require('../logger');
const { getAppVersion } = require('../version');
const { getUpdaterPublicConfig, requestUpdater } = require('./updater-client');

const DEFAULT_INTERVAL_MS = 30 * 60 * 1000;
const MIN_INTERVAL_MS = 5 * 60 * 1000;

let cache = {
    enabled: false,
    checking: false,
    updateAvailable: false,
    remoteChanged: false,
    currentVersion: '',
    currentRevision: '',
    latestVersion: '',
    latestRevision: '',
    repository: '',
    branch: '',
    lastCheckedAt: '',
    nextCheckAt: '',
    error: ''
};

function parseIntervalMs() {
    const raw = Number.parseInt(process.env.PIVOT_UPDATE_CHECK_INTERVAL_MS || String(DEFAULT_INTERVAL_MS), 10);
    if (!Number.isFinite(raw) || raw <= 0) return 0;
    return Math.max(raw, MIN_INTERVAL_MS);
}

function compareVersion(a, b) {
    const left = String(a || '').replace(/^v/i, '').split(/[.+-]/).map(part => Number.parseInt(part, 10));
    const right = String(b || '').replace(/^v/i, '').split(/[.+-]/).map(part => Number.parseInt(part, 10));
    const len = Math.max(left.length, right.length, 3);
    for (let i = 0; i < len; i += 1) {
        const x = Number.isFinite(left[i]) ? left[i] : 0;
        const y = Number.isFinite(right[i]) ? right[i] : 0;
        if (x > y) return 1;
        if (x < y) return -1;
    }
    return 0;
}

function computeUpdateState({ currentVersion, currentRevision, latestVersion, latestRevision }) {
    const versionCompare = compareVersion(latestVersion, currentVersion);
    const remoteChanged = !!(currentRevision && latestRevision && currentRevision !== latestRevision);
    return {
        updateAvailable: versionCompare > 0 || (versionCompare === 0 && remoteChanged),
        remoteChanged
    };
}

function setNextCheck(intervalMs) {
    cache.nextCheckAt = intervalMs > 0 ? new Date(Date.now() + intervalMs).toISOString() : '';
}

async function checkForUpdates({ manual = false } = {}) {
    const config = getUpdaterPublicConfig();
    const intervalMs = parseIntervalMs();
    cache = {
        ...cache,
        ...config,
        enabled: config.enabled,
        checking: true,
        currentVersion: getAppVersion(),
        currentRevision: process.env.PIVOT_BUILD_REVISION || '',
        error: ''
    };
    if (!config.enabled) {
        cache.checking = false;
        cache.lastCheckedAt = '';
        cache.nextCheckAt = '';
        cache.updateAvailable = false;
        return cache;
    }
    try {
        const data = await requestUpdater('/check', {
            method: 'POST',
            body: {
                currentVersion: cache.currentVersion,
                repository: config.repository,
                branch: config.branch
            }
        });
        const state = computeUpdateState({
            currentVersion: cache.currentVersion,
            currentRevision: cache.currentRevision,
            latestVersion: data.latestVersion,
            latestRevision: data.revision
        });
        cache = {
            ...cache,
            checking: false,
            latestVersion: data.latestVersion || '',
            latestRevision: data.revision || '',
            repository: data.repository || config.repository || '',
            branch: data.branch || config.branch || '',
            lastCheckedAt: new Date().toISOString(),
            error: '',
            ...state
        };
        setNextCheck(intervalMs);
        if (cache.updateAvailable) {
            logger.info({
                currentVersion: cache.currentVersion,
                latestVersion: cache.latestVersion,
                currentRevision: cache.currentRevision,
                latestRevision: cache.latestRevision,
                manual
            }, '检测到可用在线更新');
        }
    } catch (e) {
        cache = {
            ...cache,
            checking: false,
            lastCheckedAt: new Date().toISOString(),
            error: e.message || '自动检查更新失败'
        };
        setNextCheck(intervalMs);
        logger.warn({ err: e.message, manual }, '在线更新检查失败');
    }
    return cache;
}

function getUpdaterMonitorStatus() {
    return {
        ...cache,
        intervalMs: parseIntervalMs()
    };
}

function startUpdaterMonitor() {
    const intervalMs = parseIntervalMs();
    const config = getUpdaterPublicConfig();
    cache = {
        ...cache,
        ...config,
        enabled: config.enabled,
        currentVersion: getAppVersion(),
        currentRevision: process.env.PIVOT_BUILD_REVISION || ''
    };
    if (!config.enabled || intervalMs <= 0) return;
    setNextCheck(intervalMs);
    setTimeout(() => checkForUpdates().catch(() => {}), 15000);
    const monitorTimer = setInterval(() => checkForUpdates().catch(() => {}), intervalMs);
    monitorTimer.unref?.();
}

module.exports = {
    checkForUpdates,
    compareVersion,
    computeUpdateState,
    getUpdaterMonitorStatus,
    startUpdaterMonitor
};
