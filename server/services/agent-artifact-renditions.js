/**
 * server/services/agent-artifact-renditions.js
 * 产物渲染结果（Rendition）与 Web 下载令牌
 *
 * 落地方案 v1.2 §7.3、§7.5、阶段 2.6 / 2.7：
 * 1. Rendition 是不可变制品：一份 IR + 一种格式 + 一个渲染器版本 → 唯一内容寻址结果，
 *    同 Artifact 内重复渲染天然幂等；
 * 2. IR 无论大小都持久化到二进制 CAS 并可按授权读取，禁止只保存「内联摘要」；
 * 3. 下载令牌短时、一次性并绑定 rendition + user + tenant；下载入口复校租户与归属，
 *    令牌泄露不等于越权读取；
 * 4. tool_call_id 缺失即渲染失败而非静默（R10）。
 */
const crypto = require('crypto');
const { query, queryOne, execute } = require('../db/client');
const { getBeijingTimestamp } = require('../time');
const { assertTenantContext } = require('./agent-tenant-context');
const { getAgentArtifactForUser } = require('./agent-artifacts');
const { collectIrAssetRefs, computeIrDigest, validateDocumentIr } = require('./document-ir');
const { renderDocumentIr } = require('./document-rendering');
const {
    buildCasRef,
    incrementRefCount,
    openReadStream,
    parseCasRef,
    putBuffer,
    readBuffer,
    statObject
} = require('./agent-artifact-cas');

const DEFAULT_DOWNLOAD_TOKEN_TTL_SECONDS = 300;

function renditionError(message, code = 'ARTIFACT_RENDITION_INVALID', status = 400) {
    const error = new Error(message);
    error.status = status;
    error.statusCode = status;
    error.code = code;
    error.expose = true;
    return error;
}

function maxRenditionBytes(env = process.env) {
    return Math.max(1024, Number.parseInt(env.PIVOT_ARTIFACT_MAX_BYTES, 10) || 64 * 1024 * 1024);
}

function downloadTokenTtlSeconds(env = process.env) {
    return Math.max(30, Math.min(Number.parseInt(env.PIVOT_ARTIFACT_DOWNLOAD_TOKEN_TTL_SECONDS, 10) || DEFAULT_DOWNLOAD_TOKEN_TTL_SECONDS, 3600));
}

function hashToken(token) {
    return crypto.createHash('sha256').update(String(token)).digest('hex');
}

/**
 * 渲染并登记 Rendition。
 * @param {Object} params.ir Document IR（未规范化亦可，内部会校验并规范化）
 * @param {string} params.toolCallId 确定性步骤标识，等于 agent_tool_calls.step_id；缺失即失败
 */
