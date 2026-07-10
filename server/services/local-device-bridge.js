const crypto = require('crypto');
const {
    LOCAL_MCP_SERVER_ID,
    getLocalDeviceMcpServerTypeForTool
} = require('./local-device-mcp');
const { listDatabaseConnectionMcpTools } = require('./database-mcp');
const { listReportTools } = require('./builtin-mcp-reports');

const DEVICE_TTL_MS = Math.max(Number.parseInt(process.env.PIVOT_LOCAL_BRIDGE_DEVICE_TTL_MS || '60000', 10) || 60000, 15000);
const TASK_TIMEOUT_MS = Math.max(Number.parseInt(process.env.PIVOT_LOCAL_BRIDGE_TASK_TIMEOUT_MS || '120000', 10) || 120000, 10000);
const POLL_TIMEOUT_MS = Math.max(Number.parseInt(process.env.PIVOT_LOCAL_BRIDGE_POLL_TIMEOUT_MS || '25000', 10) || 25000, 1000);
const MAX_POLL_TIMEOUT_MS = 30000;
const LOCAL_BRIDGE_GRANT_TYPES = new Set(['local_database', 'local_report_dir']);

const devices = new Map();
const tasks = new Map();

function bridgeError(message, status = 400) {
    const err = new Error(message);
    err.status = status;
    return err;
}

function normalizeBridgeExecutionError(payloadError = {}) {
    const message = String(payloadError?.message || payloadError || '本机执行失败。').slice(0, 1000);
    const code = String(payloadError?.code || '').trim().slice(0, 80);
    const detail = String(payloadError?.detail || '').trim().slice(0, 1000);
    let status = Number(payloadError?.status || payloadError?.statusCode || 0) || 500;
    if (code === 'ENOTDIR' || /ENOTDIR|不是有效目录|无法按目录读取|必须指向目录/.test(message)) {
        status = 400;
    } else if (code === 'ENOENT' || /ENOENT|不存在|已移动|未找到/.test(message)) {
        status = 404;
    } else if (code === 'EACCES' || code === 'EPERM' || /权限不足|无权|拒绝访问/.test(message)) {
        status = 403;
    }
    return { message, code, status, detail };
}

function normalizeUserId(user) {
    const id = Number.parseInt(user?.id, 10);
    if (!Number.isSafeInteger(id) || id <= 0) throw bridgeError('需要登录后才能使用本机执行通道。', 401);
    return id;
}

function normalizeDeviceId(value) {
    return String(value || '')
        .trim()
        .replace(/[^a-zA-Z0-9_.:-]/g, '')
        .slice(0, 120);
}

function deviceKey(userId, deviceId) {
    return `${userId}:${deviceId}`;
}

function sanitizeGrant(type, grant = {}) {
    if (!LOCAL_BRIDGE_GRANT_TYPES.has(type)) return { type, authorized: false };
    const authorized = grant?.authorized === true;
    return {
        type,
        authorized,
        resourceKind: String(grant?.resourceKind || '').slice(0, 80),
        label: String(grant?.label || '').slice(0, 160),
        pathHint: String(grant?.pathHint || '').slice(0, 180),
        provider: String(grant?.provider || 'desktop').slice(0, 40),
        deviceName: String(grant?.deviceName || '').slice(0, 120),
        grantedAt: String(grant?.grantedAt || '').slice(0, 80),
        updatedAt: String(grant?.updatedAt || grant?.grantedAt || '').slice(0, 80)
    };
}

function normalizeBridgeStatus(payload = {}) {
    const grants = payload && typeof payload.grants === 'object' && payload.grants ? payload.grants : {};
    return {
        deviceId: normalizeDeviceId(payload.deviceId || payload.device_id),
        deviceName: String(payload.deviceName || payload.device_name || '我的电脑').trim().slice(0, 120) || '我的电脑',
        provider: String(payload.provider || 'desktop').trim().slice(0, 40) || 'desktop',
        mode: String(payload.mode || 'remote').trim().toLowerCase().slice(0, 40) || 'remote',
        grants: {
            local_database: sanitizeGrant('local_database', grants.local_database),
            local_report_dir: sanitizeGrant('local_report_dir', grants.local_report_dir)
        }
    };
}

