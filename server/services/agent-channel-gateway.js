'use strict';

/*
 * 受控双向消息 Gateway。
 *
 * 外部消息绝不能因知道 bindingId 就获得 Pivot 用户身份：每一条入站消息都先
 * 验证渠道签名，再通过一次性配对码绑定外部身份，最后才可映射到用户会话和
 * Agent Run。外部平台只需把自己的事件转换为 config 指定字段；平台适配层
 * 不参与租户授权、模型选择或工具权限决策。
 */
const crypto = require('crypto');
const { query, queryOne, execute } = require('../db/client');
const { getBeijingTimestamp } = require('../time');
const { canonicalJson } = require('./canonical-json');
const { resolveCredentialSecret } = require('./workflow-credentials');
const sessions = require('../repositories/sessions');
const { estimateTokens } = require('../llm');
const { buildChatAgentMetadata, prepareChatAgentContext } = require('./chat-agent-bridge');
const { getRunnableModelForUserAsync, getUserRunnableModelsAsync } = require('./models');
const { enqueueChannelDelivery } = require('./agent-channel-adapters');
const { encryptSecret, decryptSecret } = require('../security');
const { attachmentMessageReferences, normalizeInboundAttachmentPayload, persistInboundAttachments } = require('./agent-channel-inbound-attachments');

const PAIRING_TTL_MS = 15 * 60 * 1000;
const MAX_MESSAGE_CHARS = 12000;
const MAX_EVENT_ID_CHARS = 180;
const GATEWAY_STATUS = Object.freeze(['pending', 'paired', 'revoked', 'expired']);

let createAgentRunCallback = null;

function configureAgentChannelGateway({ createAgentRun } = {}) {
    if (typeof createAgentRun === 'function') createAgentRunCallback = createAgentRun;
}

function gatewayError(message, code = 'AGENT_CHANNEL_GATEWAY_INVALID', status = 400) {
    const error = new Error(message);
    error.code = code;
    error.status = status;
    error.statusCode = status;
    return error;
}

function parseJson(value, fallback = {}) {
    if (value && typeof value === 'object') return value;
    try { return JSON.parse(String(value || '')); } catch (_) { return fallback; }
}

function readByPath(value, pathText) {
    return String(pathText || '').split('.').filter(Boolean).reduce((current, key) => current == null ? undefined : current[key], value);
}

function stringAt(value, pathText, fallback = '') {
    const selected = pathText ? readByPath(value, pathText) : undefined;
    const result = selected === undefined || selected === null ? fallback : selected;
    return typeof result === 'string' || typeof result === 'number' ? String(result).trim() : '';
}

function configForBinding(binding = {}) {
    const config = parseJson(binding.config, {});
    const gateway = config.gateway && typeof config.gateway === 'object' ? config.gateway : config;
    return {
        enabled: gateway.enabled === true || gateway.gatewayEnabled === true,
        identityPath: String(gateway.identityPath || gateway.identity_path || 'senderId').trim().slice(0, 160),
        conversationPath: String(gateway.conversationPath || gateway.conversation_path || 'conversationId').trim().slice(0, 160),
        messagePath: String(gateway.messagePath || gateway.message_path || 'text').trim().slice(0, 160),
        attachmentPath: String(gateway.attachmentPath || gateway.attachment_path || 'attachments').trim().slice(0, 160),
        eventIdPath: String(gateway.eventIdPath || gateway.event_id_path || 'eventId').trim().slice(0, 160),
        pairingCodePath: String(gateway.pairingCodePath || gateway.pairing_code_path || 'pairingCode').trim().slice(0, 160),
        replayWindowSeconds: Math.max(30, Math.min(Number(gateway.replayWindowSeconds || gateway.replay_window_seconds || 300), 3600)),
        modelId: Number.parseInt(gateway.modelId || gateway.model_id, 10) || null,
        replyPrefix: String(gateway.replyPrefix || gateway.reply_prefix || '').trim().slice(0, 160)
    };
}

function requireGatewayConfig(binding) {
    const config = configForBinding(binding);
    if (!config.enabled) throw gatewayError('该渠道尚未启用双向消息 Gateway。', 'AGENT_CHANNEL_GATEWAY_DISABLED', 404);
    if (!binding.credential_ref) throw gatewayError('双向渠道必须绑定签名凭据引用。', 'AGENT_CHANNEL_GATEWAY_CREDENTIAL_REQUIRED', 409);
    return config;
}

