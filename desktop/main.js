const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const path = require('path');
const { app, BrowserWindow, dialog, ipcMain, Menu, shell } = require('electron');
const { loadDesktopConfig } = require('./config');
const { setupAutoUpdater } = require('./updater');

let mainWindow = null;
let pivotServer = null;
let runtimeConfig = null;
let currentTargetUrl = '';
let lastLoadError = null;
let updaterController = null;

function randomSecret() {
    return crypto.randomBytes(48).toString('hex');
}

function readJson(filePath) {
    try {
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (_err) {
        return {};
    }
}

function writeJson(filePath, value) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf8');
}

function findAvailablePort() {
    return new Promise((resolve, reject) => {
        const probe = net.createServer();
        probe.unref();
        probe.on('error', reject);
        probe.listen(0, () => {
            const address = probe.address();
            const port = address && typeof address === 'object' ? address.port : 0;
            probe.close(() => {
                if (!port) {
                    reject(new Error('分配本地服务端口失败。'));
                    return;
                }
                resolve(port);
            });
        });
    });
}

function windowTitle(config) {
    const env = config && config.environmentName ? config.environmentName : '';
    const base = config && typeof config.windowTitle === 'string' ? config.windowTitle : 'Pivot';
    return env && base ? base + ' - ' + env : (base || env);
}



async function loadErrorPage(message) {
    if (!mainWindow) return;
    try {
        await mainWindow.loadFile(path.join(__dirname, 'error.html'), {
            query: {
                message: message || '连接失败。',
                env: runtimeConfig && runtimeConfig.environmentName ? runtimeConfig.environmentName : '',
                target: currentTargetUrl || ''
            }
        });
    } catch (err) {
        console.error('加载错误页面失败:', err);
    }
}

async function configureLocalEnvironment() {
    const userData = app.getPath('userData');
    const secretsPath = path.join(userData, 'desktop-secrets.json');
    const secrets = readJson(secretsPath);
    let changed = false;

    if (!secrets.jwtSecret) {
        secrets.jwtSecret = randomSecret();
        changed = true;
    }
    if (!secrets.dataEncryptionKey) {
        secrets.dataEncryptionKey = randomSecret();
        changed = true;
    }
    if (changed) writeJson(secretsPath, secrets);

    process.env.PIVOT_DESKTOP = 'true';
    process.env.NODE_ENV = process.env.NODE_ENV || 'production';
    process.env.PORT = process.env.PORT || process.env.PIVOT_DESKTOP_PORT || String(await findAvailablePort());
    process.env.JWT_SECRET = process.env.JWT_SECRET || secrets.jwtSecret;
    process.env.DATA_ENCRYPTION_KEY = process.env.DATA_ENCRYPTION_KEY || secrets.dataEncryptionKey;
    process.env.DATA_DIR = process.env.DATA_DIR || path.join(userData, 'data');
    process.env.PIVOT_UPLOAD_DIR = process.env.PIVOT_UPLOAD_DIR || path.join(userData, 'uploads');
    process.env.PIVOT_ANALYSIS_DIR = process.env.PIVOT_ANALYSIS_DIR || path.join(userData, 'data', 'analysis');
    process.env.LOG_DIR = process.env.LOG_DIR || path.join(userData, 'logs');
}

function waitForServer(server) {
    return new Promise((resolve, reject) => {
        const address = server.address();
        if (server.listening && address && typeof address === 'object') {
            resolve(address.port);
            return;
        }
        server.once('listening', () => {
            const currentAddress = server.address();
            if (!currentAddress || typeof currentAddress !== 'object') {
                reject(new Error('Pivot 服务未暴露可用端口。'));
                return;
            }
            resolve(currentAddress.port);
        });
        server.once('error', reject);
    });
}

async function startLocalServer() {
    await configureLocalEnvironment();
    const exported = require('../server/index.js');
    pivotServer = exported.server;
    if (!pivotServer) throw new Error('Pivot 服务启动失败：缺少 HTTP 服务器实例。');
    const port = await waitForServer(pivotServer);
    return 'http://127.0.0.1:' + port + '/';
}

