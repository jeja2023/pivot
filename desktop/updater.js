const { dialog, ipcMain } = require('electron');
const { autoUpdater } = require('electron-updater');
const { assertAllowedUpdateFeedUrl } = require('./update-policy');

let activeController = null;
let activeAuthorizeIpc = null;
let ipcRegistered = false;

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
    if (mainWindow && !mainWindow.isDestroyed()) {
        return dialog.showMessageBox(mainWindow, options);
    }
    return dialog.showMessageBox(options);
}

function createInitialState(app, updateConfig) {
    return {
        enabled: updateConfig.enabled === true,
        status: updateConfig.enabled === true ? 'idle' : 'disabled',
        currentVersion: app.getVersion(),
        updateUrl: updateConfig.url || '',
        updatePath: updateConfig.path || '',
        allowInsecureHttp: updateConfig.allowInsecureHttp === true,
        error: '',
        updateInfo: null,
        progress: null,
        checkedAt: ''
    };
}

function registerIpcHandlers() {
    if (ipcRegistered) return;
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

function setupAutoUpdater({ app, mainWindow, config, authorizeIpc }) {
    const updateConfig = config.autoUpdate || {};
    let state = createInitialState(app, updateConfig);

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
        try {
            if (manual) emitState({ status: 'checking', error: '', progress: null });
            await autoUpdater.checkForUpdates();
        } catch (error) {
            emitState({ status: 'error', error: serializeError(error) });
        }
        return getState();
    }

    async function downloadUpdate() {
        if (!state.enabled) return getState();
        try {
            emitState({ status: 'downloading', error: '' });
            await autoUpdater.downloadUpdate();
        } catch (error) {
            emitState({ status: 'error', error: serializeError(error) });
        }
        return getState();
    }

    function installUpdate() {
        if (state.status === 'downloaded') {
            autoUpdater.quitAndInstall(false, true);
        }
        return getState();
    }

    activeAuthorizeIpc = typeof authorizeIpc === 'function' ? authorizeIpc : null;
    registerIpcHandlers();
    activeController = { getState, checkForUpdates, downloadUpdate, installUpdate };

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

    autoUpdater.autoDownload = updateConfig.autoDownload !== false;
    autoUpdater.allowPrerelease = updateConfig.allowPrerelease === true;
    autoUpdater.autoInstallOnAppQuit = updateConfig.installOnQuit !== false;
    autoUpdater.setFeedURL({ provider: 'generic', url: feedUrl });

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
        if (result.response === 0) autoUpdater.quitAndInstall(false, true);
    });
    autoUpdater.on('error', (error) => {
        emitState({ status: 'error', error: serializeError(error) });
    });

    if (updateConfig.checkOnStart !== false) {
        setTimeout(() => {
            checkForUpdates(false);
        }, 5000).unref();
    }

    return activeController;
}

module.exports = {
    setupAutoUpdater
};
