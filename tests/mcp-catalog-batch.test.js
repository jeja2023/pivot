const test = require('node:test');
const assert = require('node:assert/strict');
const { formatMcpTools } = require('../server/services/mcp-client');

test('同一目录构建只读取一次每个服务的发布版本和治理快照', async () => {
    const rows = [
        { server_id: 1, server_name: 'A', server_base_url: 'https://a.example', name: 'one', input_schema: '{}' },
        { server_id: 1, server_name: 'A', server_base_url: 'https://a.example', name: 'two', input_schema: '{}' },
        { server_id: 2, server_name: 'B', server_base_url: 'https://b.example', name: 'three', input_schema: '{}' }
    ];
    const calls = { governance: 0, releases: [], items: [] };
    const deps = {
        getGovernance: async entries => { calls.governance += 1; assert.equal(entries.length, 3); return entries.map(() => ({ enabled: true, riskLevel: 'medium' })); },
        activeRelease: async serverId => { calls.releases.push(serverId); return { id: serverId * 10, release_version: 'v1' }; },
        releaseItems: async releaseId => { calls.items.push(releaseId); return releaseId === 10
            ? [{ id: 11, toolName: 'one', description: '发布契约', inputSchema: { type: 'object' }, definitionDigest: 'digest-one' }]
            : []; }
    };
    const tools = await formatMcpTools(rows, { id: 7 }, deps);
    assert.equal(calls.governance, 1);
    assert.deepEqual(calls.releases.sort(), [1, 2]);
    assert.deepEqual(calls.items.sort(), [10, 20]);
    assert.equal(tools[0].description, '发布契约');
    assert.equal(tools[0].definitionDigest, 'digest-one');
    assert.equal(tools[1].name, 'two');
    await formatMcpTools(rows, { id: 7 }, deps);
    assert.equal(calls.governance, 2);
    assert.equal(calls.releases.length, 4);
});
