const { assertAllowedUpdateFeedUrl } = require('./update-policy');
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const yaml = require('js-yaml');

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
        allowInsecureHttp: false,
        publisherName: updateConfig.publisherName || '',
        error: '',
        updateInfo: null,
        progress: null,
        checkedAt: ''
    };
}

function normalizePublisherNames(value) {
    const names = Array.isArray(value) ? value : [value];
    return names.map(item => String(item || '').trim()).filter(Boolean);
}

function escapePowerShellLiteral(value) {
    return String(value || '').replace(/'/g, "''");
}

function normalizeWindowsPath(value) {
    return path.normalize(String(value || '')).toLowerCase();
}

function windowsPowerShellModulePath() {
    const systemRoot = process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows';
    const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
    return [
        path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'Modules'),
        path.join(programFiles, 'WindowsPowerShell', 'Modules')
    ].join(path.delimiter);
}

function publisherMatchesSubject(publisherNames, subject) {
    const normalizedSubject = String(subject || '').trim().replace(/\s+/g, ' ');
    const commonName = /(?:^|,\s*)CN=([^,]+)/i.exec(normalizedSubject)?.[1]?.trim() || '';
    return normalizePublisherNames(publisherNames).some(name => {
        const expected = String(name || '').trim().replace(/\s+/g, ' ');
        return expected === normalizedSubject
            || expected.localeCompare(commonName, undefined, { sensitivity: 'accent' }) === 0;
    });
}

function runPowerShellSignatureQuery(filePath, { execFileFn = execFile } = {}) {
    const escapedPath = escapePowerShellLiteral(filePath);
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pivot-update-signature-'));
    const outputPath = path.join(tempDir, 'signature.json');
    const escapedOutputPath = escapePowerShellLiteral(outputPath);
    const powershellPath = path.join(
        process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows',
        'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'
    );
    // 仅序列化校验所需标量，并写入临时文件。部分 Windows 镜像会把模块加载
    // 进度/类型数据告警混入 stdout；若直接 JSON.parse stdout，更新校验会误失败。
    const script = [
        "$ErrorActionPreference = 'Stop'",
        // 某些企业镜像预置了重复 TypeData；Security 模块虽报告导入警告，命令
        // 仍可加载。显式捕获该告警，避免自动加载在 -NoProfile 下失败。
        'try { Import-Module Microsoft.PowerShell.Security -ErrorAction Stop } catch { }',
        `$signature = Get-AuthenticodeSignature -LiteralPath '${escapedPath}'`,
        '$payload = [PSCustomObject]@{ Status = [int]$signature.Status; Path = [string]$signature.Path; Subject = [string]$signature.SignerCertificate.Subject } | ConvertTo-Json -Compress',
        `[System.IO.File]::WriteAllText('${escapedOutputPath}', $payload, [System.Text.UTF8Encoding]::new($false))`
    ].join('; ');
    return new Promise((resolve, reject) => {
        execFileFn(powershellPath, [
            '-NoProfile', '-NonInteractive', '-InputFormat', 'None', '-Command', script
        ], {
            encoding: 'utf8',
            windowsHide: true,
            maxBuffer: 64 * 1024,
            // Electron / Node 进程可能继承 PowerShell 7 或其他工具注入的模块
            // 路径；Windows PowerShell 5.1 的 Security 模块会因此无法自动加载。
            env: { ...process.env, PSModulePath: windowsPowerShellModulePath() }
        }, (error, stdout, stderr) => {
            try {
                if (error) throw error;
                if (stderr && String(stderr).trim()) throw new Error(String(stderr).trim());
                return resolve(JSON.parse(fs.readFileSync(outputPath, 'utf8').trim()));
            } catch (parseError) {
                return reject(new Error(`Windows 更新签名校验结果格式无效：${parseError.message}`));
            } finally {
                try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (_) {}
            }
        });
    });
}