function verifyGatewaySignature(secret, timestamp, payload, provided) {
    const expected = crypto.createHmac('sha256', String(secret || ''))
        .update(`${timestamp || ''}.${canonicalJson(payload || {})}`)
        .digest('hex');
    const actual = String(provided || '').replace(/^sha256=/i, '').trim();
    const expectedBuffer = Buffer.from(expected, 'utf8');
    const actualBuffer = Buffer.from(actual, 'utf8');
    return actualBuffer.length === expectedBuffer.length && crypto.timingSafeEqual(actualBuffer, expectedBuffer);
}

function timestampIsFresh(value, replayWindowSeconds) {
    const parsed = Number.isFinite(Number(value)) ? Number(value) : Date.parse(String(value || ''));
    return Number.isFinite(parsed) && Math.abs(Date.now() - parsed) <= replayWindowSeconds * 1000;
}

function digestExternalValue(secret, bindingId, value) {
    return crypto.createHmac('sha256', String(secret || ''))
        .update(`${String(bindingId || '')}\u0000${String(value || '')}`)
        .digest('hex');
}

function hashPairingCode(code) {
    return crypto.createHash('sha256').update(String(code || '')).digest('hex');
}

function hintExternalValue(value) {
    const text = String(value || '').trim();
    if (!text) return '';
    return text.length <= 4 ? '****' : `***${text.slice(-4)}`;
}

function generatePairingCode() {
    return `pair_${crypto.randomBytes(24).toString('base64url')}`;
}

function serializePairing(row) {
    if (!row) return null;
    return {
        id: row.id,
        bindingId: row.binding_id,
        userId: Number(row.user_id),
        tenantId: row.tenant_id ? Number(row.tenant_id) : null,
        identityHint: row.external_identity_hint || '',
        status: GATEWAY_STATUS.includes(String(row.status)) ? row.status : 'pending',
        expiresAt: row.expires_at || null,
        pairedAt: row.paired_at || null,
        revokedAt: row.revoked_at || null,
        createdAt: row.created_at || null,
        updatedAt: row.updated_at || null
    };
}

function serializeSession(row) {
    if (!row) return null;
    return {
        id: row.id,
        bindingId: row.binding_id,
        pairingId: row.pairing_id,
        userId: Number(row.user_id),
        tenantId: row.tenant_id ? Number(row.tenant_id) : null,
        conversationHint: row.external_conversation_hint || '',
        sessionId: row.session_id,
        status: row.status,
        lastInboundAt: row.last_inbound_at || null,
        lastOutboundAt: row.last_outbound_at || null,
        createdAt: row.created_at || null,
        updatedAt: row.updated_at || null
    };
}

function outboundTargetContext(bindingId) {
    return `agent_channel_sessions.outbound_target:${String(bindingId || '')}`;
}

function encryptOutboundTarget(bindingId, conversation) {
    return encryptSecret(String(conversation || ''), outboundTargetContext(bindingId));
}

function decryptOutboundTarget(bindingId, encryptedValue) {
    return decryptSecret(String(encryptedValue || ''), outboundTargetContext(bindingId));
}

async function getOwnedBinding(bindingId, user, { activeOnly = false } = {}) {
    return await queryOne(`
        SELECT * FROM agent_channel_bindings
        WHERE id = ? AND user_id = ? ${activeOnly ? "AND status = 'active'" : ''}
    `, [String(bindingId || ''), user.id]);
}

async function createChannelPairing(bindingId, user, options = {}) {
    const binding = await getOwnedBinding(bindingId, user, { activeOnly: true });
    if (!binding) return null;
    requireGatewayConfig(binding);
    const nowMs = Number(options.now || Date.now());
    const ttlMs = Math.min(Math.max(Number(options.ttlMs || PAIRING_TTL_MS), 60 * 1000), 60 * 60 * 1000);
    const code = generatePairingCode();
    const now = getBeijingTimestamp(new Date(nowMs));
    const expiresAt = getBeijingTimestamp(new Date(nowMs + ttlMs));
    const id = `channel_pair_${crypto.randomUUID()}`;
    await execute(`
        UPDATE agent_channel_pairings
        SET status = 'expired', updated_at = ?
        WHERE binding_id = ? AND user_id = ? AND status = 'pending' AND expires_at <= ?
    `, [now, binding.id, user.id, now]);
    await execute(`
        INSERT INTO agent_channel_pairings (
            id, binding_id, user_id, tenant_id, code_hash, status, expires_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?)
    `, [id, binding.id, user.id, binding.tenant_id || user.tenant_id || null, hashPairingCode(code), expiresAt, now, now]);
    return { pairing: serializePairing(await queryOne('SELECT * FROM agent_channel_pairings WHERE id = ?', [id])), code };
}

