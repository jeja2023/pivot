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

function openDeliveryStatusWindow(options = {}) {
    if (!BrowserWindow) {
        throw new Error('当前运行环境不支持 BrowserWindow');
    }
    const getStatus = typeof options.getStatus === 'function' ? options.getStatus : () => ({});
    const getParentWindow = typeof options.getParentWindow === 'function' ? options.getParentWindow : () => undefined;
    const onConfigureDirectory = typeof options.onConfigureDirectory === 'function' ? options.onConfigureDirectory : async () => {};

    currentGetStatus = getStatus;
    currentOnConfigureDirectory = onConfigureDirectory;

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
        title: '受控文档交付状态',
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

module.exports = { openDeliveryStatusWindow };
