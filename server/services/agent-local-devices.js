/**
 * server/services/agent-local-devices.js
 * 本机设备身份、密钥证明与写入目录授权
 *
 * 落地方案 v1.2 §2.3-C1/C2/C7、§7.6、§7.7、阶段 3.1~3.4：
 * 1. 设备注册表持久化到数据库，进程内存不再是设备与在途意图的权威来源；
 * 2. deviceId 只用于路由，身份由「设备公钥 + 对服务端 nonce 的签名」证明；
 *    仅持有同一用户 Web 会话而不持有设备私钥的客户端，不能冒用已注册设备；
 * 3. 写入目录授权与既有 local_database / local_report_dir 只读授权彻底分离，
 *    只读授权绝不隐含写入权；授权 id 由服务端在设备签名后签发，不接受客户端自报；
 * 4. 设备或授权被撤销时，其名下 pending / claimed 交付意图立即 cancelled。
 */
const crypto = require('crypto');
const { query, queryOne, execute } = require('../db/client');
const { getBeijingTimestamp } = require('../time');
const { assertTenantContext } = require('./agent-tenant-context');
const { DELIVERY_EXTENSION_BY_FORMAT } = require('./agent-path-safety');

const NONCE_PURPOSES = Object.freeze(['register', 'attest', 'claim', 'grant', 'download', 'ack', 'connector']);
const NONCE_TTL_SECONDS = 120;
const DEVICE_ONLINE_WINDOW_MS = 90 * 1000;

function deviceError(message, code = 'AGENT_DEVICE_FORBIDDEN', status = 403) {
    const error = new Error(message);
    error.status = status;
    error.statusCode = status;
    error.code = code;
    error.expose = true;
    return error;
}

function normalizeDeviceId(value) {
    const text = String(value || '').trim();
    if (!/^[A-Za-z0-9._:-]{8,64}$/.test(text)) throw deviceError('设备标识格式非法。', 'AGENT_DEVICE_ID_INVALID', 400);
    return text;
}

function normalizePurpose(value) {
    const purpose = String(value || '').trim().toLowerCase();
    if (!NONCE_PURPOSES.includes(purpose)) throw deviceError('不支持的设备挑战用途。', 'AGENT_DEVICE_NONCE_PURPOSE_INVALID', 400);
    return purpose;
}

function beijingTimestampAfter(seconds) {
    return getBeijingTimestamp(new Date(Date.now() + Math.max(Number(seconds) || 0, 0) * 1000));
}

/** 公钥指纹：对 SPKI DER 取 sha256，与具体 PEM 换行差异无关。 */
function computeKeyFingerprint(publicKeyPem) {
    const key = crypto.createPublicKey(String(publicKeyPem));
    const der = key.export({ type: 'spki', format: 'der' });
    return crypto.createHash('sha256').update(der).digest('hex');
}

/**
 * 校验设备签名。同时支持 Ed25519 与 RSA/ECDSA：
 * Ed25519 走一步式 crypto.verify，RSA/EC 走 sha256 摘要验签。
 */
function verifySignatureWithPublicKey(publicKeyPem, payload, signatureBase64) {
    if (!publicKeyPem || !signatureBase64) return false;
    let key;
    try {
        key = crypto.createPublicKey(String(publicKeyPem));
    } catch (_) {
        return false;
    }
    const data = Buffer.from(String(payload), 'utf8');
    const signature = Buffer.from(String(signatureBase64), 'base64');
    try {
        if (key.asymmetricKeyType === 'ed25519' || key.asymmetricKeyType === 'ed448') {
            return crypto.verify(null, data, key, signature);
        }
        const verifier = crypto.createVerify('sha256');
        verifier.update(data);
        verifier.end();
        return verifier.verify(key, signature);
    } catch (_) {
        return false;
    }
}

/** 签发一次性挑战 nonce。 */
async function issueDeviceChallenge(user, input = {}) {
    const tenant = await assertTenantContext(user);
    const purpose = normalizePurpose(input.purpose || 'attest');
    const deviceId = input.deviceId ? normalizeDeviceId(input.deviceId) : null;
    const nonce = crypto.randomBytes(32).toString('hex');
    const expiresAt = beijingTimestampAfter(NONCE_TTL_SECONDS);
    await execute(`
        INSERT INTO agent_local_device_nonces (nonce, device_id, user_id, purpose, expires_at)
        VALUES (?, ?, ?, ?, ?)
    `, [nonce, deviceId, user.id, purpose, expiresAt]);
    return { nonce, purpose, deviceId, expiresAt, tenantId: tenant.tenantId };
}

