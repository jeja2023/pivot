'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createRoundRunner } = require('./helpers/agent-round-runner');

test('原生规划回退共享真实单段预算，安全续跑后累计工具与轮次继续计费', async () => {
    let nativeCalls = 0, jsonCalls = 0, tools = 0;
    const current = createRoundRunner({ isStreamingToolsEnabled: () => true,
        tryRunAgentStreaming: async (_options, deps) => { nativeCalls++; await deps.taskBudget.beginPlanningRound(); return { completed: false, roundsUsed: nativeCalls }; },
        callModelText: async () => { jsonCalls++; return JSON.stringify({ action: 'tool', tool: 'system.health', input: {} }); },
        executeToolByName: async (_name, _input, _user, _list, context) => {
            tools++; context.budget.consumeTool({ name: 'system.health' }); await context.budget.persistUsageSnapshot(); return { rows: [tools] };
        } });
    await current.start();
    assert.deepEqual(current.errors, []);
    assert.equal(nativeCalls, 1); assert.equal(jsonCalls, 2); assert.equal(tools, 2);
    assert.equal(current.queued.length, 1);
    const first = JSON.parse(current.run.usage_stats);
    assert.equal(first.counts.steps, 3); assert.equal(first.counts.tool_calls, 2);
    await current.start();
    const resumed = JSON.parse(current.run.usage_stats);
    assert.equal(resumed.counts.steps, 5);
    assert.equal(resumed.counts.tool_calls, 3);
    assert.equal(current.queued.length, 1);
    assert.equal(current.run.status, 'completed_with_errors');
});

test('累计已耗尽时恢复不会调用模型和工具，也不会通过续跑扩大预算', async () => {
    let calls = 0;
    const current = createRoundRunner({ isStreamingToolsEnabled: () => false, callModelText: async () => { calls++; return '{}'; } });
    current.run.usage_stats = { accountingVersion: 2, counts: { steps: 5, tool_calls: 4, tokens_total: 100 }, elapsed_seconds: 1 };
    await current.start();
    assert.equal(calls, 0); assert.equal(current.queued.length, 0);
    assert.equal(JSON.parse(current.run.usage_stats).counts.steps, 5);
});

test('连续空规划不获得额外时间片，暂停时保留已有执行记录', async () => {
    const current = createRoundRunner({ isStreamingToolsEnabled: () => false,
        callModelText: async () => JSON.stringify({ action: 'tool', tool: 'system.health', input: {} }),
        executeToolByName: async () => ({}) });
    await current.start();
    assert.equal(current.queued.length, 0);
    assert.equal(current.run.metadata.continuationStop.code, 'AGENT_NO_PROGRESS');
    assert.ok(current.steps.some(step => step.type === 'tool'));
});
