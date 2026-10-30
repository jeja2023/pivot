const test = require('node:test');
const assert = require('node:assert/strict');
const { getCapabilityToolGovernanceBatch } = require('../server/services/capability-market');

test('批量读取能力治理保留用户权限、停用语义并重新读取最新配置', async () => {
    const actor = { id: 7, role: 'user' };
    const tools = [
        { type: 'builtin_tool', sourceRef: 'a', toolName: 'a' },
        { type: 'mcp_server', sourceRef: '1', toolName: 'read' },
        { type: 'mcp_server', sourceRef: '1', toolName: 'write' },
        { type: 'mcp_server', sourceRef: '2', toolName: 'read' },
        { type: 'mcp_server', sourceRef: '3', toolName: 'read' }
    ];
    const packages = [
        { package_key: 'mcp_server:1', user_id: 7, scope: 'user', status: 'enabled', config: { tools: { write: { enabled: false }, read: { riskLevel: 'high' } } } },
        { package_key: 'mcp_server:2', user_id: 8, scope: 'user', status: 'enabled' },
        { package_key: 'mcp_server:3', user_id: null, scope: 'global', status: 'disabled' }
    ];
    let calls = 0;
    const loadPackages = async keys => { calls += 1; assert.equal(keys.length, 4); return packages; };
    let result = await getCapabilityToolGovernanceBatch(tools, actor, { loadPackages });
    assert.deepEqual(result.map(item => item.enabled), [true, true, false, false, false]);
    assert.equal(result[1].riskLevel, 'high');
    packages[0].status = 'disabled';
    result = await getCapabilityToolGovernanceBatch(tools, actor, { loadPackages });
    assert.equal(result[1].enabled, false);
    assert.equal(calls, 2);
});
