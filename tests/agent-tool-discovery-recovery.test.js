'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { executeToolDiscoveryMeta } = require('../server/services/agent-tools-discovery');
const {
    assertDescribed, createToolDiscoveryState, getRememberedDescription,
    rememberDescription, rememberSearch
} = require('../server/services/agent-tool-progressive-discovery');
const { toolRef } = require('../server/services/tool-discovery');

const originalTool = {
    name: 'orders.search', source: 'mcp', catalogReleaseId: 10, definitionDigest: 'contract-v1',
    input_schema: { type: 'object', properties: { query: { type: 'string' } } },
    idempotent: true, side_effect: false, concurrency: 'read'
};

test('fallback contract digests detect execution and approval changes while ignoring object key order', async () => {
    const builtin = { ...originalTool, source: 'builtin', definitionDigest: undefined, catalogReleaseId: null };
    const reference = toolRef(builtin);
    const current = { ...builtin, side_effect: true, approval_required: true };
    assert.notEqual(toolRef(current).definitionDigest, reference.definitionDigest);
    const { executeDiscoveredTool } = require('../server/services/tool-discovery');
    let executed = false;
    await assert.rejects(() => executeDiscoveredTool({ id: 1 }, { toolRef: reference, input: {} }, {}, {
        formatToolList: async () => [current], executeToolByName: async () => { executed = true; }
    }), error => error.code === 'TOOL_REFERENCE_STALE' && error.referenceRejected === true);
    assert.equal(executed, false);
    const reordered = { ...builtin, input_schema: { properties: { query: { type: 'string' } }, type: 'object' } };
    assert.equal(toolRef(reordered).definitionDigest, reference.definitionDigest);
});

function searchedState(tool = originalTool, options = {}) {
    const state = createToolDiscoveryState(options);
    const reference = toolRef(tool);
    rememberSearch(state, { candidates: [{ toolRef: reference }] });
    rememberDescription(state, reference, { toolRef: reference, name: tool.name });
    return state;
}

function catalogDependency(tools, checkOptions = () => {}) {
    let reads = 0;
    return {
        get reads() { return reads; },
        toolDiscovery: {
            formatToolList: async (_user, options) => {
                reads += 1;
                checkOptions(options);
                return tools;
            }
        }
    };
}

test('the real tools.describe runtime recovers a model-supplied stale release instead of surfacing the production error', async () => {
    const user = { id: 1, role: 'user' };
    const { formatToolList } = require('../server/services/agent-tool-catalog');
    const { executeToolByName } = require('../server/services/agent-tool-runtime');
    const toolList = await formatToolList(user, { toolPolicy: 'builtin_only', toolAllowlist: ['rag.search'], preserveDiscoveryTools: true });
    const currentRef = toolRef(toolList.find(tool => tool.name === 'rag.search'));
    const staleRef = { ...currentRef, releaseId: 999 };
    const state = createToolDiscoveryState();
    rememberSearch(state, { candidates: [{ toolRef: staleRef }] });
    const result = await executeToolByName('tools.describe', { toolRef: staleRef }, user, toolList, {
        toolDiscoveryState: state,
        run: { tool_policy: 'builtin_only', approval_policy: 'auto' }
    });
    assert.deepEqual(result.toolRef, currentRef);
    assert.equal(result.referenceRefresh.reason, 'TOOL_REFERENCE_STALE');
    assert.doesNotThrow(() => assertDescribed(state, { ...currentRef }));
    const repeated = await executeToolByName('tools.describe', { toolRef: currentRef }, user, toolList, {
        toolDiscoveryState: state,
        run: { tool_policy: 'builtin_only', approval_policy: 'auto' }
    });
    assert.deepEqual(repeated.toolRef, currentRef, 'a builtin reference with releaseId:null must pass the real input policy');
    assert.equal(repeated.referenceRefresh, undefined);
});

