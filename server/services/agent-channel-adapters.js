const crypto = require('crypto');
const net = require('net');
const tls = require('tls');
const { query, queryOne, execute } = require('../db/client');
const { getBeijingTimestamp } = require('../time');
const { safeJsonRequest } = require('./safe-http-client');
const { assertSafeMcpOutboundUrl, createSafeHttpAgentsForUser } = require('../security');
const { resolveCredentialSecret } = require('./workflow-credentials');
const { publishUserEvent } = require('./realtime-events');
const { buildImPayload, sendIm, validateImTarget } = require('./builtin-mcp-im');

const MAX_ATTEMPTS = 6;
const MAX_BODY_CHARS = 20000;
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

function parseJson(value, fallback = {}) {
    if (value && typeof value === 'object') return value;
    try { return JSON.parse(String(value || '')); } catch (_) { return fallback; }
}

function normalizeAttachments(value) {
    const items = Array.isArray(value) ? value : [];
    return items.slice(0, 20).map(item => ({
        name: String(item?.name || '').slice(0, 255),
        url: String(item?.url || '').slice(0, 2000),
        contentType: String(item?.contentType || item?.content_type || '').slice(0, 120),
        bytes: Math.max(0, Number(item?.bytes || 0)),
        sha256: String(item?.sha256 || '').slice(0, 128),
        contentBase64: String(item?.contentBase64 || item?.content_base64 || '').slice(0, 2 * 1024 * 1024)
    })).filter(item => item.name && item.url && item.bytes <= MAX_ATTACHMENT_BYTES);
}

function backoff(attempt) {
    return Math.min(60 * 60 * 1000, 1000 * (2 ** Math.min(Math.max(attempt - 1, 0), 10)) + Math.floor(Math.random() * 500));
}

function deliveryIdempotencyKey(input = {}) {
    return String(input.idempotencyKey || input.idempotency_key || `delivery:${input.eventType || 'event'}:${input.sourceId || input.runId || crypto.randomUUID()}`).slice(0, 255);
}

async function enqueueChannelDelivery(user, input = {}) {
    const binding = await queryOne("SELECT * FROM agent_channel_bindings WHERE id = ? AND user_id = ? AND status = 'active'", [String(input.bindingId || ''), user.id]);
    if (!binding) return null;
    const attachments = normalizeAttachments(input.attachments);
    if (attachments.some(item => item.bytes > MAX_ATTACHMENT_BYTES)) throw Object.assign(new Error('附件超过渠道允许的大小。'), { status: 413, code: 'CHANNEL_ATTACHMENT_TOO_LARGE' });
    const key = deliveryIdempotencyKey(input);
    const now = getBeijingTimestamp();
    const row = await queryOne(`INSERT INTO agent_channel_deliveries (binding_id, user_id, tenant_id, idempotency_key, event_type, subject, body, attachments, interaction, status, attempts, next_attempt_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', 0, ?, ?, ?) ON CONFLICT(binding_id, idempotency_key) DO UPDATE SET updated_at = agent_channel_deliveries.updated_at RETURNING id`, [binding.id, user.id, binding.tenant_id || user.tenant_id || input.tenantId || null, key, String(input.eventType || 'agent.event').slice(0, 80), String(input.subject || '').slice(0, 255), String(input.body || '').slice(0, MAX_BODY_CHARS), JSON.stringify(attachments), JSON.stringify(input.interaction && typeof input.interaction === 'object' ? input.interaction : {}), now, now, now]);
    return queryOne('SELECT * FROM agent_channel_deliveries WHERE id = ?', [row?.id]);
}

function chunkText(body, limit = 3500) {
    const text = String(body || '');
    const chunks = [];
    for (let index = 0; index < text.length; index += limit) chunks.push(text.slice(index, index + limit));
    return chunks.length ? chunks : [''];
}

async function deliverWebhook(binding, delivery, user) {
    const config = parseJson(binding.config, {});
    const url = String(config.url || '').trim();
    if (!url) throw Object.assign(new Error('Webhook 渠道缺少 URL。'), { code: 'CHANNEL_URL_MISSING' });
    await assertSafeMcpOutboundUrl(url, user);
    const chunks = chunkText(delivery.body, Number(config.chunkSize || 3500));
    for (let index = 0; index < chunks.length; index += 1) {
        await safeJsonRequest({ method: 'post', url, data: { eventType: delivery.event_type, subject: delivery.subject, body: chunks[index], chunkIndex: index, chunkTotal: chunks.length, idempotencyKey: `${delivery.idempotency_key}:${index}`, attachments: parseJson(delivery.attachments, []), interaction: parseJson(delivery.interaction, {}) }, user, assertUrl: assertSafeMcpOutboundUrl, headers: config.headers || {}, timeout: Math.min(Number(config.timeoutMs || 15000), 30000), createAgents: targetUser => createSafeHttpAgentsForUser(targetUser, { allowPrivateEnv: 'ALLOW_PRIVATE_MCP_URLS', allowExplicitLoopbackForAdmin: true }), validateStatus: status => status >= 200 && status < 300 });
    }
}