/** 消费 nonce：必须属于同一用户与用途、未过期、未使用。消费为一次性且不可回滚。 */
async function consumeDeviceNonce(user, nonce, purpose, deviceId = null) {
    const safeNonce = String(nonce || '').trim();
    if (!/^[0-9a-f]{64}$/.test(safeNonce)) throw deviceError('设备挑战值非法。', 'AGENT_DEVICE_NONCE_INVALID', 400);
    const now = getBeijingTimestamp();
    const rows = await query(`
        UPDATE agent_local_device_nonces
        SET used_at = ?
        WHERE nonce = ?
          AND user_id = ?
          AND purpose = ?
          AND used_at IS NULL
          AND expires_at > ?
          AND (device_id IS NULL OR device_id = ?)
        RETURNING nonce, device_id, purpose
    `, [now, safeNonce, user.id, normalizePurpose(purpose), now, deviceId]);
    if (!rows.length) throw deviceError('设备挑战已过期或已被使用，请重新获取。', 'AGENT_DEVICE_NONCE_EXPIRED', 409);
    return rows[0];
}

/**
 * 注册或轮换设备密钥。
 * 首次配对：桌面端生成密钥对，用私钥对 `register:<nonce>:<deviceId>` 签名；
 * 服务端只保存公钥、指纹、状态与撤销信息，私钥始终留在设备本地凭据库。
 */
async function registerLocalDevice(user, input = {}) {
    const tenant = await assertTenantContext(user);
    const deviceId = normalizeDeviceId(input.deviceId);
    const publicKeyPem = String(input.publicKeyPem || input.public_key_pem || '').trim();
    if (!publicKeyPem) throw deviceError('设备注册必须提供公钥。', 'AGENT_DEVICE_PUBLIC_KEY_REQUIRED', 400);
    let fingerprint;
    try {
        fingerprint = computeKeyFingerprint(publicKeyPem);
    } catch (_) {
        throw deviceError('设备公钥格式非法。', 'AGENT_DEVICE_PUBLIC_KEY_INVALID', 400);
    }
    const existing = await queryOne('SELECT * FROM agent_local_devices WHERE device_id = ?', [deviceId]);
    if (existing && Number(existing.user_id) !== Number(user.id)) {
        throw deviceError('该设备标识已被其他用户注册。', 'AGENT_DEVICE_CONFLICT', 409);
    }
    // 首次配对使用待注册公钥证明；已有设备的密钥轮换必须先用旧私钥证明，
    // 否则仅持 Web 会话即可把同一 deviceId 换绑到攻击者公钥（C7/P0）。
    await consumeDeviceNonce(user, input.nonce, 'register', deviceId);
    const registrationPayload = `register:${input.nonce}:${deviceId}`;
    const verificationKey = existing ? existing.public_key_pem : publicKeyPem;
    if (!verifySignatureWithPublicKey(verificationKey, registrationPayload, input.signature)) {
        throw deviceError(
            existing ? '设备密钥轮换必须由原设备私钥签名证明。' : '设备注册签名校验失败。',
            'AGENT_DEVICE_ATTESTATION_FAILED'
        );
    }
    const now = getBeijingTimestamp();
    const deviceName = String(input.deviceName || input.device_name || '我的电脑').slice(0, 128);
    const provider = String(input.provider || 'desktop').slice(0, 32);
    if (existing) {
        const keyVersion = fingerprint === existing.key_fingerprint
            ? Number(existing.key_version || 1)
            : Number(existing.key_version || 1) + 1;
        await execute(`
            UPDATE agent_local_devices
            SET tenant_id = ?, device_name = ?, provider = ?, public_key_pem = ?, key_fingerprint = ?,
                key_version = ?, status = 'active', revoked_at = NULL, last_attested_at = ?, last_seen_at = ?, updated_at = ?
            WHERE device_id = ?
        `, [tenant.tenantId, deviceName, provider, publicKeyPem, fingerprint, keyVersion, now, now, now, deviceId]);
    } else {
        // 注册请求可能由启动时心跳和用户手动同步同时触发。不能使用
        // "先查后插" 作为并发互斥：两者都可能看到不存在并竞争同一主键。
        const inserted = await execute(`
            INSERT INTO agent_local_devices
                (device_id, tenant_id, user_id, device_name, provider, public_key_pem, key_fingerprint,
                 key_version, status, last_attested_at, last_seen_at, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, 1, 'active', ?, ?, ?, ?)
            ON CONFLICT (device_id) DO NOTHING
        `, [deviceId, tenant.tenantId, user.id, deviceName, provider, publicKeyPem, fingerprint, now, now, now, now]);
        if (!inserted) {
            const concurrent = await queryOne('SELECT * FROM agent_local_devices WHERE device_id = ?', [deviceId]);
            if (!concurrent || Number(concurrent.user_id) !== Number(user.id)) {
                throw deviceError('该设备标识已被其他用户注册。', 'AGENT_DEVICE_CONFLICT', 409);
            }
            // 仅接纳同一把公钥的并发重复注册。公钥不同仍必须走下一轮
            // 使用旧私钥证明的密钥轮换，不能借并发窗口替换设备身份。
            if (String(concurrent.key_fingerprint || '') !== fingerprint) {
                throw deviceError('设备密钥轮换必须由原设备私钥签名证明。', 'AGENT_DEVICE_ATTESTATION_FAILED');
            }
            await execute(`
                UPDATE agent_local_devices
                SET tenant_id = ?, device_name = ?, provider = ?, status = 'active', revoked_at = NULL,
                    last_attested_at = ?, last_seen_at = ?, updated_at = ?
                WHERE device_id = ? AND user_id = ? AND key_fingerprint = ?
            `, [tenant.tenantId, deviceName, provider, now, now, now, deviceId, user.id, fingerprint]);
        }
    }
    return await getLocalDeviceForUser(user, deviceId);
}

