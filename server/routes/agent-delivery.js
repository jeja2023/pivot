/**
 * server/routes/agent-delivery.js
 * 文档渲染、Web 下载与本机受控交付的 HTTP 入口
 *
 * 落地方案 v1.2 §7.3、§7.5、§7.6、§7.7、§8.1：
 * 1. 路由层只做参数校验、鉴权与响应组装，全部业务规则在 services 层（开发规范第 3 章）；
 * 2. 交付意图只能由用户操作创建，因此这些端点全部要求会话鉴权；
 * 3. 本机写入必须同时满足「用户意图 + 设备身份 + 目录授权 + 一次性令牌」四条件，缺一即拒。
 */
const express = require('express');
const { asyncHandler } = require('../http');
const { getAgentArtifactForUser } = require('../services/agent-artifacts');
const {
    createRendition,
    consumeDownloadToken,
    getRenditionForUser,
    issueDownloadToken,
    listRenditionsForArtifact,
    openRenditionContent,
    readRenditionIr
} = require('../services/agent-artifact-renditions');
const { listRendererStatus } = require('../services/document-rendering');
const {
    assertDeviceSignature,
    attestLocalDevice,
    issueDeviceChallenge,
    listLocalDevices,
    listOutputGrants,
    registerLocalDevice,
    registerOutputGrant,
    revokeLocalDevice,
    revokeOutputGrant
} = require('../services/agent-local-devices');
const {
    buildDeliveryAckSignaturePayload,
    buildDeliveryDownloadSignaturePayload,
    cancelDeliveryIntent,
    claimDeliveryIntent,
    confirmDelivery,
    createDeliveryIntent,
    failDelivery,
    listDeliveryIntents,
    reclaimDeliveryIntents,
    traceDeliveryChain
} = require('../services/agent-artifact-delivery');
const { buildDeliveryFilename } = require('../services/agent-path-safety');

function isAdmin(user) {
    return ['admin', 'root'].includes(String(user?.role || '').toLowerCase());
}