async function verifyWindowsUpdateSignature(publisherNames, artifactPath, options = {}) {
    const platform = options.platform || process.platform;
    if (platform !== 'win32') return 'Windows 更新签名校验只能在 Windows 上执行。';
    if (!artifactPath || !fs.existsSync(artifactPath)) return '待校验的 Windows 更新安装包不存在。';
    try {
        const signatureQuery = typeof options.signatureQuery === 'function'
            ? options.signatureQuery
            : runPowerShellSignatureQuery;
        const result = await signatureQuery(artifactPath, options);
        const statusCode = Number(result?.Status);
        const allowsUntrustedRoot = options.allowUntrustedRoot === true
            || normalizePublisherNames(publisherNames).includes('Pivot Local Dev');
        const isValidStatus = statusCode === 0 || (allowsUntrustedRoot && (statusCode === 1 || statusCode === 6));
        if (!isValidStatus) {
            return `更新安装包 Authenticode 签名无效（状态 ${result?.Status ?? 'unknown'}）。`;
        }
        if (normalizeWindowsPath(result?.Path) !== normalizeWindowsPath(artifactPath)) {
            return 'Windows 更新签名校验返回的文件路径与下载文件不一致。';
        }
        if (!publisherMatchesSubject(publisherNames, result?.Subject)) {
            return `更新安装包签名发布者不匹配（实际 ${String(result?.Subject || '未知')}）。`;
        }
        return null;
    } catch (error) {
        return `无法验证 Windows 更新安装包签名：${serializeError(error)}`;
    }
}

function verifyWindowsUpdateSigningConfig(updateConfig = {}, options = {}) {
    const platform = options.platform || process.platform;
    if (platform !== 'win32') return false;
    const expected = String(updateConfig.publisherName || '').trim();
    if (!expected) throw new Error('Windows 自动更新缺少签名发布者配置，已拒绝检查更新。');
    const resourcePath = options.resourcesPath || process.resourcesPath;
    const configPath = path.join(String(resourcePath || ''), 'app-update.yml');
    if (!resourcePath || !fs.existsSync(configPath)) {
        throw new Error('Windows 自动更新签名配置不存在，已拒绝检查更新。');
    }
    let parsed;
    try {
        parsed = yaml.load(fs.readFileSync(configPath, 'utf8')) || {};
    } catch (error) {
        throw new Error(`无法读取 Windows 自动更新签名配置：${error.message}`);
    }
    if (!normalizePublisherNames(parsed.publisherName).includes(expected)) {
        throw new Error('Windows 安装包的更新签名发布者与客户端配置不一致，已拒绝检查更新。');
    }
    return true;
}

function hardenWindowsAutoUpdater(autoUpdater, updateConfig = {}, options = {}) {
    const platform = options.platform || process.platform;
    if (platform !== 'win32') return false;
    verifyWindowsUpdateSigningConfig(updateConfig, options);
    if (!autoUpdater || typeof autoUpdater.verifyUpdateCodeSignature !== 'function') {
        throw new Error('当前更新器不支持 Windows 安装包签名校验，已拒绝检查更新。');
    }
    const signatureVerifier = typeof options.verifySignature === 'function'
        ? options.verifySignature
        : verifyWindowsUpdateSignature;
    autoUpdater.verifyUpdateCodeSignature = (publisherNames, artifactPath) => signatureVerifier(publisherNames, artifactPath, {
        ...options,
        allowUntrustedRoot: updateConfig.allowUntrustedRoot === true
            || normalizePublisherNames(publisherNames).includes('Pivot Local Dev')
    });
    autoUpdater.disableWebInstaller = true;
    autoUpdater.allowDowngrade = false;
    return true;
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
        env: process.env
    });

    if (autoUpdater && typeof autoUpdater.on === 'function') {
        hardenWindowsAutoUpdater(autoUpdater, updateConfig);
        autoUpdater.autoDownload = updateConfig.autoDownload !== false;
        autoUpdater.allowPrerelease = updateConfig.allowPrerelease === true;
        autoUpdater.allowDowngrade = false;
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
    hardenWindowsAutoUpdater,
    publisherMatchesSubject,
    runPowerShellSignatureQuery,
    setupAutoUpdater,
    verifyWindowsUpdateSignature,
    verifyWindowsUpdateSigningConfig,
    windowsPowerShellModulePath
};