test('all discovery input contracts accept the nullable release emitted for builtin and local tools', () => {
    const { getBuiltInToolDefinitions } = require('../server/services/agent-tools');
    const { normalizeToolContract, validateToolInput } = require('../server/services/agent-contracts');
    const reference = { toolName: 'rag.search', releaseId: null, definitionDigest: 'builtin-digest' };
    for (const name of ['tools.describe', 'tools.execute', 'tools.batch_read']) {
        const tool = normalizeToolContract(getBuiltInToolDefinitions({ id: 1 }).find(item => item.name === name));
        const input = name === 'tools.batch_read' ? { calls: [{ toolRef: reference, input: {} }] }
            : name === 'tools.execute' ? { toolRef: reference, input: {} } : { toolRef: reference };
        assert.deepEqual(validateToolInput(tool, input), []);
        const invalidRef = { ...reference, releaseId: 'guessed-version' };
        const invalid = name === 'tools.batch_read' ? { calls: [{ toolRef: invalidRef, input: {} }] }
            : { ...input, toolRef: invalidRef };
        assert.ok(validateToolInput(tool, invalid).length > 0);
    }
});

test('describe renews a changed release or digest from one authorized snapshot and retires the old execution reference', async () => {
    for (const currentTool of [
        { ...originalTool, catalogReleaseId: 11 },
        { ...originalTool, definitionDigest: 'contract-v2' }
    ]) {
        const state = searchedState();
        const oldRef = toolRef(originalTool);
        const deps = catalogDependency([currentTool]);
        const result = await executeToolDiscoveryMeta('tools.describe', { toolRef: oldRef }, { id: 1 }, { toolDiscoveryState: state }, deps);
        assert.equal(result.handled, true);
        assert.deepEqual(result.value.toolRef, toolRef(currentTool));
        assert.equal(result.value.referenceRefresh.reason, 'TOOL_REFERENCE_STALE');
        assert.deepEqual(result.value.referenceRefresh.previousToolRef, oldRef);
        assert.equal(deps.reads, 1, 'refresh must not repeatedly query a moving catalog');
        assert.doesNotThrow(() => assertDescribed(state, { ...result.value.toolRef }));
        assert.throws(() => assertDescribed(state, { ...oldRef }), error => error.code === 'TOOL_DISCOVERY_SEARCH_REQUIRED');
        assert.equal(getRememberedDescription(state, oldRef), null);
    }
});

test('describe returns the entire changed contract and cannot silently execute the old input', async () => {
    const state = searchedState();
    const currentTool = {
        ...originalTool, catalogReleaseId: 11, definitionDigest: 'contract-v2',
        input_schema: { type: 'object', properties: { confirmed: { type: 'boolean' } }, required: ['confirmed'] },
        idempotent: false, side_effect: true, concurrency: 'exclusive', approval_required: true
    };
    const deps = catalogDependency([currentTool], options => {
        assert.equal(options.toolPolicy, 'all');
        assert.deepEqual(options.toolAllowlist, ['orders.search']);
    });
    let executions = 0;
    deps.toolDiscovery.executeDiscoveredTool = async () => { executions += 1; };
    const context = { toolDiscoveryState: state, run: { tool_policy: 'all', tool_allowlist: ['orders.search'] } };
    const result = await executeToolDiscoveryMeta('tools.describe', { toolRef: toolRef(originalTool) }, { id: 1 }, context, deps);
    assert.deepEqual(result.value.inputSchema, currentTool.input_schema);
    assert.equal(result.value.sideEffect, true);
    assert.equal(result.value.requiresApproval, true);
    assert.equal(result.value.idempotent, false);
    assert.equal(executions, 0);
    const recovered = await executeToolDiscoveryMeta('tools.execute', { toolRef: toolRef(originalTool), input: { query: 'old' } }, { id: 1 }, context, deps);
    assert.equal(recovered.value.executed, false);
    assert.deepEqual(recovered.value.toolRef, result.value.toolRef);
    assert.equal(executions, 0);
});