async function getLocalDeviceForUser(user, deviceId) {
    return await queryOne(
        'SELECT device_id, tenant_id, user_id, device_name, provider, key_fingerprint, key_version, status, last_attested_at, last_seen_at, revoked_at, created_at FROM agent_local_devices WHERE device_id = ? AND user_id = ?',
        [String(deviceId || ''), user.id]
    );
}

async function listLocalDevices(user) {
    return await query(`
        SELECT device_id, device_name, provider, key_fingerprint, key_version, status, last_attested_at, last_seen_at, revoked_at, created_at
        FROM agent_local_devices
        WHERE user_id = ?
        ORDER BY last_seen_at DESC NULLS LAST, created_at DESC
        LIMIT 100
    `, [user.id]);
}

/** 读取处于 active 状态的设备行（含公钥），供签名校验使用。 */
async function loadActiveDevice(userId, deviceId) {
    const device = await queryOne(
        "SELECT * FROM agent_local_devices WHERE device_id = ? AND user_id = ? AND status = 'active' AND revoked_at IS NULL",
        [String(deviceId || ''), userId]
    );
    if (!device) throw deviceError('设备未注册、已撤销或不属于当前用户。', 'AGENT_DEVICE_NOT_REGISTERED', 404);
    return device;
}

/**
 * 设备心跳与身份证明。
 * 心跳必须携带 nonce 签名，否则只更新不了 last_attested_at —— 未证明身份的心跳一律拒绝，
 * 避免「持有会话即可冒用已注册 deviceId」（C7）。
 */
async function attestLocalDevice(user, input = {}) {
    const deviceId = normalizeDeviceId(input.deviceId);
    const device = await loadActiveDevice(user.id, deviceId);
    await consumeDeviceNonce(user, input.nonce, 'attest', deviceId);
    if (!verifySignatureWithPublicKey(device.public_key_pem, `attest:${input.nonce}:${deviceId}`, input.signature)) {
        throw deviceError('设备身份证明签名校验失败。', 'AGENT_DEVICE_ATTESTATION_FAILED');
    }
    const now = getBeijingTimestamp();
    await execute('UPDATE agent_local_devices SET last_attested_at = ?, last_seen_at = ?, updated_at = ? WHERE device_id = ?', [now, now, now, deviceId]);
    return await getLocalDeviceForUser(user, deviceId);
}