function grantAuthorized(device, type) {
    return device?.grants?.[type]?.authorized === true;
}

function isDeviceActive(device, now = Date.now()) {
    return Boolean(device && now - Number(device.lastSeenAt || 0) <= DEVICE_TTL_MS);
}

function cleanupBridgeState() {
    const now = Date.now();
    for (const [key, device] of devices.entries()) {
        if (isDeviceActive(device, now)) continue;
        for (const resolve of Array.from(device.waiters || [])) {
            try { resolve(null); } catch (_err) { /* ignore waiter cleanup */ }
        }
        devices.delete(key);
    }
    for (const [id, task] of tasks.entries()) {
        if (task.deadlineAt > now && !['completed', 'failed'].includes(task.status)) continue;
        tasks.delete(id);
        if (task.status === 'pending' || task.status === 'running') {
            const err = bridgeError('本机执行器响应超时，请确认桌面端仍在线。', 504);
            try { task.reject(err); } catch (_err) { /* ignore late rejection */ }
        }
    }
}

function activeDevicesForUser(userId) {
    cleanupBridgeState();
    return Array.from(devices.values())
        .filter(device => device.userId === userId && isDeviceActive(device))
        .sort((a, b) => Number(b.lastSeenAt || 0) - Number(a.lastSeenAt || 0));
}

function selectDeviceForGrant(userId, grantType) {
    return activeDevicesForUser(userId).find(device => grantAuthorized(device, grantType)) || null;
}

function grantTypeForTool(toolName) {
    const serverType = getLocalDeviceMcpServerTypeForTool(toolName);
    if (serverType === 'database') return 'local_database';
    if (serverType === 'reports') return 'local_report_dir';
    return '';
}

function bridgeOwner(user) {
    return {
        id: user?.id || null,
        username: user?.username || '',
        nickname: user?.nickname || '',
        unit: user?.unit || '',
        role: user?.role || '',
        displayName: user?.nickname || user?.username || (user?.id ? `用户 ${user.id}` : '当前设备'),
        scope: 'user'
    };
}

function bridgeToolRow(tool, { serverType, serverName, databaseType = '', user, device }) {
    const name = String(tool.name || '').trim();
    return {
        serverId: LOCAL_MCP_SERVER_ID,
        serverName,
        serverType,
        databaseType,
        owner: bridgeOwner(user),
        user_id: user?.id || null,
        name,
        fullName: `mcp.${LOCAL_MCP_SERVER_ID}.${name}`,
        description: tool.description || '',
        input_schema: tool.inputSchema || tool.input_schema || { type: 'object' },
        cached_at: new Date(Number(device?.lastSeenAt || Date.now())).toISOString(),
        localDevice: {
            online: true,
            deviceId: device.deviceId,
            deviceName: device.deviceName,
            provider: device.provider,
            mode: device.mode,
            grants: {
                local_database: sanitizeGrant('local_database', device.grants?.local_database),
                local_report_dir: sanitizeGrant('local_report_dir', device.grants?.local_report_dir)
            }
        }
    };
}

function buildDatabaseConnectionShape(user) {
    return {
        id: 'local_bridge_database',
        mcp_server_id: LOCAL_MCP_SERVER_ID,
        user_id: user?.id || null,
        database_type: 'sqlite',
        database_name: 'local-device://authorized-sqlite',
        trusted_local_authorization: true,
        max_rows: 500,
        options: {}
    };
}

