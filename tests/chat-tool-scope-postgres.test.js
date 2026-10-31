'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { queryOne, execute } = require('../server/db/client');
const { updateAgentRunMetadataWithRetry } = require('../server/services/agent-run-metadata-patch');
const { buildToolExecutionPlan } = require('../server/services/agent-tool-execution-plan');
const { refreshDiscoveryScope } = require('../server/services/agent-tool-discovery-scope');

test('工具范围与元数据原子落库，运行中的旧快照在发现和执行前读取新范围', async () => {
    const user = await queryOne('SELECT * FROM users ORDER BY id LIMIT 1');
    const id = `scope-${process.pid}-${Date.now()}`;
    const old = 'mcp.89.old';
    const next = 'mcp.90.new';
    const metadata = { capabilityConstraints: { present: true, capabilities: ['network.request'] } };
    await execute("INSERT INTO agent_runs (id,user_id,title,goal,status,metadata,tool_allowlist,network_policy,created_at,updated_at) VALUES (?,?,'范围回归','执行工具','running',?::jsonb,?::jsonb,?::jsonb,NOW(),NOW())",
        [id, user.id, JSON.stringify(metadata), JSON.stringify([old]), JSON.stringify({ allowed_origins: ['http://old:8501'], allowed_ports: [8501] })]);
    try {
        await updateAgentRunMetadataWithRetry(id, current => ({ ...current, chatToolScope: { sourceMessageId: 4, toolPolicy: 'all', toolAllowlist: [next], networkPolicy: { enabled: true, allowed_origins: ['http://new:8502'], allowed_ports: [8502] } } }), { userId: user.id, updateToolScope: true });
        const row = await queryOne('SELECT * FROM agent_runs WHERE id = ?', [id]);
        assert.deepEqual(typeof row.tool_allowlist === 'string' ? JSON.parse(row.tool_allowlist) : row.tool_allowlist, [next]);
        assert.deepEqual((typeof row.network_policy === 'string' ? JSON.parse(row.network_policy) : row.network_policy).allowed_ports, [8502]);
        const stale = { id, metadata, tool_allowlist: [old], network_policy: { allowed_ports: [8501] } };
        const tool = { name: old, source: 'mcp', capabilities: ['network.request'], network: true, risk_level: 3, input_schema: { type: 'object' } };
        assert.equal((await buildToolExecutionPlan({ run: stale, tool, user })).policy.decision, 'denied');
        const plan = await buildToolExecutionPlan({ run: stale, tool: { ...tool, name: next }, user });
        assert.deepEqual(plan.network.policy.allowed_ports, [8502]);
        await refreshDiscoveryScope(stale, user);
        assert.deepEqual(stale.tool_allowlist, [next]);
        assert.deepEqual(stale.network_policy.allowed_ports, [8502]);
        const denied = await updateAgentRunMetadataWithRetry(id, current => ({ ...current, unrelated: true }), { userId: Number(user.id) + 99999, updateToolScope: true });
        assert.equal(denied, null);
    } finally { await execute('DELETE FROM agent_runs WHERE id = ?', [id]); }
});