async function createRendition(params = {}) {
    const { user, ir, format } = params;
    const tenant = await assertTenantContext(user);
    const artifactId = Number.parseInt(params.artifactId, 10);
    if (!Number.isSafeInteger(artifactId) || artifactId <= 0) throw renditionError('渲染必须指定有效的产物 ID。');
    const toolCallId = String(params.toolCallId || '').trim();
    if (!toolCallId) throw renditionError('渲染必须携带工具调用标识，否则审计链不完整。', 'ARTIFACT_RENDITION_TOOL_CALL_REQUIRED');
    const artifact = await getAgentArtifactForUser(artifactId, user);
    if (!artifact) throw renditionError('产物不存在或无权访问。', 'ARTIFACT_NOT_FOUND', 404);
    // Agent run 产物沿用真实 run_id；人工创作的独立文档使用稳定的
    // standalone-artifact:<id> 链路标识，仍可在交付审计中反查到 Artifact。
    const runId = String(params.runId || artifact.run_id || `standalone-artifact:${artifact.id}`).trim();

    const checked = validateDocumentIr(ir);
    if (!checked.valid) throw renditionError(`Document IR 校验失败：${checked.errors.join('；')}`, 'DOCUMENT_IR_INVALID', 422);
    const canonicalIr = checked.ir;
    const irDigest = computeIrDigest(canonicalIr);
    const { getRenderer } = require('./document-rendering');
    const renderer = getRenderer(format);

    const existing = await queryOne(`
        SELECT * FROM agent_artifact_renditions
        WHERE tenant_id = ? AND artifact_id = ? AND ir_digest = ? AND format = ? AND renderer_version = ?
    `, [tenant.tenantId, artifactId, irDigest, renderer.format, renderer.version]);
    if (existing && existing.status === 'ready') return { rendition: existing, reused: true };

    // IR 始终持久化，且必须可按授权读取（禁止只保存内联摘要）。
    const irObject = await putBuffer({
        buffer: Buffer.from(JSON.stringify(canonicalIr), 'utf8'),
        mimeType: 'application/json; charset=utf-8',
        tenantId: tenant.tenantId,
        ownerUserId: user.id,
        kind: 'document_ir'
    });

    // 图片资产必须是当前租户内已授权的 CAS 对象，禁止跨 run 裸引用。
    const assetRefs = collectIrAssetRefs(canonicalIr);
    const resolvedAssets = new Map();
    for (const ref of assetRefs) {
        const objectId = parseCasRef(ref);
        if (!objectId) throw renditionError(`IR 引用了非法的资产地址：${ref}`, 'DOCUMENT_IR_ASSET_INVALID', 422);
        const object = await statObject({ objectId, tenantId: tenant.tenantId });
        if (!object) throw renditionError(`IR 引用的资产不存在或不属于当前租户：${ref}`, 'DOCUMENT_IR_ASSET_FORBIDDEN', 403);
        const loaded = await readBuffer({ objectId, tenantId: tenant.tenantId, userId: user.id, tenantScoped: true });
        resolvedAssets.set(ref, loaded.buffer);
    }

    const rendered = await renderDocumentIr(canonicalIr, renderer.format, {
        skipValidation: true,
        imageResolver: async ref => resolvedAssets.get(ref) || null
    });
    if (rendered.buffer.length > maxRenditionBytes()) {
        throw renditionError('渲染产物超过单文件大小上限。', 'ARTIFACT_RENDITION_TOO_LARGE', 413);
    }
    const contentDigest = crypto.createHash('sha256').update(rendered.buffer).digest('hex');
    const contentObject = await putBuffer({
        buffer: rendered.buffer,
        mimeType: rendered.mimeType,
        tenantId: tenant.tenantId,
        ownerUserId: user.id,
        kind: `rendition_${rendered.format}`
    });
    const now = getBeijingTimestamp();
    const row = await queryOne(`
        INSERT INTO agent_artifact_renditions
            (tenant_id, artifact_id, run_id, tool_call_id, created_by, ir_ref, ir_digest, format, renderer_version,
             content_digest, mime_type, byte_size, storage_ref, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ready', ?)
        ON CONFLICT (tenant_id, artifact_id, ir_digest, format, renderer_version) DO UPDATE SET
            status = 'ready', failure_reason = NULL
        RETURNING *
    `, [
        tenant.tenantId, artifactId, runId, toolCallId, user.id,
        buildCasRef(irObject.objectId), irDigest, rendered.format, rendered.rendererVersion,
        contentDigest, rendered.mimeType, rendered.buffer.length, buildCasRef(contentObject.objectId), now
    ]);
    // 引用计数按「新增的 rendition 行」计一次：即使 CAS 对象是复用的，
    // 这条 rendition 也是一个新的引用者，否则删除其中一条会误删仍被引用的对象。
    await incrementRefCount(irObject.objectId, 1);
    await incrementRefCount(contentObject.objectId, 1);
    const { recordDeliveryEvent } = require('./agent-artifact-delivery');
    await recordDeliveryEvent({
        tenantId: tenant.tenantId,
        renditionId: row.id,
        runId,
        toolCallId,
        actorType: 'system',
        actorId: String(user.id),
        eventType: 'render',
        contentDigest
    });
    return { rendition: row, reused: false, durationMs: rendered.durationMs };
}

/** 读取 rendition 并校验归属：租户必须匹配，且 Artifact 必须属于当前用户。 */
async function getRenditionForUser(renditionId, user) {
    const tenant = await assertTenantContext(user);
    const rendition = await queryOne('SELECT * FROM agent_artifact_renditions WHERE id = ? AND tenant_id = ?', [renditionId, tenant.tenantId]);
    if (!rendition) return null;
    const artifact = await getAgentArtifactForUser(rendition.artifact_id, user);
    if (!artifact) return null;
    return rendition;
}