test('describe recovers an expired discovery but execution still enforces expiry', async () => {
    let now = 10_000;
    const state = searchedState(originalTool, { ttlMs: 1_000, now: () => now });
    now += 1_000;
    const deps = catalogDependency([originalTool]);
    const context = { toolDiscoveryState: state };
    const result = await executeToolDiscoveryMeta('tools.describe', { toolRef: toolRef(originalTool) }, { id: 1 }, context, deps);
    assert.equal(result.value.referenceRefresh.reason, 'TOOL_DISCOVERY_SEARCH_EXPIRED');
    assert.doesNotThrow(() => assertDescribed(state, { ...result.value.toolRef }));
    now += 1_000;
    const recovered = await executeToolDiscoveryMeta('tools.execute', { toolRef: result.value.toolRef, input: {} }, { id: 1 }, context, deps);
    assert.equal(recovered.value.executed, false);
    assert.equal(recovered.value.reason, 'TOOL_DISCOVERY_SEARCH_EXPIRED');
});

test('execution never refreshes or replays a changed contract even if the old description is remembered', async () => {
    const state = searchedState();
    const currentTool = { ...originalTool, catalogReleaseId: 11, definitionDigest: 'contract-v2', side_effect: true };
    let executions = 0;
    const { executeDiscoveredTool } = require('../server/services/tool-discovery');
    const recovered = await executeToolDiscoveryMeta('tools.execute', { toolRef: toolRef(originalTool), input: { query: 'old' } }, { id: 1 }, { toolDiscoveryState: state }, {
            toolDiscovery: {
                formatToolList: async () => [currentTool],
                executeDiscoveredTool: async (user, input, context) => executeDiscoveredTool(user, input, context, {
                    formatToolList: async () => [currentTool],
                    executeToolByName: async () => { executions += 1; }
                })
            }
        });
    assert.equal(recovered.value.executed, false);
    assert.equal(recovered.value.reason, 'TOOL_REFERENCE_STALE');
    assert.equal(executions, 0);
});

test('a stale reference supplied after a fresh search or resumed run resolves only to the current authorized contract', async () => {
    const currentTool = { ...originalTool, catalogReleaseId: 12, definitionDigest: 'contract-v3' };
    for (const state of [createToolDiscoveryState(), searchedState(currentTool)]) {
        const deps = catalogDependency([currentTool]);
        const result = await executeToolDiscoveryMeta('tools.describe', { toolRef: toolRef(originalTool) }, { id: 1 }, { toolDiscoveryState: state }, deps);
        assert.deepEqual(result.value.toolRef, toolRef(currentTool));
        assert.doesNotThrow(() => assertDescribed(state, { ...result.value.toolRef }));
        assert.throws(() => assertDescribed(state, toolRef(originalTool)), error => error.code === 'TOOL_DISCOVERY_SEARCH_REQUIRED');
    }
});

test('refresh does not expose removed or unauthorized tools and invalidates the remembered old catalog', async () => {
    const state = searchedState();
    const deps = catalogDependency([]);
    await assert.rejects(
        () => executeToolDiscoveryMeta('tools.describe', { toolRef: toolRef(originalTool) }, { id: 1 }, { toolDiscoveryState: state }, deps),
        error => error.status === 404
    );
    assert.throws(() => assertDescribed(state, toolRef(originalTool)), error => error.code === 'TOOL_DISCOVERY_SEARCH_REQUIRED');
    assert.equal(deps.reads, 1);
});

test('remembering a replacement reference without a catalog version also retires the previous description', () => {
    const state = searchedState();
    const currentRef = toolRef({ ...originalTool, catalogReleaseId: 11 });
    rememberSearch(state, { candidates: [{ toolRef: currentRef }] });
    assert.throws(() => assertDescribed(state, toolRef(originalTool)), error => error.code === 'TOOL_DISCOVERY_SEARCH_REQUIRED');
    assert.throws(() => assertDescribed(state, currentRef), error => error.code === 'TOOL_DISCOVERY_DESCRIBE_REQUIRED');
});

test('catalog lookup failures propagate once without renewing discovery or retrying execution', async () => {
    const state = searchedState();
    let reads = 0;
    const unavailable = Object.assign(new Error('catalog unavailable'), { code: 'CATALOG_UNAVAILABLE' });
    await assert.rejects(
        () => executeToolDiscoveryMeta('tools.describe', { toolRef: toolRef(originalTool) }, { id: 1 }, { toolDiscoveryState: state }, {
            toolDiscovery: { formatToolList: async () => { reads += 1; throw unavailable; } }
        }),
        error => error === unavailable
    );
    assert.equal(reads, 1);
});
