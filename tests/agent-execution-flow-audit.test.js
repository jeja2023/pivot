'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { queryOne } = require('../server/db/client');
const { continueConversationTask } = require('../server/services/chat-task-continuation');
const { evaluateToolPolicy } = require('../server/services/agent-policy');
const { filterRunToolCatalog } = require('../server/services/agent-tool-discovery-scope');
const { createApprovalHelpers } = require('../server/services/agent-runtime/approvals');
const { formatToolList } = require('../server/services/agent-tool-catalog');
const { resolveProgressiveExecution } = require('../server/services/agent-progressive-execution');
const { executeToolByName } = require('../server/services/agent-tool-runtime');
const { describeToolForUser, toolRef } = require('../server/services/tool-discovery');
const { createToolDiscoveryState, rememberSearch, rememberDescription } = require('../server/services/agent-tool-progressive-discovery');
const { TaskBudget } = require('../server/services/agent-budget');

function approvalHelpers() {
    return createApprovalHelpers({ getRunMetadata: run => run.metadata || {}, normalizeApprovalPolicy: value => value || 'safe_mcp_auto' });
}

test('continuing a conversation retains task-bound source access without retaining unrelated old business capabilities', async () => {
    const metadata = { chatBridge: { userMessageId: 10 }, capabilityConstraints: { present: true, capabilities: ['conversation.read_source', 'filesystem.write_workspace'] } };
    let revised;
    await continueConversationTask({ user: { id: 1 }, sessionId: 'session', userMessageId: 11, sourceContent: '补充资料', instruction: '这次仅查询订单',
        decision: { continuationOf: 'run', objective: '查询订单', requiredCapabilities: ['data.sql.query'] } }, {
        listSessionTasks: async () => [{ id: 'run', status: 'running', metadata }], sendAgentControlMessage: async () => {},
        updateMetadata: async (_id, patch) => { revised = patch(metadata); }
    });
    assert.ok(revised.capabilityConstraints.capabilities.includes('conversation.read_source'));
    assert.ok(revised.capabilityConstraints.capabilities.includes('data.sql.query'));
    assert.equal(revised.capabilityConstraints.capabilities.includes('filesystem.write_workspace'), false);
});

const databaseTool = {
    name: 'db.run_readonly_query', source: 'mcp', databaseTool: true,
    capabilities: ['data.sql.query'], idempotent: true, network: false, risk: 'low',
    input_schema: { type: 'object', properties: { connectionId: { type: 'string' }, sql: { type: 'string' } }, required: ['connectionId', 'sql'] },
    databaseConnections: [1, 2].map(id => ({ serverId: String(id), connectionId: String(id), fullName: `mcp.${id}.db.run_readonly_query` }))
};

test('a concrete database allowlist exposes its generic tool and only the permitted connection', () => {
    const run = { tool_allowlist: '["mcp.1.db.run_readonly_query"]' };
    const candidates = filterRunToolCatalog([databaseTool], run, { id: 1 });
    assert.equal(candidates.length, 1);
    assert.deepEqual(candidates[0].databaseConnections.map(connection => connection.serverId), ['1']);
    assert.equal(evaluateToolPolicy({ run, tool: databaseTool, input: { connectionId: '1', sql: 'select 1' } }).decision, 'allow');
    assert.equal(evaluateToolPolicy({ run, tool: databaseTool, input: { connectionId: '2', sql: 'select 1' }, allowApproval: true }).decision, 'denied');
    const skillRun = { metadata: { skillConstraints: { present: true, tools: ['mcp.1.db.run_readonly_query'], capabilities: ['data.sql.query'] } } };
    assert.deepEqual(filterRunToolCatalog([databaseTool], skillRun).map(tool => tool.databaseConnections.length), [1]);
    assert.equal(evaluateToolPolicy({ run: skillRun, tool: databaseTool, input: { connectionId: '1', sql: 'select 1' } }).decision, 'allow');
    assert.equal(evaluateToolPolicy({ run: skillRun, tool: databaseTool, input: { connectionId: '2', sql: 'select 1' } }).decision, 'denied');
});

test('discovery refresh honors newly narrowed and revoked conversation scope instead of the executor snapshot', async () => {
    const { refreshDiscoveryScope } = require('../server/services/agent-tool-discovery-scope');
    const old = { id: 'run', metadata: { capabilityConstraints: { present: true, capabilities: ['filesystem.write_workspace'] } } };
    await refreshDiscoveryScope(old, { id: 1 }, { currentExecutionScope: async () => ({ status: 'running', source_active: true,
        metadata: { capabilityConstraints: { present: true, capabilities: ['data.sql.query'] } } }) });
    assert.deepEqual(old.metadata.capabilityConstraints.capabilities, ['data.sql.query']);
    await assert.rejects(() => refreshDiscoveryScope(old, { id: 1 }, { currentExecutionScope: async () => ({ status: 'needs_input', source_active: true }) }), error => error.code === 'AGENT_DISCOVERY_SCOPE_REVOKED');
});

test('approval preflight agrees with the policy engine for explicit builtin and API-operation requirements', () => {
    const helpers = approvalHelpers();
    for (const source of ['builtin', 'api_operation', 'mcp']) {
        const tool = { name: `${source}.sensitive_action`, source, approval_required: true, input_schema: { type: 'object' } };
        const run = { approval_policy: 'safe_mcp_auto' };
        assert.equal(evaluateToolPolicy({ run, tool, input: {} }).decision, 'require_approval');
        assert.equal(helpers.shouldPauseForApproval(run, tool, '', {}), true, source);
    }
});

test('a parameterless discovered tool accepts the same omitted input that its public meta contract allows', async () => {
    const user = await queryOne('SELECT * FROM users ORDER BY id LIMIT 1');
    const tools = await formatToolList(user, { toolAllowlist: ['models.list'], preserveDiscoveryTools: true });
    const reference = toolRef(tools.find(tool => tool.name === 'models.list'));
    const state = createToolDiscoveryState();
    rememberSearch(state, { candidates: [{ toolRef: reference }] });
    rememberDescription(state, reference);
    const input = { toolRef: reference };
    const resolved = await resolveProgressiveExecution({ toolName: 'tools.execute', input, user, toolList: tools, state });
    assert.deepEqual(resolved.approvalInput, {});
});

test('a discovered business invocation consumes one tool budget rather than charging the routing wrapper again', async () => {
    const user = await queryOne('SELECT * FROM users ORDER BY id LIMIT 1');
    const tools = await formatToolList(user, { toolAllowlist: ['models.list'], preserveDiscoveryTools: true });
    const target = tools.find(tool => tool.name === 'models.list');
    const reference = toolRef(target);
    const state = createToolDiscoveryState();
    rememberSearch(state, { candidates: [{ toolRef: reference }] });
    rememberDescription(state, reference, await describeToolForUser(user, reference));
    const budget = new TaskBudget({ max_tool_calls: 1 });
    const output = await executeToolByName('tools.execute', { toolRef: reference, input: {} }, user, tools, {
        run: { tool_allowlist: '["models.list"]' }, toolDiscoveryState: state, budget
    });
    assert.ok(Array.isArray(output));
    assert.equal(budget.counts.tool_calls, 1);
    assert.equal(budget.counts.risk, target.risk_level);
});
