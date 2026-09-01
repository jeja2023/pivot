/**
 * server/services/agent-artifact-delivery.js
 * 产物交付意图状态机与交付审计
 *
 * 落地方案 v1.2 §7.4、§7.6、§7.7、§8.1、阶段 3.3~3.7：
 * 1. Web 下载与桌面端本机写入共用同一套意图与幂等模型，不为桌面端另建协议；
 * 2. 意图只能由用户操作创建，Agent 不能创建交付意图 —— 这是阻断「模型自行往用户磁盘写文件」的根本机制；
 * 3. 幂等键由服务端按规范化字段生成（含发起人），客户端不得自报或复用任意键；
 * 4. 领取写入 claimed_by、随机 claim token 与租约；确认、失败与续约都必须携带同一 claim token，
 *    租约到期后才允许重新领取，旧 token 的回执一律拒绝，避免旧领取者覆盖新领取者状态；
 * 5. delivered 的前置条件是交付端回报摘要与 rendition.content_digest 一致；不一致记 failed 并告警，不重试。
 */
const crypto = require('crypto');
const { query, queryOne, execute } = require('../db/client');
const { getBeijingTimestamp } = require('../time');
const { assertTenantContext } = require('./agent-tenant-context');
const {
    getActiveOutputGrant,
    isDeviceOnline,
    loadActiveDevice,
    normalizeAllowedFormats,
    normalizeDeviceId
} = require('./agent-local-devices');
const { buildDeliveryFilename } = require('./agent-path-safety');
const {
    recordDeliveryDigestMismatch,
    recordDeliveryIntentState,
    recordDeliveryOverwrite
} = require('./agent-governance-metrics');

const DELIVERY_CHANNELS = Object.freeze(['web_download', 'local_device']);
const DELIVERY_STATES = Object.freeze(['pending', 'claimed', 'delivered', 'failed', 'cancelled', 'expired']);

function deliveryError(message, code = 'ARTIFACT_DELIVERY_INVALID', status = 400) {
    const error = new Error(message);
    error.status = status;
    error.statusCode = status;
    error.code = code;
    error.expose = true;
    return error;
}

function intentTtlSeconds(env = process.env) {
    return Math.max(60, Math.min(Number.parseInt(env.PIVOT_ARTIFACT_DELIVERY_TTL_SECONDS, 10) || 900, 24 * 3600));
}

function leaseSeconds(env = process.env) {
    return Math.max(10, Math.min(Number.parseInt(env.PIVOT_ARTIFACT_DELIVERY_LEASE_SECONDS, 10) || 60, 600));
}

function maxAttempts(env = process.env) {
    return Math.max(1, Math.min(Number.parseInt(env.PIVOT_ARTIFACT_DELIVERY_MAX_ATTEMPTS, 10) || 3, 10));
}

function normalizeChannel(value) {
    const channel = String(value || '').trim().toLowerCase();
    if (!DELIVERY_CHANNELS.includes(channel)) throw deliveryError(`交付通道只能是 ${DELIVERY_CHANNELS.join(' 或 ')}。`);
    return channel;
}

function hashSecret(value) {
    return crypto.createHash('sha256').update(String(value)).digest('hex');
}

/** 幂等键：由服务端以规范化字段生成，包含发起人，避免两个可访问同一 rendition 的用户互相命中。 */
function buildIdempotencyKey(parts = {}) {
    const canonical = [
        parts.tenantId ?? '',
        parts.requestedBy ?? '',
        parts.runId ?? '',
        parts.renditionId ?? '',
        parts.channel ?? '',
        parts.deviceId ?? '',
        parts.targetDirGrant ?? '',
        parts.targetFilename ?? ''
    ].join(':');
    return crypto.createHash('sha256').update(canonical).digest('hex');
}

/** 设备回执签名载荷：把一次性 claim token 与意图绑定，防止跨意图重放。 */
function buildDeliveryAckSignaturePayload({ nonce, deviceId, intentId, claimToken } = {}) {
    return `ack:${String(nonce || '').trim()}:${String(deviceId || '').trim()}:${String(intentId || '').trim()}:${String(claimToken || '').trim()}`;
}

