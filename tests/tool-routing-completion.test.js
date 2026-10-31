'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const dns = require('node:dns').promises;
const { resolveAutomaticMcpEndpoints, resolveChatSelectedTools } = require('../server/services/chat-selected-tools');
const { mcpOutboundOptions } = require('../server/services/mcp-managed-outbound');
const { getChatCapabilityAvailability } = require('../server/services/chat-capability-scope');
const { recordDiscoverySearch, pauseForMissingTool } = require('../server/services/agent-discovery-progress');
const { toolStepDiagnostics } = require('../server/services/agent-tool-diagnostics');
const { continueConversationTask } = require('../server/services/chat-task-continuation');

const actor = { id: 7, role: 'user' };
const name = 'mcp.89.render_diagram';
const server = { id: 89, user_id: null, status: 'active', base_url: 'http://offline-tools:8501/mcp' };
const diagram = { name, source: 'mcp', capabilities: ['network.request'] };

test('自动端点仅绑定能力范围内的工具，不把来源授予其他 HTTP 工具', async () => {
    let options;
    const deps = { formatToolList: async (_actor, input) => { options = input; return [diagram, { ...diagram, name: 'mcp.90.write', capabilities: ['filesystem.write_workspace'] }]; }, getAccessibleMcpServer: async () => server };
    assert.deepEqual(await resolveAutomaticMcpEndpoints(actor, ['network.request'], null, deps), { [name]: server.base_url });
    assert.deepEqual(await resolveAutomaticMcpEndpoints(actor, ['viz.render'], null, deps), {});
    await resolveAutomaticMcpEndpoints(actor, ['network.request'], [], deps);
    assert.deepEqual(options.toolAllowlist, ['__none__']);
    const lookup = dns.lookup;
    dns.lookup = async () => [{ address: '10.20.30.40', family: 4 }];
    try {
        const policy = { enabled: true, mcp_endpoints: { [name]: server.base_url } };
        const guard = await mcpOutboundOptions(server, actor, { networkPolicy: policy, toolName: name }, async () => server);
        await guard.assertUrl(server.base_url);
        await assert.rejects(guard.assertUrl('http://offline-tools:8501/other'));
        const other = await mcpOutboundOptions(server, actor, { networkPolicy: policy, toolName: 'mcp.89.other' }, async () => server);
        await assert.rejects(other.assertUrl(server.base_url));
        await assert.rejects(mcpOutboundOptions(server, actor, { networkPolicy: { ...policy, enabled: false }, toolName: name }, async () => server));
        const revoked = await mcpOutboundOptions(server, actor, { networkPolicy: policy, toolName: name }, async () => null);
        await assert.rejects(revoked.assertUrl(server.base_url));
    } finally { dns.lookup = lookup; }
});

test('超过 24 个工具时优先保留选择和相关候选，手动范围仍先过滤', async () => {
    const tools = Array.from({ length: 35 }, (_, i) => ({ name: `query_${i}`, fullName: `mcp.${i+1}.query_${i}`, description: `读取${i}`, serverType: 'external' }));
    tools.push({ name: 'render_diagram', fullName: name, description: 'Mermaid 流程图', serverType: 'external' });
    const deps = { listCachedMcpTools: async () => tools, filterMcpToolsByCapability: async items => items };
    const selected = await getChatCapabilityAvailability(actor, deps, { selectedTools: [name] });
    assert.equal(selected.tools[0].name, name);
    const ranked = await getChatCapabilityAvailability(actor, deps, { prompt: '生成 Mermaid 流程图' });
    assert.equal(ranked.tools[0].name, name);
    const excluded = await getChatCapabilityAvailability(actor, deps, { selectedTools: [name], manualAllowlist: [] });
    assert.equal(excluded.tools.length, 0);
});