async function listChannelPairings(bindingId, user, options = {}) {
    const binding = await getOwnedBinding(bindingId, user);
    if (!binding) return null;
    const now = getBeijingTimestamp();
    await execute("UPDATE agent_channel_pairings SET status = 'expired', updated_at = ? WHERE binding_id = ? AND user_id = ? AND status = 'pending' AND expires_at <= ?", [now, binding.id, user.id, now]);
    const limit = Math.max(1, Math.min(Number.parseInt(options.limit, 10) || 30, 100));
    const rows = await query('SELECT * FROM agent_channel_pairings WHERE binding_id = ? AND user_id = ? ORDER BY created_at DESC LIMIT ?', [binding.id, user.id, limit]);
    return rows.map(serializePairing);
}

async function revokeChannelPairing(bindingId, pairingId, user) {
    const binding = await getOwnedBinding(bindingId, user);
    if (!binding) return null;
    const pairing = await queryOne('SELECT * FROM agent_channel_pairings WHERE id = ? AND binding_id = ? AND user_id = ?', [String(pairingId || ''), binding.id, user.id]);
    if (!pairing) return null;
    const now = getBeijingTimestamp();
    await execute("UPDATE agent_channel_pairings SET status = 'revoked', revoked_at = ?, updated_at = ? WHERE id = ? AND binding_id = ? AND user_id = ?", [now, now, pairing.id, binding.id, user.id]);
    await execute("UPDATE agent_channel_sessions SET status = 'revoked', updated_at = ? WHERE pairing_id = ? AND status = 'active'", [now, pairing.id]);
    return serializePairing(await queryOne('SELECT * FROM agent_channel_pairings WHERE id = ?', [pairing.id]));
}

async function listChannelGatewaySessions(bindingId, user, options = {}) {
    const binding = await getOwnedBinding(bindingId, user);
    if (!binding) return null;
    const limit = Math.max(1, Math.min(Number.parseInt(options.limit, 10) || 50, 200));
    const rows = await query('SELECT * FROM agent_channel_sessions WHERE binding_id = ? AND user_id = ? ORDER BY updated_at DESC LIMIT ?', [binding.id, user.id, limit]);
    return rows.map(serializeSession);
}

// 只有用户显式选择才允许把两个已配对渠道会话收敛到同一个 Pivot 会话。
// 这样跨端未读、历史和记忆天然遵循既有 session ACL，不依赖外部平台 ID 猜测关联。
async function linkChannelGatewaySession(bindingId, channelSessionId, user, canonicalSessionId) {
    const binding = await getOwnedBinding(bindingId, user, { activeOnly: true });
    if (!binding) return null;
    const target = await queryOne('SELECT id FROM sessions WHERE id = ? AND user_id = ? AND deleted_at IS NULL', [String(canonicalSessionId || ''), user.id]);
    if (!target) throw gatewayError('要接续的 Pivot 会话不存在或无权访问。', 'AGENT_CHANNEL_GATEWAY_SESSION_SCOPE_DENIED', 403);
    const row = await queryOne("SELECT * FROM agent_channel_sessions WHERE id = ? AND binding_id = ? AND user_id = ? AND status = 'active'", [String(channelSessionId || ''), binding.id, user.id]);
    if (!row) return null;
    const now = getBeijingTimestamp();
    const updated = await queryOne("UPDATE agent_channel_sessions SET session_id = ?, updated_at = ? WHERE id = ? AND binding_id = ? AND user_id = ? AND status = 'active' RETURNING *", [target.id, now, row.id, binding.id, user.id]);
    return serializeSession(updated);
}