async function listRenditionsForArtifact(artifactId, user) {
    const tenant = await assertTenantContext(user);
    const artifact = await getAgentArtifactForUser(artifactId, user);
    if (!artifact) return null;
    return await query(`
        SELECT id, format, renderer_version, content_digest, mime_type, byte_size, ir_digest, status, created_at
        FROM agent_artifact_renditions
        WHERE tenant_id = ? AND artifact_id = ?
        ORDER BY created_at DESC
        LIMIT 200
    `, [tenant.tenantId, artifact.id]);
}

/** 签发一次性下载令牌。令牌本体只返回一次，库中只保存其 sha256。 */
async function issueDownloadToken(user, renditionId, options = {}) {
    const rendition = await getRenditionForUser(renditionId, user);
    if (!rendition) return null;
    if (rendition.status !== 'ready') throw renditionError('该渲染产物不可下载。', 'ARTIFACT_RENDITION_NOT_READY', 409);
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = getBeijingTimestamp(new Date(Date.now() + downloadTokenTtlSeconds() * 1000));
    await execute(`
        INSERT INTO agent_artifact_download_tokens (token_hash, rendition_id, tenant_id, user_id, device_id, expires_at)
        VALUES (?, ?, ?, ?, ?, ?)
    `, [hashToken(token), rendition.id, rendition.tenant_id, user.id, options.deviceId || null, expiresAt]);
    return { token, expiresAt, renditionId: rendition.id, contentDigest: rendition.content_digest };
}

/**
 * 兑换下载令牌。
 * 一次性：兑换即写 used_at；同时复校租户与产物归属，令牌泄露不等于越权读取。
 */
async function consumeDownloadToken(user, token, options = {}) {
    const now = getBeijingTimestamp();
    const requestedDeviceId = options.deviceId ? String(options.deviceId).trim() : null;
    const rows = await query(`
        UPDATE agent_artifact_download_tokens
        SET used_at = ?
        WHERE token_hash = ? AND user_id = ? AND used_at IS NULL AND expires_at > ?
          AND (device_id IS NULL OR (CAST(? AS TEXT) IS NOT NULL AND device_id = ?))
        RETURNING rendition_id, tenant_id, device_id
    `, [now, hashToken(token), user.id, now, requestedDeviceId, requestedDeviceId]);
    if (!rows.length) throw renditionError('下载令牌无效、已过期或已使用。', 'ARTIFACT_DOWNLOAD_TOKEN_INVALID', 403);
    const record = rows[0];
    const rendition = await getRenditionForUser(record.rendition_id, user);
    if (!rendition) throw renditionError('下载产物不存在或无权访问。', 'ARTIFACT_NOT_FOUND', 404);
    return rendition;
}

/**
 * 打开 rendition 内容流，并在发送前比对存储实际摘要。
 * 摘要不一致直接抛错，不发送残缺文件（§7.5）。
 */
async function openRenditionContent(rendition, user) {
    const object = await statObject({ ref: rendition.storage_ref, tenantId: rendition.tenant_id });
    if (!object) throw renditionError('渲染产物内容已不可用。', 'ARTIFACT_CONTENT_MISSING', 410);
    if (String(object.content_digest) !== String(rendition.content_digest)) {
        throw renditionError('渲染产物内容摘要与登记值不一致，已拒绝发送。', 'ARTIFACT_CONTENT_DIGEST_MISMATCH', 500);
    }
    if (Number(object.byte_size) !== Number(rendition.byte_size)) {
        throw renditionError('渲染产物大小与登记值不一致，已拒绝发送。', 'ARTIFACT_CONTENT_SIZE_MISMATCH', 500);
    }
    return await openReadStream({ ref: rendition.storage_ref, tenantId: rendition.tenant_id, userId: user.id, tenantScoped: true });
}

/** 读取 rendition 对应的原始 IR，供版本对比与复现使用。 */
async function readRenditionIr(rendition, user) {
    const loaded = await readBuffer({ ref: rendition.ir_ref, tenantId: rendition.tenant_id, userId: user.id, tenantScoped: true });
    try {
        return JSON.parse(loaded.buffer.toString('utf8'));
    } catch (_) {
        throw renditionError('渲染产物的 IR 已损坏，无法复现。', 'DOCUMENT_IR_CORRUPTED', 500);
    }
}

module.exports = {
    consumeDownloadToken,
    createRendition,
    downloadTokenTtlSeconds,
    getRenditionForUser,
    issueDownloadToken,
    listRenditionsForArtifact,
    maxRenditionBytes,
    openRenditionContent,
    readRenditionIr,
    renditionError
};
