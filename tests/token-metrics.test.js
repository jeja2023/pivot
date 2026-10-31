'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { fork } = require('node:child_process');
const test = require('node:test');
const { Client, Pool } = require('pg');
const { readTokenMetrics, readSharedTokenMetrics } = require('../server/services/token-metrics');
const snapshotMigration = require('../server/db/migrations/token-metrics-snapshot')[0];

test('token 聚合与旧查询一致，并反映修正和删除', { skip: !process.env.DATABASE_URL }, async () => {
    const client = new Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    try {
        await client.query('CREATE TEMP TABLE models (id bigint, name text)');
        await client.query('CREATE TEMP TABLE messages (model_id bigint, role text, token_count bigint, created_at timestamptz)');
        await client.query('CREATE TEMP TABLE model_usage_events (model_id bigint, source text, token_count bigint, created_at timestamptz)');
        await client.query("INSERT INTO models VALUES (1, 'model-a'), (2, NULL)");
        await client.query(`INSERT INTO messages VALUES
            (1, 'assistant', 12, '2026-10-31 00:00:00+00'),
            (1, 'assistant', 8, '2026-10-30 23:59:59+00'),
            (2, NULL, NULL, '2026-10-31 23:59:59+00'),
            (NULL, 'api', 3, '2026-11-01 00:00:00+00')`);
        await client.query(`INSERT INTO model_usage_events VALUES
            (1, 'assistant', 7, '2026-10-31 12:00:00+00'),
            (99, NULL, 0, '2026-10-31 12:00:00+00'),
            (NULL, 'api', 4, '2026-10-31 12:00:00+00')`);
        const start = '2026-10-31 00:00:00+00';
        const end = '2026-11-01 00:00:00+00';
        const run = async (sql, params) => {
            let i = 0;
            return (await client.query(sql.replace(/\?/g, () => `$${++i}`), params)).rows;
        };
        const oldQuery = today => `
            SELECT model_id, model_name, role, SUM(tokens) AS tokens FROM (
              SELECT COALESCE(m.model_id, 0) AS model_id, COALESCE(md.name, 'unknown') AS model_name,
                     COALESCE(m.role, 'unknown') AS role, COALESCE(SUM(m.token_count), 0) AS tokens
              FROM messages m LEFT JOIN models md ON md.id = m.model_id
              ${today ? 'WHERE m.created_at >= $1 AND m.created_at < $2' : ''}
              GROUP BY 1, 2, 3
              UNION ALL
              SELECT COALESCE(e.model_id, 0), COALESCE(md.name, 'unknown'), COALESCE(e.source, 'api'), COALESCE(SUM(e.token_count), 0)
              FROM model_usage_events e LEFT JOIN models md ON md.id = e.model_id
              ${today ? 'WHERE e.created_at >= $1 AND e.created_at < $2' : ''}
              GROUP BY 1, 2, 3
            ) s GROUP BY 1, 2, 3`;
        const sorted = rows => rows.map(row => ({ ...row, tokens: String(row.tokens) }))
            .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
        async function compare() {
            const actual = await readTokenMetrics(run, start, end);
            assert.deepEqual(sorted(actual.all), sorted((await client.query(oldQuery(false))).rows));
            assert.deepEqual(sorted(actual.today), sorted((await client.query(oldQuery(true), [start, end])).rows));
        }
        await compare();
        await client.query("UPDATE messages SET token_count = 23 WHERE model_id = 1 AND token_count = 12");
        await client.query('DELETE FROM model_usage_events WHERE model_id = 99');
        await compare();
    } finally {
        await client.end();
    }
});

