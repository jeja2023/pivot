'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { getPgPool } = require('../server/db/pg-connection');
const { runMigrationsPg } = require('../server/db/migrate');
const { recordPgMigration } = require('../server/db/migrations/runner');
const [foundation] = require('../server/db/migrations/chat-conversation-turns');
const [repair] = require('../server/db/migrations/chat-message-turn-link-repair');

test('历史迁移已登记但字段缺失时启动自动修复，重复启动幂等，历史消息和回复去重均保留', async () => {
    const client = await getPgPool().connect();
    const schema = `chat_turn_repair_${process.pid}_${Date.now().toString(36)}`;
    const originalPath = (await client.query('SHOW search_path')).rows[0].search_path;
    try {
        await client.query(`CREATE SCHEMA "${schema}"`);
        await client.query(`SET search_path TO "${schema}", public`);
        await client.query(`
            CREATE TABLE users (id BIGINT PRIMARY KEY);
            CREATE TABLE sessions (id VARCHAR(128) PRIMARY KEY, user_id BIGINT NOT NULL);
            CREATE TABLE agent_runs (id VARCHAR(128) PRIMARY KEY);
            CREATE TABLE messages (id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
                user_id BIGINT NOT NULL, session_id VARCHAR(128) NOT NULL, role TEXT NOT NULL,
                content TEXT NOT NULL, deleted_at TIMESTAMPTZ NULL);
            CREATE TABLE schema_migrations (id TEXT PRIMARY KEY, description TEXT, applied_at TIMESTAMPTZ);
            INSERT INTO users VALUES (1);
            INSERT INTO sessions VALUES ('session',1);
            INSERT INTO messages (user_id,session_id,role,content) VALUES (1,'session','user','已有的历史消息');
        `);
        await foundation.upPg(client);
        await recordPgMigration(client, foundation.id, foundation.description);
        await client.query('ALTER TABLE messages DROP COLUMN conversation_turn_id CASCADE');
        await assert.rejects(client.query('SELECT m.conversation_turn_id FROM messages m'), error => error.code === '42703');
        assert.equal(await repair.checkPg(client), false);

        const pool = { connect: async () => ({ query: (...args) => client.query(...args), release() {} }) };
        const options = { pool, migrations: [foundation, repair] };
        assert.deepEqual(await runMigrationsPg(options), [repair.id]);
        assert.equal(await repair.checkPg(client), true);
        assert.equal((await client.query('SELECT content FROM messages ORDER BY id')).rows[0].content, '已有的历史消息');
        assert.deepEqual(await runMigrationsPg(options), []);
        await client.query('DROP INDEX idx_messages_conversation_turn_assistant');
        assert.deepEqual(await runMigrationsPg(options), [repair.id]);
        await client.query('ALTER TABLE messages DROP CONSTRAINT messages_conversation_turn_id_fkey');
        assert.deepEqual(await runMigrationsPg(options), [repair.id]);
        assert.equal(await repair.checkPg(client), true);

        await client.query("INSERT INTO chat_conversation_turns(id,user_id,session_id,request_key,input_hash) VALUES ('turn',1,'session','request',repeat('a',64))");
        const insert = `INSERT INTO messages(user_id,session_id,role,content,conversation_turn_id)
            VALUES (1,'session','assistant','唯一回复','turn')
            ON CONFLICT(conversation_turn_id) WHERE conversation_turn_id IS NOT NULL AND role = 'assistant'
            DO UPDATE SET conversation_turn_id = EXCLUDED.conversation_turn_id RETURNING id`;
        const first = (await client.query(insert)).rows[0].id;
        assert.equal((await client.query(insert)).rows[0].id, first);
        assert.equal(Number((await client.query("SELECT COUNT(*) AS count FROM messages WHERE role='assistant'")).rows[0].count), 1);
        await client.query("DELETE FROM chat_conversation_turns WHERE id='turn'");
        assert.equal((await client.query('SELECT conversation_turn_id FROM messages WHERE id=$1', [first])).rows[0].conversation_turn_id, null);

        // 备份恢复或人工改表后，即使修复版本也已登记，启动仍校验实际结构。
        await client.query('ALTER TABLE messages DROP COLUMN conversation_turn_id CASCADE');
        assert.deepEqual(await runMigrationsPg(options), [repair.id]);
        assert.equal(await repair.checkPg(client), true);
        assert.equal(Number((await client.query('SELECT COUNT(*) AS count FROM messages')).rows[0].count), 2);
    } finally {
        await client.query('ROLLBACK').catch(() => {});
        await client.query(`SET search_path TO ${originalPath}`);
        await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
        client.release();
    }
});

test('迁移校验不通过时回滚并阻止启动，不能留下虚假的完成记录', async () => {
    const calls = [];
    const client = { query: async (sql, values) => {
        calls.push({ sql, values });
        if (sql.includes('SELECT id FROM schema_migrations')) return { rows: [] };
        return { rows: [] };
    }, release() {} };
    await assert.rejects(runMigrationsPg({ pool: { connect: async () => client },
        migrations: [{ id: 'test_readiness', description: '校验失败', upPg: async () => {}, checkPg: async () => false }] }), /结构校验未通过/);
    assert.ok(calls.some(call => call.sql === 'ROLLBACK'));
    assert.equal(calls.some(call => call.sql.includes('INSERT INTO schema_migrations')), false);
});
