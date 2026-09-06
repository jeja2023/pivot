const { assertAllowedUpdateFeedUrl } = require('./update-policy');

let activeController = null;
let activeAuthorizeIpc = null;
let ipcRegistered = false;

function getElectronModule() {
    try {
        const electron = require('electron');
        return electron && typeof electron === 'object' ? electron : null;
    } catch (_) {
        return null;
    }
}

function getAutoUpdater() {
    try {
        const updaterModule = require('electron-updater');
        return updaterModule?.autoUpdater || null;
    } catch (_) {
        return null;
    }
}

function serializeError(error) {
    if (!error) return '';
    if (error.message) return String(error.message);
    return String(error);
}

function serializeUpdateInfo(info) {
    if (!info) return null;
    return {
        version: info.version || '',
        releaseName: info.releaseName || '',
        releaseDate: info.releaseDate || '',
        releaseNotes: typeof info.releaseNotes === 'string' ? info.releaseNotes : ''
    };
}

function serializeProgress(progress) {
    if (!progress) return null;
    return {
        percent: Number(progress.percent || 0),
        bytesPerSecond: Number(progress.bytesPerSecond || 0),
        transferred: Number(progress.transferred || 0),
        total: Number(progress.total || 0)
    };
}

function showUpdateDialog(mainWindow, options) {
    const electron = getElectronModule();
    if (!electron?.dialog) return Promise.resolve({ response: 1 });
    if (mainWindow && !mainWindow.isDestroyed()) {
        return electron.dialog.showMessageBox(mainWindow, options);
    }
    return electron.dialog.showMessageBox(options);
}

function createInitialState(app, updateConfig) {
    return {
        enabled: updateConfig.enabled === true,
        status: updateConfig.enabled === true ? 'idle' : 'disabled',
        currentVersion: typeof app?.getVersion === 'function' ? app.getVersion() : '0.0.0',
        updateUrl: updateConfig.url || '',
        updatePath: updateConfig.path || '',
        checkIntervalMinutes: Number.isFinite(Number(updateConfig.checkIntervalMinutes))
            ? Math.max(0, Math.floor(Number(updateConfig.checkIntervalMinutes)))
            : 30,
        allowInsecureHttp: updateConfig.allowInsecureHttp === true,
        error: '',
        updateInfo: null,
        progress: null,
        checkedAt: ''
    };
}

function registerIpcHandlers() {
    if (ipcRegistered) return;
    const electron = getElectronModule();
    const ipcMain = electron?.ipcMain;
    if (!ipcMain) return;
    ipcRegistered = true;
    const authorize = (event) => activeAuthorizeIpc?.(event);
    ipcMain.handle('pivot-updater:status', async (event) => (
        authorize(event),
        activeController ? activeController.getState() : { enabled: false, status: 'not-ready' }
    ));
    ipcMain.handle('pivot-updater:check', async (event) => (
        authorize(event),
        activeController ? activeController.checkForUpdates(true) : { enabled: false, status: 'not-ready' }
    ));
    ipcMain.handle('pivot-updater:download', async (event) => (
        authorize(event),
        activeController ? activeController.downloadUpdate() : { enabled: false, status: 'not-ready' }
    ));
    ipcMain.handle('pivot-updater:install', async (event) => {
        authorize(event);
        if (!activeController) return { enabled: false, status: 'not-ready' };
        return activeController.installUpdate();
    });
}