test('多个数据库连接共享 token 快照，过期后并发只重算一次并反映修正和删除', { skip: !process.env.DATABASE_URL, timeout: 30000 }, async () => {
    const schema = `pivot_metrics_test_${process.pid}_${Date.now().toString(36)}`;
    assert.match(schema, /^[a-z0-9_]+$/);
    const admin = new Client({ connectionString: process.env.DATABASE_URL });
    await admin.connect();
    let pool;
    let holder;
    let created = false;
    try {
        await admin.query(`CREATE SCHEMA "${schema}"`);
        created = true;
        await admin.query(`SET search_path TO "${schema}"`);
        await admin.query('CREATE TABLE models (id bigint PRIMARY KEY, name text)');
        await admin.query('CREATE TABLE messages (model_id bigint, role text, token_count bigint, created_at timestamptz)');
        await admin.query('CREATE TABLE model_usage_events (model_id bigint, source text, token_count bigint, created_at timestamptz)');
        await snapshotMigration.upPg(admin);
        assert.equal(await snapshotMigration.checkPg(admin), true);
        await snapshotMigration.upPg(admin);
        await admin.query("INSERT INTO models VALUES (1, 'model-a')");
        await admin.query("INSERT INTO messages VALUES (1, 'assistant', 12, '2026-10-31 12:00:00+00'), (1, 'assistant', 8, '2026-10-30 12:00:00+00')");
        await admin.query("INSERT INTO model_usage_events VALUES (1, 'assistant', 7, '2026-10-31 12:00:00+00')");
        pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 8, options: `-c search_path=${schema} -c timezone=UTC` });
        let aggregates = 0;
        const pgSql = sql => { let i = 0; return sql.replace(/\?/g, () => `$${++i}`); };
        const wrap = client => ({
            async query(sql, params = []) {
                if (sql.includes('FROM messages') && sql.includes('FROM model_usage_events')) {
                    aggregates += 1;
                    await new Promise(resolve => setTimeout(resolve, 50));
                }
                return (await client.query(pgSql(sql), params)).rows;
            },
            async queryOne(sql, params = []) { return (await client.query(pgSql(sql), params)).rows[0] || null; },
            async execute(sql, params = []) { return (await client.query(pgSql(sql), params)).rowCount; }
        });
        const queryOne = async (sql, params) => (await pool.query(pgSql(sql), params)).rows[0] || null;
        const transaction = async fn => {
            const client = await pool.connect();
            try { await client.query('BEGIN'); const result = await fn(wrap(client)); await client.query('COMMIT'); return result; }
            catch (error) { await client.query('ROLLBACK'); throw error; }
            finally { client.release(); }
        };
        const run = (start = '2026-10-31 00:00:00+00', nextStart = '2026-11-01 00:00:00+00') =>
            readSharedTokenMetrics({ queryOne, transaction, start, nextStart, ttlMs: 15000 });
        const first = await Promise.all(Array.from({ length: 6 }, () => run()));
        assert.equal(aggregates, 1);
        for (const result of first) {
            assert.equal(Number(result.all[0].tokens), 27);
            assert.equal(Number(result.today[0].tokens), 19);
        }
        await admin.query("UPDATE messages SET token_count = 22 WHERE token_count = 12");
        await admin.query('DELETE FROM model_usage_events');
        assert.equal(Number((await run()).all[0].tokens), 27);
        await admin.query("UPDATE token_metrics_snapshot SET computed_at = clock_timestamp() - INTERVAL '30 seconds'");
        const next = await Promise.all(Array.from({ length: 6 }, () => run()));
        assert.equal(aggregates, 2);
        for (const result of next) {
            assert.equal(Number(result.all[0].tokens), 30);
            assert.equal(Number(result.today[0].tokens), 22);
        }
        await admin.query("UPDATE token_metrics_snapshot SET computed_at = clock_timestamp() - INTERVAL '30 seconds'");
        const failingTransaction = async fn => transaction(async trx => fn({
            ...trx,
            async query(sql, params) {
                if (sql.includes('FROM messages') && sql.includes('FROM model_usage_events')) throw new Error('模拟聚合失败');
                return await trx.query(sql, params);
            }
        }));
        await assert.rejects(readSharedTokenMetrics({ queryOne, transaction: failingTransaction,
            start: '2026-10-31 00:00:00+00', nextStart: '2026-11-01 00:00:00+00', ttlMs: 15000 }), /模拟聚合失败/);
        assert.equal(Number((await run()).today[0].tokens), 22);
        assert.equal(aggregates, 3);
        const nextDay = await run('2026-11-01 00:00:00+00', '2026-11-02 00:00:00+00');
        assert.equal(aggregates, 4);
        assert.deepEqual(nextDay.today, []);
        await admin.query("UPDATE token_metrics_snapshot SET computed_at = clock_timestamp() + INTERVAL '30 seconds'");
        await run('2026-11-01 00:00:00+00', '2026-11-02 00:00:00+00');
        assert.equal(aggregates, 5);
        await admin.query("UPDATE token_metrics_snapshot SET computed_at = clock_timestamp() - INTERVAL '30 seconds'");
        holder = fork(path.join(__dirname, 'fixtures/token-metrics-lock-holder.js'), [], {
            env: { ...process.env, PIVOT_METRICS_LOCK_SCHEMA: schema }, stdio: ['ignore', 'ignore', 'ignore', 'ipc']
        });
        await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('测试锁进程未就绪')), 10000);
            holder.once('message', message => { clearTimeout(timer); message.ready ? resolve() : reject(new Error(message.error || '锁失败')); });
            holder.once('exit', code => { clearTimeout(timer); reject(new Error(`测试锁进程提前退出: ${code}`)); });
        });
        let completed = false;
        const afterCrash = run('2026-11-01 00:00:00+00', '2026-11-02 00:00:00+00').then(value => { completed = true; return value; });
        await new Promise(resolve => setTimeout(resolve, 100));
        assert.equal(completed, false);
        const exited = new Promise(resolve => holder.once('exit', resolve));
        holder.kill();
        await exited;
        await afterCrash;
        assert.equal(aggregates, 6);
        await admin.query('DROP TABLE token_metrics_snapshot');
        assert.equal(await snapshotMigration.checkPg(admin), false);
        await snapshotMigration.upPg(admin);
        assert.equal(await snapshotMigration.checkPg(admin), true);
    } finally {
        if (holder && holder.exitCode === null && holder.signalCode === null) {
            const exited = new Promise(resolve => holder.once('exit', resolve));
            holder.kill();
            await exited;
        }
        if (pool) await pool.end();
        await admin.query('SET search_path TO public');
        if (created) await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
        await admin.end();
    }
});

