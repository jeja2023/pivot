const crypto = require('crypto');
const { queryOne, execute } = require('../db/client');
const { getBeijingTimestamp } = require('../time');
const { resolveCredentialSecret } = require('./workflow-credentials');
const { decideWorkflowApprovalRequest } = require('./agent-approval-requests');

function readByPath(value, pathText) {
    return String(pathText || '').split('.').filter(Boolean).reduce((current, key) => current == null ? undefined : current[key], value);
}

function invalid(message, status = 400, code = 'CHANNEL_INTERACTION_INVALID') {
    const error = new Error(message);
    error.status = status;
    error.statusCode = status;
    error.code = code;
    return error;
}

function verifySignature(secret, timestamp, payload, provided) {
    const expected = crypto.createHmac('sha256', String(secret || '')).update(`${timestamp || ''}.${JSON.stringify(payload || {})}`).digest('hex');
    const actual = String(provided || '').replace(/^sha256=/i, '').trim();
    return Boolean(actual) && actual.length === expected.length && crypto.timingSafeEqual(Buffer.from(actual), Buffer.from(expected));
}

async function receiveChannelInteraction(bindingId, payload = {}, headers = {}) {
    const binding = await queryOne("SELECT * FROM agent_channel_bindings WHERE id = ? AND status = 'active'", [String(bindingId || '')]);
    if (!binding) return null;
    const config = binding.config && typeof binding.config === 'object' ? binding.config : (() => { try { return JSON.parse(binding.config || '{}'); } catch (_) { return {}; } })();
    const timestamp = headers['x-agent-event-timestamp'] || headers['x-webhook-timestamp'] || headers['x-signature-timestamp'] || '';
    const replayWindowSeconds = Math.max(30, Math.min(Number(config.replayWindowSeconds || config.replay_window_seconds || 300), 3600));
    const parsedTimestamp = Number.isFinite(Number(timestamp)) ? Number(timestamp) : Date.parse(String(timestamp));
    if (!Number.isFinite(parsedTimestamp) || Math.abs(Date.now() - parsedTimestamp) > replayWindowSeconds * 1000) throw invalid('渠道交互请求已过期或时间戳无效。', 401, 'CHANNEL_INTERACTION_REPLAY');
    const credential = binding.credential_ref ? await resolveCredentialSecret(binding.credential_ref, { id: binding.user_id, unit: config.unit || '' }) : null;
    const signingSecret = credential?.value || String(config.signingSecret || config.signing_secret || '');
    if (!signingSecret || !verifySignature(signingSecret, timestamp, payload, headers['x-agent-signature'] || headers['x-signature'])) throw invalid('渠道交互签名无效。', 401, 'CHANNEL_INTERACTION_SIGNATURE_INVALID');
    const identityPath = String(config.identityPath || config.identity_path || '').trim();
    if (identityPath) {
        const identity = readByPath(payload, identityPath);
        const allowed = Array.isArray(config.allowedIdentities || config.allowed_identities) ? (config.allowedIdentities || config.allowed_identities).map(String) : [String(binding.channel_key)];
        if (!allowed.includes(String(identity || ''))) throw invalid('渠道交互身份不匹配。', 403, 'CHANNEL_INTERACTION_IDENTITY_DENIED');
    }
    const requestId = String(payload.requestId || payload.request_id || payload.approvalId || payload.approval_id || '').trim();
    const decision = String(payload.decision || payload.action || '').trim().toLowerCase();
    if (!requestId || !['approve', 'approved', 'reject', 'rejected'].includes(decision)) throw invalid('渠道交互必须提供 requestId 和 approve/reject 决定。');
    const idempotencyKey = String(headers['idempotency-key'] || payload.idempotencyKey || payload.idempotency_key || `${requestId}:${decision}:${timestamp}`).slice(0, 255);
    const existing = await queryOne('SELECT id, status, interaction FROM agent_channel_deliveries WHERE binding_id = ? AND idempotency_key = ?', [binding.id, `inbound:${idempotencyKey}`]);
    if (existing) return { deduped: true, deliveryId: existing.id, status: existing.status, decision: JSON.parse(existing.interaction || '{}').decision || decision };
    const now = getBeijingTimestamp();
    const inserted = await queryOne(`INSERT INTO agent_channel_deliveries (binding_id, user_id, tenant_id, idempotency_key, event_type, subject, body, interaction, status, attempts, next_attempt_at, created_at, updated_at) VALUES (?, ?, ?, ?, 'channel.interaction', 'approval', ?, ?, 'queued', 0, ?, ?, ?) RETURNING id`, [binding.id, binding.user_id, binding.tenant_id || null, `inbound:${idempotencyKey}`, JSON.stringify({ requestId, decision, identity: identityPath ? readByPath(payload, identityPath) : null }), JSON.stringify(payload).slice(0, 10000), now, now, now]);
    try {
        const approval = await decideWorkflowApprovalRequest(requestId, { id: binding.user_id }, { approve: decision === 'approve' || decision === 'approved', note: String(payload.note || '').slice(0, 2000) });
        await execute("UPDATE agent_channel_deliveries SET status = 'delivered', delivered_at = ?, updated_at = ? WHERE id = ?", [now, now, inserted.id]);
        return { deduped: false, deliveryId: inserted.id, request: approval, decision };
    } catch (error) {
        await execute("UPDATE agent_channel_deliveries SET status = 'dead_letter', attempts = 1, last_error = ?, dead_lettered_at = ?, updated_at = ? WHERE id = ?", [String(error.message || error).slice(0, 2000), now, now, inserted.id]);
        throw error;
    }
}

module.exports = { receiveChannelInteraction, verifySignature };
