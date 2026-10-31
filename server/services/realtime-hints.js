'use strict';

const { query } = require('../db/client');
const { getDeploymentProfile } = require('./deployment-profile');
const { logger } = require('../logger');
const crypto = require('node:crypto');
const origin = crypto.randomUUID();
const pending = new Map();
const activeKeys = new Set();
let active = 0;
let scheduled = null;
let schemaPromise = null;
const MAX_PENDING = 512;
const MAX_ACTIVE = 4;

function sign(schema, sender, message) {
    const secret = String(process.env.DATA_ENCRYPTION_KEY || '');
    if (!secret.trim()) throw new Error('实时提示需要配置 DATA_ENCRYPTION_KEY');
    const key = crypto.createHash('sha256').update('pivot:realtime-hint:v1\0').update(secret).digest();
    return crypto.createHmac('sha256', key).update(JSON.stringify([schema, sender, message])).digest('hex');
}

function encodeHint(schema, sender, hint) {
    const message = JSON.stringify(hint);
    return { schema, origin: sender, message, signature: sign(schema, sender, message) };
}

function verifyHint(body, schema) {
    if (!body || body.schema !== schema || typeof body.origin !== 'string' || body.origin.length > 64
        || typeof body.message !== 'string' || body.message.length > 4096 || !/^[a-f0-9]{64}$/.test(String(body.signature || ''))) return null;
    try {
        const expected = Buffer.from(sign(schema, body.origin, body.message), 'hex');
        const actual = Buffer.from(body.signature, 'hex');
        if (!crypto.timingSafeEqual(expected, actual)) return null;
        const hint = JSON.parse(body.message);
        return buildHint(hint?.user, hint?.type, hint?.payload);
    } catch (_) { return null; }
}

function currentSchema() {
    if (!schemaPromise) {
        schemaPromise = query('SELECT current_schema() AS schema').then(rows => {
            const schema = rows[0]?.schema;
            if (!schema) throw new Error('未获取到实时事件数据库 schema');
            return schema;
        }).catch(error => { schemaPromise = null; throw error; });
    }
    return schemaPromise;
}

function buildHint(userId, type, payload) {
    const user = String(userId || '');
    if (!/^[1-9]\d{0,18}$/.test(user)) return null;
    const source = payload && typeof payload === 'object' ? payload : {};
    const run = String(source.run?.id || source.notification?.run_id || '').slice(0, 160);
    const presentation = String(source.presentationId || '').slice(0, 128);
    if (type === 'agent.streaming' && source.runId) {
        const step = Number(source.step);
        if (!Number.isSafeInteger(step) || step < 0) return null;
        return { user, type, payload: { runId: String(source.runId).slice(0, 160), step,
            partialToolCalls: Array.isArray(source.partialToolCalls) && source.partialToolCalls.length ? [{}] : [],
            completed: source.completed === true, metadataOnly: true } };
    }
    if (type === 'agent.run' && run) return { user, type, payload: { run: { id: run } } };
    if (type === 'agent.notification') return { user, type, payload: { notification: { run_id: run } } };
    if (['presentation.updated', 'presentation.comments', 'presentation.collaborators', 'presentation.access_revoked'].includes(type) && presentation) {
        // 撤权提示触发授权查询，避免迟到的旧撤权事件关闭已重新授权的文稿。
        return { user, type: type === 'presentation.access_revoked' ? 'presentation.updated' : type, payload: { presentationId: presentation } };
    }
    return null;
}

function pump() {
    scheduled = null;
    while (active < MAX_ACTIVE && pending.size) {
        const key = [...pending.keys()].find(item => !activeKeys.has(item));
        if (!key) return;
        const hint = pending.get(key);
        pending.delete(key);
        active += 1;
        activeKeys.add(key);
        void currentSchema().then(schema => {
            const body = encodeHint(schema, origin, hint);
            return query("SELECT pg_notify('pivot_user_hint_v1', ?::text)", [JSON.stringify(body)]);
        })
            .catch(error => logger.warn({ code: error.code || 'REALTIME_HINT_FAILED' }, '实时刷新提示发送失败，依靠状态补查恢复'))
            .finally(() => { active -= 1; activeKeys.delete(key); pump(); });
    }
}

function publishHint(userId, type, payload) {
    const hint = buildHint(userId, type, payload);
    if (!hint || getDeploymentProfile().requestedMode !== 'multi_node') return;
    const key = JSON.stringify([hint.user, hint.type, hint.type === 'agent.streaming' ? hint.payload.runId : hint.payload]);
    if (!pending.has(key) && pending.size >= MAX_PENDING) {
        logger.warn({ code: 'REALTIME_HINT_OVERFLOW' }, '实时刷新提示队列已满，依靠状态补查恢复');
        return;
    }
    pending.set(key, hint);
    if (!scheduled) { scheduled = setTimeout(pump, 100); scheduled.unref?.(); }
}

module.exports = { buildHint, encodeHint, origin, publishHint, verifyHint };
