'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { getPgPool } = require('../server/db/pg-connection');
const { capture, activate } = require('../server/services/tool-catalog-releases');
const { executeToolDiscoveryMeta } = require('../server/services/agent-tools-discovery');
const { executeDiscoveredTool } = require('../server/services/tool-discovery');
const { assertDescribed, createToolDiscoveryState } = require('../server/services/agent-tool-progressive-discovery');

test('actual PostgreSQL release activation recovers stale describe and refuses stale execution or a disabled server', { skip: !process.env.DATABASE_URL }, async () => {
    const pool = getPgPool();
    const suffix = `${process.pid}-${Date.now()}`;
    const createdUser = await pool.query(`
        INSERT INTO users (username, password_hash, nickname, unit, role, status, created_at)
        VALUES ($1, 'hash', '发现恢复测试', 'QA', 'admin', 'active', NOW()) RETURNING id
    `, [`discovery_recovery_${suffix}`]);
    const user = { id: Number(createdUser.rows[0].id), role: 'admin', unit: 'QA' };
    let server;
    try {
        const createdServer = await pool.query(`
            INSERT INTO mcp_servers (user_id, name, base_url, api_key, description, status, created_at, updated_at)
            VALUES ($1, $2, 'https://discovery-recovery.example.test/mcp', '', '工具版本恢复测试', 'active', NOW(), NOW())
            RETURNING id, name
        `, [user.id, `Discovery Recovery ${suffix}`]);
        server = { ...createdServer.rows[0], id: Number(createdServer.rows[0].id) };
        const tool = {
            name: 'orders.search', title: '订单查询', description: '查询订单',
            inputSchema: { type: 'object', properties: { query: { type: 'string' } } }
        };
        const first = await capture({ server, tools: [tool], user });
        await activate(server.id, first.release.id, user);
        const toolName = `mcp.${server.id}.orders.search`;
        const state = createToolDiscoveryState();
        const context = { toolDiscoveryState: state, run: { tool_policy: 'all', tool_allowlist: [toolName] } };
        const search = await executeToolDiscoveryMeta('tools.search', { query: '订单查询' }, user, context);
        const oldRef = search.value.candidates.find(candidate => candidate.toolRef.toolName === toolName)?.toolRef;
        assert.equal(oldRef.releaseId, first.release.id);
        const before = await executeToolDiscoveryMeta('tools.describe', { toolRef: oldRef }, user, context);
        assert.equal(before.value.referenceRefresh, undefined);

        const changed = { ...tool, inputSchema: { ...tool.inputSchema, properties: { ...tool.inputSchema.properties, limit: { type: 'integer' } } } };
        const second = await capture({ server, tools: [changed], user });
        await activate(server.id, second.release.id, user);
        await assert.rejects(
            () => executeDiscoveredTool(user, { toolRef: oldRef, input: {} }, context),
            error => error.code === 'TOOL_REFERENCE_STALE'
        );
        const after = await executeToolDiscoveryMeta('tools.describe', { toolRef: oldRef }, user, context);
        assert.equal(after.value.toolRef.releaseId, second.release.id);
        assert.notEqual(after.value.toolRef.definitionDigest, oldRef.definitionDigest);
        assert.equal(after.value.inputSchema.properties.limit.type, 'integer');
        assert.equal(after.value.referenceRefresh.reason, 'TOOL_REFERENCE_STALE');
        assert.doesNotThrow(() => assertDescribed(state, { ...after.value.toolRef }));
        assert.throws(() => assertDescribed(state, { ...oldRef }), error => error.code === 'TOOL_DISCOVERY_SEARCH_REQUIRED');

        await pool.query("UPDATE mcp_servers SET status = 'disabled' WHERE id = $1", [server.id]);
        await assert.rejects(
            () => executeToolDiscoveryMeta('tools.describe', { toolRef: after.value.toolRef }, user, context),
            error => error.status === 404
        );
        assert.throws(() => assertDescribed(state, { ...after.value.toolRef }), error => error.code === 'TOOL_DISCOVERY_SEARCH_REQUIRED');
    } finally {
        if (server) await pool.query('DELETE FROM mcp_servers WHERE id = $1', [server.id]);
        await pool.query('DELETE FROM users WHERE id = $1', [user.id]);
    }
});
