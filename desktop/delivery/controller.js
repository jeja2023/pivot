/**
 * Desktop 受控文件交付控制器。
 *
 * 保持网络会话、设备密钥、目录授权和原子写入都在 Electron 主进程；渲染页只能拿到
 * 经过脱敏的状态和明确的 IPC 操作，不能读取 Cookie、私钥或本机绝对目录。
 */
const crypto = require('crypto');
const { createDeliveryApiClient } = require('./api-client');
const { createDeliveryExecutor } = require('./executor');
const { openDeliveryStatusWindow, openDeliveryGrantWindow } = require('./status-window');

function createDesktopDeliveryController(options = {}) {
    const createExecutor = typeof options.createExecutor === 'function' ? options.createExecutor : createDeliveryExecutor;
    const openDeliveryStatus = typeof options.openDeliveryStatusWindow === 'function'
        ? options.openDeliveryStatusWindow
        : openDeliveryStatusWindow;
    const openDeliveryGrant = typeof options.openDeliveryGrantWindow === 'function'
        ? options.openDeliveryGrantWindow
        : openDeliveryGrantWindow;
    const getTargetUrl = typeof options.getTargetUrl === 'function' ? options.getTargetUrl : () => '';
    const getSession = typeof options.getSession === 'function' ? options.getSession : () => null;
    const getStealthSecret = typeof options.getStealthSecret === 'function' ? options.getStealthSecret : () => '';
    const showDirectoryPicker = typeof options.showDirectoryPicker === 'function' ? options.showDirectoryPicker : async () => ({ canceled: true });
    const showMessageBox = typeof options.showMessageBox === 'function' ? options.showMessageBox : async () => ({});
    const getParentWindow = typeof options.getParentWindow === 'function' ? options.getParentWindow : () => undefined;
    const logger = options.logger || console;
    let executor = null;

    async function request(options = {}) {
        const target = new URL(getTargetUrl());
        const endpoint = String(options.path || '').startsWith('/') ? String(options.path) : `/${String(options.path || '')}`;
        const url = new URL(endpoint, `${target.origin}/`);
        if (options.query && typeof options.query === 'object') {
            Object.entries(options.query).forEach(([key, value]) => {
                if (value !== undefined && value !== null && String(value) !== '') url.searchParams.set(key, String(value));
            });
        }
        const headers = { Accept: 'application/json' };
        if (options.body !== undefined) headers['Content-Type'] = 'application/json';
        try {
            const activeSession = getSession();
            const cookies = activeSession ? await activeSession.cookies.get({ url: target.origin }) : [];
            if (cookies.length) {
                headers.Cookie = cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; ');
                // 主进程 fetch 不会像渲染器请求一样自动从 Cookie 同步 CSRF
                // header；服务端对所有 Cookie 鉴权的非安全方法要求两者匹配。
                const csrfCookie = cookies.find(cookie => cookie.name === 'pivot_csrf_token');
                if (csrfCookie?.value) headers['X-CSRF-Token'] = csrfCookie.value;
            }
        } catch (_) {}
        const secret = String(getStealthSecret(url.toString()) || '').trim();
        if (secret) {
            const timestamp = Date.now().toString();
            headers['X-Pivot-Stealth-Time'] = timestamp;
            headers['X-Pivot-Stealth-Token'] = crypto.createHmac('sha256', secret).update(timestamp).digest('hex');
        }
        const response = await fetch(url, {
            method: String(options.method || 'GET').toUpperCase(),
            headers,
            body: options.body === undefined ? undefined : JSON.stringify(options.body),
            signal: AbortSignal.timeout(Number(options.timeoutMs) || 30000)
        });
        if (options.stream === true) return { status: response.status, body: response.body, headers: Object.fromEntries(response.headers.entries()) };
        let data = {};
        try { data = await response.json(); } catch (_) { data = { error: await response.text().catch(() => '') }; }
        return { status: response.status, data, headers: Object.fromEntries(response.headers.entries()) };
    }

    function ensureExecutor() {
        if (executor) return executor;
        const api = createDeliveryApiClient({ request });
        executor = createExecutor({
            api,
            chooseDirectory: async () => {
                const result = await showDirectoryPicker();
                if (result?.canceled || !result?.directory) return { canceled: true };
                return { canceled: false, directory: result.directory };
            },
            logger: {
                warn: message => logger.warn?.('[Pivot 交付]', message),
                error: message => logger.error?.('[Pivot 交付]', message),
                info: message => logger.info?.('[Pivot 交付]', message)
            }
        });
        return executor;
    }

    function publicStatus(status = {}, options = {}) {
        const includeDirectory = options.includeDirectory === true;
        return {
            available: status.available === true,
            reason: status.reason || status.lastError || '',
            deviceId: status.deviceId || '',
            deviceName: status.deviceName || '',
            keyType: status.keyType || '',
            keyFingerprint: status.keyFingerprint || '',
            registered: status.registered === true,
            running: status.running === true,
            lastRunAt: status.lastRunAt || '',
            lastStatus: status.lastStatus || '',
            lastError: status.lastError || '',
            deliveredCount: Number(status.deliveredCount || 0),
            failedCount: Number(status.failedCount || 0),
            grants: (Array.isArray(status.grants) ? status.grants : []).map(grant => ({
                grantId: grant.grantId || grant.id || '',
                pathHint: grant.pathHint || '',
                allowedFormats: Array.isArray(grant.allowedFormats) ? grant.allowedFormats : [],
                expiresAt: grant.expiresAt || '',
                expired: grant.expired === true,
                ...(includeDirectory && grant.directory ? { directory: grant.directory } : {})
            }))
        };
    }

    function start() {
        try {
            return publicStatus(ensureExecutor().start());
        } catch (error) {
            logger.warn?.('[Pivot 交付] 受控交付未启动：', error?.message || error);
            const reason = error?.message || String(error);
            return { available: false, reason, running: false, lastStatus: 'unavailable', lastError: reason };
        }
    }

    function stop() {
        return publicStatus(executor ? executor.stop() : { available: false, running: false, lastStatus: 'not-started' });
    }

    /**
     * 网页创建交付意图前的同步就绪检查。客户端启动轮询可能仍停留在登录前状态，
     * 因此这里强制用当前 Web 会话重新登记设备，避免首个保存请求命中“设备未注册”。
     */
    async function prepare() {
        try {
            const currentExecutor = ensureExecutor();
            const currentStatus = currentExecutor.getStatus();
            if (currentStatus.available !== true || !currentStatus.deviceId) return publicStatus(currentStatus);
            await currentExecutor.ensureRegistered(currentStatus.deviceId, { force: true });
            currentExecutor.start();
            return publicStatus(currentExecutor.getStatus());
        } catch (error) {
            const reason = error?.message || String(error);
            logger.warn?.('[Pivot 交付] 准备本机交付失败：', reason);
            return { available: false, reason, running: false, lastStatus: 'unavailable', lastError: reason, grants: [] };
        }
    }

    function status() {
        try {
            // 状态查询也是网页端首次“保存到本机”的入口。必须在这里初始化执行器，
            // 否则首个查询总会返回不可用，页面无法引导用户选择并授权目录。
            return publicStatus(ensureExecutor().getStatus());
        } catch (error) {
            const reason = error?.message || String(error);
            logger.warn?.('[Pivot 交付] 读取交付状态失败：', reason);
            return { available: false, reason, running: false, lastStatus: 'unavailable', lastError: reason, grants: [] };
        }
    }

    /** 完整路径只交给本地 file:// 状态窗口，远程 Web 渲染页始终只能拿到目录提示。 */
    function localStatus() {
        try {
            return publicStatus(ensureExecutor().getStatus({ includeDirectory: true }), { includeDirectory: true });
        } catch (error) {
            const reason = error?.message || String(error);
            logger.warn?.('[Pivot 交付] 读取本地交付状态失败：', reason);
            return { available: false, reason, running: false, lastStatus: 'unavailable', lastError: reason, grants: [] };
        }
    }

    async function authorizeDirectory(input = {}) {
        return await ensureExecutor().authorizeOutputDirectory(input);
    }

    async function revokeDirectory(grantId) {
        return await ensureExecutor().revokeOutputDirectory(grantId);
    }

    async function configureDirectoryFromMenu() {
        try {
            const result = await authorizeDirectory();
            if (result?.canceled) return;
            const grant = result?.grant || {};
            try {
                openDeliveryGrant(grant, {
                    getParentWindow,
                    onViewStatus: () => showStatusFromMenu()
                });
            } catch (winErr) {
                logger.warn?.('[Pivot 交付] 打开受控目录授权弹窗失败，回退到原生消息框', winErr);
                const formats = Array.isArray(grant.allowedFormats) && grant.allowedFormats.length
                    ? (grant.allowedFormats.length > 8 ? `${grant.allowedFormats.slice(0, 8).join('、')} 等 ${grant.allowedFormats.length} 种格式` : grant.allowedFormats.join('、'))
                    : '默认格式';
                await showMessageBox(getParentWindow(), {
                    type: 'info',
                    title: '文件交付目录已授权',
                    message: `已授权目录：${grant.directoryName || grant.pathHint || '已选择目录'}`,
                    detail: `格式：${formats}\n到期时间：${grant.expiresAt || '按服务端策略'}\n\n交付仅在你于 Web 端明确选择“保存到本机”后才会写入该目录。`,
                    buttons: ['确定'], noLink: true
                });
            }
        } catch (error) {
            const isDuplicate = error?.code === 'DELIVERY_GRANT_ALREADY_EXISTS';
            await showMessageBox(getParentWindow(), {
                type: isDuplicate ? 'info' : 'error',
                title: isDuplicate ? '受控目录已存在' : '文件交付目录授权失败',
                message: error?.message || '无法授权文件交付目录。',
                buttons: ['确定'],
                noLink: true
            });
        }
    }

    async function showStatusFromMenu() {
        try {
            openDeliveryStatus({
                getStatus: () => localStatus(),
                getParentWindow,
                onConfigureDirectory: () => configureDirectoryFromMenu(),
                onRevokeDirectory: async (grantId) => {
                    return await revokeDirectory(grantId);
                }
            });
        } catch (err) {
            logger.warn?.('[Pivot 交付] 打开受控交付状态弹窗失败，回退到原生消息框', err);
            const state = status();
            await showMessageBox(getParentWindow(), {
                type: state.available === false ? 'warning' : 'info',
                title: '受控文件交付状态',
                message: state.available === false ? '文件交付当前不可用。' : (state.running ? '文件交付轮询运行中。' : '文件交付轮询已停止。'),
                detail: `设备：${state.deviceId || '未初始化'}\n目录授权：${state.grants.length} 个\n已完成交付：${state.deliveredCount}\n最近状态：${state.lastStatus || '未知'}${state.lastError ? `\n最近错误：${state.lastError}` : ''}`,
                buttons: ['确定'], noLink: true
            });
        }
    }

    async function ensureRegistered(deviceId) {
        return await ensureExecutor().ensureRegistered(deviceId);
    }

    return { authorizeDirectory, configureDirectoryFromMenu, ensureRegistered, prepare, request, revokeDirectory, showStatusFromMenu, start, status, stop };
}

module.exports = { createDesktopDeliveryController };
