'use strict';

const { Client } = require('pg');
const { getPgPool } = require('./pg-connection');

async function withPgInitializationLock(operation, { pool = getPgPool(), createClient = options => new Client(options) } = {}) {
    // 独立连接只持有会话锁，不占用应用连接池；连接池大小为 1 时也能完成初始化。
    const client = createClient(pool.options);
    try {
        await client.connect();
        await client.query("SET statement_timeout = '10min'");
        await client.query("SELECT pg_advisory_lock(hashtext('pivot:initialization'), hashtext(current_schema()))");
        return await operation();
    } finally {
        await client.end();
    }
}

module.exports = { withPgInitializationLock };
