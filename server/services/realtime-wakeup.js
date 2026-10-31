'use strict';

const { Client } = require('pg');
const { getPgPool } = require('../db/pg-connection');
const { logger } = require('../logger');

function createRealtimeWakeup({ createClient = () => new Client(getPgPool().options), retryMs = 1000,
    onHint = hint => require('./realtime-events').deliverLocalUserEvent(hint.user, hint.type, hint.payload),
    onResync = user => require('./realtime-events').deliverLocalUserEvent(user, 'realtime.resync', { userId: Number(user), reason: 'listener_reconnected' }) } = {}) {
    const users = new Map();
    let current = null;
    let retry = null;
    let generation = 0;
    function notifyRealtimeSubscribers(user) {
        for (const fn of [...(users.get(String(user)) || [])]) {
            try { fn(); } catch (_) {}
        }
    }
    function schedule() {
        if (!users.size || current || retry) return;
        retry = setTimeout(() => { retry = null; void connect(); }, retryMs);
        retry.unref?.();
    }
    async function connect() {
        if (!users.size || current) return;
        const token = ++generation;
        let client;
        try {
            client = createClient();
            current = client;
            let lost = false;
            const onLost = () => {
                if (lost) return;
                lost = true;
                if (current === client) current = null;
                void client.end().catch(() => {});
                schedule();
            };
            client.on('error', onLost);
            client.on('end', onLost);
            await client.connect();
            const schema = (await client.query('SELECT current_schema() AS schema')).rows[0]?.schema;
            if (!schema) throw new Error('未获取到实时事件数据库 schema');
            client.on('notification', message => {
                try {
                    const body = JSON.parse(message.payload || '');
                    if (body.schema !== schema) return;
                    if (message.channel === 'pivot_agent_event_v1' && /^\d{1,19}$/.test(String(body.user))) notifyRealtimeSubscribers(body.user);
                    if (message.channel === 'pivot_user_hint_v1' && body.origin !== require('./realtime-hints').origin) {
                        const valid = require('./realtime-hints').verifyHint(body, schema);
                        if (valid && users.has(valid.user)) onHint(valid);
                    }
                } catch (_) {}
            });
            await client.query('LISTEN pivot_agent_event_v1');
            await client.query('LISTEN pivot_user_hint_v1');
            if (token !== generation || current !== client || !users.size) { await client.end(); return; }
            // LISTEN 前和断线期间可能漏通知，所有现有连接立即补查。
            for (const user of users.keys()) {
                notifyRealtimeSubscribers(user);
                try { onResync(user); } catch (_) {}
            }
        } catch (error) {
            if (current === client) current = null;
            if (client) await client.end().catch(() => {});
            logger.warn({ code: error.code || 'REALTIME_WAKEUP_UNAVAILABLE' }, '实时事件通知不可用，继续周期补查');
            schedule();
        }
    }
    function subscribe(userId, callback) {
        const key = String(userId);
        if (!users.has(key)) users.set(key, new Set());
        users.get(key).add(callback);
        void connect().catch(() => schedule());
        let closed = false;
        return () => {
            if (closed) return;
            closed = true;
            const listeners = users.get(key);
            listeners?.delete(callback);
            if (!listeners?.size) users.delete(key);
            if (!users.size) {
                generation += 1;
                if (retry) clearTimeout(retry);
                retry = null;
                const client = current;
                current = null;
                if (client) void client.end().catch(() => {});
            }
        };
    }
    return { subscribe };
}

const realtimeWakeup = createRealtimeWakeup();
module.exports = { createRealtimeWakeup, realtimeWakeup };
