/**
 * 持久化桌面连接器：为只读本机 MCP 工具提供设备签名、显式设备绑定和可恢复任务租约。
 * 不保存本机绝对路径；实际路径始终只留在桌面端已有授权存储中。
 */
const crypto = require('crypto');
const { query, queryOne, execute } = require('../db/client');
const { getBeijingTimestamp } = require('../time');
const { assertTenantContext } = require('./agent-tenant-context');
const { loadActiveDevice, normalizeDeviceId } = require('./agent-local-devices');
const { getLocalDeviceMcpServerTypeForTool } = require('./local-device-mcp');
const { isLocalBrowserConnectorTool, normalizeLocalBrowserGrant, normalizeLocalBrowserTask } = require('./local-browser-connector-tools');

const GRANT_TYPES = Object.freeze(['local_database', 'local_report_dir', 'local_browser']);
const CONNECTOR_LEASE_SECONDS = 60;
const CONNECTOR_TASK_TTL_SECONDS = 120;
const LOCAL_BROWSER_TASK_TTL_SECONDS = 10 * 60;
const CONNECTOR_MAX_ATTEMPTS = 3;

function connectorError(message, code = 'LOCAL_CONNECTOR_INVALID', status = 400) {
    const error = new Error(message);
    error.code = code;
    error.status = status;
    error.statusCode = status;
    error.expose = true;
    return error;
}

function hash(value) { return crypto.createHash('sha256').update(String(value)).digest('hex'); }
function parseJson(value, fallback = {}) { try { return typeof value === 'object' ? value : JSON.parse(String(value || '')); } catch (_) { return fallback; } }
function grantTypeForTool(toolName) {
    if (isLocalBrowserConnectorTool(toolName)) return 'local_browser';
    const serverType = getLocalDeviceMcpServerTypeForTool(toolName);
    return serverType === 'database' ? 'local_database' : serverType === 'reports' ? 'local_report_dir' : '';
}
function normalizeConnectorGrants(value = {}) {
    const source = value && typeof value === 'object' ? value : {};
    return GRANT_TYPES.map(grantType => {
        const item = source[grantType] && typeof source[grantType] === 'object' ? source[grantType] : {};
        const browser = grantType === 'local_browser' ? normalizeLocalBrowserGrant(item) : null;
        return {
            grantType,
            authorized: item.authorized === true && (grantType !== 'local_browser' || browser.browsers.length > 0),
            pathHint: String(item.pathHint || '').slice(0, 255),
            label: String(item.label || '').slice(0, 255),
            metadata: browser || {}
        };
    });
}
function connectorHeartbeatPayload({ nonce, deviceId }) { return `connector:${nonce}:${deviceId}`; }
function connectorClaimPayload({ nonce, deviceId }) { return `connector-claim:${nonce}:${deviceId}`; }
function connectorResultPayload({ nonce, deviceId, taskId, claimToken }) { return `connector-result:${nonce}:${deviceId}:${taskId}:${claimToken}`; }

async function heartbeatConnector(user, input = {}) {
    const tenant = await assertTenantContext(user);
    const deviceId = normalizeDeviceId(input.deviceId);
    await loadActiveDevice(user.id, deviceId);
    const now = getBeijingTimestamp();
    const grants = normalizeConnectorGrants(input.grants);
    for (const grant of grants) {
        if (grant.authorized) {
            await execute(`
                INSERT INTO agent_local_connector_grants (id, device_id, tenant_id, user_id, grant_type, path_hint, label, metadata_json, revoked_at, last_attested_at, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?::jsonb, NULL, ?, ?, ?)
                ON CONFLICT(device_id, grant_type) DO UPDATE SET
                    tenant_id = EXCLUDED.tenant_id, user_id = EXCLUDED.user_id, path_hint = EXCLUDED.path_hint,
                    label = EXCLUDED.label, metadata_json = EXCLUDED.metadata_json, revoked_at = NULL,
                    last_attested_at = EXCLUDED.last_attested_at, updated_at = EXCLUDED.updated_at
            `, [crypto.randomBytes(20).toString('hex'), deviceId, tenant.tenantId, user.id, grant.grantType, grant.pathHint, grant.label, JSON.stringify(grant.metadata || {}), now, now, now]);
        } else {
            await execute(`UPDATE agent_local_connector_grants SET revoked_at = ?, updated_at = ? WHERE device_id = ? AND grant_type = ? AND revoked_at IS NULL`, [now, now, deviceId, grant.grantType]);
        }
    }
    return { deviceId, grants: grants.filter(item => item.authorized).map(item => ({ type: item.grantType, pathHint: item.pathHint, label: item.label })) };
}