/** 校验一次任务级签名（领取、回执、令牌兑换）。payload 由调用方按用途拼装。 */
async function assertDeviceSignature(user, { deviceId, purpose, nonce, signature, payload } = {}) {
    const safeDeviceId = normalizeDeviceId(deviceId);
    const device = await loadActiveDevice(user.id, safeDeviceId);
    await consumeDeviceNonce(user, nonce, purpose, safeDeviceId);
    const expected = payload || `${normalizePurpose(purpose)}:${nonce}:${safeDeviceId}`;
    if (!verifySignatureWithPublicKey(device.public_key_pem, expected, signature)) {
        throw deviceError('设备签名校验失败。', 'AGENT_DEVICE_ATTESTATION_FAILED');
    }
    const now = getBeijingTimestamp();
    await execute('UPDATE agent_local_devices SET last_seen_at = ?, updated_at = ? WHERE device_id = ?', [now, now, safeDeviceId]);
    return device;
}

function isDeviceOnline(device, now = Date.now()) {
    if (!device || device.status !== 'active' || device.revoked_at) return false;
    const lastSeen = device.last_seen_at ? Date.parse(String(device.last_seen_at).replace(' ', 'T')) : NaN;
    if (!Number.isFinite(lastSeen)) return false;
    return now - lastSeen <= DEVICE_ONLINE_WINDOW_MS;
}

/** 撤销设备：级联撤销其写入授权，并把在途交付意图置为 cancelled。 */
async function revokeLocalDevice(user, deviceId) {
    const safeDeviceId = normalizeDeviceId(deviceId);
    const device = await getLocalDeviceForUser(user, safeDeviceId);
    if (!device) return null;
    const now = getBeijingTimestamp();
    await execute("UPDATE agent_local_devices SET status = 'revoked', revoked_at = ?, updated_at = ? WHERE device_id = ?", [now, now, safeDeviceId]);
    await execute('UPDATE agent_local_output_grants SET revoked_at = ? WHERE device_id = ? AND revoked_at IS NULL', [now, safeDeviceId]);
    await execute(`
        UPDATE agent_artifact_delivery_intents
        SET state = 'cancelled', failure_code = 'device_revoked', failure_reason = '目标设备已被撤销。', updated_at = ?
        WHERE device_id = ? AND state IN ('pending', 'claimed')
    `, [now, safeDeviceId]);
    return await getLocalDeviceForUser(user, safeDeviceId);
}

function normalizeAllowedFormats(value) {
    const source = Array.isArray(value) ? value : [];
    const allowed = source
        .map(item => String(item || '').trim().toLowerCase())
        .filter(item => Object.prototype.hasOwnProperty.call(DELIVERY_EXTENSION_BY_FORMAT, item));
    return [...new Set(allowed.length ? allowed : Object.keys(DELIVERY_EXTENSION_BY_FORMAT))];
}

function grantMaxDays(env = process.env) {
    return Math.max(1, Math.min(Number.parseInt(env.PIVOT_LOCAL_OUTPUT_GRANT_MAX_DAYS, 10) || 30, 365));
}

function grantMaxBytes(env = process.env) {
    return Math.max(1024, Number.parseInt(env.PIVOT_LOCAL_OUTPUT_MAX_BYTES, 10) || 64 * 1024 * 1024);
}

function grantDailyQuota(env = process.env) {
    return Math.max(0, Number.parseInt(env.PIVOT_LOCAL_OUTPUT_DAILY_QUOTA_BYTES, 10) || 1024 * 1024 * 1024);
}

/**
 * 登记写入目录授权。
 * 完整目录路径只保存在桌面端受保护的授权存储中，服务端只保留末级目录提示、
 * 授权 id、设备绑定与有效期（§7.6）。授权 id 由服务端生成，客户端不得自报。
 */