test('旧版本表结构并存时只有部署为多节点的指标路径使用共享快照', { skip: !process.env.DATABASE_URL, timeout: 30000 }, async () => {
    const { spawnSync } = require('node:child_process');
    const client = new Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    const schema = `pivot_metrics_test_upgrade_${process.pid}_${Date.now().toString(36)}`;
    let created = false;
    try {
        assert.match(schema, /^[a-z0-9_]+$/);
        await client.query(`CREATE SCHEMA "${schema}"`);
        created = true;
        await client.query(`SET search_path TO "${schema}"`);
        await client.query('CREATE TABLE models (id bigint, name text)');
        await client.query('CREATE TABLE messages (model_id bigint, role text, token_count bigint, created_at timestamptz)');
        await client.query('CREATE TABLE model_usage_events (model_id bigint, source text, token_count bigint, created_at timestamptz)');
        const run = async (sql, params) => { let i = 0; return (await client.query(sql.replace(/\?/g, () => `$${++i}`), params)).rows; };
        const result = await readTokenMetrics(run, '2026-10-31 00:00:00+00', '2026-11-01 00:00:00+00');
        assert.deepEqual(result, { all: [], today: [] });
        const script = `const migration=require('./server/db/migrations/token-metrics-snapshot')[0]; const {Client}=require('pg'); (async()=>{const c=new Client({connectionString:process.env.DATABASE_URL});await c.connect();await c.query('SET search_path TO "${schema}"');if(await migration.checkPg(c))throw Error('unexpected');await migration.upPg(c);if(!await migration.checkPg(c))throw Error('missing');await c.end()})().catch(()=>process.exitCode=1)`;
        const migrated = spawnSync(process.execPath, ['-e', script], { env: process.env, windowsHide: true, timeout: 10000, encoding: 'utf8' });
        assert.equal(migrated.status, 0, migrated.stderr);
        assert.equal(await snapshotMigration.checkPg(client), true);
    } finally {
        await client.query('SET search_path TO public');
        if (created) await client.query(`DROP SCHEMA "${schema}" CASCADE`);
        await client.end();
    }
});