async function signingSecretForBinding(binding, config) {
    const user = { id: binding.user_id, tenant_id: binding.tenant_id || null, unit: config.unit || '' };
    const credential = await resolveCredentialSecret(binding.credential_ref, user);
    if (!credential?.value) throw gatewayError('渠道签名凭据不可用。', 'AGENT_CHANNEL_GATEWAY_CREDENTIAL_UNAVAILABLE', 503);
    return credential.value;
}

function normalizeInboundMessage(payload, config, headers = {}) {
    const identity = stringAt(payload, config.identityPath, payload.senderId || payload.sender_id || payload.userId || payload.user_id);
    const conversation = stringAt(payload, config.conversationPath, payload.conversationId || payload.conversation_id || payload.chatId || payload.chat_id || identity);
    const text = stringAt(payload, config.messagePath, payload.text || payload.message || payload.content).slice(0, MAX_MESSAGE_CHARS);
    const eventId = stringAt(payload, config.eventIdPath, payload.eventId || payload.event_id || headers['idempotency-key']).slice(0, MAX_EVENT_ID_CHARS);
    const pairingCode = stringAt(payload, config.pairingCodePath, payload.pairingCode || payload.pairing_code).slice(0, 160);
    const attachments = config.attachmentPath ? readByPath(payload, config.attachmentPath) : (payload.attachments || []);
    const normalizedAttachments = normalizeInboundAttachmentPayload(attachments || []);
    if (!identity) throw gatewayError('渠道消息缺少发送者身份标识。', 'AGENT_CHANNEL_GATEWAY_IDENTITY_REQUIRED', 400);
    if (!conversation) throw gatewayError('渠道消息缺少会话标识。', 'AGENT_CHANNEL_GATEWAY_CONVERSATION_REQUIRED', 400);
    if (!text && !pairingCode && !normalizedAttachments.length) throw gatewayError('渠道消息缺少正文、附件或配对码。', 'AGENT_CHANNEL_GATEWAY_MESSAGE_REQUIRED', 400);
    const generatedEventId = eventId || crypto.createHash('sha256').update(canonicalJson(payload || {})).digest('hex').slice(0, 48);
    return { identity, conversation, text, attachments: normalizedAttachments, eventId: generatedEventId, pairingCode };
}

async function pairInboundIdentity(binding, secret, inbound) {
    const identityHash = digestExternalValue(secret, binding.id, inbound.identity);
    const existing = await queryOne("SELECT * FROM agent_channel_pairings WHERE binding_id = ? AND external_identity_hash = ? AND status = 'paired'", [binding.id, identityHash]);
    if (existing) return { pairing: existing, pairedNow: false };
    if (!inbound.pairingCode) throw gatewayError('该外部身份尚未配对，请先在 Pivot 中创建配对码。', 'AGENT_CHANNEL_GATEWAY_PAIRING_REQUIRED', 403);
    const now = getBeijingTimestamp();
    const pending = await queryOne("SELECT * FROM agent_channel_pairings WHERE binding_id = ? AND code_hash = ? AND status = 'pending' AND expires_at > ?", [binding.id, hashPairingCode(inbound.pairingCode), now]);
    if (!pending) throw gatewayError('配对码无效或已过期，请重新创建。', 'AGENT_CHANNEL_GATEWAY_PAIRING_INVALID', 403);
    const duplicate = await queryOne("SELECT * FROM agent_channel_pairings WHERE binding_id = ? AND external_identity_hash = ? AND status = 'paired'", [binding.id, identityHash]);
    if (duplicate) {
        await execute("UPDATE agent_channel_pairings SET status = 'revoked', revoked_at = ?, updated_at = ? WHERE id = ?", [now, now, pending.id]);
        return { pairing: duplicate, pairedNow: false };
    }
    const updated = await queryOne(`
        UPDATE agent_channel_pairings
        SET status = 'paired', external_identity_hash = ?, external_identity_hint = ?, paired_at = ?, updated_at = ?
        WHERE id = ? AND binding_id = ? AND status = 'pending' AND expires_at > ?
        RETURNING *
    `, [identityHash, hintExternalValue(inbound.identity), now, now, pending.id, binding.id, now]);
    if (!updated) throw gatewayError('配对码已被使用或已失效，请重新创建。', 'AGENT_CHANNEL_GATEWAY_PAIRING_INVALID', 409);
    return { pairing: updated, pairedNow: true };
}

