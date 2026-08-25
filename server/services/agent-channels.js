const crypto = require('crypto');
const { query, queryOne, execute } = require('../db/client');
const { getBeijingTimestamp } = require('../time');
const { getPrimaryTenantId } = require('./enterprise-access');

const CHANNEL_TYPES = Object.freeze(['web', 'webhook', 'im', 'email']);

function invalid(message, status = 400) {
    const error = new Error(message);
    error.status = status;
    error.statusCode = status;
    error.code = 'AGENT_CHANNEL_INVALID';
    return error;
}

function parseJson(value, fallback = {}) {
    if (value && typeof value === 'object') return value;
    try { return JSON.parse(String(value || '')); } catch (_) { return fallback; }
}

function redactConfig(value, depth = 0) {
    if (depth > 4 || value === null || value === undefined) return value;
    if (Array.isArray(value)) return value.slice(0, 50).map(item => redactConfig(item, depth + 1));
    if (typeof value !== 'object') return value;
    return Object.fromEntries(Object.entries(value).slice(0, 50).map(([key, item]) => [
        key,
        /secret|token|password|api[-_]?key|private[-_]?key/i.test(key) ? '[已脱敏]' : redactConfig(item, depth + 1)
    ]));
}

function normalizeBindingInput(input = {}) {
    const channelType = String(input.channelType || input.channel_type || '').trim().toLowerCase();
    if (!CHANNEL_TYPES.includes(channelType)) throw invalid('渠道类型只能是 web、webhook、im 或 email。');
    const channelKey = String(input.channelKey || input.channel_key || input.address || '').trim().slice(0, 160);
    if (!channelKey) throw invalid('渠道绑定标识不能为空。');
    const config = input.config && typeof input.config === 'object' ? input.config : {};
    const notificationPolicy = input.notificationPolicy || input.notification_policy;
    return {
        channelType,
        channelKey,
        credentialRef: String(input.credentialRef || input.credential_ref || '').trim().slice(0, 255),
        config: Object.fromEntries(Object.entries(config).slice(0, 32)),
        notificationPolicy: notificationPolicy && typeof notificationPolicy === 'object' ? notificationPolicy : {},
        status: input.status === 'paused' ? 'paused' : 'active'
    };
}

function serializeBinding(row) {
    if (!row) return null;
    return {
        id: row.id,
        userId: Number(row.user_id),
        tenantId: row.tenant_id ? Number(row.tenant_id) : null,
        channelType: row.channel_type,
        channelKey: row.channel_key,
        credentialRef: row.credential_ref || '',
        config: redactConfig(parseJson(row.config, {})),
        notificationPolicy: parseJson(row.notification_policy, {}),
        status: row.status,
        createdAt: row.created_at || null,
        updatedAt: row.updated_at || null
    };
}

async function listAgentChannels(user, options = {}) {
    const tenantId = options.tenantId || user.tenant_id || await getPrimaryTenantId(user.id);
    const params = [user.id, tenantId];
    const where = ['user_id = ?', '(tenant_id IS NULL OR tenant_id = ?)'];
    if (options.status) { where.push('status = ?'); params.push(String(options.status)); }
    const rows = await query(`SELECT * FROM agent_channel_bindings WHERE ${where.join(' AND ')} ORDER BY updated_at DESC`, params);
    return rows.map(serializeBinding);
}

async function createAgentChannel(user, input = {}) {
    const data = normalizeBindingInput(input);
    const tenantId = user.tenant_id || await getPrimaryTenantId(user.id);
    const id = `channel_${crypto.randomUUID()}`;
    const now = getBeijingTimestamp();
    await execute(`INSERT INTO agent_channel_bindings (id, user_id, tenant_id, channel_type, channel_key, credential_ref, config, notification_policy, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [id, user.id, tenantId, data.channelType, data.channelKey, data.credentialRef, JSON.stringify(data.config), JSON.stringify(data.notificationPolicy), data.status, now, now]);
    return serializeBinding(await queryOne('SELECT * FROM agent_channel_bindings WHERE id = ? AND user_id = ?', [id, user.id]));
}

async function updateAgentChannel(id, user, input = {}) {
    const current = await queryOne('SELECT * FROM agent_channel_bindings WHERE id = ? AND user_id = ?', [String(id || ''), user.id]);
    if (!current) return null;
    const data = normalizeBindingInput({ ...serializeBinding(current), ...input });
    const now = getBeijingTimestamp();
    await execute('UPDATE agent_channel_bindings SET channel_type = ?, channel_key = ?, credential_ref = ?, config = ?, notification_policy = ?, status = ?, updated_at = ? WHERE id = ? AND user_id = ?', [data.channelType, data.channelKey, data.credentialRef, JSON.stringify(data.config), JSON.stringify(data.notificationPolicy), data.status, now, current.id, user.id]);
    return serializeBinding(await queryOne('SELECT * FROM agent_channel_bindings WHERE id = ?', [current.id]));
}

async function deleteAgentChannel(id, user) {
    const current = await queryOne('SELECT * FROM agent_channel_bindings WHERE id = ? AND user_id = ?', [String(id || ''), user.id]);
    if (!current) return null;
    await execute("UPDATE agent_channel_bindings SET status = 'deleted', credential_ref = '', config = '{}'::jsonb, updated_at = ? WHERE id = ? AND user_id = ?", [getBeijingTimestamp(), current.id, user.id]);
    return serializeBinding({ ...current, status: 'deleted', credential_ref: '', config: '{}', notification_policy: current.notification_policy });
}

module.exports = {
    CHANNEL_TYPES,
    createAgentChannel,
    deleteAgentChannel,
    listAgentChannels,
    normalizeBindingInput,
    serializeBinding,
    updateAgentChannel
};
