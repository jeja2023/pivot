const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { app, BrowserWindow, dialog, ipcMain, Menu, shell } = require('electron');

// 提前初始化桌面环境基础路径，避免引入 server 模块时因 asar 路径导致 ENOTDIR
function initEarlyDesktopEnv() {
    try {
        const userData = app.getPath('userData');
        process.env.PIVOT_DESKTOP = 'true';
        if (!process.env.LOG_DIR) process.env.LOG_DIR = path.join(userData, 'logs');
        if (!process.env.DATA_DIR) process.env.DATA_DIR = path.join(userData, 'data');
        if (!process.env.PIVOT_UPLOAD_DIR) process.env.PIVOT_UPLOAD_DIR = path.join(userData, 'uploads');
        if (!process.env.PIVOT_ANALYSIS_DIR) process.env.PIVOT_ANALYSIS_DIR = path.join(userData, 'data', 'analysis');
    } catch (_) {}
}
initEarlyDesktopEnv();

const { loadDesktopConfig } = require('./config');
const { resolveInitializedServer } = require('./local-server');
const { isTrustedRendererUrl } = require('./navigation-policy');
const { setupAutoUpdater } = require('./updater');
const { runDesktopWorker } = require('./agent-runtime');

let mainWindow = null;
let pivotServer = null;
let runtimeConfig = null;
let currentTargetUrl = '';
let lastLoadError = null;
let updaterController = null;
let aboutWindow = null;

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


async function clearDesktopCaches() {
    if (!mainWindow || mainWindow.isDestroyed()) return false;
    const webSession = mainWindow.webContents.session;
    await webSession.clearCache();
    if (typeof webSession.clearStorageData === 'function') {
        await webSession.clearStorageData({
            storages: ['appcache', 'shadercache', 'serviceworkers', 'cachestorage']
        }).catch(() => { });
    }
    return true;
}

async function reloadDesktop(options = {}) {
    if (!mainWindow || mainWindow.isDestroyed()) return false;
    if (options.clearCache === true) await clearDesktopCaches();
    lastLoadError = null;
    const currentUrl = mainWindow.webContents.getURL();
    if (!currentUrl || currentUrl.startsWith('file://')) {
        await loadTarget();
        return true;
    }
    mainWindow.webContents.reloadIgnoringCache();
    return true;
}

async function resetRendererPivotCaches() {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    await mainWindow.webContents.executeJavaScript(
        "window.PivotPwa && window.PivotPwa.reset ? window.PivotPwa.reset() : null",
        true
    ).catch(() => { });
}

async function clearCacheAndReloadDesktop() {
    await resetRendererPivotCaches();
    return reloadDesktop({ clearCache: true });
}


function desktopModeLabel(mode) {
    if (mode === 'remote') return '远程模式 (remote)';
    if (mode === 'local') return '本地模式 (local)';
    return mode || '未配置';
}

function showAboutDialog() {
    if (aboutWindow && !aboutWindow.isDestroyed()) {
        aboutWindow.focus();
        return;
    }
    const env = runtimeConfig && runtimeConfig.environmentName ? runtimeConfig.environmentName : '默认环境';
    const mode = desktopModeLabel(runtimeConfig && runtimeConfig.mode ? runtimeConfig.mode : '');
    aboutWindow = new BrowserWindow({
        width: 500,
        height: 360,
        resizable: false,
        maximizable: false,
        minimizable: false,
        fullscreenable: false,
        show: false,
        frame: false,
        modal: Boolean(mainWindow),
        parent: mainWindow || undefined,
        title: '关于 Pivot',
        backgroundColor: '#ffffff',
        autoHideMenuBar: true,
        webPreferences: {
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
            preload: path.join(__dirname, 'about-preload.js')
        }
    });
    aboutWindow.once('ready-to-show', () => aboutWindow && aboutWindow.show());
    aboutWindow.on('closed', () => {
        aboutWindow = null;
    });
    aboutWindow.loadFile(path.join(__dirname, 'about.html'), {
        query: {
            version: app.getVersion(),
            env,
            mode
        }
    }).catch((error) => {
        console.error('加载关于窗口失败:', error);
        if (aboutWindow && !aboutWindow.isDestroyed()) aboutWindow.close();
        dialog.showMessageBox(mainWindow || undefined, {
            type: 'info',
            title: '关于 Pivot',
            message: 'Pivot 智枢',
            detail: [
                '当前版本：v' + app.getVersion(),
                '运行模式：' + mode
            ].filter(Boolean).join('\n'),
            buttons: ['确定']
        });
    });
}

