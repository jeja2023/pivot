'use strict';

const { Client } = require('pg');

const INDEX_NAME = 'idx_agent_events_user_id_replay';
function validSchema(schema) {
    return typeof schema === 'string' && /^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/.test(schema);
}
function quote(name) { return `"${name.replace(/"/g, '""')}"`; }

async function inspect(client, schema) {
    if (!validSchema(schema)) throw new Error('无效的数据库模式名称');
    const table = await client.query(`
        SELECT c.oid::text AS oid, c.relkind, pg_total_relation_size(c.oid)::text AS bytes
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = $1 AND c.relname = 'agent_events'
    `, [schema]);
    if (!table.rows.length || table.rows[0].relkind !== 'r') throw new Error('agent_events 必须是普通物理表');
    const indexes = await client.query(`
        SELECT index_table.relname AS name, i.indisvalid AS valid, i.indisready AS ready,
            am.amname = 'btree' AND i.indnkeyatts = 2 AND i.indnatts = 2
              AND i.indpred IS NULL AND i.indexprs IS NULL
              AND i.indoption[0] = 0 AND i.indoption[1] = 0
              AND op0.opcdefault AND op1.opcdefault
              AND op0.opcintype = a0.atttypid AND op1.opcintype = a1.atttypid
              AND a0.attname = 'user_id' AND a1.attname = 'id' AS matching
        FROM pg_index i JOIN pg_class index_table ON index_table.oid = i.indexrelid
        JOIN pg_am am ON am.oid = index_table.relam
        LEFT JOIN pg_attribute a0 ON a0.attrelid = i.indrelid AND a0.attnum = i.indkey[0]
        LEFT JOIN pg_attribute a1 ON a1.attrelid = i.indrelid AND a1.attnum = i.indkey[1]
        LEFT JOIN pg_opclass op0 ON op0.oid = i.indclass[0]
        LEFT JOIN pg_opclass op1 ON op1.oid = i.indclass[1]
        WHERE i.indrelid = $1::oid ORDER BY index_table.relname
    `, [table.rows[0].oid]);
    const occupied = await client.query(`
        SELECT c.relkind FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = $1 AND c.relname = $2
    `, [schema, INDEX_NAME]);
    const matching = indexes.rows.filter(row => row.matching && row.valid && row.ready).map(row => row.name);
    return { schema, tableBytes: table.rows[0].bytes, matchingIndexes: matching,
        indexNameOccupied: occupied.rows.length > 0, indexes: indexes.rows };
}

async function ensureRealtimeIndex(client, schema, { create = false } = {}) {
    if (!validSchema(schema)) throw new Error('无效的数据库模式名称');
    if (!create) return { ...(await inspect(client, schema)), action: 'inspect' };
    await client.query("SET statement_timeout = '30min'");
    await client.query("SET lock_timeout = '5s'");
    const result = await client.query("SELECT pg_try_advisory_lock(hashtext('pivot:realtime-index'), hashtext($1)) AS acquired", [schema]);
    if (!result.rows[0]?.acquired) return { schema, action: 'build_in_progress' };
    try {
        const state = await inspect(client, schema);
        if (state.matchingIndexes.length) return { ...state, action: 'already_available' };
        if (state.indexNameOccupied) return { ...state, action: 'name_conflict' };
        // CREATE INDEX CONCURRENTLY 必须在事务外，失败产生的索引留给运维检查。
        await client.query(`CREATE INDEX CONCURRENTLY ${quote(INDEX_NAME)} ON ${quote(schema)}.agent_events (user_id, id)`);
        const verified = await inspect(client, schema);
        if (!verified.matchingIndexes.includes(INDEX_NAME)) throw new Error('新建索引校验失败');
        return { ...verified, action: 'created' };
    } finally {
        await client.query("SELECT pg_advisory_unlock(hashtext('pivot:realtime-index'), hashtext($1))", [schema]);
    }
}

async function main() {
    const args = process.argv.slice(2);
    const schemaArg = args.filter(value => value.startsWith('--schema='));
    if (schemaArg.length !== 1 || args.some(value => !value.startsWith('--schema=') && value !== '--create')) throw new Error('参数格式无效');
    const schema = schemaArg[0].slice('--schema='.length);
    if (!validSchema(schema) || !process.env.REALTIME_INDEX_DATABASE_URL) throw new Error('缺少数据库连接或模式参数');
    const create = args.includes('--create');
    if (create && process.env.PIVOT_REALTIME_INDEX_CONFIRM !== 'YES') throw new Error('创建索引需显式设置确认变量');
    const client = new Client({ connectionString: process.env.REALTIME_INDEX_DATABASE_URL, connectionTimeoutMillis: 5000 });
    await client.connect();
    try {
        const result = await ensureRealtimeIndex(client, schema, { create });
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        if (['name_conflict', 'build_in_progress'].includes(result.action)) process.exitCode = 1;
    } finally { await client.end(); }
}

if (require.main === module) main().catch(error => {
    process.stderr.write(`实时事件索引操作失败（${String(error.code || 'INDEX_FAILED').replace(/[^A-Z0-9_]/gi, '').slice(0, 40)}），请检查数据库日志；不会自动删除已有索引。\n`);
    process.exitCode = 1;
});

module.exports = { INDEX_NAME, ensureRealtimeIndex, inspect, validSchema };
