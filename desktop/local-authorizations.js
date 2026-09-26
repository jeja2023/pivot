'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { chooseLocalBrowserAuthorization, sanitizeLocalBrowserGrant } = require('./local-browser-authorization');
const { writeJsonAtomic } = require('./atomic-json');

const LOCAL_AUTH_TYPES = new Set(['local_database', 'local_report_dir', 'local_browser', 'local_workspace', 'local_desktop_control']);

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

const writeJson = writeJsonAtomic;

function localPathHint(resourcePath) {
    const base = path.basename(resourcePath || '');
    const parent = path.basename(path.dirname(resourcePath || ''));
    return !base ? '' : (parent ? path.join(parent, base) : base);
}

function normalizeLocalAuthorizationStore(value) {
    const grants = value && typeof value.grants === 'object' && value.grants ? value.grants : {};
    return { version: 1, grants };
}

function sanitizeLocalGrant(type, grant) {
    if (!grant || typeof grant !== 'object') return { type, authorized: false };
    if (type === 'local_browser') {
        return sanitizeLocalBrowserGrant(grant, os.hostname());
    }
    if (type === 'local_workspace') {
        return {
            type, authorized: true, resourceKind: 'git_workspace',
            label: grant.label || localPathHint(grant.path) || '已授权 Git 工作区', pathHint: localPathHint(grant.path),
            provider: grant.provider || 'desktop', deviceName: grant.deviceName || os.hostname(),
            gitProvider: grant.gitProvider === 'github_cli' ? 'github_cli' : 'none',
            grantedAt: grant.grantedAt || '', updatedAt: grant.updatedAt || grant.grantedAt || ''
        };
    }
    if (type === 'local_desktop_control') {
        return {
            type, authorized: true, resourceKind: 'desktop_application', label: grant.label || '已授权桌面应用',
            windowTitle: String(grant.windowTitle || '').slice(0, 240), processName: String(grant.processName || '').slice(0, 160),
            provider: grant.provider || 'desktop', deviceName: grant.deviceName || os.hostname(),
            grantedAt: grant.grantedAt || '', updatedAt: grant.updatedAt || grant.grantedAt || ''
        };
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

function assertLocalAuthorizationType(type) {
    if (!LOCAL_AUTH_TYPES.has(type)) throw new Error('不支持的本机授权类型。');
}

function createLocalAuthorizationManager(options = {}) {
    const app = options.app;
    const dialog = options.dialog;
    const getMainWindow = typeof options.getMainWindow === 'function' ? options.getMainWindow : () => null;
    const getRuntimeConfig = typeof options.getRuntimeConfig === 'function' ? options.getRuntimeConfig : () => null;

    function getUserDataPath() {
        return typeof app?.getPath === 'function' ? app.getPath('userData') : process.cwd();
    }

    function localAuthorizationFilePath() {
        return path.join(getUserDataPath(), 'local-authorizations.json');
    }

    function readLocalAuthorizations() {
        return normalizeLocalAuthorizationStore(readJson(localAuthorizationFilePath()));
    }

    function writeLocalAuthorizations(value) {
        writeJson(localAuthorizationFilePath(), normalizeLocalAuthorizationStore(value));
    }

    function configureLocalAuthorizationEnvironment() {
        const userData = getUserDataPath();
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

    function buildLocalAuthorizationStatus() {
        configureLocalAuthorizationEnvironment();
        const store = readLocalAuthorizations();
        const runtimeConfig = getRuntimeConfig();
        return {
            available: true,
            provider: 'desktop',
            mode: runtimeConfig && runtimeConfig.mode ? runtimeConfig.mode : 'unknown',
            deviceName: os.hostname(),
            supportedTypes: Array.from(LOCAL_AUTH_TYPES),
            grants: {
                local_database: sanitizeLocalGrant('local_database', store.grants.local_database),
                local_report_dir: sanitizeLocalGrant('local_report_dir', store.grants.local_report_dir),
                local_browser: sanitizeLocalGrant('local_browser', store.grants.local_browser),
                local_workspace: sanitizeLocalGrant('local_workspace', store.grants.local_workspace),
                local_desktop_control: sanitizeLocalGrant('local_desktop_control', store.grants.local_desktop_control)
            },
            message: '桌面客户端已就绪，本机授权信息仅保存在当前设备。'
        };
    }

    function showLocalAuthorizationDialog(dialogOptions) {
        const mainWindow = getMainWindow();
        return mainWindow && !mainWindow.isDestroyed()
            ? dialog.showOpenDialog(mainWindow, dialogOptions)
            : dialog.showOpenDialog(dialogOptions);
    }

    async function chooseLocalAuthorizationTarget(type, chooseOptions = {}) {
        assertLocalAuthorizationType(type);
        const now = new Date().toISOString();
        if (type === 'local_browser') {
            return await chooseLocalBrowserAuthorization(chooseOptions, {
                showDialog: showLocalAuthorizationDialog,
                readStore: readLocalAuthorizations,
                platform: process.platform,
                deviceName: os.hostname()
            });
        }
        if (type === 'local_workspace') {
            const result = await showLocalAuthorizationDialog({ title: '选择本机 Git 代码工作区', properties: ['openDirectory'] });
            if (result.canceled || !result.filePaths?.[0]) return null;
            const selectedPath = path.resolve(result.filePaths[0]);
            if (!fs.existsSync(path.join(selectedPath, '.git'))) throw new Error('所选目录不是 Git 工作区。');
            const previous = readLocalAuthorizations().grants.local_workspace;
            const sameWorkspace = previous?.path && path.resolve(previous.path) === selectedPath;
            return {
                resourceKind: 'git_workspace', label: path.basename(selectedPath) || '本机 Git 工作区', path: selectedPath,
                provider: 'desktop', deviceName: os.hostname(), gitProvider: chooseOptions.gitProvider === 'github_cli' ? 'github_cli' : 'none',
                managedWorktrees: sameWorkspace && previous?.managedWorktrees && typeof previous.managedWorktrees === 'object' ? previous.managedWorktrees : {},
                grantedAt: sameWorkspace ? previous.grantedAt || now : now, updatedAt: now
            };
        }
        if (type === 'local_desktop_control') {
            const windowTitle = String(chooseOptions.windowTitle || '').trim().slice(0, 240);
            const processName = String(chooseOptions.processName || '').trim().slice(0, 160);
            if (!windowTitle || !processName) throw new Error('桌面控制授权需要指定当前应用窗口标题和进程名。');
            return { resourceKind: 'desktop_application', label: String(chooseOptions.label || processName).slice(0, 160), windowTitle, processName, provider: 'desktop', deviceName: os.hostname(), grantedAt: now, updatedAt: now };
        }
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

    async function grantLocalAuthorization(type, grantOptions = {}) {
        const grant = await chooseLocalAuthorizationTarget(type, grantOptions);
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
            const mainWindow = getMainWindow();
            return await runLocalBrowserTask({
                toolName,
                input: payload.input && typeof payload.input === 'object' ? payload.input : {},
                grant,
                profileRoot: path.join(getUserDataPath(), 'browser-automation-profiles'),
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
        if (/^workspace\./.test(toolName)) {
            const { runLocalWorkspaceTask } = require('./local-workspace-automation');
            const grant = readLocalAuthorizations().grants.local_workspace;
            const mainWindow = getMainWindow();
            return await runLocalWorkspaceTask({
                toolName,
                input: payload.input && typeof payload.input === 'object' ? payload.input : {},
                grant,
                workerDefinition: payload.workerDefinition || null,
                env: process.env,
                onManagedWorktreeCreated: async record => {
                    const store = readLocalAuthorizations();
                    const current = store.grants.local_workspace;
                    if (!current?.path || path.resolve(current.path) !== path.resolve(grant?.path || '')) throw new Error('代码工作区授权已变化，拒绝登记工作树。');
                    const managedWorktrees = current.managedWorktrees && typeof current.managedWorktrees === 'object' ? current.managedWorktrees : {};
                    managedWorktrees[record.name] = { branch: record.branch, pathHint: record.pathHint, createdAt: new Date().toISOString() };
                    current.managedWorktrees = managedWorktrees;
                    current.updatedAt = new Date().toISOString();
                    store.grants.local_workspace = current;
                    writeLocalAuthorizations(store);
                },
                onManagedWorktreeRemoved: async record => {
                    const store = readLocalAuthorizations();
                    const current = store.grants.local_workspace;
                    if (!current?.path || path.resolve(current.path) !== path.resolve(grant?.path || '')) throw new Error('代码工作区授权已变化，拒绝移除工作树登记。');
                    const managedWorktrees = current.managedWorktrees && typeof current.managedWorktrees === 'object' ? current.managedWorktrees : {};
                    delete managedWorktrees[record.name];
                    current.managedWorktrees = managedWorktrees;
                    current.updatedAt = new Date().toISOString();
                    store.grants.local_workspace = current;
                    writeLocalAuthorizations(store);
                },
                confirmAction: async details => {
                    const response = await dialog.showMessageBox(mainWindow || undefined, {
                        type: 'warning', title: String(details.title || '确认本机代码工作区操作'),
                        message: String(details.message || '确认继续？'),
                        detail: `${details.workspace || '代码工作区'}\n${Array.isArray(details.files) ? details.files.join('\n') : ''}`.slice(0, 4000),
                        buttons: ['继续', '取消'], defaultId: 1, cancelId: 1, noLink: true
                    });
                    return response.response === 0;
                }
            });
        }
        if (/^desktop\./.test(toolName)) {
            const { runLocalDesktopControlTask } = require('./local-desktop-control');
            const grant = readLocalAuthorizations().grants.local_desktop_control;
            const mainWindow = getMainWindow();
            return await runLocalDesktopControlTask({
                toolName,
                input: payload.input && typeof payload.input === 'object' ? payload.input : {},
                grant,
                confirmAction: async details => {
                    const response = await dialog.showMessageBox(mainWindow || undefined, {
                        type: 'warning', title: String(details.title || '确认原生桌面应用操作'),
                        message: String(details.message || '确认继续？'),
                        detail: `${details.application || ''}\n${details.target?.name || details.target?.automationId || ''}`.slice(0, 1000),
                        buttons: ['继续', '取消'], defaultId: 1, cancelId: 1, noLink: true
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

    return {
        LOCAL_AUTH_TYPES,
        buildLocalAuthorizationStatus,
        chooseLocalAuthorizationTarget,
        configureLocalAuthorizationEnvironment,
        executeLocalMcpTool,
        grantLocalAuthorization,
        localAuthorizationFilePath,
        readLocalAuthorizations,
        revokeLocalAuthorization,
        showLocalAuthorizationDialog,
        writeLocalAuthorizations
    };
}

module.exports = {
    LOCAL_AUTH_TYPES,
    createLocalAuthorizationManager,
    normalizeLocalAuthorizationStore,
    sanitizeLocalGrant
};