function runWindowAction(action) {
    if (!mainWindow || mainWindow.isDestroyed()) return false;
    const webContents = mainWindow.webContents;
    switch (action) {
        case 'zoom-reset':
            webContents.setZoomLevel(0);
            return true;
        case 'zoom-in':
            webContents.setZoomLevel(Math.min(webContents.getZoomLevel() + 0.5, 6));
            return true;
        case 'zoom-out':
            webContents.setZoomLevel(Math.max(webContents.getZoomLevel() - 0.5, -6));
            return true;
        case 'toggle-fullscreen':
            mainWindow.setFullScreen(!mainWindow.isFullScreen());
            return true;
        case 'about':
            showAboutDialog();
            return true;
        default:
            return false;
    }
}

function buildApplicationMenu() {
    const template = [
        {
            label: '页面',
            submenu: [
                { label: '刷新页面', accelerator: 'CmdOrCtrl+R', click: () => reloadDesktop() },
                { label: '清理缓存并刷新', accelerator: 'CmdOrCtrl+Shift+R', click: () => clearCacheAndReloadDesktop() }
            ]
        },
        {
            label: '显示',
            submenu: [
                { label: '实际大小', role: 'resetZoom' },
                { label: '放大', role: 'zoomIn' },
                { label: '缩小', role: 'zoomOut' },
                { type: 'separator' },
                { label: '切换全屏', accelerator: 'F11', role: 'togglefullscreen' }
            ]
        },
        {
            label: '客户端',
            submenu: [
                { label: '检查客户端更新', click: () => updaterController?.checkForUpdates?.(true) },
                { type: 'separator' },
                { label: '关于 Pivot', click: () => showAboutDialog() },
                { type: 'separator' },
                { label: '退出客户端', click: () => app.quit() }
            ]
        }
    ];
    return Menu.buildFromTemplate(template);
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
    process.env.PIVOT_LOCAL_AUTHORIZATIONS_FILE = process.env.PIVOT_LOCAL_AUTHORIZATIONS_FILE
        || path.join(userData, 'local-authorizations.json');
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
    pivotServer = await resolveInitializedServer(exported);
    const port = await waitForServer(pivotServer);
    return 'http://127.0.0.1:' + port + '/';
}

async function resolveTargetUrl(config) {
    if (config.mode === 'remote') return config.remoteUrl;
    return startLocalServer();
}

function shouldOpenExternal(targetUrl) {
    if (!runtimeConfig || !runtimeConfig.allowExternalOpen) return false;
    try {
        const target = new URL(targetUrl);
        if (!['http:', 'https:'].includes(target.protocol)) return false;
        if (currentTargetUrl) {
            const current = new URL(currentTargetUrl);
            if (target.origin === current.origin) return false;
        }
        const allowed = Array.isArray(runtimeConfig.allowedExternalOrigins)
            ? runtimeConfig.allowedExternalOrigins
            : [];
        if (allowed.length === 0) return true;
        return allowed.some(item => item === target.origin || item === target.hostname);
    } catch (_err) {
        return false;
    }
}

function trustedRendererOptions() {
    return { allowedFilePaths: [path.join(__dirname, 'error.html')] };
}

function isTrustedMainRendererUrl(targetUrl) {
    return isTrustedRendererUrl(targetUrl, currentTargetUrl, trustedRendererOptions());
}