/** 设备下载令牌兑换签名载荷：把令牌、rendition 与设备挑战绑定。 */
function buildDeliveryDownloadSignaturePayload({ nonce, deviceId, renditionId, token } = {}) {
    return `download:${String(nonce || '').trim()}:${String(deviceId || '').trim()}:${String(renditionId || '').trim()}:${String(token || '').trim()}`;
}

/** 附加式审计事件。只保存目录末级提示与文件名，绝不保存终端完整绝对路径。 */
async function recordDeliveryEvent(event = {}) {
    await execute(`
        INSERT INTO agent_artifact_delivery_events
            (tenant_id, intent_id, rendition_id, run_id, tool_call_id, actor_type, actor_id, event_type,
             channel, device_id, path_hint, content_digest, decision_reason)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
        event.tenantId, event.intentId || null, event.renditionId || null, String(event.runId || ''),
        event.toolCallId || null, String(event.actorType || 'system').slice(0, 16), String(event.actorId || '').slice(0, 64),
        String(event.eventType || '').slice(0, 32), event.channel || null, event.deviceId || null,
        event.pathHint ? String(event.pathHint).slice(0, 255) : null,
        event.contentDigest || null,
        event.decisionReason ? String(event.decisionReason).slice(0, 2000) : null
    ]);
}

/**
 * 创建交付意图。只允许用户操作触发；Agent 侧工具最多产出 Rendition。
 * local_device 通道必须显式携带 deviceId 与目录授权（C2：服务端不再隐式选设备）。
 */
async function createDeliveryIntent(user, input = {}) {
    if (input.actorType === 'agent' || input.agentInitiated === true) {
        throw deliveryError('交付意图只能由用户操作创建，Agent 不得创建交付意图。', 'ARTIFACT_DELIVERY_ACTOR_FORBIDDEN', 403);
    }
    const tenant = await assertTenantContext(user);
    const channel = normalizeChannel(input.channel);
    const { getRenditionForUser } = require('./agent-artifact-renditions');
    const rendition = await getRenditionForUser(input.renditionId, user);
    if (!rendition) throw deliveryError('渲染产物不存在或无权交付。', 'ARTIFACT_NOT_FOUND', 404);
    if (rendition.status !== 'ready') throw deliveryError('该渲染产物尚未就绪，不能交付。', 'ARTIFACT_RENDITION_NOT_READY', 409);

    let deviceId = null;
    let grantId = null;
    let filename = null;
    if (channel === 'local_device') {
        deviceId = normalizeDeviceId(input.deviceId);
        const device = await loadActiveDevice(user.id, deviceId);
        if (Number(device.tenant_id) !== Number(tenant.tenantId)) {
            throw deliveryError('目标设备不属于当前租户。', 'AGENT_DEVICE_TENANT_MISMATCH', 403);
        }
        grantId = String(input.targetDirGrant || input.target_dir_grant || '').trim();
        if (!grantId) throw deliveryError('本机交付必须指定写入目录授权。', 'ARTIFACT_DELIVERY_GRANT_REQUIRED');
        const grant = await getActiveOutputGrant({ grantId, deviceId, userId: user.id, tenantId: tenant.tenantId });
        if (!grant) throw deliveryError('写入目录授权无效、已过期或不属于该设备。', 'ARTIFACT_DELIVERY_GRANT_INVALID', 403);
        const allowedFormats = normalizeAllowedFormats(typeof grant.allowed_formats === 'string' ? JSON.parse(grant.allowed_formats || '[]') : grant.allowed_formats);
        if (!allowedFormats.includes(String(rendition.format))) {
            throw deliveryError(`该目录授权不允许 ${rendition.format} 格式。`, 'ARTIFACT_DELIVERY_FORMAT_FORBIDDEN', 403);
        }
        if (Number(grant.max_bytes) > 0 && Number(rendition.byte_size) > Number(grant.max_bytes)) {
            throw deliveryError('渲染产物超过该授权的单次写入体积上限。', 'ARTIFACT_DELIVERY_TOO_LARGE', 413);
        }
        await assertDailyQuota(grant, rendition);
        // 文件名与扩展名一律由服务端按 format 白名单决定，不接受交付端指定可执行扩展名。
        filename = buildDeliveryFilename(input.targetFilename || input.target_filename || rendition.format, rendition.format);
    }

    const idempotencyKey = buildIdempotencyKey({
        tenantId: tenant.tenantId,
        requestedBy: user.id,
        runId: rendition.run_id,
        renditionId: rendition.id,
        channel,
        deviceId,
        targetDirGrant: grantId,
        targetFilename: filename
    });
    const existing = await queryOne(
        'SELECT * FROM agent_artifact_delivery_intents WHERE tenant_id = ? AND requested_by = ? AND idempotency_key = ?',
        [tenant.tenantId, user.id, idempotencyKey]
    );
    if (existing) {
        // 已 delivered 的意图再次创建时直接返回既有结果，不重新写文件。
        return { intent: existing, reused: true };
    }
    const now = getBeijingTimestamp();
    const expiresAt = getBeijingTimestamp(new Date(Date.now() + intentTtlSeconds() * 1000));
    const intent = await queryOne(`
        INSERT INTO agent_artifact_delivery_intents
            (tenant_id, rendition_id, run_id, requested_by, channel, device_id, target_dir_grant, target_filename,
             allow_overwrite, idempotency_key, state, expires_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)
        RETURNING *
    `, [
        tenant.tenantId, rendition.id, rendition.run_id, user.id, channel, deviceId, grantId, filename,
        input.allowOverwrite === true, idempotencyKey, expiresAt, now, now
    ]);
    recordDeliveryIntentState({ channel, state: 'pending' });
    await recordDeliveryEvent({
        tenantId: tenant.tenantId,
        intentId: intent.id,
        renditionId: rendition.id,
        runId: rendition.run_id,
        toolCallId: rendition.tool_call_id,
        actorType: 'user',
        actorId: String(user.id),
        eventType: 'intent_created',
        channel,
        deviceId,
        pathHint: filename,
        contentDigest: rendition.content_digest
    });
    return { intent, reused: false };
}

/** 单设备单日写入配额：服务端侧限制，桌面端另有一份（§7.7 第 5 条双侧限制）。 */
async function assertDailyQuota(grant, rendition) {
    const quota = Number(grant.daily_quota_bytes) || 0;
    if (quota <= 0) return;
    const since = getBeijingTimestamp(new Date(Date.now() - 24 * 60 * 60 * 1000));
    const row = await queryOne(`
        SELECT COALESCE(SUM(r.byte_size), 0) AS total
        FROM agent_artifact_delivery_intents i
        JOIN agent_artifact_renditions r ON r.id = i.rendition_id
        WHERE i.target_dir_grant = ? AND i.state = 'delivered' AND i.updated_at >= ?
    `, [grant.id, since]);
    const used = Number(row?.total || 0);
    if (used + Number(rendition.byte_size) > quota) {
        throw deliveryError('本机写入已达单日配额上限。', 'ARTIFACT_DELIVERY_QUOTA_EXCEEDED', 429);
    }
}

/** 回收过期租约与过期意图。租约到期只在原 token 失效后才回到 pending。 */
async function reclaimDeliveryIntents() {
    const now = getBeijingTimestamp();
    const reclaimed = await query(`
        UPDATE agent_artifact_delivery_intents
        SET state = 'pending', claimed_by = '', claim_token_hash = NULL, lease_expires_at = NULL,
            attempt_count = attempt_count + 1, updated_at = ?
        WHERE state = 'claimed' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ? AND attempt_count + 1 < ?
        RETURNING id, channel
    `, [now, now, maxAttempts()]);
    const exhausted = await query(`
        UPDATE agent_artifact_delivery_intents
        SET state = 'failed', failure_code = 'attempts_exhausted', failure_reason = '领取重试次数已达上限。',
            claim_token_hash = NULL, lease_expires_at = NULL, updated_at = ?
        WHERE state = 'claimed' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ? AND attempt_count + 1 >= ?
        RETURNING id, channel
    `, [now, now, maxAttempts()]);
    const expired = await query(`
        UPDATE agent_artifact_delivery_intents
        SET state = 'expired', claim_token_hash = NULL, lease_expires_at = NULL, updated_at = ?
        WHERE state IN ('pending', 'claimed') AND expires_at <= ?
        RETURNING id, channel
    `, [now, now]);
    reclaimed.forEach(item => recordDeliveryIntentState({ channel: item.channel, state: 'pending' }));
    exhausted.forEach(item => recordDeliveryIntentState({ channel: item.channel, state: 'failed' }));
    expired.forEach(item => recordDeliveryIntentState({ channel: item.channel, state: 'expired' }));
    return { reclaimed: reclaimed.length, exhausted: exhausted.length, expired: expired.length };
}

/**
 * 设备领取一条待交付意图。
 * 四条件之一「设备在线、已配对且持有注册私钥」在此校验：调用方必须已通过
 * assertDeviceSignature（路由层完成），本函数再校验设备状态、授权与意图归属。
 */
async function claimDeliveryIntent(user, input = {}) {
    const tenant = await assertTenantContext(user);
    const deviceId = normalizeDeviceId(input.deviceId);
    const device = await loadActiveDevice(user.id, deviceId);
    await reclaimDeliveryIntents();
    const now = getBeijingTimestamp();
    const candidate = await queryOne(`
        SELECT * FROM agent_artifact_delivery_intents
        WHERE tenant_id = ? AND requested_by = ? AND device_id = ? AND channel = 'local_device'
          AND state = 'pending' AND expires_at > ?
        ORDER BY created_at ASC
        LIMIT 1
    `, [tenant.tenantId, user.id, deviceId, now]);
    if (!candidate) return { intent: null, status: 'idle' };
    const grant = await getActiveOutputGrant({
        grantId: candidate.target_dir_grant,
        deviceId,
        userId: user.id,
        tenantId: tenant.tenantId
    });
    if (!grant) {
        await execute(`
            UPDATE agent_artifact_delivery_intents
            SET state = 'cancelled', failure_code = 'grant_invalid', failure_reason = '写入目录授权已失效。', updated_at = ?
            WHERE id = ?
        `, [now, candidate.id]);
        return { intent: null, status: 'grant_invalid' };
    }
    const claimToken = crypto.randomBytes(32).toString('hex');
    const leaseExpiresAt = getBeijingTimestamp(new Date(Date.now() + leaseSeconds() * 1000));
    const claimed = await query(`
        UPDATE agent_artifact_delivery_intents
        SET state = 'claimed', claimed_by = ?, claim_token_hash = ?, lease_expires_at = ?,
            attempt_count = attempt_count + 1, updated_at = ?
        WHERE id = ? AND state = 'pending'
        RETURNING *
    `, [String(input.workerId || deviceId).slice(0, 128), hashSecret(claimToken), leaseExpiresAt, now, candidate.id]);
    if (!claimed.length) return { intent: null, status: 'raced' };
    const intent = claimed[0];
    recordDeliveryIntentState({ channel: intent.channel, state: 'claimed' });
    const { getRenditionForUser, issueDownloadToken } = require('./agent-artifact-renditions');
    const rendition = await getRenditionForUser(intent.rendition_id, user);
    const download = await issueDownloadToken(user, intent.rendition_id, { deviceId });
    await recordDeliveryEvent({
        tenantId: tenant.tenantId,
        intentId: intent.id,
        renditionId: intent.rendition_id,
        runId: intent.run_id,
        actorType: 'device',
        actorId: deviceId,
        eventType: 'claimed',
        channel: intent.channel,
        deviceId,
        pathHint: intent.target_filename,
        contentDigest: rendition?.content_digest || null
    });
    return {
        status: 'claimed',
        intent,
        claimToken,
        leaseExpiresAt,
        deviceOnline: isDeviceOnline(device),
        downloadToken: download?.token || '',
        downloadTokenExpiresAt: download?.expiresAt || '',
        rendition: rendition
            ? {
                id: rendition.id,
                format: rendition.format,
                mimeType: rendition.mime_type,
                byteSize: Number(rendition.byte_size),
                contentDigest: rendition.content_digest
            }
            : null,
        grant: { id: grant.id, pathHint: grant.path_hint, maxBytes: Number(grant.max_bytes) },
        targetFilename: intent.target_filename,
        allowOverwrite: intent.allow_overwrite === true
    };
}

async function loadClaimedIntent(user, intentId, claimToken, deviceId = '') {
    const tenant = await assertTenantContext(user);
    const intent = await queryOne(
        'SELECT * FROM agent_artifact_delivery_intents WHERE id = ? AND tenant_id = ? AND requested_by = ?',
        [intentId, tenant.tenantId, user.id]
    );
    if (!intent) throw deliveryError('交付意图不存在或无权访问。', 'ARTIFACT_DELIVERY_NOT_FOUND', 404);
    if (deviceId && String(intent.device_id || '') !== String(deviceId)) {
        throw deliveryError('交付意图与设备不匹配。', 'ARTIFACT_DELIVERY_DEVICE_MISMATCH', 403);
    }
    if (intent.state === 'delivered') return { intent, tenant, alreadyDelivered: true };
    if (intent.state !== 'claimed') throw deliveryError('交付意图当前不处于已领取状态。', 'ARTIFACT_DELIVERY_STATE_CONFLICT', 409);
    if (!intent.claim_token_hash || intent.claim_token_hash !== hashSecret(claimToken || '')) {
        throw deliveryError('领取凭据无效或已被新的领取者取代。', 'ARTIFACT_DELIVERY_CLAIM_INVALID', 403);
    }
    return { intent, tenant, alreadyDelivered: false };
}

/**
 * 交付端回执。
 * delivered 的前置条件是回报摘要与 rendition.content_digest 一致；
 * 不一致记 failed 并告警，且不重试（内容不一致意味着传输或篡改问题，重试无意义）。
 */
async function confirmDelivery(user, input = {}) {
    const { intent, tenant, alreadyDelivered } = await loadClaimedIntent(user, input.intentId, input.claimToken, input.deviceId);
    if (alreadyDelivered) return { intent, reused: true };
    const { getRenditionForUser } = require('./agent-artifact-renditions');
    const rendition = await getRenditionForUser(intent.rendition_id, user);
    if (!rendition) throw deliveryError('渲染产物不存在或无权访问。', 'ARTIFACT_NOT_FOUND', 404);
    const confirmedDigest = String(input.confirmedDigest || '').trim().toLowerCase();
    const now = getBeijingTimestamp();
    if (!/^[0-9a-f]{64}$/.test(confirmedDigest) || confirmedDigest !== String(rendition.content_digest).toLowerCase()) {
        recordDeliveryDigestMismatch();
        await execute(`
            UPDATE agent_artifact_delivery_intents
            SET state = 'failed', failure_code = 'digest_mismatch', failure_reason = '交付端回报摘要与登记摘要不一致。',
                claim_token_hash = NULL, lease_expires_at = NULL, confirmed_digest = ?, updated_at = ?
            WHERE id = ?
        `, [confirmedDigest || null, now, intent.id]);
        recordDeliveryIntentState({ channel: intent.channel, state: 'failed' });
        await recordDeliveryEvent({
            tenantId: tenant.tenantId,
            intentId: intent.id,
            renditionId: rendition.id,
            runId: intent.run_id,
            actorType: 'device',
            actorId: String(intent.device_id || user.id),
            eventType: 'digest_mismatch',
            channel: intent.channel,
            deviceId: intent.device_id,
            contentDigest: confirmedDigest || null,
            decisionReason: '摘要不一致，已判定为失败且不重试。'
        });
        throw deliveryError('交付内容摘要不一致，已记为失败且不会重试。', 'ARTIFACT_DELIVERY_DIGEST_MISMATCH', 409);
    }
    const pathHint = String(input.pathHint || intent.target_filename || '').slice(0, 255);
    await execute(`
        UPDATE agent_artifact_delivery_intents
        SET state = 'delivered', confirmed_digest = ?, confirmed_path_hint = ?,
            claim_token_hash = NULL, lease_expires_at = NULL, updated_at = ?
        WHERE id = ?
    `, [confirmedDigest, pathHint, now, intent.id]);
    recordDeliveryIntentState({ channel: intent.channel, state: 'delivered' });
    if (input.overwritten === true) {
        recordDeliveryOverwrite();
        await recordDeliveryEvent({
            tenantId: tenant.tenantId,
            intentId: intent.id,
            renditionId: rendition.id,
            runId: intent.run_id,
            actorType: 'device',
            actorId: String(intent.device_id || user.id),
            eventType: 'overwrite',
            channel: intent.channel,
            deviceId: intent.device_id,
            pathHint,
            contentDigest: confirmedDigest,
            decisionReason: '用户在本次交付中显式勾选了允许覆盖。'
        });
    }
    await recordDeliveryEvent({
        tenantId: tenant.tenantId,
        intentId: intent.id,
        renditionId: rendition.id,
        runId: intent.run_id,
        actorType: 'device',
        actorId: String(intent.device_id || user.id),
        eventType: 'delivered',
        channel: intent.channel,
        deviceId: intent.device_id,
        pathHint,
        contentDigest: confirmedDigest
    });
    return { intent: await queryOne('SELECT * FROM agent_artifact_delivery_intents WHERE id = ?', [intent.id]), reused: false };
}

/** 交付端报告失败：回到 pending 等待重试，达上限转 failed。 */
async function failDelivery(user, input = {}) {
    const { intent, tenant, alreadyDelivered } = await loadClaimedIntent(user, input.intentId, input.claimToken, input.deviceId);
    if (alreadyDelivered) return { intent, reused: true };
    const now = getBeijingTimestamp();
    const failureCode = String(input.failureCode || 'device_reported_failure').slice(0, 64);
    const failureReason = String(input.failureReason || '交付端报告写入失败。').slice(0, 2000);
    const exhausted = Number(intent.attempt_count || 0) >= maxAttempts();
    if (exhausted) {
        await execute(`
            UPDATE agent_artifact_delivery_intents
            SET state = 'failed', failure_code = ?, failure_reason = ?, claim_token_hash = NULL, lease_expires_at = NULL, updated_at = ?
            WHERE id = ?
        `, [failureCode, failureReason, now, intent.id]);
    } else {
        await execute(`
            UPDATE agent_artifact_delivery_intents
            SET state = 'pending', failure_code = ?, failure_reason = ?, claimed_by = '', claim_token_hash = NULL,
                lease_expires_at = NULL, updated_at = ?
            WHERE id = ?
        `, [failureCode, failureReason, now, intent.id]);
    }
    recordDeliveryIntentState({ channel: intent.channel, state: exhausted ? 'failed' : 'pending' });
    await recordDeliveryEvent({
        tenantId: tenant.tenantId,
        intentId: intent.id,
        renditionId: intent.rendition_id,
        runId: intent.run_id,
        actorType: 'device',
        actorId: String(intent.device_id || user.id),
        eventType: exhausted ? 'denied' : 'claimed',
        channel: intent.channel,
        deviceId: intent.device_id,
        decisionReason: `${failureCode}：${failureReason}`
    });
    return { intent: await queryOne('SELECT * FROM agent_artifact_delivery_intents WHERE id = ?', [intent.id]), reused: false };
}

/** 用户主动取消交付意图。 */
async function cancelDeliveryIntent(user, intentId) {
    const tenant = await assertTenantContext(user);
    const now = getBeijingTimestamp();
    const rows = await query(`
        UPDATE agent_artifact_delivery_intents
        SET state = 'cancelled', claim_token_hash = NULL, lease_expires_at = NULL, updated_at = ?
        WHERE id = ? AND tenant_id = ? AND requested_by = ? AND state IN ('pending', 'claimed')
        RETURNING *
    `, [now, intentId, tenant.tenantId, user.id]);
    if (!rows.length) return null;
    recordDeliveryIntentState({ channel: rows[0].channel, state: 'cancelled' });
    await recordDeliveryEvent({
        tenantId: tenant.tenantId,
        intentId: rows[0].id,
        renditionId: rows[0].rendition_id,
        runId: rows[0].run_id,
        actorType: 'user',
        actorId: String(user.id),
        eventType: 'cancelled',
        channel: rows[0].channel,
        deviceId: rows[0].device_id
    });
    return rows[0];
}

async function listDeliveryIntents(user, options = {}) {
    const tenant = await assertTenantContext(user);
    const limit = Math.max(1, Math.min(Number.parseInt(options.limit, 10) || 50, 200));
    return await query(`
        SELECT id, rendition_id, run_id, channel, device_id, target_dir_grant, target_filename, state,
               attempt_count, confirmed_digest, confirmed_path_hint, failure_code, failure_reason, expires_at, created_at, updated_at
        FROM agent_artifact_delivery_intents
        WHERE tenant_id = ? AND requested_by = ?
        ORDER BY created_at DESC
        LIMIT ?
    `, [tenant.tenantId, user.id, limit]);
}

/**
 * 交付链反查（§8.1）。
 * 支持按 run_id、内容摘要或文件名提示反查完整链路，管理端不展示终端完整绝对路径。
 */
async function traceDeliveryChain(user, criteria = {}) {
    const tenant = await assertTenantContext(user);
    const filters = [];
    const params = [tenant.tenantId];
    if (criteria.runId) { filters.push('e.run_id = ?'); params.push(String(criteria.runId)); }
    if (criteria.contentDigest) { filters.push('e.content_digest = ?'); params.push(String(criteria.contentDigest).toLowerCase()); }
    if (criteria.pathHint) { filters.push('e.path_hint LIKE ?'); params.push(`%${String(criteria.pathHint).slice(0, 100)}%`); }
    if (criteria.intentId) { filters.push('e.intent_id = ?'); params.push(Number.parseInt(criteria.intentId, 10) || 0); }
    if (!filters.length) throw deliveryError('反查必须提供 run_id、内容摘要、文件名提示或意图 ID 之一。');
    const limit = Math.max(1, Math.min(Number.parseInt(criteria.limit, 10) || 100, 500));
    params.push(limit);
    return await query(`
        SELECT e.id, e.event_type, e.actor_type, e.actor_id, e.channel, e.device_id, e.path_hint,
               e.content_digest, e.decision_reason, e.created_at,
               e.intent_id, e.rendition_id, e.run_id, e.tool_call_id,
               r.format, r.renderer_version, r.ir_digest, r.artifact_id
        FROM agent_artifact_delivery_events e
        LEFT JOIN agent_artifact_renditions r ON r.id = e.rendition_id
        WHERE e.tenant_id = ? AND (${filters.join(' OR ')})
        ORDER BY e.created_at DESC, e.id DESC
        LIMIT ?
    `, params);
}

module.exports = {
    DELIVERY_CHANNELS,
    DELIVERY_STATES,
    buildDeliveryAckSignaturePayload,
    buildDeliveryDownloadSignaturePayload,
    buildIdempotencyKey,
    cancelDeliveryIntent,
    claimDeliveryIntent,
    confirmDelivery,
    createDeliveryIntent,
    deliveryError,
    failDelivery,
    intentTtlSeconds,
    leaseSeconds,
    listDeliveryIntents,
    maxAttempts,
    recordDeliveryEvent,
    reclaimDeliveryIntents,
    traceDeliveryChain
};
