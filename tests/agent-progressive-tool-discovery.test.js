'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
    assertDescribed,
    assertSearched,
    buildProgressivePlannerToolList,
    createToolDiscoveryState,
    getRememberedDescription,
    referenceKey,
    rememberDescription,
    rememberSearch
} = require('../server/services/agent-tool-progressive-discovery');
const { executeReadOnlyDiscoveredBatch } = require('../server/services/agent-tools-discovery');
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
        { name: 'tools.execute', description: 'execute' }, { name: 'tools.batch_read', description: 'batch' }, exampleTool
    ]);
    assert.deepEqual(list.map(item => item.name), ['tools.search', 'tools.describe', 'tools.execute', 'tools.batch_read']);
    assert.match(list[0].description, /search → describe → execute/);
});

test('discovered batch read runs only described idempotent reads and preserves result order', async () => {
    const state = createToolDiscoveryState();
    const first = { toolName: 'orders.search', releaseId: 1, definitionDigest: 'first' };
    const second = { toolName: 'orders.summary', releaseId: 1, definitionDigest: 'second' };
    rememberSearch(state, { candidates: [{ toolRef: first }, { toolRef: second }] });
    const descriptions = new Map([
        [first.definitionDigest, { toolRef: first, name: 'orders.search', idempotent: true, sideEffect: false, concurrency: 'read', requiresApproval: false }],
        [second.definitionDigest, { toolRef: second, name: 'orders.summary', idempotent: true, sideEffect: false, concurrency: 'read', requiresApproval: false }]
    ]);
    rememberDescription(state, first, descriptions.get(first.definitionDigest));
    rememberDescription(state, second, descriptions.get(second.definitionDigest));
    const value = await executeReadOnlyDiscoveredBatch({ id: 1 }, [
        { toolRef: first, input: { q: 'a' } }, { toolRef: second, input: { q: 'b' } }
    ], { toolDiscoveryState: state }, {
        toolDiscovery: {
            describeToolForUser: async (_user, reference) => descriptions.get(reference.definitionDigest),
            executeDiscoveredTool: async (_user, input) => ({ value: input.input.q })
        }
    });
    assert.equal(value.count, 2);
    assert.deepEqual(value.results.map(item => item.output.value), ['a', 'b']);
    const unsafe = { toolName: 'orders.write', releaseId: 1, definitionDigest: 'unsafe' };
    rememberSearch(state, { candidates: [{ toolRef: unsafe }] });
    rememberDescription(state, unsafe, { toolRef: unsafe, name: 'orders.write', idempotent: false, sideEffect: true, concurrency: 'exclusive', requiresApproval: true });
    await assert.rejects(
        () => executeReadOnlyDiscoveredBatch({ id: 1 }, [{ toolRef: unsafe, input: {} }], { toolDiscoveryState: state }, { toolDiscovery: { describeToolForUser: async () => null, executeDiscoveredTool: async () => null } }),
        error => error.code === 'TOOL_BATCH_READ_FORBIDDEN'
    );
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

test('described contracts are cached only inside the current discovery state', () => {
    const reference = { toolName: 'orders.search', releaseId: 3, definitionDigest: 'digest-v1' };
    const first = createToolDiscoveryState();
    const contract = { toolRef: reference, name: 'orders.search', inputSchema: { type: 'object' } };
    rememberDescription(first, reference, contract);
    assert.equal(getRememberedDescription(first, reference), contract);
    assert.equal(getRememberedDescription(createToolDiscoveryState(), reference), null);
    assert.equal(getRememberedDescription(first, { ...reference, definitionDigest: 'digest-v2' }), null);
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

test('narrow tool allowlists retain only the safe discovery control surface plus the named business tool when preserveDiscoveryTools is true', async () => {
    const tools = await formatToolList({ id: 1, role: 'user' }, { toolAllowlist: ['rag.search'], preserveDiscoveryTools: true });
    const names = new Set(tools.map(tool => tool.name));
    assert.equal(names.has('tools.search'), true);
    assert.equal(names.has('tools.describe'), true);
    assert.equal(names.has('tools.execute'), true);
    assert.equal(names.has('tools.batch_read'), true);
    assert.equal(names.has('rag.search'), true);
    assert.equal(names.has('agent.http'), false);

    const scopedWithoutDiscovery = await formatToolList({ id: 1, role: 'user' }, { toolAllowlist: ['rag.search'] });
    assert.deepEqual(scopedWithoutDiscovery.map(tool => tool.name), ['rag.search']);
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