async function getOrCreateChannelSession(binding, pairing, secret, conversation) {
    const conversationHash = digestExternalValue(secret, binding.id, `conversation:${conversation}`);
    const current = await queryOne("SELECT * FROM agent_channel_sessions WHERE binding_id = ? AND external_conversation_hash = ? AND status = 'active'", [binding.id, conversationHash]);
    if (current) return current;
    const now = getBeijingTimestamp();
    const id = `channel_session_${crypto.randomUUID()}`;
    // 会话 ID 由 binding + 外部会话哈希确定。并发的首条外部消息会收敛到同一
    // Pivot 会话，不会留下一个未映射的随机孤儿会话。
    const sessionId = `channel_${conversationHash.slice(0, 52)}`;
    await execute(`
        INSERT INTO sessions (id, user_id, title, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(id) DO NOTHING
    `, [sessionId, binding.user_id, `渠道会话 · ${hintExternalValue(conversation) || '已配对联系人'}`, now, now]);
    const created = await queryOne(`
        INSERT INTO agent_channel_sessions (
            id, binding_id, pairing_id, user_id, tenant_id, external_conversation_hash,
            external_conversation_hint, outbound_target_encrypted, session_id, status, last_inbound_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)
        ON CONFLICT(binding_id, external_conversation_hash) DO NOTHING
        RETURNING *
    `, [id, binding.id, pairing.id, binding.user_id, binding.tenant_id || pairing.tenant_id || null, conversationHash, hintExternalValue(conversation), encryptOutboundTarget(binding.id, conversation), sessionId, now, now, now]);
    if (created) return created;
    // 并发首条消息可能已经创建了同一个映射；遗留空会话不会被映射或暴露，后续由数据清理治理。
    return await queryOne("SELECT * FROM agent_channel_sessions WHERE binding_id = ? AND external_conversation_hash = ? AND status = 'active'", [binding.id, conversationHash]);
}

function requireCreateAgentRun() {
    if (typeof createAgentRunCallback !== 'function') throw gatewayError('双向渠道运行时尚未初始化。', 'AGENT_CHANNEL_GATEWAY_RUNTIME_UNAVAILABLE', 503);
    return createAgentRunCallback;
}