function listBridgeLocalDeviceMcpTools(user = null) {
    const userId = Number.parseInt(user?.id, 10);
    if (!Number.isSafeInteger(userId) || userId <= 0) return [];
    const tools = [];
    const dbDevice = selectDeviceForGrant(userId, 'local_database');
    const reportDevice = selectDeviceForGrant(userId, 'local_report_dir');
    if (dbDevice) {
        listDatabaseConnectionMcpTools(buildDatabaseConnectionShape(user)).forEach(tool => {
            tools.push(bridgeToolRow(tool, {
                serverType: 'database',
                serverName: `${dbDevice.deviceName || '我的电脑'}：本机 SQLite`,
                databaseType: 'sqlite',
                user,
                device: dbDevice
            }));
        });
    }
    if (reportDevice) {
        listReportTools().forEach(tool => {
            tools.push(bridgeToolRow(tool, {
                serverType: 'reports',
                serverName: `${reportDevice.deviceName || '我的电脑'}：本机报表目录`,
                user,
                device: reportDevice
            }));
        });
    }
    return tools;
}

function registerLocalBridgeDevice(user, payload = {}) {
    const userId = normalizeUserId(user);
    const status = normalizeBridgeStatus(payload);
    if (!status.deviceId) throw bridgeError('缺少本机执行器 deviceId。', 400);
    const key = deviceKey(userId, status.deviceId);
    const existing = devices.get(key) || {
        userId,
        deviceId: status.deviceId,
        waiters: new Set()
    };
    const device = {
        ...existing,
        userId,
        deviceId: status.deviceId,
        deviceName: status.deviceName,
        provider: status.provider,
        mode: status.mode,
        grants: status.grants,
        lastSeenAt: Date.now()
    };
    devices.set(key, device);
    notifyDevice(device);
    return summarizeDevice(device);
}

function summarizeDevice(device) {
    const active = isDeviceActive(device);
    return {
        deviceId: device.deviceId,
        deviceName: device.deviceName,
        provider: device.provider,
        mode: device.mode,
        active,
        lastSeenAt: new Date(Number(device.lastSeenAt || Date.now())).toISOString(),
        grants: {
            local_database: sanitizeGrant('local_database', device.grants?.local_database),
            local_report_dir: sanitizeGrant('local_report_dir', device.grants?.local_report_dir)
        }
    };
}

function getLocalBridgeStatus(user) {
    const userId = normalizeUserId(user);
    const activeDevices = activeDevicesForUser(userId).map(summarizeDevice);
    return {
        available: activeDevices.length > 0,
        devices: activeDevices
    };
}

function publicTaskPayload(task) {
    return {
        id: task.id,
        toolName: task.toolName,
        input: task.input || {},
        createdAt: new Date(task.createdAt).toISOString(),
        timeoutMs: Math.max(task.deadlineAt - Date.now(), 0)
    };
}

function findClaimableTask(device) {
    cleanupBridgeState();
    for (const task of tasks.values()) {
        if (task.userId !== device.userId) continue;
        if (task.deviceId !== device.deviceId) continue;
        if (task.status !== 'pending') continue;
        return task;
    }
    return null;
}

function claimTask(task) {
    task.status = 'running';
    task.startedAt = Date.now();
    return publicTaskPayload(task);
}

function notifyDevice(device) {
    const waiters = Array.from(device?.waiters || []);
    device.waiters?.clear();
    const [first, ...rest] = waiters;
    if (first) {
        try { first(findClaimableTask(device)); } catch (_err) { /* ignore waiter failure */ }
    }
    rest.forEach(resolve => {
        try { resolve(null); } catch (_err) { /* ignore waiter cleanup */ }
    });
}

