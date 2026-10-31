'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { resolveChatSelectedTools } = require('../server/services/chat-selected-tools');
const { toolMatchesAllowlist, narrowDatabaseConnections } = require('../server/services/agent-tool-identities');
const { filterRunToolCatalog } = require('../server/services/agent-tool-discovery-scope');
const { evaluateToolPolicy } = require('../server/services/agent-policy');
const { executeToolDiscoveryMeta } = require('../server/services/agent-tools-discovery');
const { createToolDiscoveryState } = require('../server/services/agent-tool-progressive-discovery');

const user = { id: 7, role: 'user' };
const diagram = { name: 'mcp.89.render_diagram', source: 'mcp', title: '离线绘图', capabilities: ['network.request'], network: true,
    risk_level: 3, input_schema: { type: 'object', properties: { source: { type: 'string' } }, required: ['source'] } };
const local = { name: 'mcp.0.workspace.read', source: 'mcp', capabilities: ['filesystem.read_workspace'], network: false };
const database = { name: 'db.run_readonly_query', source: 'mcp', databaseTool: true, capabilities: ['data.sql.query'], network: false,
    databaseConnections: [90, 91].map(id => ({ serverId: String(id), fullName: `mcp.${id}.db.run_readonly_query` })), input_schema: { type: 'object' } };

function dependencies(tools = [diagram, local, database], servers = {}) {
    return {
        formatToolList: async (_user, options) => tools.map(tool => narrowDatabaseConnections(tool, [options.toolAllowlist]))
            .filter(tool => tool && toolMatchesAllowlist(tool, options.toolAllowlist, {}, true)),
        getAccessibleMcpServer: async id => Object.hasOwn(servers, id) ? servers[id] : ({ status: 'active', base_url: id === 89 ? 'http://offline-tools:8501/mcp' : 'pivot-db://connection' })
    };
}

function handoff(deps = dependencies()) {
    const module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../server/services/chat-agent-handoff.js'), 'utf8'), {
        module, URL, require(name) {
            if (name === './chat-selected-tools') return { resolveChatSelectedTools: (actor, overrides, allowed) => resolveChatSelectedTools(actor, overrides, allowed, deps) };
            if (name === './chat-preference-context') return { resolveChatProject: async () => ({ projectId: null }) };
            if (name === './chat-agent-bridge') return { normalizeChatHistory: rows => rows, prepareChatAgentContext: async () => ({}), buildChatAgentMetadata: input => ({ chatHistory: [], chatBridge: { mcpEnabled: input.mcpEnabled, mcpToolAllowlist: input.mcpToolAllowlist } }) };
            return name.startsWith('./') ? require(path.join(__dirname, '../server/services', name)) : require(name);
        }
    });
    return async (options = {}) => {
        let payload;
        await module.exports.createChatAgentHandoff({ user, userId: user.id, sessionId: 'selection-test', userMessageId: 2,
            visibleContent: '@绘图 生成流程图', modelContent: '@绘图 生成流程图', modelCfg: { id: 3 },
            routeOverrides: { tools: [diagram.name] }, automaticExecution: { action: 'agent_run', requiredCapabilities: ['agent.execute'] }, ...options,
            agentRunFactory: async input => { payload = input; return { id: 'run' }; } });
        return JSON.parse(JSON.stringify(payload));
    };
}

test('混合选择保留外部、本机与指定数据库连接，不整组丢弃', async () => {
    const names = [diagram.name, local.name, 'mcp.90.db.run_readonly_query'];
    const selected = await resolveChatSelectedTools(user, { tools: names }, null, dependencies());
    assert.deepEqual(selected.names, names);
    assert.equal(selected.tools.length, 3);
    assert.deepEqual(selected.origins, ['http://offline-tools:8501']);
    assert.deepEqual(selected.ports, [8501]);
    assert.deepEqual(selected.tools[2].databaseConnections.map(connection => connection.serverId), ['90']);
});

test('选择必须属于当前用户目录、手动白名单和活动服务，不能部分丢弃后扩大范围', async () => {
    await assert.rejects(resolveChatSelectedTools(user, { tools: [diagram.name] }, [], dependencies()), /允许范围/);
    await assert.rejects(resolveChatSelectedTools(user, { tools: [diagram.name], excludedTools: [diagram.name] }, null, dependencies()), /允许范围/);
    await assert.rejects(resolveChatSelectedTools(user, { tools: [diagram.name] }, null, dependencies([])), /无权使用/);
    await assert.rejects(resolveChatSelectedTools(user, { tools: [diagram.name] }, null, dependencies([diagram], { 89: null })), /不可用/);
    await assert.rejects(resolveChatSelectedTools(user, { tools: [diagram.name] }, null, dependencies([diagram], { 89: { status: 'paused' } })), /不可用/);
    assert.deepEqual((await resolveChatSelectedTools(user, { tools: [diagram.name], excludeTools: true }, null, dependencies())).names, []);
});