async function deliverEmail(binding, delivery, user) {
    const config = parseJson(binding.config, {});
    const endpoint = String(config.endpoint || '').trim();
    if (endpoint) {
        await assertSafeMcpOutboundUrl(endpoint, user);
        return safeJsonRequest({ method: 'post', url: endpoint, data: { to: binding.channel_key, subject: delivery.subject, text: delivery.body, attachments: parseJson(delivery.attachments, []), idempotencyKey: delivery.idempotency_key }, user, assertUrl: assertSafeMcpOutboundUrl, headers: config.headers || {}, timeout: 30000, createAgents: targetUser => createSafeHttpAgentsForUser(targetUser, { allowPrivateEnv: 'ALLOW_PRIVATE_MCP_URLS', allowExplicitLoopbackForAdmin: true }), validateStatus: status => status >= 200 && status < 300 });
    }
    const host = String(config.host || '').trim();
    const port = Number(config.port || (config.secure ? 465 : 587));
    const from = String(config.from || '').trim();
    if (!host || !from) throw Object.assign(new Error('邮件渠道需要 endpoint 或 SMTP host/from。'), { code: 'CHANNEL_EMAIL_ENDPOINT_MISSING' });
    if (config.secure !== true) throw Object.assign(new Error('直接 SMTP 渠道必须启用 TLS；非 TLS 邮件请配置受控 HTTPS endpoint。'), { code: 'CHANNEL_SMTP_TLS_REQUIRED' });
    if (port !== 465) throw Object.assign(new Error('直接 SMTP 渠道当前只允许 implicit TLS 的 465 端口；587 请配置受控 HTTPS endpoint。'), { code: 'CHANNEL_SMTP_PORT_INVALID' });
    await assertSafeMcpOutboundUrl(`https://${host}:${port}`, user);
    const credential = binding.credential_ref ? await resolveCredentialSecret(binding.credential_ref, user) : null;
    if (config.authUser && !credential) throw Object.assign(new Error('SMTP 渠道凭据引用不可用。'), { code: 'CHANNEL_EMAIL_CREDENTIAL_MISSING' });
    await sendSmtpMessage({ host, port, secure: config.secure === true, user: String(config.authUser || ''), password: credential?.value || '', from, to: binding.channel_key, subject: delivery.subject, body: delivery.body, attachments: parseJson(delivery.attachments, []) });
}

function smtpLine(value) { return `${String(value || '').replace(/[\r\n]/g, ' ').slice(0, 1000)}\r\n`; }
function sendSmtpMessage(options = {}) {
    return new Promise((resolve, reject) => {
        const socket = options.secure ? tls.connect({ host: options.host, port: options.port, rejectUnauthorized: true }) : net.connect({ host: options.host, port: options.port });
        let buffer = '';
        let step = 0;
        let settled = false;
        const finish = error => { if (settled) return; settled = true; socket.end(); error ? reject(error) : resolve(); };
        const fail = message => finish(Object.assign(new Error(message), { code: 'CHANNEL_SMTP_ERROR' }));
        const send = command => socket.write(command);
        socket.setTimeout(30000, () => fail('SMTP 连接超时。'));
        socket.on('error', error => finish(error));
        socket.on('data', chunk => {
            buffer += chunk.toString();
            if (!buffer.includes('\r\n')) return;
            const lines = buffer.split('\r\n');
            buffer = lines.pop();
            const line = lines[lines.length - 1] || '';
            const code = Number.parseInt(line.slice(0, 3), 10);
            if (code >= 400) return fail(`SMTP 服务拒绝请求：${line}`);
            if (step === 0) { step = 1; send('EHLO pivot.local\r\n'); return; }
            if (step === 1) { step = options.user ? 2 : 4; return send(options.user ? 'AUTH LOGIN\r\n' : `MAIL FROM:<${options.from}>\r\n`); }
            if (step === 2) { step = 3; return send(`${Buffer.from(options.user).toString('base64')}\r\n`); }
            if (step === 3) { step = 4; return send(`${Buffer.from(options.password).toString('base64')}\r\n`); }
            if (step === 4) { step = 5; return send(`RCPT TO:<${options.to}>\r\n`); }
            if (step === 5) { step = 6; return send('DATA\r\n'); }
            if (step === 6) {
                step = 7;
                const boundary = `pivot_${crypto.randomBytes(8).toString('hex')}`;
                const attachments = (options.attachments || []).filter(item => item.contentBase64).map(item => `--${boundary}\r\nContent-Type: ${item.contentType || 'application/octet-stream'}; name="${String(item.name).replace(/"/g, '')}"\r\nContent-Disposition: attachment; filename="${String(item.name).replace(/"/g, '')}"\r\nContent-Transfer-Encoding: base64\r\n\r\n${item.contentBase64}\r\n`).join('');
                const message = `From: ${smtpLine(options.from)}To: ${smtpLine(options.to)}Subject: ${smtpLine(options.subject)}MIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary="${boundary}"\r\n\r\n--${boundary}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${String(options.body || '').replace(/\r?\n/g, '\r\n')}\r\n${attachments}--${boundary}--\r\n.\r\n`;
                return send(message);
            }
            if (step === 7) finish();
        });
    });
}