async function receiveChannelMessage(bindingId, payload = {}, headers = {}) {
    const binding = await queryOne("SELECT * FROM agent_channel_bindings WHERE id = ? AND status = 'active'", [String(bindingId || '')]);
    if (!binding) return null;
    const config = requireGatewayConfig(binding);
    const timestamp = headers['x-agent-event-timestamp'] || headers['x-webhook-timestamp'] || headers['x-signature-timestamp'] || '';
    if (!timestampIsFresh(timestamp, config.replayWindowSeconds)) throw gatewayError('渠道消息已过期或时间戳无效。', 'AGENT_CHANNEL_GATEWAY_REPLAY', 401);
    const secret = await signingSecretForBinding(binding, config);
    const signature = headers['x-agent-signature'] || headers['x-webhook-signature'] || headers['x-signature'] || '';
    if (!verifyGatewaySignature(secret, timestamp, payload, signature)) throw gatewayError('渠道消息签名无效。', 'AGENT_CHANNEL_GATEWAY_SIGNATURE_INVALID', 401);
    const inbound = normalizeInboundMessage(payload, config, headers);
    const pairingResult = await pairInboundIdentity(binding, secret, inbound);
    if (!inbound.text && !inbound.attachments.length) return { paired: pairingResult.pairedNow, accepted: true, runId: null, sessionId: null };

    const channelSession = await getOrCreateChannelSession(binding, pairingResult.pairing, secret, inbound.conversation);
    if (!channelSession) throw gatewayError('渠道会话初始化失败，请稍后重试。', 'AGENT_CHANNEL_GATEWAY_SESSION_UNAVAILABLE', 503);
    const eventKey = `message:${inbound.eventId}`.slice(0, 255);
    const now = getBeijingTimestamp();
    const inserted = await queryOne(`
        INSERT INTO agent_channel_inbound_events (
            binding_id, channel_session_id, pairing_id, user_id, tenant_id, idempotency_key,
            event_type, payload_summary, status, received_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'message', ?, 'received', ?, ?, ?)
        ON CONFLICT(binding_id, idempotency_key) DO NOTHING
        RETURNING *
    `, [binding.id, channelSession.id, pairingResult.pairing.id, binding.user_id, binding.tenant_id || null, eventKey, JSON.stringify({ eventId: inbound.eventId, identityHint: hintExternalValue(inbound.identity), conversationHint: hintExternalValue(inbound.conversation), textLength: inbound.text.length, attachmentCount: inbound.attachments.length, attachmentTypes: [...new Set(inbound.attachments.map(item => item.contentType))].slice(0, 8) }), now, now, now]);
    if (!inserted) {
        const existing = await queryOne('SELECT * FROM agent_channel_inbound_events WHERE binding_id = ? AND idempotency_key = ?', [binding.id, eventKey]);
        return { deduped: true, paired: pairingResult.pairedNow, accepted: true, runId: existing?.run_id || null, sessionId: channelSession.session_id };
    }

    const user = await queryOne("SELECT * FROM users WHERE id = ? AND deleted_at IS NULL AND COALESCE(status, 'active') != 'disabled'", [binding.user_id]);
    if (!user) throw gatewayError('渠道绑定所属账号不可用。', 'AGENT_CHANNEL_GATEWAY_USER_UNAVAILABLE', 403);
    try {
        // 文件落入既有受 ACL 保护的附件存储，正文只保留受限本地引用；绝不透传平台 URL。
        const storedAttachments = await persistInboundAttachments({ userId: user.id, sessionId: channelSession.session_id, attachments: inbound.attachments });
        const messageContent = [inbound.text, attachmentMessageReferences(storedAttachments)].filter(Boolean).join('\n\n').slice(0, MAX_MESSAGE_CHARS + 8000);
        const saved = await sessions.insertMessage({
            sessionId: channelSession.session_id,
            userId: user.id,
            role: 'user',
            content: messageContent,
            tokenCount: estimateTokens(messageContent),
            contextTokenCount: estimateTokens(messageContent),
            modelId: config.modelId,
            routeMetadata: JSON.stringify({ source: 'channel_gateway', bindingId: binding.id, inboundEventId: inserted.id }),
            createdAt: now
        });
        await sessions.touchSession(channelSession.session_id, now);
        const history = await sessions.listMessages(channelSession.session_id, user.id);
        const preferredModelId = config.modelId || user.default_model_id || user.defaultModelId || null;
        let modelCfg = await getRunnableModelForUserAsync(preferredModelId, user);
        if (!modelCfg) {
            const models = await getUserRunnableModelsAsync(user);
            modelCfg = models[0] || null;
        }
        if (!modelCfg) throw gatewayError('渠道绑定未找到当前账号可用模型。', 'AGENT_CHANNEL_GATEWAY_MODEL_UNAVAILABLE', 409);
        const context = await prepareChatAgentContext({ userId: user.id, user, sessionId: channelSession.session_id, modelCfg, modelContent: messageContent });
        const metadata = {
            ...buildChatAgentMetadata({
                sessionId: channelSession.session_id,
                userMessageId: saved.lastInsertRowid,
                visibleContent: messageContent,
                history,
                source: 'channel_gateway',
                currentContent: messageContent,
                memoryContext: context.memoryContext,
                ragContext: context.ragContext,
                ragEnabled: false,
                mcpEnabled: false
            }),
                channelGateway: {
                bindingId: binding.id,
                pairingId: pairingResult.pairing.id,
                channelSessionId: channelSession.id,
                inboundEventId: inserted.id,
                    eventKey
                },
                inboundAttachments: storedAttachments.map(item => ({ name: item.name, contentType: item.contentType, bytes: item.bytes, sha256: item.sha256 }))
            };
        const run = await requireCreateAgentRun()({
            user,
            goal: messageContent,
            modelId: modelCfg.id,
            sessionId: channelSession.session_id,
            title: `${config.replyPrefix}${inbound.text || `处理 ${storedAttachments.length} 个渠道附件`}`.slice(0, 160),
            maxSteps: 30,
            runMode: 'standard',
            toolPolicy: 'builtin_only',
            toolAllowlist: [],
            approvalPolicy: 'safe_mcp_auto',
            dedupeKey: `channel:${binding.id}:${eventKey}`,
            metadata,
            contextConfig: { mode: 'recent', notes: '来自已配对外部渠道的受控 Agent 会话。' },
            chatAgent: true
        });
        await execute(`
            UPDATE agent_channel_inbound_events
            SET status = 'accepted', run_id = ?, processed_at = ?, updated_at = ?
            WHERE id = ? AND binding_id = ? AND status = 'received'
        `, [run.id, now, now, inserted.id, binding.id]);
        await execute('UPDATE agent_channel_sessions SET last_inbound_at = ?, updated_at = ? WHERE id = ? AND status = \'active\'', [now, now, channelSession.id]);
        return { deduped: false, paired: pairingResult.pairedNow, accepted: true, runId: run.id, sessionId: channelSession.session_id, channelSessionId: channelSession.id };
    } catch (error) {
        await execute(`
            UPDATE agent_channel_inbound_events
            SET status = 'rejected', error_code = ?, error_message = ?, processed_at = ?, updated_at = ?
            WHERE id = ? AND binding_id = ?
        `, [String(error.code || 'CHANNEL_GATEWAY_MESSAGE_FAILED').slice(0, 80), String(error.message || error).slice(0, 2000), now, now, inserted.id, binding.id]);
        throw error;
    }
}

