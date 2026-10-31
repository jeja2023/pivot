'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const { Client } = require('pg');
const { createRealtimeWakeup } = require('../server/services/realtime-wakeup');
const migration = require('../server/db/migrations/realtime-agent-wakeup')[0];
const { buildHint, encodeHint, origin, verifyHint } = require('../server/services/realtime-hints');

test('跨节点提示只保留业务对象标识，不携带正文与凭据', () => {
    const hint = buildHint(7, 'agent.notification', { notification: { run_id: 'run-1', body: 'secret' }, token: 'secret' });
    assert.deepEqual(hint, { user: '7', type: 'agent.notification', payload: { notification: { run_id: 'run-1' } } });
    assert.deepEqual(buildHint(7, 'agent.streaming', { runId: 'run-1', step: 2, content: 'secret', partialToolCalls: [{ arguments: 'secret' }] }),
        { user: '7', type: 'agent.streaming', payload: { runId: 'run-1', step: 2, partialToolCalls: [{}], completed: false, metadataOnly: true } });
    assert.equal(buildHint(7, 'agent.event', {}), null);
    assert.equal(buildHint(7, 'agent.channel', { deliveryId: '123', body: 'secret' }), null);
    assert.deepEqual(buildHint(7, 'presentation.access_revoked', { presentationId: 'doc-1' }),
        { user: '7', type: 'presentation.updated', payload: { presentationId: 'doc-1' } });
});

test('通知只唤醒同 schema 的用户，重连后唤醒全部订阅者', async () => {
    const previousKey = process.env.DATA_ENCRYPTION_KEY;
    process.env.DATA_ENCRYPTION_KEY = 'realtime-test-key-012345678901234567890';
    const clients = [];
    function createClient() {
        const client = new EventEmitter();
        client.connect = async () => {};
        client.query = async sql => sql.startsWith('SELECT') ? { rows: [{ schema: 'tenant_schema' }] } : { rows: [] };
        client.end = async () => {};
        clients.push(client);
        return client;
    }
    const received = [];
    const resyncs = [];
    const hub = createRealtimeWakeup({ createClient, retryMs: 10, onHint: hint => received.push(hint), onResync: user => resyncs.push(user) });
    let a = 0; let b = 0;
    const stopA = hub.subscribe(1, () => { a += 1; });
    const stopB = hub.subscribe(2, () => { b += 1; });
    try {
        await new Promise(resolve => setImmediate(resolve));
        assert.deepEqual([a, b], [1, 1]);
        assert.deepEqual(resyncs, ['1', '2']);
        clients[0].emit('notification', { channel: 'pivot_agent_event_v1', payload: JSON.stringify({ schema: 'other', user: '1' }) });
        clients[0].emit('notification', { channel: 'pivot_agent_event_v1', payload: JSON.stringify({ schema: 'tenant_schema', user: '2' }) });
        assert.deepEqual([a, b], [1, 2]);
        const hint = { user: '2', type: 'presentation.comments', payload: { presentationId: 'doc', text: 'secret' } };
        clients[0].emit('notification', { channel: 'pivot_user_hint_v1', payload: JSON.stringify(encodeHint('tenant_schema', origin, hint)) });
        assert.equal(received.length, 0);
        const signed = encodeHint('tenant_schema', 'other', hint);
        assert.equal(verifyHint({ ...signed, message: signed.message.replace('doc', 'evil') }, 'tenant_schema'), null);
        assert.equal(verifyHint(signed, 'other_schema'), null);
        clients[0].emit('notification', { channel: 'pivot_user_hint_v1', payload: JSON.stringify({ ...signed, signature: '0'.repeat(64) }) });
        assert.equal(received.length, 0);
        clients[0].emit('notification', { channel: 'pivot_user_hint_v1', payload: JSON.stringify(signed) });
        assert.deepEqual(received, [{ user: '2', type: 'presentation.comments', payload: { presentationId: 'doc' } }]);
        clients[0].emit('error', new Error('连接断开'));
        await new Promise(resolve => setTimeout(resolve, 35));
        assert.equal(clients.length, 2);
        assert.deepEqual([a, b], [2, 3]);
        assert.deepEqual(resyncs, ['1', '2', '1', '2']);
    } finally {
        stopA(); stopB();
        if (previousKey === undefined) delete process.env.DATA_ENCRYPTION_KEY; else process.env.DATA_ENCRYPTION_KEY = previousKey;
    }
});

test('数据库通知只在提交后产生，回滚不唤醒', { skip: !process.env.DATABASE_URL, timeout: 30000 }, async () => {
    const schema = `pivot_notify_test_${process.pid}_${Date.now().toString(36)}`;
    assert.match(schema, /^[a-z0-9_]+$/);
    const writer = new Client({ connectionString: process.env.DATABASE_URL });
    const listener = new Client({ connectionString: process.env.DATABASE_URL });
    await writer.connect(); await listener.connect();
    let created = false;
    try {
        await writer.query(`CREATE SCHEMA "${schema}"`); created = true;
        await writer.query(`SET search_path TO "${schema}"`);
        await writer.query('CREATE TABLE agent_events(id bigint, user_id bigint)');
        await migration.upPg(writer);
        assert.equal(await migration.checkPg(writer), true);
        await listener.query('LISTEN pivot_agent_event_v1');
        const messages = [];
        listener.on('notification', message => messages.push(JSON.parse(message.payload)));
        await writer.query('BEGIN');
        await writer.query('INSERT INTO agent_events VALUES (1, 7)');
        await writer.query('ROLLBACK');
        await new Promise(resolve => setTimeout(resolve, 80));
        assert.equal(messages.length, 0);
        await writer.query('BEGIN');
        await writer.query('INSERT INTO agent_events VALUES (2, 7), (3, 7)');
        await writer.query('COMMIT');
        const deadline = Date.now() + 2000;
        while (!messages.length && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
        assert.deepEqual(messages, [{ schema, user: '7' }]);
    } finally {
        await listener.end();
        await writer.query('SET search_path TO public');
        if (created) await writer.query(`DROP SCHEMA "${schema}" CASCADE`);
        await writer.end();
    }
});