async function registerOutputGrant(user, input = {}) {
    const tenant = await assertTenantContext(user);
    const deviceId = normalizeDeviceId(input.deviceId);
    const pathHint = String(input.pathHint || input.path_hint || '').trim().slice(0, 255);
    if (!pathHint) throw deviceError('写入授权必须提供目录提示。', 'AGENT_OUTPUT_GRANT_INVALID', 400);
    await assertDeviceSignature(user, {
        deviceId,
        purpose: 'grant',
        nonce: input.nonce,
        signature: input.signature,
        payload: `grant:${input.nonce}:${deviceId}:${pathHint}`
    });
    const days = Math.min(Math.max(Number.parseInt(input.expiresInDays, 10) || grantMaxDays(), 1), grantMaxDays());
    const grantId = crypto.randomBytes(24).toString('hex');
    const now = getBeijingTimestamp();
    await execute(`
        INSERT INTO agent_local_output_grants
            (id, device_id, tenant_id, user_id, path_hint, allowed_formats, max_bytes, daily_quota_bytes, expires_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
        grantId, deviceId, tenant.tenantId, user.id, pathHint,
        JSON.stringify(normalizeAllowedFormats(input.allowedFormats || input.allowed_formats)),
        grantMaxBytes(), grantDailyQuota(),
        getBeijingTimestamp(new Date(Date.now() + days * 24 * 60 * 60 * 1000)), now
    ]);
    return await queryOne('SELECT * FROM agent_local_output_grants WHERE id = ?', [grantId]);
}

async function listOutputGrants(user, options = {}) {
    const deviceId = options.deviceId ? normalizeDeviceId(options.deviceId) : null;
    const params = [user.id];
    let clause = '';
    if (deviceId) {
        clause = ' AND device_id = ?';
        params.push(deviceId);
    }
    return await query(`
        SELECT id, device_id, path_hint, allowed_formats, max_bytes, daily_quota_bytes, expires_at, revoked_at, created_at
        FROM agent_local_output_grants
        WHERE user_id = ?${clause}
        ORDER BY created_at DESC
        LIMIT 200
    `, params);
}

/** 读取有效授权：未撤销、未过期、归属当前用户与租户、绑定指定设备。 */
async function getActiveOutputGrant({ grantId, deviceId, userId, tenantId } = {}) {
    const now = getBeijingTimestamp();
    return await queryOne(`
        SELECT * FROM agent_local_output_grants
        WHERE id = ? AND device_id = ? AND user_id = ? AND tenant_id = ?
          AND revoked_at IS NULL AND expires_at > ?
    `, [String(grantId || ''), String(deviceId || ''), userId, tenantId, now]);
}

/** 撤销写入授权：该授权下所有 pending / claimed 意图立即 cancelled（§7.7 第 6 条）。 */
async function revokeOutputGrant(user, grantId) {
    const safeId = String(grantId || '').trim();
    const grant = await queryOne('SELECT * FROM agent_local_output_grants WHERE id = ? AND user_id = ?', [safeId, user.id]);
    if (!grant) return null;
    const now = getBeijingTimestamp();
    await execute('UPDATE agent_local_output_grants SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL', [now, safeId]);
    await execute(`
        UPDATE agent_artifact_delivery_intents
        SET state = 'cancelled', failure_code = 'grant_revoked', failure_reason = '目标目录授权已被撤销。', updated_at = ?
        WHERE target_dir_grant = ? AND state IN ('pending', 'claimed')
    `, [now, safeId]);
    return await queryOne('SELECT * FROM agent_local_output_grants WHERE id = ?', [safeId]);
}

module.exports = {
    DEVICE_ONLINE_WINDOW_MS,
    NONCE_PURPOSES,
    NONCE_TTL_SECONDS,
    assertDeviceSignature,
    attestLocalDevice,
    computeKeyFingerprint,
    consumeDeviceNonce,
    deviceError,
    getActiveOutputGrant,
    getLocalDeviceForUser,
    grantDailyQuota,
    grantMaxBytes,
    isDeviceOnline,
    issueDeviceChallenge,
    listLocalDevices,
    listOutputGrants,
    loadActiveDevice,
    normalizeAllowedFormats,
    normalizeDeviceId,
    registerLocalDevice,
    registerOutputGrant,
    revokeLocalDevice,
    revokeOutputGrant,
    verifySignatureWithPublicKey
};
