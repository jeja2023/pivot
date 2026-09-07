let electron = null;
try {
    electron = require('electron');
} catch (_) {}

const BrowserWindow = electron?.BrowserWindow;
const ipcMain = electron?.ipcMain;
const path = require('path');

let statusWindow = null;
let ipcRegistered = false;
let currentGetStatus = null;
let currentOnConfigureDirectory = null;
let currentOnRevokeDirectory = null;

function openDeliveryStatusWindow(options = {}) {
    if (!BrowserWindow) {
        throw new Error('当前运行环境不支持 BrowserWindow');
    }
    const getStatus = typeof options.getStatus === 'function' ? options.getStatus : () => ({});
    const getParentWindow = typeof options.getParentWindow === 'function' ? options.getParentWindow : () => undefined;
    const onConfigureDirectory = typeof options.onConfigureDirectory === 'function' ? options.onConfigureDirectory : async () => {};
    const onRevokeDirectory = typeof options.onRevokeDirectory === 'function' ? options.onRevokeDirectory : async () => false;

    currentGetStatus = getStatus;
    currentOnConfigureDirectory = onConfigureDirectory;
    currentOnRevokeDirectory = onRevokeDirectory;

    if (!ipcRegistered && typeof ipcMain?.handle === 'function') {
        ipcRegistered = true;
        ipcMain.handle('pivot-delivery-status:close', (event) => {
            const win = BrowserWindow.fromWebContents(event.sender);
            if (win && !win.isDestroyed()) win.close();
            return true;
        });
        ipcMain.handle('pivot-delivery-status:get-status', async () => {
            return typeof currentGetStatus === 'function' ? currentGetStatus() : {};
        });
        ipcMain.handle('pivot-delivery-status:configure-directory', async () => {
            return typeof currentOnConfigureDirectory === 'function' ? await currentOnConfigureDirectory() : undefined;
        });
        ipcMain.handle('pivot-delivery-status:revoke-directory', async (_event, grantId) => {
            return typeof currentOnRevokeDirectory === 'function' ? await currentOnRevokeDirectory(grantId) : false;
        });
    }

    if (statusWindow && !statusWindow.isDestroyed()) {
        statusWindow.focus();
        return statusWindow;
    }

    const parent = getParentWindow();
    statusWindow = new BrowserWindow({
        width: 580,
        height: 640,
        resizable: false,
        maximizable: false,
        minimizable: false,
        fullscreenable: false,
        show: false,
        frame: false,
        modal: Boolean(parent),
        parent: parent || undefined,
        title: '受控文件交付状态',
        backgroundColor: '#ffffff',
        autoHideMenuBar: true,
        webPreferences: {
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
            preload: path.join(__dirname, '..', 'delivery-status-preload.js')
        }
    });

    statusWindow.once('ready-to-show', () => {
        if (statusWindow && !statusWindow.isDestroyed()) statusWindow.show();
    });

    statusWindow.on('closed', () => {
        statusWindow = null;
    });

    const initialState = getStatus();
    statusWindow.loadFile(path.join(__dirname, '..', 'delivery-status.html'), {
        query: {
            initialState: JSON.stringify(initialState)
        }
    }).catch((err) => {
        console.error('加载受控交付状态窗口失败:', err);
        if (statusWindow && !statusWindow.isDestroyed()) statusWindow.close();
    });

    return statusWindow;
}

let grantWindow = null;
let grantIpcRegistered = false;
let currentGrantData = null;
let currentOnViewStatus = null;

function openDeliveryGrantWindow(grant = {}, options = {}) {
    if (!BrowserWindow) {
        throw new Error('当前运行环境不支持 BrowserWindow');
    }
    const getParentWindow = typeof options.getParentWindow === 'function' ? options.getParentWindow : () => undefined;
    const onViewStatus = typeof options.onViewStatus === 'function' ? options.onViewStatus : null;

    currentGrantData = grant || {};
    currentOnViewStatus = onViewStatus;

    if (!grantIpcRegistered && typeof ipcMain?.handle === 'function') {
        grantIpcRegistered = true;
        ipcMain.handle('pivot-delivery-grant:close', (event) => {
            const win = BrowserWindow.fromWebContents(event.sender);
            if (win && !win.isDestroyed()) win.close();
            return true;
        });
        ipcMain.handle('pivot-delivery-grant:get-data', async () => {
            return currentGrantData || {};
        });
        ipcMain.handle('pivot-delivery-grant:view-status', async (event) => {
            const win = BrowserWindow.fromWebContents(event.sender);
            if (win && !win.isDestroyed()) win.close();
            if (typeof currentOnViewStatus === 'function') {
                try {
                    await currentOnViewStatus();
                } catch (e) {
                    console.error('跳转查看受控交付状态失败:', e);
                }
            }
            return true;
        });
    }

    if (grantWindow && !grantWindow.isDestroyed()) {
        grantWindow.focus();
        return grantWindow;
    }

    const parent = getParentWindow();
    grantWindow = new BrowserWindow({
        width: 500,
        height: 440,
        resizable: false,
        maximizable: false,
        minimizable: false,
        fullscreenable: false,
        show: false,
        frame: false,
        modal: Boolean(parent),
        parent: parent || undefined,
        title: '受控文件交付目录已授权',
        backgroundColor: '#ffffff',
        autoHideMenuBar: true,
        webPreferences: {
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
            preload: path.join(__dirname, '..', 'delivery-grant-preload.js')
        }
    });

    grantWindow.once('ready-to-show', () => {
        if (grantWindow && !grantWindow.isDestroyed()) grantWindow.show();
    });

    grantWindow.on('closed', () => {
        grantWindow = null;
    });

    grantWindow.loadFile(path.join(__dirname, '..', 'delivery-grant.html'), {
        query: {
            grant: JSON.stringify(grant || {})
        }
    }).catch((err) => {
        console.error('加载受控目录授权窗口失败:', err);
        if (grantWindow && !grantWindow.isDestroyed()) grantWindow.close();
    });

    return grantWindow;
}

module.exports = { openDeliveryStatusWindow, openDeliveryGrantWindow };
