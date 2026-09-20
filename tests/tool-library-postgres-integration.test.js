'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { getPgPool } = require('../server/db/pg-connection');
const { capture, activeRelease, activate, releaseItems } = require('../server/services/tool-catalog-releases');

async function createUserAndServer() {
    const pool = getPgPool();
    const suffix = `${process.pid}-${Date.now()}`;
    const user = await pool.query(`
        INSERT INTO users (username, password_hash, nickname, unit, role, status, created_at)
        VALUES ($1, 'hash', '工具库集成测试', 'QA', 'admin', 'active', NOW())
        RETURNING id, username, role, unit
    `, [`tool_library_pg_${suffix}`]);
    const server = await pool.query(`
        INSERT INTO mcp_servers (user_id, name, base_url, api_key, description, status, created_at, updated_at)
        VALUES ($1, $2, 'https://tool-library.example.test/mcp', '', 'PostgreSQL 工具目录集成测试', 'active', NOW(), NOW())
        RETURNING id, name
    `, [user.rows[0].id, `Tool Library ${suffix}`]);
    return { pool, user: { id: Number(user.rows[0].id), username: user.rows[0].username, role: user.rows[0].role, unit: user.rows[0].unit }, server: { id: Number(server.rows[0].id), name: server.rows[0].name } };
}

test('工具目录 Release 生命周期保留旧版本、写入别名并在审核激活后切换兼容缓存', { skip: !process.env.DATABASE_URL }, async () => {
    const { pool, user, server } = await createUserAndServer();
    try {
        const first = await capture({
            server,
            user,
            protocolVersion: '2026-07-28',
            tools: [{
                name: 'orders.search', title: '订单查询', description: '按条件查询订单。',
                inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
                outputSchema: { type: 'object', properties: { rows: { type: 'array' } } },
                tags: ['订单', '查询']
            }]
        });
        assert.equal(first.activated, true);
        assert.equal((await activeRelease(server.id))?.id, first.release.id);
        const aliases = await pool.query('SELECT alias FROM tool_catalog_aliases WHERE server_id = $1 ORDER BY alias', [server.id]);
        assert.deepEqual(new Set(aliases.rows.map(row => row.alias)), new Set(['orders.search', '订单', '订单查询', '查询']));

        const breaking = await capture({
            server,
            user,
            tools: [{
                name: 'orders.search', title: '订单查询', description: '按条件查询订单。',
                inputSchema: { type: 'object', properties: { query: { type: 'string', minLength: 3 } }, required: ['query'] },
                outputSchema: { type: 'object', properties: { rows: { type: 'array' } } }
            }]
        });
        assert.equal(breaking.activated, false);
        assert.equal(breaking.release.status, 'pending_review');
        assert.equal((await activeRelease(server.id))?.id, first.release.id);

        const activated = await activate(server.id, breaking.release.id, user);
        assert.equal(activated.status, 'active');
        const activeItems = await releaseItems(activated.id);
        assert.equal(activeItems[0].inputSchema.required.includes('query'), true);
        const legacy = await pool.query('SELECT name, input_schema FROM mcp_tool_cache WHERE server_id = $1', [server.id]);
        assert.equal(legacy.rows.length, 1);
        assert.equal(legacy.rows[0].name, 'orders.search');
        assert.match(String(legacy.rows[0].input_schema), /minLength/);
    } finally {
        await pool.query('DELETE FROM mcp_servers WHERE id = $1', [server.id]);
        await pool.query('DELETE FROM users WHERE id = $1', [user.id]);
    }
});