async function pollLocalBridgeTask(user, deviceId, waitMs = POLL_TIMEOUT_MS) {
    const userId = normalizeUserId(user);
    const safeDeviceId = normalizeDeviceId(deviceId);
    if (!safeDeviceId) throw bridgeError('缺少本机执行器 deviceId。', 400);
    cleanupBridgeState();
    const device = devices.get(deviceKey(userId, safeDeviceId));
    if (!device || !isDeviceActive(device)) {
        return { task: null, status: 'offline' };
    }
    device.lastSeenAt = Date.now();
    const immediate = findClaimableTask(device);
    if (immediate) return { task: claimTask(immediate), status: 'claimed' };
    const timeoutMs = Math.min(Math.max(Number.parseInt(waitMs, 10) || POLL_TIMEOUT_MS, 1000), MAX_POLL_TIMEOUT_MS);
    const task = await new Promise(resolve => {
        const finish = (value) => {
            clearTimeout(timer);
            device.waiters.delete(finish);
            resolve(value);
        };
        const timer = setTimeout(() => finish(null), timeoutMs);
        device.waiters.add(finish);
    });
    if (!task) return { task: null, status: 'idle' };
    return { task: claimTask(task), status: 'claimed' };
}

async function executeBridgeLocalDeviceMcpTool(toolName, input = {}, user = null) {
    const userId = normalizeUserId(user);
    const grantType = grantTypeForTool(toolName);
    if (!grantType) throw bridgeError('不支持的本机工具。', 400);
    const device = selectDeviceForGrant(userId, grantType);
    if (!device) {
        throw bridgeError('当前没有在线的桌面端本机执行器，或尚未授权对应本机资源。', 404);
    }
    const id = crypto.randomUUID();
    const createdAt = Date.now();
    let resolveTask;
    let rejectTask;
    const promise = new Promise((resolve, reject) => {
        resolveTask = resolve;
        rejectTask = reject;
    });
    const task = {
        id,
        userId,
        deviceId: device.deviceId,
        toolName: String(toolName || ''),
        input: input || {},
        status: 'pending',
        createdAt,
        deadlineAt: createdAt + TASK_TIMEOUT_MS,
        resolve: resolveTask,
        reject: rejectTask,
        promise
    };
    tasks.set(id, task);
    notifyDevice(device);
    const timeout = setTimeout(() => {
        if (!tasks.has(id)) return;
        tasks.delete(id);
        const err = bridgeError('本机执行器响应超时，请确认桌面端仍在线。', 504);
        rejectTask(err);
    }, TASK_TIMEOUT_MS);
    timeout.unref?.();
    try {
        return await promise;
    } finally {
        clearTimeout(timeout);
        tasks.delete(id);
    }
}

function completeLocalBridgeTask(user, taskId, payload = {}) {
    const userId = normalizeUserId(user);
    const id = String(taskId || '').trim();
    const task = tasks.get(id);
    if (!task || task.userId !== userId) throw bridgeError('本机执行任务不存在或已过期。', 404);
    const safeDeviceId = normalizeDeviceId(payload.deviceId || payload.device_id);
    if (safeDeviceId !== task.deviceId) throw bridgeError('本机执行任务不属于当前设备。', 403);
    if (payload.success === false) {
        const normalized = normalizeBridgeExecutionError(payload.error);
        const err = bridgeError(normalized.message, normalized.status);
        err.code = normalized.code;
        err.detail = normalized.detail;
        task.status = 'failed';
        task.reject(err);
        tasks.delete(id);
        return { success: false };
    }
    task.status = 'completed';
    task.resolve(payload.result);
    tasks.delete(id);
    return { success: true };
}

function resetLocalBridgeForTests() {
    devices.clear();
    for (const task of tasks.values()) {
        try { task.reject(bridgeError('本机执行桥已重置。', 500)); } catch (_err) { /* ignore */ }
    }
    tasks.clear();
}

module.exports = {
    completeLocalBridgeTask,
    executeBridgeLocalDeviceMcpTool,
    getLocalBridgeStatus,
    listBridgeLocalDeviceMcpTools,
    pollLocalBridgeTask,
    registerLocalBridgeDevice,
    resetLocalBridgeForTests
};