function assertTrustedIpcSender(event) {
    const senderUrl = event?.senderFrame?.url || event?.sender?.getURL?.() || '';
    if (!isTrustedMainRendererUrl(senderUrl)) {
        const error = new Error('已拦截来自非受信渲染进程源的特权桌面 IPC 调用。');
        error.code = 'PIVOT_UNTRUSTED_RENDERER';
        throw error;
    }
    return true;
}

function handleRendererNavigation(event, targetUrl, openExternal) {
    if (isTrustedMainRendererUrl(targetUrl)) return;
    event.preventDefault();
    if (openExternal && shouldOpenExternal(targetUrl)) {
        shell.openExternal(targetUrl).catch(() => {});
    }
}

function createMainWindow(config) {
    mainWindow = new BrowserWindow({
        width: 1320,
        height: 860,
        minWidth: 1100,
        minHeight: 720,
        show: false,
        title: 'Pivot 智枢',
        titleBarStyle: 'hidden',
        titleBarOverlay: {
            color: '#ffffff',
            symbolColor: '#334155',
            height: 30
        },
        backgroundColor: '#0f172a',
        icon: path.join(__dirname, 'icon.ico'),
        webPreferences: {
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: config.sandbox !== false,
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
    mainWindow.webContents.on('will-navigate', (event, targetUrl) => {
        handleRendererNavigation(event, targetUrl, true);
    });
    mainWindow.webContents.on('will-redirect', (event, targetUrl) => {
        handleRendererNavigation(event, targetUrl, false);
    });
    mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedUrl, isMainFrame) => {
        if (!isMainFrame || !mainWindow || String(validatedUrl || '').startsWith('file://')) return;
        lastLoadError = { errorCode, errorDescription, validatedUrl };
        loadErrorPage(errorDescription + ' (' + errorCode + ')');
    });
    mainWindow.webContents.on('page-title-updated', (event, title) => {
        event.preventDefault();
        if (mainWindow) mainWindow.setTitle(title || 'Pivot');
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

const LOCAL_AUTH_TYPES = new Set(['local_database', 'local_report_dir']);

function localAuthorizationFilePath() {
    return path.join(app.getPath('userData'), 'local-authorizations.json');
}

function configureLocalAuthorizationEnvironment() {
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
    process.env.PIVOT_LOCAL_AUTHORIZATIONS_FILE = localAuthorizationFilePath();
    process.env.NODE_ENV = process.env.NODE_ENV || 'production';
    process.env.JWT_SECRET = process.env.JWT_SECRET || secrets.jwtSecret;
    process.env.DATA_ENCRYPTION_KEY = process.env.DATA_ENCRYPTION_KEY || secrets.dataEncryptionKey;
    process.env.DATA_DIR = process.env.DATA_DIR || path.join(userData, 'data');
    process.env.PIVOT_UPLOAD_DIR = process.env.PIVOT_UPLOAD_DIR || path.join(userData, 'uploads');
    process.env.PIVOT_ANALYSIS_DIR = process.env.PIVOT_ANALYSIS_DIR || path.join(userData, 'data', 'analysis');
    process.env.LOG_DIR = process.env.LOG_DIR || path.join(userData, 'logs');
}

function normalizeLocalAuthorizationStore(value) {
    const grants = value && typeof value.grants === 'object' && value.grants ? value.grants : {};
    return { version: 1, grants };
}

function readLocalAuthorizations() {
    return normalizeLocalAuthorizationStore(readJson(localAuthorizationFilePath()));
}

function writeLocalAuthorizations(value) {
    writeJson(localAuthorizationFilePath(), normalizeLocalAuthorizationStore(value));
}

function localPathHint(resourcePath) {
    const base = path.basename(resourcePath || '');
    const parent = path.basename(path.dirname(resourcePath || ''));
    if (!base) return '';
    return parent ? path.join(parent, base) : base;
}

function sanitizeLocalGrant(type, grant) {
    if (!grant || typeof grant !== 'object') return { type, authorized: false };
    return {
        type,
        authorized: true,
        resourceKind: grant.resourceKind || 'local_resource',
        label: grant.label || localPathHint(grant.path) || '已授权资源',
        pathHint: localPathHint(grant.path),
        provider: grant.provider || 'desktop',
        deviceName: grant.deviceName || os.hostname(),
        grantedAt: grant.grantedAt || '',
        updatedAt: grant.updatedAt || grant.grantedAt || ''
    };
}

function buildLocalAuthorizationStatus() {
    configureLocalAuthorizationEnvironment();
    const store = readLocalAuthorizations();
    return {
        available: true,
        provider: 'desktop',
        mode: runtimeConfig && runtimeConfig.mode ? runtimeConfig.mode : 'unknown',
        deviceName: os.hostname(),
        supportedTypes: Array.from(LOCAL_AUTH_TYPES),
        grants: {
            local_database: sanitizeLocalGrant('local_database', store.grants.local_database),
            local_report_dir: sanitizeLocalGrant('local_report_dir', store.grants.local_report_dir)
        },
        message: '桌面客户端已就绪，本机授权信息仅保存在当前设备。'
    };
}

function assertLocalAuthorizationType(type) {
    if (!LOCAL_AUTH_TYPES.has(type)) throw new Error('不支持的本机授权类型。');
}

function showLocalAuthorizationDialog(options) {
    return mainWindow ? dialog.showOpenDialog(mainWindow, options) : dialog.showOpenDialog(options);
}
async function chooseLocalAuthorizationTarget(type) {
    assertLocalAuthorizationType(type);
    const now = new Date().toISOString();
    if (type === 'local_database') {
        const result = await showLocalAuthorizationDialog({
            title: '选择本机 SQLite 数据库文件',
            properties: ['openFile'],
            filters: [{ name: 'SQLite 数据库', extensions: ['sqlite', 'sqlite3', 'db'] }]
        });
        if (result.canceled || !result.filePaths || !result.filePaths[0]) return null;
        const selectedPath = result.filePaths[0];
        return {
            resourceKind: 'sqlite_file',
            label: path.basename(selectedPath) || '本机 SQLite 数据库',
            path: selectedPath,
            provider: 'desktop',
            deviceName: os.hostname(),
            grantedAt: now,
            updatedAt: now
        };
    }
    const result = await showLocalAuthorizationDialog({
        title: '选择本机报表目录',
        properties: ['openDirectory']
    });
    if (result.canceled || !result.filePaths || !result.filePaths[0]) return null;
    const selectedPath = result.filePaths[0];
    return {
        resourceKind: 'report_directory',
        label: path.basename(selectedPath) || '本机报表目录',
        path: selectedPath,
        provider: 'desktop',
        deviceName: os.hostname(),
        grantedAt: now,
        updatedAt: now
    };
}

async function grantLocalAuthorization(type) {
    const grant = await chooseLocalAuthorizationTarget(type);
    if (!grant) return { canceled: true, status: buildLocalAuthorizationStatus() };
    const store = readLocalAuthorizations();
    store.grants[type] = grant;
    writeLocalAuthorizations(store);
    return { canceled: false, status: buildLocalAuthorizationStatus() };
}

function revokeLocalAuthorization(type) {
    assertLocalAuthorizationType(type);
    const store = readLocalAuthorizations();
    delete store.grants[type];
    writeLocalAuthorizations(store);
    return buildLocalAuthorizationStatus();
}

function normalizeLocalMcpExecutionError(error) {
    const message = String(error?.message || error || '本机执行失败。');
    let friendlyMessage = message;
    let status = Number(error?.status || error?.statusCode || 0) || 500;
    const code = String(error?.code || '').trim();
    if ((code === 'ENOTDIR' || /ENOTDIR/i.test(message)) && /app\.asar/i.test(message)) {
        friendlyMessage = '桌面端本机执行环境目录初始化失败，请重新打包或重启客户端后再试。';
        status = 500;
    } else if (code === 'ENOTDIR' || /ENOTDIR/i.test(message)) {
        friendlyMessage = '本机报表目录中存在无法按目录读取的路径，或当前授权目标不是有效目录；请重新授权一个真实文件夹后再试。';
        status = 400;
    } else if (code === 'ENOENT' || /ENOENT/i.test(message)) {
        friendlyMessage = '本机授权资源不存在或已移动；请重新授权后再试。';
        status = 404;
    } else if (code === 'EACCES' || code === 'EPERM') {
        friendlyMessage = '当前系统权限不足，无法读取本机授权资源。';
        status = 403;
    }
    return {
        message: friendlyMessage,
        status,
        code,
        detail: friendlyMessage === message ? '' : message.slice(0, 1000)
    };
}

async function executeLocalMcpTool(payload = {}) {
    configureLocalAuthorizationEnvironment();
    const toolName = String(payload.toolName || payload.name || '').trim();
    if (!/^(db|reports)\./.test(toolName)) {
        const err = new Error('不支持的本机 MCP 工具。');
        err.status = 400;
        throw err;
    }
    const input = payload.input && typeof payload.input === 'object' ? payload.input : {};
    const { executeLocalDeviceMcpTool } = require('../server/services/local-device-mcp');
    return executeLocalDeviceMcpTool(toolName, input, null);
}
async function shutdownServer() {
    if (!pivotServer) return;
    await new Promise((resolve) => {
        pivotServer.close(() => resolve());
        setTimeout(resolve, 3000).unref();
    });
    pivotServer = null;
}

ipcMain.handle('pivot-local-auth:status', async (event) => {
    assertTrustedIpcSender(event);
    return buildLocalAuthorizationStatus();
});

ipcMain.handle('pivot-local-auth:grant', async (event, type) => {
    assertTrustedIpcSender(event);
    return grantLocalAuthorization(String(type || ''));
});

ipcMain.handle('pivot-local-auth:revoke', async (event, type) => {
    assertTrustedIpcSender(event);
    return revokeLocalAuthorization(String(type || ''));
});

ipcMain.handle('pivot-local-auth:execute-tool', async (event, payload) => {
    assertTrustedIpcSender(event);
    try {
        return { success: true, result: await executeLocalMcpTool(payload || {}) };
    } catch (error) {
        return { success: false, error: normalizeLocalMcpExecutionError(error) };
    }
});
ipcMain.handle('pivot-agent:run-worker', async (event, payload = {}) => {
    assertTrustedIpcSender(event);
    configureLocalAuthorizationEnvironment();
    return runDesktopWorker({
        ...payload,
        approved: payload.approved === true,
        workspaceRoot: payload.workspaceRoot || path.join(app.getPath('userData'), 'agent-workspaces')
    });
});
ipcMain.handle('pivot-desktop:retry', async (event) => {
    assertTrustedIpcSender(event);
    lastLoadError = null;
    await loadTarget();
    return true;
});

ipcMain.handle('pivot-desktop:reload', async (event, options = {}) => {
    assertTrustedIpcSender(event);
    return reloadDesktop({ clearCache: options && options.clearCache === true });
});

ipcMain.handle('pivot-desktop:window-action', async (event, action) => {
    assertTrustedIpcSender(event);
    return runWindowAction(String(action || ''));
});

ipcMain.handle('pivot-desktop:quit', async (event) => {
    assertTrustedIpcSender(event);
    app.quit();
    return true;
});

ipcMain.handle('pivot-about:close', async (event) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (window && !window.isDestroyed()) window.close();
    return true;
});
ipcMain.handle('pivot-desktop:status', async (event) => {
    assertTrustedIpcSender(event);
    return {
        config: runtimeConfig,
        targetUrl: currentTargetUrl,
        lastLoadError,
        updateState: updaterController ? updaterController.getState() : { enabled: false, status: 'not-ready' }
    };
});

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
        Menu.setApplicationMenu(buildApplicationMenu());
        try {
            runtimeConfig = loadDesktopConfig(app);
            createMainWindow(runtimeConfig);
            await loadTarget();
            updaterController = setupAutoUpdater({
                app,
                mainWindow,
                config: runtimeConfig,
                authorizeIpc: assertTrustedIpcSender
            });
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