async function listConnectorDevices(user) {
    const tenant = await assertTenantContext(user);
    const rows = await query(`
        SELECT d.device_id, d.device_name, d.provider, d.last_seen_at, g.grant_type, g.path_hint, g.label, g.metadata_json
        FROM agent_local_devices d
        JOIN agent_local_connector_grants g ON g.device_id = d.device_id
        WHERE d.user_id = ? AND d.tenant_id = ? AND d.status = 'active' AND d.revoked_at IS NULL
          AND g.tenant_id = ? AND g.revoked_at IS NULL
        ORDER BY d.last_seen_at DESC
    `, [user.id, tenant.tenantId, tenant.tenantId]);
    const grouped = new Map();
    rows.forEach(row => {
        if (!grouped.has(row.device_id)) grouped.set(row.device_id, { deviceId: row.device_id, deviceName: row.device_name, provider: row.provider, lastSeenAt: row.last_seen_at, grants: {} });
        const grant = { authorized: true, pathHint: row.path_hint, label: row.label };
        if (row.grant_type === 'local_browser') Object.assign(grant, normalizeLocalBrowserGrant(parseJson(row.metadata_json, {})));
        grouped.get(row.device_id).grants[row.grant_type] = grant;
    });
    return [...grouped.values()];
}

async function getConnectorGrant(user, deviceId, grantType) {
    const tenant = await assertTenantContext(user);
    return await queryOne(`
        SELECT * FROM agent_local_connector_grants
        WHERE device_id = ? AND tenant_id = ? AND user_id = ? AND grant_type = ? AND revoked_at IS NULL
    `, [deviceId, tenant.tenantId, user.id, grantType]);
}

async function resolveConnectorDeviceId(user, requestedDeviceId, grantType) {
    const rawDeviceId = String(requestedDeviceId || '').trim();
    const explicit = rawDeviceId ? normalizeDeviceId(rawDeviceId) : '';
    if (explicit) return explicit;
    const candidates = (await listConnectorDevices(user))
        .filter(device => device?.grants?.[grantType]?.authorized === true)
        .map(device => String(device.deviceId || ''))
        .filter(Boolean);
    if (candidates.length === 1) return candidates[0];
    if (!candidates.length) throw connectorError('当前没有在线且已授权的本机设备。', 'LOCAL_CONNECTOR_GRANT_REQUIRED', 403);
    throw connectorError('存在多个本机设备，请在工具调用中明确选择 deviceId。', 'LOCAL_CONNECTOR_DEVICE_REQUIRED', 409);
}

async function resolveConnectorDeviceForTool(user, toolName, input = {}, grantType) {
    if (grantType !== 'local_browser') return resolveConnectorDeviceId(user, input.deviceId || input.device_id, grantType);
    const rawDeviceId = String(input.deviceId || input.device_id || '').trim();
    const explicit = rawDeviceId ? normalizeDeviceId(rawDeviceId) : '';
    if (explicit) return explicit;
    const browserId = String(input.browserId || input.browser_id || '').trim();
    if (browserId) {
        const candidates = (await listConnectorDevices(user))
            .filter(device => device?.grants?.local_browser?.authorized === true)
            .filter(device => (device.grants.local_browser?.browsers || []).some(browser => String(browser?.id || '') === browserId));
        if (candidates.length === 1) return String(candidates[0].deviceId);
        if (candidates.length > 1) throw connectorError('该浏览器标识对应多个本机设备，请明确选择 deviceId。', 'LOCAL_CONNECTOR_DEVICE_REQUIRED', 409);
    }
    return resolveConnectorDeviceId(user, '', grantType);
}

