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
const { describeToolForUser, executeDiscoveredTool, searchToolsForUser } = require('../server/services/tool-discovery');
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
        () => executeReadOnlyDiscoveredBatch({ id: 1 }, [{ toolRef: unsafe, input: {} }], { toolDiscoveryState: state }, { toolDiscovery: { describeToolForUser: async () => ({ name: 'orders.write', sideEffect: true }), executeDiscoveredTool: async () => null } }),
        error => error.code === 'TOOL_BATCH_READ_FORBIDDEN'
    );
});

test('batch reads recheck current authorization even when a safe description was remembered', async () => {
    const state = createToolDiscoveryState();
    const reference = { toolName: 'orders.search', releaseId: 1, definitionDigest: 'digest' };
    rememberSearch(state, { candidates: [{ toolRef: reference }] });
    rememberDescription(state, reference, { toolRef: reference, name: reference.toolName, idempotent: true, sideEffect: false, concurrency: 'read' });
    let executed = false;
    await assert.rejects(
        () => executeReadOnlyDiscoveredBatch({ id: 1 }, [{ toolRef: reference, input: {} }], { toolDiscoveryState: state }, {
            toolDiscovery: {
                describeToolForUser: async () => { throw Object.assign(new Error('access revoked'), { code: 'ACCESS_REVOKED' }); },
                executeDiscoveredTool: async () => { executed = true; }
            }
        }),
        error => error.code === 'ACCESS_REVOKED'
    );
    assert.equal(executed, false);
});

test('批量预检共用一次目录快照，实际执行仍分别重新核验', async () => {
    const { toolRef } = require('../server/services/tool-discovery');
    const state = createToolDiscoveryState();
    const tools = [{ ...exampleTool, name: 'orders.search' }, { ...exampleTool, name: 'orders.summary' }];
    const refs = tools.map(toolRef);
    rememberSearch(state, { candidates: refs.map(ref => ({ toolRef: ref })) });
    refs.forEach(ref => rememberDescription(state, ref, { toolRef: ref, name: ref.toolName, idempotent: true, sideEffect: false, concurrency: 'read' }));
    let catalogReads = 0;
    let executions = 0;
    const result = await executeReadOnlyDiscoveredBatch({ id: 1 }, refs.map(ref => ({ toolRef: ref, input: {} })), { toolDiscoveryState: state }, {
        toolDiscovery: {
            formatToolList: async () => { catalogReads += 1; return tools; },
            executeDiscoveredTool: async () => { executions += 1; return 'ok'; }
        }
    });
    assert.equal(result.count, 2);
    assert.equal(catalogReads, 1);
    assert.equal(executions, 2);
});

test('batch reads refuse a tool that becomes unsafe before dispatch', async () => {
    const state = createToolDiscoveryState();
    const reference = { toolName: 'orders.search', releaseId: null, definitionDigest: 'fixed' };
    rememberSearch(state, { candidates: [{ toolRef: reference }] });
    rememberDescription(state, reference, { toolRef: reference, name: reference.toolName, idempotent: true, sideEffect: false, concurrency: 'read' });
    let executed = false;
    await assert.rejects(
        () => executeReadOnlyDiscoveredBatch({ id: 1 }, [{ toolRef: reference, input: {} }], { toolDiscoveryState: state }, {
            toolDiscovery: {
                describeToolForUser: async () => ({ name: reference.toolName, idempotent: true, sideEffect: false, concurrency: 'read' }),
                executeDiscoveredTool,
                formatToolList: async () => [{ ...exampleTool, definitionDigest: 'fixed', side_effect: true }],
                executeToolByName: async () => { executed = true; }
            }
        }),
        error => error.code === 'TOOL_BATCH_READ_FORBIDDEN'
    );
    assert.equal(executed, false);
});

