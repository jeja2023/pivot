'use strict';

const { Client } = require('pg');

(async () => {
    const schema = String(process.env.PIVOT_METRICS_LOCK_SCHEMA || '');
    if (!/^pivot_metrics_test_[a-z0-9_]+$/.test(schema)) throw new Error('测试数据库模式无效');
    const client = new Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    await client.query(`SET search_path TO "${schema}"`);
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtext('pivot:token-metrics'), hashtext(current_schema()))");
    process.send?.({ ready: true });
    process.on('disconnect', () => { void client.end(); });
})().catch(error => { process.send?.({ error: error.message }); process.exitCode = 1; });