async function createConnectorTask(toolName, input = {}, user) {
    const grantType = grantTypeForTool(toolName);
    if (!grantType) throw connectorError('不支持的本机连接器工具。', 'LOCAL_CONNECTOR_TOOL_INVALID');
    const deviceId = await resolveConnectorDeviceForTool(user, toolName, input, grantType);
    await loadActiveDevice(user.id, deviceId);
    const grant = await getConnectorGrant(user, deviceId, grantType);
    if (!grant) throw connectorError('指定设备未授权该本机只读资源。', 'LOCAL_CONNECTOR_GRANT_REQUIRED', 403);
    const tenant = await assertTenantContext(user);
    const safeInput = grantType === 'local_browser'
        ? await normalizeLocalBrowserTask(toolName, input, parseJson(grant.metadata_json, {}))
        : { ...(input || {}) };
    delete safeInput.deviceId;
    delete safeInput.device_id;
    const inputJson = JSON.stringify(safeInput);
    const id = crypto.randomUUID();
    const now = getBeijingTimestamp();
    const ttlSeconds = grantType === 'local_browser' ? LOCAL_BROWSER_TASK_TTL_SECONDS : CONNECTOR_TASK_TTL_SECONDS;
    const expiresAt = getBeijingTimestamp(new Date(Date.now() + ttlSeconds * 1000));
    await execute(`
        INSERT INTO agent_local_connector_tasks (id, tenant_id, user_id, device_id, grant_type, tool_name, input_json, input_digest, state, expires_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?::jsonb, ?, 'pending', ?, ?, ?)
    `, [id, tenant.tenantId, user.id, deviceId, grantType, String(toolName), inputJson, hash(inputJson), expiresAt, now, now]);
    return await queryOne('SELECT * FROM agent_local_connector_tasks WHERE id = ?', [id]);
}

async function reclaimConnectorTasks() {
    const now = getBeijingTimestamp();
    await execute(`UPDATE agent_local_connector_tasks SET state = 'expired', updated_at = ? WHERE state IN ('pending', 'claimed') AND expires_at <= ?`, [now, now]);
    await execute(`UPDATE agent_local_connector_tasks SET state = CASE WHEN attempt_count >= ? THEN 'failed' ELSE 'pending' END, claim_token_hash = NULL, lease_expires_at = NULL, updated_at = ? WHERE state = 'claimed' AND lease_expires_at <= ?`, [CONNECTOR_MAX_ATTEMPTS, now, now]);
}

async function claimConnectorTask(user, input = {}) {
    const tenant = await assertTenantContext(user);
    const deviceId = normalizeDeviceId(input.deviceId);
    await loadActiveDevice(user.id, deviceId);
    await reclaimConnectorTasks();
    const now = getBeijingTimestamp();
    const candidate = await queryOne(`
        SELECT * FROM agent_local_connector_tasks
        WHERE tenant_id = ? AND user_id = ? AND device_id = ? AND state = 'pending' AND expires_at > ?
        ORDER BY created_at ASC LIMIT 1
    `, [tenant.tenantId, user.id, deviceId, now]);
    if (!candidate) return { status: 'idle', task: null };
    const token = crypto.randomBytes(32).toString('hex');
    // 本机浏览器可能需要用户在可见窗口完成登录；使用与任务同级的长租约，
    // 避免登录尚未完成时被 60 秒通用租约错误回收。
    const leaseSeconds = candidate.grant_type === 'local_browser' ? LOCAL_BROWSER_TASK_TTL_SECONDS : CONNECTOR_LEASE_SECONDS;
    const lease = getBeijingTimestamp(new Date(Date.now() + leaseSeconds * 1000));
    const rows = await query(`
        UPDATE agent_local_connector_tasks
        SET state = 'claimed', attempt_count = attempt_count + 1, claim_token_hash = ?, lease_expires_at = ?, updated_at = ?
        WHERE id = ? AND state = 'pending'
        RETURNING *
    `, [hash(token), lease, now, candidate.id]);
    if (!rows.length) return { status: 'raced', task: null };
    const task = rows[0];
    return { status: 'claimed', claimToken: token, leaseExpiresAt: lease, task: { id: task.id, toolName: task.tool_name, input: parseJson(task.input_json), inputDigest: task.input_digest } };
}

