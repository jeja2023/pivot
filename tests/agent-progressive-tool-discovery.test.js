'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
    assertDescribed,
    assertSearched,
    buildProgressivePlannerToolList,
    createToolDiscoveryState,
    referenceKey,
    rememberDescription,
    rememberSearch
} = require('../server/services/agent-tool-progressive-discovery');
const { describeToolForUser, searchToolsForUser } = require('../server/services/tool-discovery');
const { executeToolByName } = require('../server/services/agent-tool-runtime');
const { formatToolList } = require('../server/services/agent-tool-catalog');

const exampleTool = {
    name: 'orders.search', title: '订单查询', description: '查询订单信息', source: 'builtin',
    capabilities: ['data.sql.query'], input_schema: { type: 'object', properties: { q: { type: 'string' } } },
    output_schema: { type: 'object', properties: { rows: { type: 'array' } } }, idempotent: true
};

test('progressive planner publishes only discovery meta tools', () => {
    const list = buildProgressivePlannerToolList([
        { name: 'tools.search', description: 'search' }, { name: 'tools.describe', description: 'describe' },
        { name: 'tools.execute', description: 'execute' }, exampleTool
    ]);
    assert.deepEqual(list.map(item => item.name), ['tools.search', 'tools.describe', 'tools.execute']);
    assert.match(list[0].description, /search → describe → execute/);
});

test('discovery state refuses describe and execute when the required preceding step is absent', () => {
    const state = createToolDiscoveryState();
    const reference = { toolName: 'orders.search', releaseId: null, definitionDigest: 'digest' };
    assert.throws(() => assertSearched(state, reference), error => error.code === 'TOOL_DISCOVERY_SEARCH_REQUIRED');
    rememberSearch(state, { candidates: [{ toolRef: reference }] });
    assert.doesNotThrow(() => assertSearched(state, reference));
    assert.throws(() => assertDescribed(state, reference), error => error.code === 'TOOL_DISCOVERY_DESCRIBE_REQUIRED');
    rememberDescription(state, reference);
    assert.doesNotThrow(() => assertDescribed(state, reference));
    assert.equal(referenceKey(reference), 'orders.search||digest');
});

test('search returns compact references and describe rejects a changed contract digest', async () => {
    const deps = { formatToolList: async () => [exampleTool] };
    const found = await searchToolsForUser({ id: 1 }, { query: '查询订单' }, deps);
    assert.equal(found.candidates.length, 1);
    const reference = found.candidates[0].toolRef;
    const described = await describeToolForUser({ id: 1 }, reference, deps);
    assert.equal(described.name, 'orders.search');
    await assert.rejects(
        () => describeToolForUser({ id: 1 }, { ...reference, definitionDigest: 'stale' }, deps),
        error => error.code === 'TOOL_REFERENCE_STALE'
    );
});

test('autonomous runtime rejects a direct non-meta tool before policy evaluation', async () => {
    await assert.rejects(
        () => executeToolByName('orders.search', {}, { id: 1 }, [], { autonomous: true, plannerToolNames: new Set(['tools.search', 'tools.describe', 'tools.execute']) }),
        error => error.code === 'TOOL_DISCOVERY_REQUIRED'
    );
});

test('narrow tool allowlists retain only the safe discovery control surface plus the named business tool', async () => {
    const tools = await formatToolList({ id: 1, role: 'user' }, { toolAllowlist: ['rag.search'] });
    const names = new Set(tools.map(tool => tool.name));
    assert.equal(names.has('tools.search'), true);
    assert.equal(names.has('tools.describe'), true);
    assert.equal(names.has('tools.execute'), true);
    assert.equal(names.has('rag.search'), true);
    assert.equal(names.has('agent.http'), false);
});

test('both Agent execution paths keep full catalog execution behind the progressive planner surface', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const root = path.resolve(__dirname, '..');
    const standard = fs.readFileSync(path.join(root, 'server/services/agent-runtime/run-execution.js'), 'utf8');
    const streaming = fs.readFileSync(path.join(root, 'server/services/agent-streaming-runtime.js'), 'utf8');
    assert.match(standard, /plannerToolList/);
    assert.match(standard, /resolveProgressiveExecution/);
    assert.match(streaming, /plannerToolList = toolList/);
    assert.match(streaming, /resolveProgressiveExecution/);
    assert.match(streaming, /toolDiscoveryState/);
});