async function deliverIm(binding, delivery, user) {
    const config = parseJson(binding.config, {});
    if (config.driver === 'builtinIm' || config.driver === 'pivot-im') {
        const targetType = String(config.targetType || 'user').toLowerCase() === 'group' ? 'group' : 'user';
        const target = validateImTarget({ ...config, defaultTarget: binding.channel_key }, binding.channel_key, targetType);
        const credential = binding.credential_ref ? await resolveCredentialSecret(binding.credential_ref, user) : null;
        const chunks = chunkText(delivery.body, Number(config.chunkSize || 3000));
        for (let index = 0; index < chunks.length; index += 1) {
            await sendIm(config, credential?.value || '', buildImPayload(config, { target, targetType, title: delivery.subject, message: chunks[index], chunkIndex: index, chunkTotal: chunks.length, idempotencyKey: `${delivery.idempotency_key}:${index}` }, user), user);
        }
        return;
    }
    const endpoint = String(config.endpoint || '').trim();
    if (!endpoint) throw Object.assign(new Error('IM 渠道缺少受控发送端点。'), { code: 'CHANNEL_IM_ENDPOINT_MISSING' });
    await assertSafeMcpOutboundUrl(endpoint, user);
    const chunks = chunkText(delivery.body, Number(config.chunkSize || 3000));
    for (let index = 0; index < chunks.length; index += 1) await safeJsonRequest({ method: 'post', url: endpoint, data: { target: binding.channel_key, title: delivery.subject, message: chunks[index], chunkIndex: index, chunkTotal: chunks.length, idempotencyKey: `${delivery.idempotency_key}:${index}`, interaction: parseJson(delivery.interaction, {}) }, user, assertUrl: assertSafeMcpOutboundUrl, createAgents: targetUser => createSafeHttpAgentsForUser(targetUser, { allowPrivateEnv: 'ALLOW_PRIVATE_MCP_URLS', allowExplicitLoopbackForAdmin: true }), headers: config.headers || {}, timeout: 30000, validateStatus: status => status >= 200 && status < 300 });
}

async function deliverChannelDelivery(deliveryId, options = {}) {
    const delivery = await queryOne('SELECT d.*, b.channel_type, b.channel_key, b.config FROM agent_channel_deliveries d JOIN agent_channel_bindings b ON b.id = d.binding_id WHERE d.id = ?', [deliveryId]);
    if (!delivery) return null;
    const user = await queryOne('SELECT id, username, nickname, unit, role FROM users WHERE id = ?', [delivery.user_id]);
    try {
        if (delivery.channel_type === 'web') publishUserEvent(delivery.user_id, 'agent.channel', { deliveryId: delivery.id, eventType: delivery.event_type, subject: delivery.subject, body: delivery.body, attachments: parseJson(delivery.attachments, []), interaction: parseJson(delivery.interaction, {}) });
        else if (delivery.channel_type === 'webhook') await deliverWebhook(delivery, delivery, user);
        else if (delivery.channel_type === 'email') await deliverEmail(delivery, delivery, user);
        else if (delivery.channel_type === 'im') await deliverIm(delivery, delivery, user);
        else throw new Error(`暂不支持渠道类型：${delivery.channel_type}`);
        await execute("UPDATE agent_channel_deliveries SET status = 'delivered', delivered_at = ?, updated_at = ? WHERE id = ?", [getBeijingTimestamp(), getBeijingTimestamp(), delivery.id]);
    } catch (error) {
        const attempts = Number(delivery.attempts || 0) + 1;
        const dead = attempts >= MAX_ATTEMPTS;
        await execute('UPDATE agent_channel_deliveries SET status = ?, attempts = ?, next_attempt_at = ?, last_error = ?, dead_lettered_at = CASE WHEN ? THEN ? ELSE dead_lettered_at END, updated_at = ? WHERE id = ?', [dead ? 'dead_letter' : 'queued', attempts, getBeijingTimestamp(new Date(Date.now() + backoff(attempts))), String(error.message || error).slice(0, 2000), dead, dead ? getBeijingTimestamp() : null, getBeijingTimestamp(), delivery.id]);
        if (dead && typeof options.onDeadLetter === 'function') await options.onDeadLetter(delivery, error);
    }
    return queryOne('SELECT * FROM agent_channel_deliveries WHERE id = ?', [delivery.id]);
}

async function dispatchChannelDeliveries(limit = 50, options = {}) {
    const rows = await query("SELECT id FROM agent_channel_deliveries WHERE status = 'queued' AND next_attempt_at <= NOW() ORDER BY created_at ASC LIMIT ?", [Math.max(1, Math.min(Number.parseInt(limit, 10) || 50, 200))]);
    for (const row of rows) await deliverChannelDelivery(row.id, options);
    return { processed: rows.length };
}

module.exports = { MAX_ATTEMPTS, MAX_ATTACHMENT_BYTES, backoff, chunkText, deliverEmail, deliverIm, deliverWebhook, dispatchChannelDeliveries, deliverChannelDelivery, deliveryIdempotencyKey, enqueueChannelDelivery, normalizeAttachments };