async function deliverChannelGatewayRunResult(runId, status = '') {
    const run = await queryOne('SELECT id, user_id, tenant_id, title, final_answer, error_message, metadata FROM agent_runs WHERE id = ?', [String(runId || '')]);
    const metadata = parseJson(run?.metadata, {});
    const gateway = metadata.channelGateway;
    if (!run || !gateway?.bindingId || !gateway?.channelSessionId) return null;
    const binding = await queryOne("SELECT * FROM agent_channel_bindings WHERE id = ? AND user_id = ? AND status = 'active'", [String(gateway.bindingId), run.user_id]);
    if (!binding) return null;
    const channelSession = await queryOne("SELECT * FROM agent_channel_sessions WHERE id = ? AND binding_id = ? AND user_id = ? AND status = 'active'", [String(gateway.channelSessionId), binding.id, run.user_id]);
    if (!channelSession) return null;
    // 在写入 outbox 前仅验证密文可用；明文目标绝不能写入 delivery/trace/log。
    if (!decryptOutboundTarget(binding.id, channelSession.outbound_target_encrypted)) {
        throw gatewayError('渠道会话缺少可用的受保护回复目标。', 'AGENT_CHANNEL_GATEWAY_TARGET_UNAVAILABLE', 409);
    }
    const message = String(run.final_answer || '').trim()
        || (String(status) === 'cancelled' ? '任务已停止。' : `任务执行失败：${String(run.error_message || '未生成可用结果。').slice(0, 1600)}`);
    const delivery = await enqueueChannelDelivery({ id: run.user_id, tenant_id: run.tenant_id || null }, {
        bindingId: binding.id,
        eventType: 'channel.agent_result',
        runId: run.id,
        sourceId: run.id,
        idempotencyKey: `channel-run:${run.id}`,
        subject: String(run.title || 'Pivot Agent').slice(0, 255),
        body: message,
        interaction: { gatewaySessionId: gateway.channelSessionId, source: 'channel_gateway', outboundTargetEncrypted: channelSession.outbound_target_encrypted }
    });
    return delivery;
}

async function recordChannelGatewayDelivery(channelSessionId, deliveredAt = getBeijingTimestamp()) {
    if (!channelSessionId) return null;
    return await queryOne("UPDATE agent_channel_sessions SET last_outbound_at = ?, updated_at = ? WHERE id = ? AND status = 'active' RETURNING *", [deliveredAt, deliveredAt, String(channelSessionId)]);
}

module.exports = {
    configureAgentChannelGateway,
    configForBinding,
    createChannelPairing,
    deliverChannelGatewayRunResult,
    digestExternalValue,
    decryptOutboundTarget,
    encryptOutboundTarget,
    listChannelGatewaySessions,
    linkChannelGatewaySession,
    listChannelPairings,
    normalizeInboundMessage,
    receiveChannelMessage,
    recordChannelGatewayDelivery,
    revokeChannelPairing,
    verifyGatewaySignature
};