test('系统 MCP 别名仅可映射当前可见的同名内置契约', async () => {
    const alias = 'mcp.12.viz.build_chart';
    const builtin = { name: 'viz.build_chart', source: 'builtin', capabilities: ['viz.render'] };
    const deps = { formatToolList: async (_u, opts) => opts.toolPolicy === 'builtin_only' ? [builtin] : [],
        listCachedMcpTools: async () => [{ name: builtin.name, fullName: alias, serverType: 'visualization' }],
        filterMcpToolsByCapability: async rows => rows,
        getAccessibleMcpServer: async () => ({ status: 'active', base_url: 'pivot-builtin://visualization' }) };
    const selected = await resolveChatSelectedTools(actor, { tools: [alias] }, null, deps);
    assert.deepEqual(selected.executionNames, [builtin.name]);
    await assert.rejects(resolveChatSelectedTools(actor, { tools: [alias] }, null, { ...deps, filterMcpToolsByCapability: async () => [] }), /无权/);
});

test('四次空搜索暂停；更换关键词和无关非空结果不会清空空搜索计数，目录或用户修订才重置', async () => {
    const state = {};
    const result = { catalogVersion: 'v1', candidates: [] };
    for (let i = 0; i < 3; i++) recordDiscoverySearch(state, { ...result, query: `词${i}` });
    recordDiscoverySearch(state, { ...result, candidates: [{ toolRef: { toolName: 'unrelated' } }] });
    let failure;
    assert.throws(() => recordDiscoverySearch(state, result), error => { failure = error; return error.code === 'TOOL_DISCOVERY_NO_PROGRESS'; });
    recordDiscoverySearch(state, { ...result, catalogVersion: 'v2' });
    assert.equal(state.searchProgress.empty, 1);
    recordDiscoverySearch(state, result, { metadata: { capabilityConstraints: { sourceMessageId: 2 } } });
    assert.equal(state.searchProgress.empty, 1);
    let patch;
    await pauseForMissingTool({ updateRun: async (_id, value) => { patch = value; }, createAgentNotification: async () => {} }, 'run', 7, failure);
    assert.equal(patch.status, 'needs_input');
});

test('审计仅提取工具定位与错误码，不导出参数秘密和自由文本', () => {
    const result = toolStepDiagnostics({ input: JSON.stringify({ toolRef: { toolName: name }, input: { api_key: 'secret' } }),
        output: { code: 'TOOL_POLICY_DENIED', toolCalls: [{ arguments: { toolRef: { toolName: 'draw.diagram' }, token: 'secret' } }], content: 'secret' } });
    assert.deepEqual(result.targets, [name, 'draw.diagram']);
    assert.equal(JSON.stringify(result).includes('secret'), false);
});

test('续接更换工具先提交授权修订再发送控制消息，并拒绝旧消息覆盖较新修订', async () => {
    let metadata = { chatBridge: { selectedTools: ['mcp.1.old'] }, capabilityConstraints: { present: true, capabilities: ['agent.execute'] } };
    const order = [];
    const deps = { listSessionTasks: async () => [{ id: 'r', status: 'running', metadata }],
        resolveChatSelectedTools: async () => ({ names: [name], executionNames: [name], tools: [diagram], origins: ['http://offline-tools:8501'], ports: [8501] }),
        updateMetadata: async (_id, transform, opts) => { assert.equal(opts.updateToolScope, true); metadata = transform(metadata); order.push('scope'); },
        sendAgentControlMessage: async () => { order.push('control'); } };
    const input = { user: actor, sessionId: 's', userMessageId: 4, routeOverrides: { tools: [name] }, decision: { continuationOf: 'r', requiredCapabilities: ['agent.execute'] } };
    await continueConversationTask(input, deps);
    assert.deepEqual(order, ['scope', 'control']);
    assert.deepEqual(metadata.chatToolScope.toolAllowlist, [name, 'chat.read_source']);
    assert.deepEqual(metadata.chatToolScope.networkPolicy.allowed_ports, [8501]);
    await assert.rejects(continueConversationTask({ ...input, userMessageId: 3 }, deps), /更新的消息/);
});