test('会话交接到真实搜索与描述链路可见所选工具，审批和其他工具边界仍生效', async () => {
    const payload = await handoff()();
    const run = { tool_policy: payload.toolPolicy, tool_allowlist: payload.toolAllowlist, network_policy: payload.networkPolicy, metadata: payload.metadata };
    const context = { run, toolDiscoveryState: createToolDiscoveryState() };
    const other = { ...diagram, name: 'mcp.89.other' };
    const deps = { toolDiscovery: { formatToolList: async () => [diagram, other] } };
    const searched = await executeToolDiscoveryMeta('tools.search', { query: 'render_diagram' }, user, context, deps);
    assert.deepEqual(searched.value.candidates.map(item => item.toolRef.toolName), [diagram.name]);
    const described = await executeToolDiscoveryMeta('tools.describe', { toolRef: searched.value.candidates[0].toolRef }, user, context, deps);
    assert.equal(described.value.name, diagram.name);
    assert.equal(evaluateToolPolicy({ run, tool: { ...diagram, risk_level: 4 }, input: { source: 'graph LR;A-->B' }, user }).decision, 'require_approval');
    assert.equal(evaluateToolPolicy({ run, tool: other, input: { source: 'graph LR;A-->B' }, user }).decision, 'denied');
    assert.deepEqual(filterRunToolCatalog([diagram], { ...run, metadata: { ...run.metadata, skillConstraints: { present: true, capabilities: [], tools: [] } } }, user), []);
    const { validateNetworkPolicyUrl } = require('../server/services/agent-network-policy');
    assert.doesNotThrow(() => validateNetworkPolicyUrl('http://offline-tools:8501/mcp', run.network_policy, { requireAllowlist: true }));
    assert.throws(() => validateNetworkPolicyUrl('http://other:8501/mcp', run.network_policy, { requireAllowlist: true }));
    assert.throws(() => validateNetworkPolicyUrl('http://offline-tools:8000/mcp', run.network_policy, { requireAllowlist: true }));
    assert.ok(payload.metadata.chatHistory.some(item => item.content.includes(diagram.name)));
});

test('显式模式也保留选择，全局排除工具不能被模型建议重新开启', async () => {
    const explicit = await handoff()({ automaticExecution: null });
    assert.ok(explicit.toolAllowlist.includes(diagram.name));
    assert.deepEqual(explicit.networkPolicy.allowed_ports, [8501]);
    const excluded = await handoff()({ routeOverrides: { tools: [diagram.name], excludeTools: true }, mcpEnabled: true,
        automaticExecution: { action: 'agent_run', allowMcp: true, requiredCapabilities: ['network.request'] } });
    assert.equal(excluded.toolPolicy, 'builtin_only');
    assert.equal(excluded.networkPolicy.enabled, false);
});

test('续接重新验证所选工具并保留必要能力，撤权或禁用后不恢复旧授权', async () => {
    const { continueConversationTask } = require('../server/services/chat-task-continuation');
    const payload = await handoff()();
    let metadata = payload.metadata;
    const run = { id: 'run', status: 'running', goal: '生成流程图', metadata };
    const deps = { listSessionTasks: async () => [run], sendAgentControlMessage: async () => {},
        updateMetadata: async (_id, patch) => { metadata = patch(metadata); },
        resolveChatSelectedTools: (actor, overrides, allowed) => resolveChatSelectedTools(actor, overrides, allowed, dependencies()) };
    const input = { user, sessionId: 'selection-test', userMessageId: 3, instruction: '继续生成', decision: {
        continuationOf: 'run', objective: run.goal, requiredCapabilities: ['agent.execute']
    } };
    await continueConversationTask(input, deps);
    assert.ok(metadata.capabilityConstraints.capabilities.includes('network.request'));
    await assert.rejects(continueConversationTask(input, { ...deps, resolveChatSelectedTools: async () => { throw new Error('工具授权已撤销'); } }), /撤销/);
    run.metadata = { ...metadata, routeCorrection: { routeOverrides: { excludeTools: true } }, capabilityConstraints: { present: true, capabilities: [] } };
    metadata = run.metadata;
    await continueConversationTask(input, { ...deps, resolveChatSelectedTools: async () => { throw new Error('不应加载已排除工具'); } });
    assert.equal(metadata.capabilityConstraints.capabilities.includes('network.request'), false);
});
