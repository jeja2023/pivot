'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { evaluateToolPolicy, normalizeAllowlist } = require('../server/services/agent-policy');
const { filterRunToolCatalog } = require('../server/services/agent-tool-discovery-scope');
const { getBuiltInToolDefinitions } = require('../server/services/agent-tools');
const { executeToolDiscoveryMeta } = require('../server/services/agent-tools-discovery');
const { createToolDiscoveryState } = require('../server/services/agent-tool-progressive-discovery');

const user = { id: 1, role: 'user' };
const readTool = {
    name: 'orders.search', source: 'builtin', capabilities: ['data.sql.query'],
    idempotent: true, side_effect: false, input_schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] }
};
const scopedRun = {
    tool_allowlist: JSON.stringify([readTool.name]),
    metadata: {
        capabilityConstraints: { present: true, readOnly: true, capabilities: readTool.capabilities },
        skillConstraints: { present: true, reference: 'orders-skill', capabilities: readTool.capabilities, tools: [readTool.name] }
    }
};

test('policy normalizes persisted JSON allowlists consistently with catalog filtering', () => {
    assert.deepEqual(normalizeAllowlist('[]'), []);
    assert.deepEqual(normalizeAllowlist('["orders.search"]'), ['orders.search']);
    assert.deepEqual(normalizeAllowlist('orders.search,orders.search'), ['orders.search']);
    assert.equal(evaluateToolPolicy({ run: scopedRun, tool: readTool, input: { query: 'orders' } }).decision, 'allow');
});

test('business scopes allow the discovery control surface while retaining all target restrictions', () => {
    for (const tool of getBuiltInToolDefinitions(user).filter(tool => tool.name.startsWith('tools.'))) {
        const input = tool.name === 'tools.search' ? { query: '查询订单' }
            : tool.name === 'tools.batch_read' ? { calls: [{ toolRef: { toolName: readTool.name }, input: {} }] }
            : { toolRef: { toolName: readTool.name }, ...(tool.name === 'tools.execute' ? { input: {} } : {}) };
        assert.equal(evaluateToolPolicy({ run: scopedRun, tool, input }).decision, 'allow', tool.name);
    }
    assert.equal(evaluateToolPolicy({ run: scopedRun, tool: { ...readTool, name: 'other.search' }, input: { query: 'x' } }).decision, 'denied');
    assert.equal(evaluateToolPolicy({ run: scopedRun, tool: { ...readTool, side_effect: true }, input: { query: 'x' } }).decision, 'denied');
    assert.equal(evaluateToolPolicy({ run: scopedRun, tool: { ...readTool, name: 'tools.execute', source: 'mcp' }, input: {} }).decision, 'denied');
    assert.equal(evaluateToolPolicy({ run: scopedRun, tool: readTool, input: {} }).decision, 'denied', 'business parameter validation remains mandatory');
});

test('search and describe apply task and Skill scopes to targets before returning contracts', async () => {
    const forbidden = { ...readTool, name: 'other.search' };
    const context = { run: scopedRun, toolDiscoveryState: createToolDiscoveryState() };
    const deps = { toolDiscovery: { formatToolList: async () => [readTool, forbidden] } };
    const search = await executeToolDiscoveryMeta('tools.search', { query: 'orders' }, user, context, deps);
    assert.deepEqual(search.value.candidates.map(item => item.toolRef.toolName), [readTool.name]);
    assert.equal(search.value.totalAuthorizedTools, 1);
    const described = await executeToolDiscoveryMeta('tools.describe', { toolName: readTool.name }, user, context, deps);
    assert.deepEqual(described.value.inputSchema.required, ['query']);
    await assert.rejects(() => executeToolDiscoveryMeta('tools.describe', { toolName: forbidden.name }, user, context, deps), error => error.status === 404);
    const emptySkill = { ...scopedRun, metadata: { skillConstraints: { present: true, tools: [], capabilities: [] } } };
    assert.deepEqual(filterRunToolCatalog([readTool], emptySkill, user), []);
});

test('run preparation keeps discovery controls for a narrowly authorized automatic read task', async () => {
    const { createRunPreparation } = require('../server/services/agent-runtime/run-preparation');
    const definitions = getBuiltInToolDefinitions(user).filter(tool => tool.name.startsWith('tools.'));
    const preparation = createRunPreparation({
        formatToolList: async () => [...definitions.map(tool => ({ ...tool, source: 'builtin' })), readTool],
        listToolReliability: async () => ({ signals: [], days: 30 }), selectToolOrder: tools => tools,
        setRunMetadata: async () => {}, logger: { warn() {} }
    });
    const result = await preparation.prepareTools({ runId: 'scoped-read', user, run: scopedRun, runtimeMetadata: scopedRun.metadata });
    assert.deepEqual(result.plannerToolList.map(tool => tool.name), ['tools.search', 'tools.describe', 'tools.execute', 'tools.batch_read']);
    assert.equal(result.toolList.some(tool => tool.name === readTool.name), true);
});

test('the actual tool runtime can describe an allowed business tool under persisted task, read-only, and Skill constraints', async () => {
    const { formatToolList } = require('../server/services/agent-tool-catalog');
    const { executeToolByName } = require('../server/services/agent-tool-runtime');
    const tools = await formatToolList(user, { toolAllowlist: ['rag.search'], preserveDiscoveryTools: true });
    const target = tools.find(tool => tool.name === 'rag.search');
    const run = {
        tool_allowlist: '["rag.search"]',
        metadata: {
            capabilityConstraints: { present: true, readOnly: true, capabilities: target.capabilities },
            skillConstraints: { present: true, reference: 'rag-skill', capabilities: target.capabilities, tools: ['rag.search'] }
        }
    };
    const result = await executeToolByName('tools.describe', { toolName: 'rag.search' }, user, tools, { run, toolDiscoveryState: createToolDiscoveryState() });
    assert.equal(result.name, 'rag.search');
});