/** 按 RFC 5987 输出 CJK 文件名，避免直接拼原始文件名造成响应头注入。 */
function contentDisposition(filename) {
    const fallback = filename.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_');
    return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

function createAgentDeliveryRouter({ authMiddleware, logAction, automationLimiter } = {}) {
    const router = express.Router();
    const automationGuard = typeof automationLimiter === 'function' ? automationLimiter : (_req, _res, next) => next();
    const writeLog = typeof logAction === 'function' ? logAction : () => {};

    // ── 渲染器状态 ──────────────────────────────────────────────────────────
    router.get('/agents/renderers', authMiddleware, asyncHandler(async (_req, res) => {
        res.json({ data: listRendererStatus() });
    }));

    // ── 渲染产物 ────────────────────────────────────────────────────────────
    router.get('/agents/artifacts/:id/renditions', authMiddleware, asyncHandler(async (req, res) => {
        const rows = await listRenditionsForArtifact(req.params.id, req.user);
        if (!rows) return res.status(404).json({ error: '产物不存在或无权访问。' });
        res.json({ data: rows });
    }));

    router.post('/agents/artifacts/:id/renditions', authMiddleware, automationGuard, asyncHandler(async (req, res) => {
        const artifact = await getAgentArtifactForUser(req.params.id, req.user);
        if (!artifact) return res.status(404).json({ error: '产物不存在或无权访问。' });
        const ir = req.body?.ir;
        if (!ir || typeof ir !== 'object' || Array.isArray(ir)) return res.status(400).json({ error: '请提供 Document IR 对象。' });
        const format = String(req.body?.format || '').trim().toLowerCase();
        if (!format) return res.status(400).json({ error: '请指定渲染格式。' });
        const result = await createRendition({
            user: req.user,
            artifactId: artifact.id,
            runId: artifact.run_id,
            // 用户在前端主动渲染时没有 Agent 工具调用，使用确定性的用户操作标识维持审计链。
            toolCallId: String(req.body?.toolCallId || `user:${req.user.id}:artifact:${artifact.id}`),
            ir,
            format
        });
        writeLog(req, '渲染 Agent 产物', `产物ID: ${artifact.id}，格式: ${format}，复用: ${result.reused ? '是' : '否'}`);
        res.status(result.reused ? 200 : 201).json({ success: true, rendition: result.rendition, reused: result.reused });
    }));

    router.get('/agents/renditions/:id/ir', authMiddleware, asyncHandler(async (req, res) => {
        const rendition = await getRenditionForUser(req.params.id, req.user);
        if (!rendition) return res.status(404).json({ error: '渲染产物不存在或无权访问。' });
        res.json({ success: true, ir: await readRenditionIr(rendition, req.user), irDigest: rendition.ir_digest });
    }));

    router.post('/agents/renditions/:id/download-token', authMiddleware, automationGuard, asyncHandler(async (req, res) => {
        const issued = await issueDownloadToken(req.user, req.params.id, { deviceId: req.body?.deviceId || null });
        if (!issued) return res.status(404).json({ error: '渲染产物不存在或无权访问。' });
        res.status(201).json({ success: true, ...issued });
    }));

    router.get('/agents/renditions/:id/download', authMiddleware, asyncHandler(async (req, res) => {
        const token = String(req.query.token || '').trim();
        if (!token) return res.status(400).json({ error: '缺少下载令牌。' });
        const deviceId = req.query.deviceId ? String(req.query.deviceId).trim() : '';
        // 桌面端下载令牌兑换也必须有设备私钥证明；Web 下载沿用户会话鉴权即可。
        if (deviceId) {
            const nonce = String(req.query.nonce || '').trim();
            const signature = String(req.query.signature || '').trim();
            if (!nonce || !signature) return res.status(403).json({ error: '设备下载必须携带 nonce 与签名。', code: 'AGENT_DEVICE_ATTESTATION_REQUIRED' });
            await assertDeviceSignature(req.user, {
                deviceId,
                purpose: 'download',
                nonce,
                signature,
                payload: buildDeliveryDownloadSignaturePayload({ nonce, deviceId, renditionId: req.params.id, token })
            });
        }
        const rendition = await consumeDownloadToken(req.user, token, { deviceId: deviceId || null });
        if (String(rendition.id) !== String(req.params.id)) {
            return res.status(403).json({ error: '下载令牌与产物不匹配。' });
        }
        const artifact = await getAgentArtifactForUser(rendition.artifact_id, req.user);
        const filename = buildDeliveryFilename(artifact?.title || `产物-${rendition.artifact_id}`, rendition.format);
        const { stream } = await openRenditionContent(rendition, req.user);
        res.setHeader('Content-Type', rendition.mime_type);
        res.setHeader('Content-Length', String(rendition.byte_size));
        res.setHeader('Content-Disposition', contentDisposition(filename));
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('X-Content-Digest', `sha256:${rendition.content_digest}`);
        res.setHeader('Cache-Control', 'no-store');
        stream.on('error', () => {
            if (!res.headersSent) res.status(500).json({ error: '读取渲染产物失败。' });
            else res.destroy();
        });
        stream.pipe(res);
    }));

    // ── 本机设备身份 ────────────────────────────────────────────────────────
    router.post('/agents/local-devices/challenge', authMiddleware, automationGuard, asyncHandler(async (req, res) => {
        const challenge = await issueDeviceChallenge(req.user, { purpose: req.body?.purpose, deviceId: req.body?.deviceId });
        res.status(201).json({ success: true, ...challenge });
    }));

    router.get('/agents/local-devices', authMiddleware, asyncHandler(async (req, res) => {
        res.json({ data: await listLocalDevices(req.user) });
    }));

    router.post('/agents/local-devices', authMiddleware, automationGuard, asyncHandler(async (req, res) => {
        const device = await registerLocalDevice(req.user, req.body || {});
        writeLog(req, '注册本机交付设备', `设备: ${device.device_id}，密钥指纹: ${device.key_fingerprint}`);
        res.status(201).json({ success: true, device });
    }));

    router.post('/agents/local-devices/:deviceId/attest', authMiddleware, asyncHandler(async (req, res) => {
        const device = await attestLocalDevice(req.user, { ...(req.body || {}), deviceId: req.params.deviceId });
        res.json({ success: true, device });
    }));

    router.delete('/agents/local-devices/:deviceId', authMiddleware, automationGuard, asyncHandler(async (req, res) => {
        const device = await revokeLocalDevice(req.user, req.params.deviceId);
        if (!device) return res.status(404).json({ error: '设备不存在或无权操作。' });
        writeLog(req, '撤销本机交付设备', `设备: ${req.params.deviceId}`);
        res.json({ success: true, device });
    }));

    router.get('/agents/local-devices/:deviceId/output-grants', authMiddleware, asyncHandler(async (req, res) => {
        res.json({ data: await listOutputGrants(req.user, { deviceId: req.params.deviceId }) });
    }));

    router.post('/agents/local-devices/:deviceId/output-grants', authMiddleware, automationGuard, asyncHandler(async (req, res) => {
        const grant = await registerOutputGrant(req.user, { ...(req.body || {}), deviceId: req.params.deviceId });
        writeLog(req, '登记本机写入目录授权', `设备: ${req.params.deviceId}，目录提示: ${grant.path_hint}`);
        res.status(201).json({ success: true, grant });
    }));

    router.delete('/agents/output-grants/:grantId', authMiddleware, automationGuard, asyncHandler(async (req, res) => {
        const grant = await revokeOutputGrant(req.user, req.params.grantId);
        if (!grant) return res.status(404).json({ error: '写入授权不存在或无权操作。' });
        writeLog(req, '撤销本机写入目录授权', `授权ID: ${req.params.grantId}`);
        res.json({ success: true, grant });
    }));

    // ── 交付意图 ────────────────────────────────────────────────────────────
    router.get('/agents/deliveries', authMiddleware, asyncHandler(async (req, res) => {
        res.json({ data: await listDeliveryIntents(req.user, { limit: req.query.limit }) });
    }));

    router.get('/agents/deliveries/trace', authMiddleware, asyncHandler(async (req, res) => {
        if (!isAdmin(req.user)) return res.status(403).json({ error: '只有管理员可以反查交付链。' });
        const rows = await traceDeliveryChain(req.user, {
            runId: req.query.runId,
            contentDigest: req.query.contentDigest,
            pathHint: req.query.pathHint,
            intentId: req.query.intentId,
            limit: req.query.limit
        });
        res.json({ data: rows });
    }));

    router.post('/agents/deliveries', authMiddleware, automationGuard, asyncHandler(async (req, res) => {
        const result = await createDeliveryIntent(req.user, req.body || {});
        writeLog(req, '创建产物交付意图', `渲染产物ID: ${req.body?.renditionId}，通道: ${req.body?.channel}，复用: ${result.reused ? '是' : '否'}`);
        res.status(result.reused ? 200 : 201).json({ success: true, intent: result.intent, reused: result.reused });
    }));

    router.post('/agents/deliveries/claim', authMiddleware, asyncHandler(async (req, res) => {
        // 领取必须先完成设备身份证明（nonce 签名），再进入意图状态机。
        await assertDeviceSignature(req.user, {
            deviceId: req.body?.deviceId,
            purpose: 'claim',
            nonce: req.body?.nonce,
            signature: req.body?.signature
        });
        const result = await claimDeliveryIntent(req.user, req.body || {});
        res.json({ success: true, ...result });
    }));

    router.post('/agents/deliveries/reclaim', authMiddleware, automationGuard, asyncHandler(async (req, res) => {
        if (!isAdmin(req.user)) return res.status(403).json({ error: '只有管理员可以手动回收交付租约。' });
        res.json({ success: true, ...(await reclaimDeliveryIntents()) });
    }));

    router.post('/agents/deliveries/:id/confirm', authMiddleware, asyncHandler(async (req, res) => {
        const body = req.body || {};
        const deviceId = String(body.deviceId || '').trim();
        const nonce = String(body.nonce || '').trim();
        const signature = String(body.signature || '').trim();
        if (!deviceId || !nonce || !signature) return res.status(403).json({ error: '交付回执必须携带设备身份签名。', code: 'AGENT_DEVICE_ATTESTATION_REQUIRED' });
        await assertDeviceSignature(req.user, {
            deviceId,
            purpose: 'ack',
            nonce,
            signature,
            payload: buildDeliveryAckSignaturePayload({ nonce, deviceId, intentId: req.params.id, claimToken: body.claimToken })
        });
        const result = await confirmDelivery(req.user, { ...body, deviceId, intentId: req.params.id });
        res.json({ success: true, intent: result.intent, reused: result.reused });
    }));

    router.post('/agents/deliveries/:id/fail', authMiddleware, asyncHandler(async (req, res) => {
        const body = req.body || {};
        const deviceId = String(body.deviceId || '').trim();
        const nonce = String(body.nonce || '').trim();
        const signature = String(body.signature || '').trim();
        if (!deviceId || !nonce || !signature) return res.status(403).json({ error: '交付失败回执必须携带设备身份签名。', code: 'AGENT_DEVICE_ATTESTATION_REQUIRED' });
        await assertDeviceSignature(req.user, {
            deviceId,
            purpose: 'ack',
            nonce,
            signature,
            payload: buildDeliveryAckSignaturePayload({ nonce, deviceId, intentId: req.params.id, claimToken: body.claimToken })
        });
        const result = await failDelivery(req.user, { ...body, deviceId, intentId: req.params.id });
        res.json({ success: true, intent: result.intent, reused: result.reused });
    }));

    router.delete('/agents/deliveries/:id', authMiddleware, automationGuard, asyncHandler(async (req, res) => {
        const intent = await cancelDeliveryIntent(req.user, req.params.id);
        if (!intent) return res.status(404).json({ error: '交付意图不存在或已完成。' });
        writeLog(req, '取消产物交付意图', `意图ID: ${req.params.id}`);
        res.json({ success: true, intent });
    }));

    return router;
}

module.exports = { createAgentDeliveryRouter };
