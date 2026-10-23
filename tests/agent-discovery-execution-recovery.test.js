'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const { executeToolDiscoveryMeta } = require('../server/services/agent-tools-discovery');
const { resolveProgressiveExecution } = require('../server/services/agent-progressive-execution');
const { createToolDiscoveryState, rememberSearch, rememberDescription } = require('../server/services/agent-tool-progressive-discovery');
const { toolRef } = require('../server/services/tool-discovery');

const user = { id: 1, role: 'user' };
const tool = { name: 'orders.search', source: 'builtin', idempotent: true, side_effect: false, input_schema: { type: 'object' } };

test('missing describe is repaired with a contract-only result and requires a separate model decision before execution', async () => {
    const state = createToolDiscoveryState();
    const context = { toolDiscoveryState: state };
    let executions = 0;
    const deps = { toolDiscovery: { formatToolList: async () => [tool], executeDiscoveredTool: async () => { executions += 1; return 'actual result'; } } };
    const first = await executeToolDiscoveryMeta('tools.execute', { toolName: tool.name, input: {} }, user, context, deps);
    assert.equal(first.value.executed, false);
    assert.equal(first.value.contract.name, tool.name);
    assert.equal(executions, 0);
    const second = await executeToolDiscoveryMeta('tools.execute', { toolRef: first.value.toolRef, input: {} }, user, context, deps);
    assert.equal(second.value, 'actual result');
    assert.equal(executions, 1);
});

test('preflight routes missing descriptions to discovery without approving the target and pins that decision across concurrent calls', async () => {
    const state = createToolDiscoveryState();
    const meta = { name: 'tools.execute', source: 'builtin' };
    const input = { toolName: tool.name, input: {} };
    const prepared = await resolveProgressiveExecution({ toolName: meta.name, input, user, toolList: [meta, tool], state });
    assert.equal(prepared.discoveryRequired, 'TOOL_DISCOVERY_SEARCH_REQUIRED');
    assert.equal(prepared.approvalTool, meta);
    const reference = toolRef(tool);
    rememberSearch(state, { candidates: [{ toolRef: reference }] });
    rememberDescription(state, reference, { name: tool.name, toolRef: reference });
    let executed = false;
    const result = await executeToolDiscoveryMeta('tools.execute', input, user, { toolDiscoveryState: state, discoveryRequired: prepared.discoveryRequired }, {
        toolDiscovery: { formatToolList: async () => [tool], executeDiscoveredTool: async () => { executed = true; } }
    });
    assert.equal(result.value.executed, false);
    assert.equal(executed, false);
});

test('batch recovery describes all targets and dispatches none of the batch', async () => {
    const targets = [tool, { ...tool, name: 'orders.summary' }];
    let executions = 0;
    const result = await executeToolDiscoveryMeta('tools.batch_read', { calls: targets.map(target => ({ toolRef: { toolName: target.name }, input: {} })) }, user,
        { toolDiscoveryState: createToolDiscoveryState() }, { toolDiscovery: {
            formatToolList: async () => targets, executeDiscoveredTool: async () => { executions += 1; }
        } });
    assert.equal(result.value.executed, false);
    assert.deepEqual(result.value.contracts.map(contract => contract.name), targets.map(target => target.name));
    assert.equal(executions, 0);
});

test('a business error with a discovery-like code is not treated as a safe pre-dispatch recovery', async () => {
    const state = createToolDiscoveryState();
    const reference = toolRef(tool);
    rememberSearch(state, { candidates: [{ toolRef: reference }] });
    rememberDescription(state, reference);
    const error = Object.assign(new Error('business operation failed'), { code: 'TOOL_REFERENCE_STALE' });
    await assert.rejects(() => executeToolDiscoveryMeta('tools.execute', { toolRef: reference, input: {} }, user, { toolDiscoveryState: state }, {
        toolDiscovery: { executeDiscoveredTool: async () => { throw error; } }
    }), actual => actual === error);
});

test('waiting status displays the concrete verification reason instead of always asking for more requirements', () => {
    const context = { agentRunMetadata: () => ({}), agentStatusLabel: () => '' };
    vm.createContext(context);
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../client/chat/agent-run-status-views.js'), 'utf8'), context);
    const reason = '任务尚未完成：验收服务暂时不可用，可稍后重试。';
    assert.equal(context.agentRunFriendlySummary({ status: 'needs_input', error_message: reason }), reason);
    assert.doesNotMatch(context.agentRunFriendlySummary({ status: 'needs_input' }), /请补充要求后继续/);
});
