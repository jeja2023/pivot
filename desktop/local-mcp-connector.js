/** 持久化只读本机 MCP 连接器，运行在 Electron 主进程，不把设备私钥交给网页。 */
const identity = require('./delivery/device-identity');

function createLocalMcpConnector({ request, getLocalAuthorizationStatus, executeLocalTool, logger = console } = {}) {
    if (typeof request !== 'function' || typeof getLocalAuthorizationStatus !== 'function' || typeof executeLocalTool !== 'function') {
        throw new Error('本机连接器缺少受控依赖。');
    }
    let running = false;
    let timer = null;
    let registered = false;

    async function call(method, path, body) {
        const response = await request({ method, path, body, timeoutMs: 30000 });
        if (response.status < 200 || response.status >= 300) throw new Error(response.data?.error || '本机连接器请求失败。');
        return response.data || {};
    }
    async function challenge(deviceId) {
        const data = await call('POST', '/api/agents/local-devices/challenge', { purpose: 'connector', deviceId });
        if (!data.nonce) throw new Error('服务端未返回连接器挑战值。');
        return data.nonce;
    }
    async function ensureRegistered(deviceId) {
        if (registered) return;
        const nonce = await call('POST', '/api/agents/local-devices/challenge', { purpose: 'register', deviceId });
        await call('POST', '/api/agents/local-devices', {
            deviceId,
            deviceName: getLocalAuthorizationStatus().deviceName || '我的电脑',
            publicKeyPem: identity.getPublicKeyPem(),
            nonce: nonce.nonce,
            signature: identity.signPayload(`register:${nonce.nonce}:${deviceId}`)
        });
        registered = true;
    }
    async function heartbeat() {
        const status = getLocalAuthorizationStatus();
        const deviceId = identity.getDeviceId();
        await ensureRegistered(deviceId);
        const nonce = await challenge(deviceId);
        await call('POST', '/api/mcp/local-device/connector/heartbeat', {
            deviceId, grants: status.grants || {}, nonce,
            signature: identity.signPayload(`connector:${nonce}:${deviceId}`)
        });
        return { deviceId, active: Object.values(status.grants || {}).some(grant => grant?.authorized === true) };
    }
    async function claim() {
        const deviceId = identity.getDeviceId();
        const nonce = await challenge(deviceId);
        return await call('POST', '/api/mcp/local-device/connector/tasks/claim', {
            deviceId, nonce, signature: identity.signPayload(`connector-claim:${nonce}:${deviceId}`)
        });
    }
    async function complete(task, claimToken, outcome) {
        const deviceId = identity.getDeviceId();
        const nonce = await challenge(deviceId);
        return await call('POST', `/api/mcp/local-device/connector/tasks/${encodeURIComponent(task.id)}/result`, {
            deviceId, claimToken, nonce,
            signature: identity.signPayload(`connector-result:${nonce}:${deviceId}:${task.id}:${claimToken}`),
            ...outcome
        });
    }
    async function runOnce() {
        const registration = await heartbeat();
        if (!registration.active) return { status: 'idle' };
        const claimed = await claim();
        if (claimed.status !== 'claimed' || !claimed.task) return { status: claimed.status || 'idle' };
        try {
            const result = await executeLocalTool({ taskId: claimed.task.id, toolName: claimed.task.toolName, input: claimed.task.input || {} });
            await complete(claimed.task, claimed.claimToken, { success: true, result });
            return { status: 'completed', taskId: claimed.task.id };
        } catch (error) {
            await complete(claimed.task, claimed.claimToken, { success: false, error: { message: error?.message || '本机执行失败。', code: error?.code || '', status: Number(error?.status || 500) } });
            return { status: 'failed', taskId: claimed.task.id };
        }
    }
    /** Immediately publish current grants after a user changes local authorization. */
    async function sync() {
        const registration = await heartbeat();
        return { ...registration, status: 'synced' };
    }
    async function tick() {
        if (!running) return;
        try { await runOnce(); } catch (error) { logger.debug?.('[Pivot 本机连接器] 等待中：', error?.message || error); }
        if (running) timer = setTimeout(tick, 3000);
    }
    function start() { if (!running) { running = true; void tick(); } return status(); }
    function stop() { running = false; if (timer) clearTimeout(timer); timer = null; return status(); }
    function status() { return { running, deviceId: identity.getIdentityStatus().deviceId || '', identity: identity.getIdentityStatus() }; }
    return { runOnce, start, status, stop, sync };
}

module.exports = { createLocalMcpConnector };
