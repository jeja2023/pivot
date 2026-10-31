'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { Client } = require('pg');
const { INDEX_NAME, ensureRealtimeIndex } = require('../scripts/realtime_event_index');

test('实时事件索引只在明确执行时并发创建，冲突时不改变已有对象', { skip: !process.env.DATABASE_URL, timeout: 30000 }, async () => {
    const schema = `pivot_replay_index_${process.pid}_${Date.now().toString(36)}`;
    assert.match(schema, /^[a-z0-9_]+$/);
    const admin = new Client({ connectionString: process.env.DATABASE_URL });
    const other = new Client({ connectionString: process.env.DATABASE_URL });
    await admin.connect();
    await other.connect();
    let created = false;
    try {
        await admin.query(`CREATE SCHEMA "${schema}"`);
        created = true;
        await admin.query(`CREATE TABLE "${schema}".agent_events(id bigint PRIMARY KEY, user_id bigint NOT NULL, payload text)`);
        await admin.query(`INSERT INTO "${schema}".agent_events SELECT n, n % 100, 'x' FROM generate_series(1, 30000) n`);
        const before = await ensureRealtimeIndex(admin, schema);
        assert.equal(before.action, 'inspect');
        assert.deepEqual(before.matchingIndexes, []);
        await other.query("SELECT pg_advisory_lock(hashtext('pivot:realtime-index'), hashtext($1))", [schema]);
        assert.equal((await ensureRealtimeIndex(admin, schema, { create: true })).action, 'build_in_progress');
        await other.query("SELECT pg_advisory_unlock(hashtext('pivot:realtime-index'), hashtext($1))", [schema]);
        const result = await ensureRealtimeIndex(admin, schema, { create: true });
        assert.equal(result.action, 'created');
        assert.deepEqual(result.matchingIndexes, [INDEX_NAME]);
        assert.equal((await ensureRealtimeIndex(admin, schema, { create: true })).action, 'already_available');
        await admin.query('SET enable_seqscan = off');
        const plan = await admin.query(`EXPLAIN (FORMAT JSON) SELECT id FROM "${schema}".agent_events WHERE user_id = 33 AND id > 1000 ORDER BY id LIMIT 200`);
        assert.match(JSON.stringify(plan.rows), new RegExp(INDEX_NAME));
        await admin.query('RESET enable_seqscan');
        await admin.query(`DROP INDEX "${schema}"."${INDEX_NAME}"`);
        await admin.query(`CREATE INDEX replay_existing ON "${schema}".agent_events (user_id, id)`);
        const existing = await ensureRealtimeIndex(admin, schema, { create: true });
        assert.equal(existing.action, 'already_available');
        assert.deepEqual(existing.matchingIndexes, ['replay_existing']);
        await admin.query(`DROP INDEX "${schema}".replay_existing`);
        await admin.query(`CREATE TABLE "${schema}"."${INDEX_NAME}" (keep text)`);
        const conflict = await ensureRealtimeIndex(admin, schema, { create: true });
        assert.equal(conflict.action, 'name_conflict');
        assert.equal((await admin.query('SELECT to_regclass($1) AS object', [`${schema}.${INDEX_NAME}`])).rows[0].object, `${schema}.${INDEX_NAME}`);
        await assert.rejects(ensureRealtimeIndex(admin, `${schema}";DROP SCHEMA public`, { create: true }), /invalid schema/);
    } finally {
        await other.end();
        if (created) await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
        await admin.end();
    }
});