function setupAutoUpdater({ app, mainWindow, config, authorizeIpc, autoUpdater: injectedUpdater }) {
    const updateConfig = config.autoUpdate || {};
    let state = createInitialState(app, updateConfig);
    const autoUpdater = injectedUpdater || getAutoUpdater();
    let startTimer = null;
    let initialRetryTimer = null;
    let checkIntervalTimer = null;
    let lastCheckTime = 0;

    function emitState(patch) {
        state = {
            ...state,
            ...patch,
            checkedAt: new Date().toISOString()
        };
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('pivot-updater:event', state);
        }
        return state;
    }

    function getState() {
        return { ...state };
    }

    async function checkForUpdates(manual = false) {
        if (!state.enabled) return getState();
        if (!app.isPackaged) {
            return emitState({
                enabled: false,
                status: 'disabled',
                error: '自动更新只在已打包的 Windows 客户端中运行。'
            });
        }
        if (state.status === 'checking' || state.status === 'downloading') {
            return getState();
        }
        try {
            lastCheckTime = Date.now();
            if (manual) emitState({ status: 'checking', error: '', progress: null });
            if (autoUpdater?.checkForUpdates) await autoUpdater.checkForUpdates();
        } catch (error) {
            emitState({ status: 'error', error: serializeError(error) });
        }
        return getState();
    }

    async function downloadUpdate() {
        if (!state.enabled) return getState();
        try {
            emitState({ status: 'downloading', error: '' });
            if (autoUpdater?.downloadUpdate) await autoUpdater.downloadUpdate();
        } catch (error) {
            emitState({ status: 'error', error: serializeError(error) });
        }
        return getState();
    }

    function installUpdate() {
        if (state.status === 'downloaded' && autoUpdater?.quitAndInstall) {
            autoUpdater.quitAndInstall(false, true);
        }
        return getState();
    }

    function handleWindowFocus() {
        if (!state.enabled || !app.isPackaged) return;
        if (state.status === 'checking' || state.status === 'downloading') return;
        const fifteenMinutes = 15 * 60 * 1000;
        if (Date.now() - lastCheckTime >= fifteenMinutes) {
            checkForUpdates(false);
        }
    }

    function destroy() {
        if (startTimer) clearTimeout(startTimer);
        if (initialRetryTimer) clearTimeout(initialRetryTimer);
        if (checkIntervalTimer) clearInterval(checkIntervalTimer);
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.removeListener('focus', handleWindowFocus);
        }
    }

    activeAuthorizeIpc = typeof authorizeIpc === 'function' ? authorizeIpc : null;
    registerIpcHandlers();
    activeController = { getState, checkForUpdates, downloadUpdate, installUpdate, destroy };

    if (!updateConfig.enabled) return activeController;

    if (!app.isPackaged) {
        emitState({
            enabled: false,
            status: 'disabled',
            error: '自动更新只在已打包的 Windows 客户端中运行。'
        });
        return activeController;
    }

    const feedUrl = assertAllowedUpdateFeedUrl(updateConfig.url, {
        allowedOrigins: updateConfig.allowedOrigins || [],
        allowInsecureHttp: updateConfig.allowInsecureHttp === true,
        env: process.env
    });

    if (autoUpdater && typeof autoUpdater.on === 'function') {
        autoUpdater.autoDownload = updateConfig.autoDownload !== false;
        autoUpdater.allowPrerelease = updateConfig.allowPrerelease === true;
        autoUpdater.autoInstallOnAppQuit = updateConfig.installOnQuit !== false;
        if (typeof autoUpdater.setFeedURL === 'function') {
            autoUpdater.setFeedURL({ provider: 'generic', url: feedUrl });
        }

        autoUpdater.on('checking-for-update', () => {
            emitState({ status: 'checking', error: '', progress: null });
        });
        autoUpdater.on('update-available', (info) => {
            emitState({ status: 'available', updateInfo: serializeUpdateInfo(info), error: '', progress: null });
        });
        autoUpdater.on('update-not-available', (info) => {
            emitState({ status: 'not-available', updateInfo: serializeUpdateInfo(info), error: '', progress: null });
        });
        autoUpdater.on('download-progress', (progress) => {
            emitState({ status: 'downloading', progress: serializeProgress(progress), error: '' });
        });
        autoUpdater.on('update-downloaded', async (info) => {
            emitState({ status: 'downloaded', updateInfo: serializeUpdateInfo(info), progress: null, error: '' });
            const version = info && info.version ? info.version : '新版本';
            const result = await showUpdateDialog(mainWindow, {
                type: 'info',
                title: 'Pivot 更新已就绪',
                message: 'Pivot ' + version + ' 已下载完成。',
                detail: '重启 Pivot 后会安装更新。继续前请先保存未完成的工作。',
                buttons: ['重启并安装', '稍后'],
                defaultId: 0,
                cancelId: 1
            });
            if (result.response === 0 && autoUpdater.quitAndInstall) autoUpdater.quitAndInstall(false, true);
        });
        autoUpdater.on('error', (error) => {
            emitState({ status: 'error', error: serializeError(error) });
        });
    }

    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.on('focus', handleWindowFocus);
    }

    if (updateConfig.checkOnStart !== false) {
        startTimer = setTimeout(async () => {
            const res = await checkForUpdates(false);
            if (res && res.status === 'error') {
                initialRetryTimer = setTimeout(() => {
                    checkForUpdates(false);
                }, 30000);
                if (initialRetryTimer.unref) initialRetryTimer.unref();
            }
        }, 5000);
        if (startTimer.unref) startTimer.unref();
    }

    const intervalMinutes = Number.isFinite(Number(updateConfig.checkIntervalMinutes))
        ? Math.max(0, Math.floor(Number(updateConfig.checkIntervalMinutes)))
        : 30;
    if (intervalMinutes > 0) {
        const intervalMs = intervalMinutes * 60 * 1000;
        checkIntervalTimer = setInterval(() => {
            checkForUpdates(false);
        }, intervalMs);
        if (checkIntervalTimer.unref) checkIntervalTimer.unref();
    }

    return activeController;
}

module.exports = {
    setupAutoUpdater
};