async function completeConnectorTask(user, taskId, input = {}) {
    const tenant = await assertTenantContext(user);
    const deviceId = normalizeDeviceId(input.deviceId);
    const task = await queryOne(`SELECT * FROM agent_local_connector_tasks WHERE id = ? AND tenant_id = ? AND user_id = ?`, [taskId, tenant.tenantId, user.id]);
    if (!task) throw connectorError('本机连接器任务不存在。', 'LOCAL_CONNECTOR_TASK_NOT_FOUND', 404);
    if (task.device_id !== deviceId || task.state !== 'claimed' || task.claim_token_hash !== hash(input.claimToken || '')) {
        throw connectorError('连接器任务凭据无效或已被重新领取。', 'LOCAL_CONNECTOR_CLAIM_INVALID', 403);
    }
    const now = getBeijingTimestamp();
    if (input.success === false) {
        await execute(`UPDATE agent_local_connector_tasks SET state = 'failed', failure_code = ?, failure_reason = ?, claim_token_hash = NULL, lease_expires_at = NULL, updated_at = ? WHERE id = ?`, [String(input.error?.code || 'device_failed').slice(0, 80), String(input.error?.message || '桌面端执行失败。').slice(0, 2000), now, task.id]);
        return { success: false };
    }
    await execute(`UPDATE agent_local_connector_tasks SET state = 'completed', result_json = ?::jsonb, claim_token_hash = NULL, lease_expires_at = NULL, updated_at = ? WHERE id = ?`, [JSON.stringify(input.result ?? null), now, task.id]);
    return { success: true };
}

async function waitForConnectorTask(taskId, user, timeoutMs = LOCAL_BROWSER_TASK_TTL_SECONDS * 1000) {
    const deadline = Date.now() + Math.min(Math.max(Number(timeoutMs) || 0, 1000), LOCAL_BROWSER_TASK_TTL_SECONDS * 1000);
    while (Date.now() < deadline) {
        const task = await queryOne('SELECT * FROM agent_local_connector_tasks WHERE id = ? AND user_id = ?', [taskId, user.id]);
        if (!task) throw connectorError('本机连接器任务不存在。', 'LOCAL_CONNECTOR_TASK_NOT_FOUND', 404);
        if (task.state === 'completed') return parseJson(task.result_json, null);
        if (task.state === 'failed') throw connectorError(task.failure_reason || '桌面端执行失败。', task.failure_code || 'LOCAL_CONNECTOR_FAILED', 502);
        if (task.state === 'expired') throw connectorError('本机连接器任务已过期。', 'LOCAL_CONNECTOR_TIMEOUT', 504);
        await new Promise(resolve => setTimeout(resolve, 250));
    }
    throw connectorError('等待桌面连接器响应超时。', 'LOCAL_CONNECTOR_TIMEOUT', 504);
}

async function executeConnectorTool(toolName, input, user) {
    const task = await createConnectorTask(toolName, input, user);
    return await waitForConnectorTask(task.id, user);
}

module.exports = { claimConnectorTask, completeConnectorTask, connectorClaimPayload, connectorHeartbeatPayload, connectorResultPayload, createConnectorTask, executeConnectorTool, heartbeatConnector, listConnectorDevices, reclaimConnectorTasks, resolveConnectorDeviceForTool, resolveConnectorDeviceId, waitForConnectorTask };
