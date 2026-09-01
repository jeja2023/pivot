const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { app, BrowserWindow, dialog, ipcMain, Menu, session, shell } = require('electron');

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

const { loadDesktopConfig, normalizeRemoteUrl, saveUserDesktopConfig } = require('./config');
const { resolveInitializedServer } = require('./local-server');
const { isTrustedRendererUrl } = require('./navigation-policy');
const { setupAutoUpdater } = require('./updater');
const { runDesktopWorker } = require('./agent-runtime');
const { createDesktopDeliveryController } = require('./delivery/controller');
const { createLazyLocalMcpController } = require('./local-mcp-controller');
const { chooseLocalBrowserAuthorization, sanitizeLocalBrowserGrant } = require('./local-browser-authorization');
const { normalizeLocalMcpExecutionError } = require('./local-mcp-execution-error');
const { buildApplicationMenu } = require('./application-menu');
const {
    createWorkerApprovalStore,
    isSecureWorkerRendererUrl,
    normalizeWorkerRequest
} = require('./worker-security');

let mainWindow = null;
let pivotServer = null;
let runtimeConfig = null;
let currentTargetUrl = '';
let lastLoadError = null;
let updaterController = null;
let aboutWindow = null;
let serverConfigWindow = null;
let deliveryController = null;
const getLocalMcpConnector = createLazyLocalMcpController({
    request: options => getDeliveryController().request(options), getLocalAuthorizationStatus: buildLocalAuthorizationStatus,
    executeLocalTool: executeLocalMcpTool, logger: console
});
const workerApprovals = createWorkerApprovalStore();

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
function sanitizeErrorMessage(msg) {
    if (!msg) return '无法连接到智枢服务器，请检查您的网络连接或服务器运行状态。';
    const text = String(msg);
    if (text.includes('ERR_EMPTY_RESPONSE')) {
        return '目标服务器已开启「客户端隐身模式」，当前客户端未携带或配置了错误的通信密钥，连接已被阻断。';
    }
    if (text.includes('ERR_CONNECTION_REFUSED')) {
        return '无法连接到目标服务器，请确认服务端进程已启动且端口正常监听。';
    }
    if (text.includes('ERR_ABORTED')) {
        return '连接被中断或重置，请重试或检查服务器配置。';
    }
    return text
        .replace(/(?:https?|file):\/\/[^\s'")]+/gi, '')
        .replace(/loading\s*['"][^'"]*['"]/gi, '')
        .replace(/\s+/g, ' ')
        .trim() || '无法连接到智枢服务器，请检查您的网络连接或服务器运行状态。';
}

let isLoadingErrorPage = false;
async function loadErrorPage(message) {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (isLoadingErrorPage) return;
    isLoadingErrorPage = true;
    try {
        await mainWindow.loadFile(path.join(__dirname, 'error.html'), {
            query: {
                message: sanitizeErrorMessage(message),
                env: runtimeConfig && runtimeConfig.environmentName ? runtimeConfig.environmentName : ''
            }
        });
    } catch (err) {
        if (err?.code !== 'ERR_ABORTED') {
            console.error('加载错误页面失败:', err);
        }
    } finally {
        isLoadingErrorPage = false;
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

function showServerConfigDialog() {
    if (serverConfigWindow && !serverConfigWindow.isDestroyed()) {
        serverConfigWindow.focus();
        return;
    }
    serverConfigWindow = new BrowserWindow({
        width: 520,
        height: 480,
        resizable: false,
        maximizable: false,
        minimizable: false,
        fullscreenable: false,
        show: false,
        frame: false,
        modal: Boolean(mainWindow),
        parent: mainWindow || undefined,
        title: '服务器连接配置',
        backgroundColor: '#ffffff',
        autoHideMenuBar: true,
        webPreferences: {
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
            preload: path.join(__dirname, 'server-config-preload.js')
        }
    });
    serverConfigWindow.once('ready-to-show', () => serverConfigWindow && serverConfigWindow.show());
    serverConfigWindow.on('closed', () => {
        serverConfigWindow = null;
    });
    serverConfigWindow.loadFile(path.join(__dirname, 'server-config.html')).catch((error) => {
        console.error('加载服务器配置窗口失败:', error);
        if (serverConfigWindow && !serverConfigWindow.isDestroyed()) serverConfigWindow.close();
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
        case 'server-config':
            showServerConfigDialog();
            return true;
        default:
            return false;
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
    if (!secrets.stealthSecret) {
        secrets.stealthSecret = randomSecret();
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
    process.env.PIVOT_STEALTH_SECRET = process.env.PIVOT_STEALTH_SECRET || secrets.stealthSecret;
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
    return {
        allowedFilePaths: [
            path.join(__dirname, 'error.html'),
            path.join(__dirname, 'server-config.html')
        ]
    };
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

function assertSecureWorkerIpcSender(event) {
    assertTrustedIpcSender(event);
    const senderUrl = event?.senderFrame?.url || event?.sender?.getURL?.() || '';
    if (!isSecureWorkerRendererUrl(senderUrl)) {
        const error = new Error('本机 Worker 只允许 HTTPS 页面或本地回环页面调用。');
        error.code = 'PIVOT_WORKER_INSECURE_RENDERER';
        throw error;
    }
}

function desktopWorkerRoot() {
    return path.join(app.getPath('userData'), 'agent-workspaces');
}

function handleRendererNavigation(event, targetUrl, openExternal) {
    if (isTrustedMainRendererUrl(targetUrl)) return;
    event.preventDefault();
    if (openExternal && shouldOpenExternal(targetUrl)) {
        shell.openExternal(targetUrl).catch(() => {});
    }
}

function resolveStealthSecret(currentConfig, targetUrl) {
    if (process.env.PIVOT_STEALTH_SECRET) return process.env.PIVOT_STEALTH_SECRET;
    const activeConfig = currentConfig || runtimeConfig;
    if (activeConfig?.stealthSecret) return activeConfig.stealthSecret;
    try {
        const userData = app.getPath('userData');
        const userConfig = readJson(path.join(userData, 'user-config.json'));
        if (userConfig?.stealthSecret) return userConfig.stealthSecret;

        // 如果是本机/本地回环地址，自动回退读取同一机器上的 desktop-secrets.json
        const parsed = new URL(targetUrl || currentTargetUrl || '');
        if (['localhost', '127.0.0.1', '::1'].includes(parsed.hostname)) {
            const localSecrets = readJson(path.join(userData, 'desktop-secrets.json'));
            if (localSecrets?.stealthSecret) return localSecrets.stealthSecret;
        }
    } catch (_) {}
    return '';
}

function attachStealthHeaderInterceptor(targetSession) {
    if (!targetSession || !targetSession.webRequest) return;
    try {
        targetSession.webRequest.onBeforeSendHeaders((details, callback) => {
            try {
                const secret = resolveStealthSecret(runtimeConfig, details.url);
                if (secret && typeof secret === 'string') {
                    const now = Date.now().toString();
                    const token = crypto.createHmac('sha256', secret).update(now).digest('hex');
                    details.requestHeaders['X-Pivot-Stealth-Time'] = now;
                    details.requestHeaders['X-Pivot-Stealth-Token'] = token;
                }
            } catch (_) {}
            callback({ requestHeaders: details.requestHeaders });
        });
    } catch (_) {}
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
    const webSession = mainWindow.webContents.session;
    attachStealthHeaderInterceptor(webSession);
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
        if (err?.code === 'ERR_ABORTED' || err?.errno === -3) {
            return;
        }
        const message = err && err.message ? err.message : String(err);
        lastLoadError = {
            errorCode: 'LOAD_FAILED',
            errorDescription: message,
            validatedUrl: currentTargetUrl
        };
        await loadErrorPage(message);
    }
}

function getDeliveryController() {
    if (deliveryController) return deliveryController;
    deliveryController = createDesktopDeliveryController({
        getTargetUrl: () => currentTargetUrl || runtimeConfig?.remoteUrl || '',
        getSession: () => mainWindow?.webContents?.session || session.defaultSession,
        getStealthSecret: targetUrl => resolveStealthSecret(runtimeConfig, targetUrl),
        showDirectoryPicker: async () => {
            const result = await showLocalAuthorizationDialog({ title: '选择 Pivot 文档输出目录', properties: ['openDirectory', 'createDirectory'] });
            return result?.canceled || !result?.filePaths?.[0] ? { canceled: true } : { directory: result.filePaths[0] };
        },
        showMessageBox: (parent, config) => dialog.showMessageBox(parent, config),
        getParentWindow: () => mainWindow || undefined,
        logger: console
    });
    return deliveryController;
}

const LOCAL_AUTH_TYPES = new Set(['local_database', 'local_report_dir', 'local_browser']);

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

function localPathHint(resourcePath) { const base = path.basename(resourcePath || ''); const parent = path.basename(path.dirname(resourcePath || '')); return !base ? '' : (parent ? path.join(parent, base) : base); }

function sanitizeLocalGrant(type, grant) {
    if (!grant || typeof grant !== 'object') return { type, authorized: false };
    if (type === 'local_browser') {
        return sanitizeLocalBrowserGrant(grant, os.hostname());
    }
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
            local_report_dir: sanitizeLocalGrant('local_report_dir', store.grants.local_report_dir),
            local_browser: sanitizeLocalGrant('local_browser', store.grants.local_browser)
        },
        message: '桌面客户端已就绪，本机授权信息仅保存在当前设备。'
    };
}

function assertLocalAuthorizationType(type) { if (!LOCAL_AUTH_TYPES.has(type)) throw new Error('不支持的本机授权类型。'); }
function showLocalAuthorizationDialog(options) { return mainWindow ? dialog.showOpenDialog(mainWindow, options) : dialog.showOpenDialog(options); }

async function chooseLocalAuthorizationTarget(type, options = {}) {
    assertLocalAuthorizationType(type);
    const now = new Date().toISOString();
    if (type === 'local_browser') return await chooseLocalBrowserAuthorization(options, {
        showDialog: showLocalAuthorizationDialog,
        readStore: readLocalAuthorizations,
        platform: process.platform,
        deviceName: os.hostname()
    });
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

async function grantLocalAuthorization(type, options = {}) {
    const grant = await chooseLocalAuthorizationTarget(type, options);
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

async function executeLocalMcpTool(payload = {}) {
    configureLocalAuthorizationEnvironment();
    const toolName = String(payload.toolName || payload.name || '').trim();
    if (/^browser\./.test(toolName)) {
        const { runLocalBrowserTask } = require('./local-browser-automation');
        const grant = readLocalAuthorizations().grants.local_browser;
        return await runLocalBrowserTask({
            toolName,
            input: payload.input && typeof payload.input === 'object' ? payload.input : {},
            grant,
            profileRoot: path.join(app.getPath('userData'), 'browser-automation-profiles'),
            confirmAction: async details => {
                const response = await dialog.showMessageBox(mainWindow || undefined, {
                    type: 'question',
                    title: String(details.title || '确认本机浏览器操作'),
                    message: String(details.message || '确认继续？'),
                    detail: `${details.browser || '浏览器'}\n${details.url || ''}`,
                    buttons: ['继续', '取消'],
                    defaultId: 1,
                    cancelId: 1,
                    noLink: true
                });
                return response.response === 0;
            }
        });
    }
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

ipcMain.handle('pivot-local-auth:grant', async (event, type, options = {}) => {
    assertTrustedIpcSender(event);
    return grantLocalAuthorization(String(type || ''), options || {});
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

ipcMain.handle('pivot-local-connector:status', async (event) => {
    assertTrustedIpcSender(event);
    return getLocalMcpConnector().status();
});

ipcMain.handle('pivot-delivery:status', async (event) => {
    assertTrustedIpcSender(event);
    return getDeliveryController().status();
});

ipcMain.handle('pivot-delivery:start', async (event) => {
    assertTrustedIpcSender(event);
    return getDeliveryController().start();
});

ipcMain.handle('pivot-delivery:stop', async (event) => {
    assertTrustedIpcSender(event);
    return getDeliveryController().stop();
});

ipcMain.handle('pivot-delivery:authorize-directory', async (event, options = {}) => {
    assertTrustedIpcSender(event);
    return getDeliveryController().authorizeDirectory(options || {});
});

ipcMain.handle('pivot-delivery:revoke-directory', async (event, grantId) => {
    assertTrustedIpcSender(event);
    return getDeliveryController().revokeDirectory(grantId);
});
ipcMain.handle('pivot-agent:request-approval', async (event, payload = {}) => {
    assertSecureWorkerIpcSender(event);
    configureLocalAuthorizationEnvironment();
    const request = normalizeWorkerRequest(payload, { workspaceRoot: desktopWorkerRoot() });
    const result = await dialog.showMessageBox(mainWindow || undefined, {
        type: 'warning',
        title: '批准本机脚本执行',
        message: `是否允许 Pivot 执行 ${path.basename(request.args[0])}？`,
        detail: `解释器：${request.command}\n任务：${request.taskId}\n网络：禁止\n\n仅在确认该任务由你发起时批准。`,
        buttons: ['批准一次', '取消'],
        defaultId: 1,
        cancelId: 1,
        noLink: true
    });
    if (result.response !== 0) return { approved: false, canceled: true };
    const approval = workerApprovals.issue(request);
    return { approved: true, approvalToken: approval.token, expiresAt: new Date(approval.expiresAt).toISOString() };
});

ipcMain.handle('pivot-agent:run-worker', async (event, payload = {}, approvalToken = '') => {
    assertSecureWorkerIpcSender(event);
    configureLocalAuthorizationEnvironment();
    const request = normalizeWorkerRequest(payload, { workspaceRoot: desktopWorkerRoot() });
    workerApprovals.consume(approvalToken, request);
    return runDesktopWorker({
        ...request,
        approvedByMainProcess: true
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

ipcMain.handle('pivot-server-config:close', async (event) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (window && !window.isDestroyed()) window.close();
    return true;
});

ipcMain.handle('pivot-desktop:get-server-config', async (event) => {
    assertTrustedIpcSender(event);
    return {
        mode: runtimeConfig?.mode || 'local',
        remoteUrl: runtimeConfig?.remoteUrl || '',
        stealthSecret: process.env.PIVOT_STEALTH_SECRET || runtimeConfig?.stealthSecret || '',
        environmentName: runtimeConfig?.environmentName || ''
    };
});

ipcMain.handle('pivot-desktop:open-server-config-dialog', async (event) => {
    assertTrustedIpcSender(event);
    showServerConfigDialog();
    return true;
});

ipcMain.handle('pivot-desktop:test-server-connection', async (event, payload = {}) => {
    assertTrustedIpcSender(event);
    const targetUrl = String(payload.url || '').trim();
    if (!targetUrl) return { success: false, error: '缺少服务器访问地址' };
    try {
        const parsed = new URL(targetUrl);
        if (!['http:', 'https:'].includes(parsed.protocol)) {
            return { success: false, error: '访问地址必须使用 http:// 或 https:// 协议' };
        }
        const secret = String(payload.stealthSecret || process.env.PIVOT_STEALTH_SECRET || runtimeConfig?.stealthSecret || '').trim();
        const healthUrl = new URL('/api/health', parsed).toString();
        const headers = {};
        if (secret) {
            const now = Date.now().toString();
            const token = crypto.createHmac('sha256', secret).update(now).digest('hex');
            headers['X-Pivot-Stealth-Time'] = now;
            headers['X-Pivot-Stealth-Token'] = token;
        }
        const start = Date.now();
        const res = await fetch(healthUrl, {
            headers,
            signal: AbortSignal.timeout(6000)
        });
        const latencyMs = Date.now() - start;
        if (res.ok) {
            return { success: true, latencyMs };
        }
        return { success: false, error: `服务器返回异常状态码 HTTP ${res.status}` };
    } catch (err) {
        const msg = err.name === 'TimeoutError' ? '连接超时（6秒未响应）' : (err.message || String(err));
        return { success: false, error: msg };
    }
});

ipcMain.handle('pivot-desktop:set-server-config', async (event, payload = {}) => {
    assertTrustedIpcSender(event);
    const mode = payload.mode === 'local' ? 'local' : 'remote';
    let remoteUrl = '';
    if (mode === 'remote') {
        try {
            remoteUrl = normalizeRemoteUrl(payload.remoteUrl);
        } catch (err) {
            return { success: false, error: err.message || '远程服务器地址无效' };
        }
    }
    const stealthSecret = typeof payload.stealthSecret === 'string' ? payload.stealthSecret.trim() : undefined;
    
    saveUserDesktopConfig(app, {
        mode,
        remoteUrl,
        ...(stealthSecret !== undefined ? { stealthSecret } : {})
    });

    if (stealthSecret !== undefined) {
        process.env.PIVOT_STEALTH_SECRET = stealthSecret;
    }

    runtimeConfig = loadDesktopConfig(app);
    currentTargetUrl = '';
    lastLoadError = null;
    await loadTarget();
    return { success: true };
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
        Menu.setApplicationMenu(buildApplicationMenu({
            Menu,
            reloadDesktop,
            clearCacheAndReloadDesktop,
            showServerConfigDialog,
            configureDeliveryDirectory: () => getDeliveryController().configureDirectoryFromMenu(),
            showDeliveryStatus: () => getDeliveryController().showStatusFromMenu(),
            checkForUpdates: () => updaterController?.checkForUpdates?.(true),
            showAboutDialog,
            quit: () => app.quit()
        }));
        try {
            runtimeConfig = loadDesktopConfig(app);
            if (runtimeConfig.partition) {
                attachStealthHeaderInterceptor(session.fromPartition(runtimeConfig.partition));
            }
            attachStealthHeaderInterceptor(session.defaultSession);
            createMainWindow(runtimeConfig);
            await loadTarget();
            getDeliveryController().start();
            getLocalMcpConnector().start();
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
        try { deliveryController?.stop?.(); } catch (_) {}
        try { getLocalMcpConnector().stop(); } catch (_) {}
        if (!pivotServer) return;
        event.preventDefault();
        shutdownServer().finally(() => app.exit(0));
    });

    app.on('window-all-closed', () => {
        app.quit();
    });
}
