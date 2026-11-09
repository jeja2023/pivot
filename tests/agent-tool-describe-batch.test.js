'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { executeToolDiscoveryMeta, getToolDiscoveryDefinitions } = require('../server/services/agent-tools-discovery');
const { createToolDiscoveryState, assertDescribed, rememberSearch } = require('../server/services/agent-tool-progressive-discovery');
const { normalizeDiscoveryInput } = require('../server/services/tool-reference-input');
const { normalizeToolContract, validateToolInput } = require('../server/services/agent-contracts');
const { toolRef } = require('../server/services/tool-discovery');
const { TaskBudget } = require('../server/services/agent-budget');
const tools = ['orders.read', 'orders.write'].map((name, index) => normalizeToolContract({ name, source: 'builtin',
    description: '读取或保存订单', capabilities: ['agent.execute'], risk: 'low', side_effect: !!index,
    input_schema: { type: 'object', properties: { id: { type: 'string' } } } }));

test('批量读取从一个授权快照返回有序契约，版本刷新后才记忆且不执行业务', async () => {
    const state = createToolDiscoveryState(), budget = new TaskBudget({ max_tool_calls: 8 });
    let reads = 0;
    budget.consumeTool({ name: 'tools.describe', risk_level: 1 });
    const refs = tools.map(toolRef); refs[1] = { ...refs[1], definitionDigest: 'old' };
    const input = normalizeDiscoveryInput('tools.describe', { toolRefs: refs });
    const definition = getToolDiscoveryDefinitions((properties, required) => ({ type: 'object', properties, required })).find(tool => tool.name === 'tools.describe');
    assert.deepEqual(validateToolInput(normalizeToolContract(definition), input), []);
    const result = await executeToolDiscoveryMeta('tools.describe', input, { id: 1 }, { toolDiscoveryState: state, budget }, {
        toolDiscovery: { formatToolList: async () => { reads++; return tools; } }
    });
    assert.equal(reads, 1); assert.equal(result.value.executed, false);
    assert.deepEqual(result.value.descriptions.map(item => item.name), tools.map(tool => tool.name));
    assert.equal(result.value.descriptions[1].referenceRefresh.reason, 'TOOL_REFERENCE_STALE');
    for (const tool of tools) assert.doesNotThrow(() => assertDescribed(state, toolRef(tool)));
    assert.equal(budget.counts.tool_calls, 2); assert.equal(budget.counts.risk, 2);
    budget.counts.steps = 4;
    assert.equal(budget.recordProgress('tools.describe', input, result.value), false);
    assert.equal(budget.progress.count, 0); assert.equal(budget.progress.preparedTools.length, 2);
    budget.counts.steps = 5; budget.recordProgress('tools.describe', input, result.value);
    assert.equal(budget.progress.lastProgressRound, 4);
});

test('批量引用有界且不接受空名，单双引用合并去重但冲突拒绝', () => {
    for (const input of [{ toolRefs: [] }, { toolRefs: [{}] },
        { toolRefs: Array.from({ length: 9 }, (_, index) => ({ toolName: 'read' + index })) }]) {
        assert.throws(() => normalizeDiscoveryInput('tools.describe', input), error => error.code === 'TOOL_DISCOVERY_DESCRIBE_BATCH_INVALID');
    }
    assert.deepEqual(normalizeDiscoveryInput('tools.describe', { toolRef: toolRef(tools[0]), toolName: tools[0].name,
        toolRefs: [toolRef(tools[0]), toolRef(tools[1])] }), { toolRefs: tools.map(tool => normalizeDiscoveryInput('tools.describe', { toolRef: toolRef(tool) }).toolRef) });
    assert.throws(() => normalizeDiscoveryInput('tools.describe', { toolRef: { ...toolRef(tools[0]), definitionDigest: 'conflict' }, toolRefs: [toolRef(tools[0])] }),
        error => error.code === 'TOOL_DISCOVERY_REFERENCE_CONFLICT');
});

test('未授权或取消的半批契约不返回也不记忆，预算不足在读取目录前拒绝', async () => {
    const input = { toolRefs: tools.map(toolRef) }, state = createToolDiscoveryState();
    const context = { run: { tool_allowlist: [tools[0].name] }, toolDiscoveryState: state };
    await assert.rejects(executeToolDiscoveryMeta('tools.describe', input, { id: 1 }, context, {
        toolDiscovery: { formatToolList: async () => tools }
    }), error => error.status === 404);
    assert.equal(state.described.size, 0); assert.equal(state.searched.size, 0);
    const controller = new AbortController();
    controller.abort(Object.assign(new Error('已取消'), { code: 'AGENT_RUN_CANCELLED' }));
    await assert.rejects(executeToolDiscoveryMeta('tools.describe', input, { id: 1 }, { ...context, signal: controller.signal }, {
        toolDiscovery: { formatToolList: async () => tools }
    }), error => error.code === 'AGENT_RUN_CANCELLED');
    const budget = new TaskBudget({ max_tool_calls: 1 }); budget.consumeTool({ name: 'tools.describe' });
    let reads = 0;
    await assert.rejects(executeToolDiscoveryMeta('tools.describe', input, { id: 1 }, { budget }, {
        toolDiscovery: { formatToolList: async () => { reads++; return tools; } }
    }), error => error.code === 'AGENT_BUDGET_EXCEEDED');
    assert.equal(reads, 0);
});

test('当前目录撤权后批量读取撤销旧状态，describe不使后续执行跳过实时鉴权', async () => {
    const state = createToolDiscoveryState();
    await executeToolDiscoveryMeta('tools.describe', { toolRefs: tools.map(toolRef) }, { id: 1 }, { toolDiscoveryState: state }, {
        toolDiscovery: { formatToolList: async () => tools }
    });
    await assert.rejects(executeToolDiscoveryMeta('tools.describe', { toolRefs: tools.map(toolRef) }, { id: 1 }, { toolDiscoveryState: state }, {
        toolDiscovery: { formatToolList: async () => [] }
    }), error => error.status === 404);
    assert.throws(() => assertDescribed(state, toolRef(tools[0])), error => error.code === 'TOOL_DISCOVERY_SEARCH_REQUIRED');
    assert.equal(state.described.size, 0);
    rememberSearch(state, { candidates: [] });
});