async function resolveTargetUrl(config) {
    if (config.mode === 'remote') return config.remoteUrl;
    return startLocalServer();
}

function shouldOpenExternal(targetUrl) {
    if (!runtimeConfig || !runtimeConfig.allowExternalOpen) return false;
    if (!currentTargetUrl) return true;
    try {
        const target = new URL(targetUrl);
        const current = new URL(currentTargetUrl);
        return target.origin !== current.origin;
    } catch (_err) {
        return true;
    }
}

function createMainWindow(config) {
    mainWindow = new BrowserWindow({
        width: 1320,
        height: 860,
        minWidth: 1100,
        minHeight: 720,
        show: false,
        title: windowTitle(config),
        backgroundColor: '#0f172a',
        icon: path.join(__dirname, 'icon.ico'),
        webPreferences: {
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: false,
            preload: path.join(__dirname, 'preload.js'),
            partition: config.partition
        }
    });

    mainWindow.once('ready-to-show', () => {
        mainWindow.show();
    });
    mainWindow.webContents.setWindowOpenHandler(({ url: targetUrl }) => {
        if (shouldOpenExternal(targetUrl)) shell.openExternal(targetUrl);
        return { action: 'deny' };
    });
    mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedUrl, isMainFrame) => {
        if (!isMainFrame || !mainWindow || String(validatedUrl || '').startsWith('file://')) return;
        lastLoadError = { errorCode, errorDescription, validatedUrl };
        loadErrorPage(errorDescription + ' (' + errorCode + ')');
    });
    mainWindow.webContents.on('page-title-updated', (event) => {
        event.preventDefault();
        if (mainWindow) mainWindow.setTitle(windowTitle(config));
    });
    mainWindow.on('closed', () => {
        mainWindow = null;
    });
}

async function loadTarget() {
    if (!mainWindow) return;
    if (!currentTargetUrl) currentTargetUrl = await resolveTargetUrl(runtimeConfig);
    try {
        await mainWindow.loadURL(currentTargetUrl);
    } catch (err) {
        if (!mainWindow || mainWindow.isDestroyed()) return;
        const message = err && err.message ? err.message : String(err);
        lastLoadError = {
            errorCode: 'LOAD_FAILED',
            errorDescription: message,
            validatedUrl: currentTargetUrl
        };
        await loadErrorPage(message);
    }
}

async function shutdownServer() {
    if (!pivotServer) return;
    await new Promise((resolve) => {
        pivotServer.close(() => resolve());
        setTimeout(resolve, 3000).unref();
    });
    pivotServer = null;
}

ipcMain.handle('pivot-desktop:retry', async () => {
    lastLoadError = null;
    await loadTarget();
    return true;
});

ipcMain.handle('pivot-desktop:status', async () => ({
    config: runtimeConfig,
    targetUrl: currentTargetUrl,
    lastLoadError,
    updateState: updaterController ? updaterController.getState() : { enabled: false, status: 'not-ready' }
}));

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
    app.quit();
} else {
    app.on('second-instance', () => {
        if (!mainWindow) return;
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.focus();
    });

    app.whenReady().then(async () => {
        app.setAppUserModelId('com.pivot.desktop');
        Menu.setApplicationMenu(null);
        try {
            runtimeConfig = loadDesktopConfig(app);
            createMainWindow(runtimeConfig);
            await loadTarget();
            updaterController = setupAutoUpdater({ app, mainWindow, config: runtimeConfig });
        } catch (err) {
            dialog.showErrorBox('Pivot 启动失败', err && err.stack ? err.stack : String(err));
            app.quit();
        }
    });

    app.on('before-quit', (event) => {
        if (!pivotServer) return;
        event.preventDefault();
        shutdownServer().finally(() => app.exit(0));
    });

    app.on('window-all-closed', () => {
        app.quit();
    });
}
