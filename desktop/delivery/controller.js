/**
 * Desktop 受控文档交付控制器。
 *
 * 保持网络会话、设备密钥、目录授权和原子写入都在 Electron 主进程；渲染页只能拿到
 * 经过脱敏的状态和明确的 IPC 操作，不能读取 Cookie、私钥或本机绝对目录。
 */
const crypto = require('crypto');
const { createDeliveryApiClient } = require('./api-client');
const { createDeliveryExecutor } = require('./executor');

function createDesktopDeliveryController(options = {}) {
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
        executor = createDeliveryExecutor({
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

    function publicStatus(status = {}) {
        return {
            available: status.available === true,
            reason: status.reason || '',
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
                expiresAt: grant.expiresAt || ''
            }))
        };
    }

    function start() {
        try {
            return publicStatus(ensureExecutor().start());
        } catch (error) {
            logger.warn?.('[Pivot 交付] 受控交付未启动：', error?.message || error);
            return { available: false, running: false, lastStatus: 'unavailable', lastError: error?.message || String(error) };
        }
    }

    function stop() {
        return publicStatus(executor ? executor.stop() : { available: false, running: false, lastStatus: 'not-started' });
    }

    function status() {
        return publicStatus(executor ? executor.getStatus() : { available: false, running: false, lastStatus: 'not-started' });
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
            await showMessageBox(getParentWindow(), {
                type: 'info',
                title: '文档交付目录已授权',
                message: `已授权目录：${grant.directoryName || grant.pathHint || '已选择目录'}`,
                detail: `格式：${Array.isArray(grant.allowedFormats) && grant.allowedFormats.length ? grant.allowedFormats.join('、') : '默认格式'}\n到期时间：${grant.expiresAt || '按服务端策略'}\n\n交付仅在你于 Web 端明确选择“保存到本机”后才会写入该目录。`,
                buttons: ['确定'], noLink: true
            });
        } catch (error) {
            await showMessageBox(getParentWindow(), {
                type: 'error', title: '文档交付目录授权失败', message: error?.message || '无法授权文档交付目录。', buttons: ['确定'], noLink: true
            });
        }
    }

    async function showStatusFromMenu() {
        const state = status();
        await showMessageBox(getParentWindow(), {
            type: state.available === false ? 'warning' : 'info',
            title: '受控文档交付状态',
            message: state.available === false ? '文档交付当前不可用。' : (state.running ? '文档交付轮询运行中。' : '文档交付轮询已停止。'),
            detail: `设备：${state.deviceId || '未初始化'}\n目录授权：${state.grants.length} 个\n已完成交付：${state.deliveredCount}\n最近状态：${state.lastStatus || '未知'}${state.lastError ? `\n最近错误：${state.lastError}` : ''}`,
            buttons: ['确定'], noLink: true
        });
    }

    return { authorizeDirectory, configureDirectoryFromMenu, request, revokeDirectory, showStatusFromMenu, start, status, stop };
}

module.exports = { createDesktopDeliveryController };