test('discovered execution validates and dispatches against the same authorized catalog snapshot', async () => {
    let catalogReads = 0;
    const catalog = [{ ...exampleTool, definitionDigest: 'fixed' }];
    const result = await executeDiscoveredTool({ id: 1 }, {
        toolRef: { toolName: exampleTool.name, definitionDigest: 'fixed' }, input: {}
    }, {}, {
        formatToolList: async () => { catalogReads += 1; return catalog; },
        executeToolByName: async (_name, _input, _user, actualTools) => {
            assert.equal(actualTools, catalog);
            return 'ok';
        }
    });
    assert.equal(result, 'ok');
    assert.equal(catalogReads, 1);
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

test('discovery state expires search and description together, requiring a new current catalog lookup', () => {
    let now = 10_000;
    const state = createToolDiscoveryState({ ttlMs: 1_000, now: () => now });
    const reference = { toolName: 'orders.search', releaseId: 3, definitionDigest: 'digest-v1' };
    rememberSearch(state, { catalogVersion: 'catalog-v1', candidates: [{ toolRef: reference }] });
    rememberDescription(state, reference, { toolRef: reference, name: reference.toolName });
    assert.doesNotThrow(() => assertDescribed(state, reference));
    now += 1_000;
    assert.throws(() => assertDescribed(state, reference), error => error.code === 'TOOL_DISCOVERY_SEARCH_EXPIRED');
    assert.throws(() => assertSearched(state, reference), error => error.code === 'TOOL_DISCOVERY_SEARCH_REQUIRED');
});

test('a changed authorization or release catalog version invalidates remembered discovery references', () => {
    const state = createToolDiscoveryState();
    const oldReference = { toolName: 'orders.search', releaseId: 1, definitionDigest: 'digest-v1' };
    const currentReference = { toolName: 'orders.search', releaseId: 2, definitionDigest: 'digest-v2' };
    rememberSearch(state, { catalogVersion: 'catalog-v1', candidates: [{ toolRef: oldReference }] });
    rememberDescription(state, oldReference, { toolRef: oldReference, name: oldReference.toolName });
    rememberSearch(state, { catalogVersion: 'catalog-v2', candidates: [{ toolRef: currentReference }] });
    assert.throws(() => assertSearched(state, oldReference), error => error.code === 'TOOL_DISCOVERY_SEARCH_REQUIRED');
    assert.doesNotThrow(() => assertSearched(state, currentReference));
    assert.throws(() => assertDescribed(state, currentReference), error => error.code === 'TOOL_DISCOVERY_DESCRIBE_REQUIRED');
});

test('search cache is scoped by current authorization catalog and TTL, never by a stale result alone', async () => {
    const cache = new Map();
    let now = 20_000;
    let rankings = 0;
    let currentTool = { ...exampleTool, catalogReleaseId: 1, definitionDigest: 'release-v1' };
    const deps = {
        formatToolList: async () => [currentTool],
        rankTools: (query, tools, filters) => {
            rankings += 1;
            return require('../server/services/tool-discovery').rankTools(query, tools, filters);
        }
    };
    const options = { discoveryCache: cache, cacheTtlMs: 1_000, now: () => now };
    const first = await searchToolsForUser({ id: 7, role: 'user' }, { query: '查询订单' }, deps, options);
    const second = await searchToolsForUser({ id: 7, role: 'user' }, { query: '查询订单' }, deps, options);
    assert.equal(rankings, 1, '同一授权/发布摘要和 TTL 内应复用搜索结果');
    assert.equal(second.catalogVersion, first.catalogVersion);
    currentTool = { ...currentTool, catalogReleaseId: 2, definitionDigest: 'release-v2' };
    const updated = await searchToolsForUser({ id: 7, role: 'user' }, { query: '查询订单' }, deps, options);
    assert.equal(rankings, 2, '发布摘要变化必须绕过旧缓存');
    assert.notEqual(updated.catalogVersion, first.catalogVersion);
    assert.equal(updated.candidates[0].toolRef.definitionDigest, 'release-v2');
    now += 1_000;
    await searchToolsForUser({ id: 7, role: 'user' }, { query: '查询订单' }, deps, options);
    assert.equal(rankings, 3, 'TTL 到期后必须重算搜索结果');
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

test('describe rejects a changed release even when the definition digest is unchanged', async () => {
    const deps = { formatToolList: async () => [{ ...exampleTool, catalogReleaseId: 2 }] };
    const found = await searchToolsForUser({ id: 1 }, { query: '查询订单' }, deps);
    await assert.rejects(
        () => describeToolForUser({ id: 1 }, { ...found.candidates[0].toolRef, releaseId: 1 }, deps),
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

test('candidate toolRef can be resolved by toolName when definitionDigest is omitted by model', () => {
    const { createToolDiscoveryState, rememberSearch, assertSearched, assertDescribed, rememberDescription } = require('../server/services/agent-tool-progressive-discovery');
    const state = createToolDiscoveryState();
    const canonicalRef = { toolName: 'web_search', releaseId: 5, definitionDigest: 'sha256-full-digest-abc' };
    rememberSearch(state, { candidates: [{ toolRef: canonicalRef }] });

    // Model only passes toolName without digest or releaseId
    const callerRef = { toolName: 'web_search' };
    assert.doesNotThrow(() => assertSearched(state, callerRef));
    // Verify canonical release and digest are auto-populated
    assert.equal(callerRef.releaseId, 5);
    assert.equal(callerRef.definitionDigest, 'sha256-full-digest-abc');

    // Model calls describe and remembers description
    rememberDescription(state, callerRef, { name: 'web_search', inputSchema: {} });
    assert.doesNotThrow(() => assertDescribed(state, { toolName: 'web_search' }));
});

test('executeToolDiscoveryMeta gracefully auto-searches authorized catalog if tools.describe is called directly', async () => {
    const { executeToolDiscoveryMeta } = require('../server/services/agent-tools-discovery');
    const { createToolDiscoveryState } = require('../server/services/agent-tool-progressive-discovery');
    const state = createToolDiscoveryState();
    const context = { toolDiscoveryState: state, run: { toolPolicy: 'all' } };
    const user = { id: 1, role: 'user' };

    // Direct describe call with { toolName: 'rag.search' } without calling tools.search first
    const result = await executeToolDiscoveryMeta('tools.describe', { toolName: 'rag.search' }, user, context);
    assert.equal(result.handled, true);
    assert.equal(result.value.name, 'rag.search');
    assert.ok(result.value.toolRef.definitionDigest);

    // After describe, assertDescribed passes for subsequent tools.execute
    const { assertDescribed } = require('../server/services/agent-tool-progressive-discovery');
    assert.doesNotThrow(() => assertDescribed(state, { toolName: 'rag.search' }));
});

test('streaming payload extractor safely handles empty choices array without delta crash', () => {
    const { extractStreamPayload } = require('../server/streaming');
    // Frame with choices: [] which triggered TypeError: Cannot read properties of undefined (reading 'delta')
    const frameWithEmptyChoices = { id: 'chatcmpl-123', choices: [], usage: { total_tokens: 10 } };
    assert.doesNotThrow(() => {
        const payload = extractStreamPayload(frameWithEmptyChoices);
        assert.equal(payload.delta, '');
        assert.equal(payload.isThought, false);
    });
});

