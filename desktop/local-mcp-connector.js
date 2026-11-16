/** 持久化只读本机 MCP 连接器，运行在 Electron 主进程，不把设备私钥交给网页。 */
const defaultIdentity = require('./delivery/device-identity');

const HEARTBEAT_INTERVAL_MS = 45000;
const ACTIVE_POLL_INTERVAL_MS = 5000;
const IDLE_POLL_INTERVAL_MS = 20000;
const MAX_BACKOFF_MS = 60000;

function withRetryJitter(delayMs, random = Math.random) {
    const base = Math.max(0, Number(delayMs) || 0);
    const sample = Math.min(1, Math.max(0, Number(random()) || 0));
    return Math.round(base * (0.8 + sample * 0.4));
}

function createLocalMcpConnector({ request, getLocalAuthorizationStatus, executeLocalTool, identity: customIdentity, ensureRegistered: customEnsureRegistered, logger = console, random = Math.random } = {}) {
    if (typeof request !== 'function' || typeof getLocalAuthorizationStatus !== 'function' || typeof executeLocalTool !== 'function') {
        throw new Error('本机连接器缺少受控依赖。');
    }
    const identity = customIdentity || defaultIdentity;
    let running = false;
    let timer = null;
    let registered = false;
    let registeringPromise = null;
    let lastHeartbeatAt = 0;
    let consecutiveErrors = 0;
    let generation = 0;
    const inFlight = new Set();
    const controllers = new Set();

    function assertCurrent(expected) {
        if (expected !== generation) throw Object.assign(new Error('本机连接器已停止，旧任务不能继续。'), { code: 'LOCAL_CONNECTOR_STOPPED' });
    }

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
        if (registeringPromise) return registeringPromise;
        const expected = generation;
        registeringPromise = (async () => {
            try {
                if (typeof customEnsureRegistered === 'function') {
                    await customEnsureRegistered(deviceId);
                } else {
                    const nonce = await call('POST', '/api/agents/local-devices/challenge', { purpose: 'register', deviceId });
                    await call('POST', '/api/agents/local-devices', {
                        deviceId,
                        deviceName: getLocalAuthorizationStatus().deviceName || '我的电脑',
                        publicKeyPem: identity.getPublicKeyPem(),
                        nonce: nonce.nonce,
                        signature: identity.signPayload(`register:${nonce.nonce}:${deviceId}`)
                    });
                }
                assertCurrent(expected);
                registered = true;
            } finally {
                registeringPromise = null;
            }
        })();
        return registeringPromise;
    }
    async function heartbeat() {
        const expected = generation;
        const status = getLocalAuthorizationStatus();
        const deviceId = identity.getDeviceId();
        await ensureRegistered(deviceId);
        assertCurrent(expected);
        const nonce = await challenge(deviceId);
        assertCurrent(expected);
        await call('POST', '/api/mcp/local-device/connector/heartbeat', {
            deviceId, grants: status.grants || {}, nonce,
            signature: identity.signPayload(`connector:${nonce}:${deviceId}`)
        });
        assertCurrent(expected);
        lastHeartbeatAt = Date.now();
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
    async function runOnceInternal(expected) {
        const status = getLocalAuthorizationStatus();
        const active = Object.values(status.grants || {}).some(grant => grant?.authorized === true);
        const now = Date.now();

        if (!registered || now - lastHeartbeatAt >= HEARTBEAT_INTERVAL_MS) {
            await heartbeat();
        }
        assertCurrent(expected);

        if (!active) return { status: 'idle', active: false };

        const claimed = await claim();
        assertCurrent(expected);
        if (claimed.status !== 'claimed' || !claimed.task) return { status: claimed.status || 'idle', active: true };
        const controller = new AbortController();
        controllers.add(controller);
        try {
            const result = await executeLocalTool({ taskId: claimed.task.id, toolName: claimed.task.toolName, input: claimed.task.input || {}, signal: controller.signal });
            assertCurrent(expected);
            await complete(claimed.task, claimed.claimToken, { success: true, result });
            assertCurrent(expected);
            return { status: 'completed', taskId: claimed.task.id, active: true };
        } catch (error) {
            if (expected !== generation) throw error;
            await complete(claimed.task, claimed.claimToken, { success: false, error: { message: error?.message || '本机执行失败。', code: error?.code || '', status: Number(error?.status || 500) } });
            assertCurrent(expected);
            return { status: 'failed', taskId: claimed.task.id, active: true };
        } finally {
            controllers.delete(controller);
        }
    }
    function track(promise) {
        inFlight.add(promise);
        return promise.finally(() => inFlight.delete(promise));
    }
    function runOnce() { return track(runOnceInternal(generation)); }
    /** Immediately publish current grants after a user changes local authorization. */
    async function syncInternal() {
        const registration = await heartbeat();
        return { ...registration, status: 'synced' };
    }
    function sync() { return track(syncInternal()); }
    async function tick() {
        if (!running) return;
        const expected = generation;
        let nextDelay = ACTIVE_POLL_INTERVAL_MS;
        try {
            const outcome = await runOnce();
            consecutiveErrors = 0;
            if (outcome.status === 'completed') {
                nextDelay = 500;
            } else if (outcome.active === false) {
                nextDelay = IDLE_POLL_INTERVAL_MS;
            } else {
                nextDelay = ACTIVE_POLL_INTERVAL_MS;
            }
        } catch (error) {
            consecutiveErrors += 1;
            const exponentialDelay = Math.min(10000 * Math.pow(2, Math.min(consecutiveErrors - 1, 3)), MAX_BACKOFF_MS);
            nextDelay = withRetryJitter(exponentialDelay, random);
            logger.debug?.('[Pivot 本机连接器] 轮询等待（将在 ' + Math.round(nextDelay / 1000) + 's 后重试）：', error?.message || error);
        }
        if (running && expected === generation) timer = setTimeout(tick, nextDelay);
    }
    function start() { if (!running) { running = true; void tick(); } return status(); }
    function stop() { running = false; generation++; registered = false; lastHeartbeatAt = 0; for (const controller of controllers) controller.abort(); if (timer) clearTimeout(timer); timer = null; return status(); }
    async function stopAndDrain() { stop(); await Promise.allSettled([...inFlight]); return status(); }
    function status() { return { running, deviceId: identity.getIdentityStatus().deviceId || '', identity: identity.getIdentityStatus() }; }
    return { runOnce, start, status, stop, stopAndDrain, sync };
}

module.exports = { createLocalMcpConnector, withRetryJitter };
