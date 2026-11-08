'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createModelToolProtocol, providerToolName } = require('../server/services/model-tool-protocol');
const { createToolCallAccumulator, buildOpenAiToolsPayload, buildAssistantToolMessage, buildToolResultMessage } = require('../server/services/streaming-tools');
const { agentToolStepId, normalizeAgentStepId, normalizeAgentOperationKey } = require('../server/services/agent-tool-call-identity');

test('模型工具名称稳定映射且不与原本合法名称或长名称发生截断碰撞', () => {
    const names = ['tools.search', 'tools_search', 'pivot_fn_search', '工具.查询', 'a'.repeat(80) + 'x', 'a'.repeat(80) + 'y'];
    const protocol = createModelToolProtocol(names.map(name => ({ name })));
    const aliases = names.map(protocol.name);
    assert.equal(new Set(aliases).size, names.length);
    for (const [index, name] of names.entries()) {
        assert.match(aliases[index], /^[A-Za-z0-9_-]{1,64}$/);
        assert.equal(protocol.canonicalName(aliases[index]), name);
        assert.equal(providerToolName(name), aliases[index]);
    }
    assert.equal(protocol.name('tools_search'), 'tools_search');
    assert.equal(protocol.canonicalName('未登记工具'), '未登记工具');
});

test('工具目录、历史消息和指定工具选择使用同一别名且不改调用ID及参数', () => {
    const messages = [{ role: 'assistant', content: '', tool_calls: [{ id: 'call_original', type: 'function', function: { name: 'tools.execute', arguments: '{"toolName":"mcp.1.read"}' } }] },
        { role: 'tool', tool_call_id: 'call_original', content: '{"saved":true}' }];
    const snapshot = JSON.stringify(messages);
    const protocol = createModelToolProtocol([{ name: 'tools.execute' }], messages);
    assert.equal(protocol.messages[0].tool_calls[0].function.name, protocol.name('tools.execute'));
    assert.equal(protocol.messages[0].tool_calls[0].id, 'call_original');
    assert.equal(protocol.messages[1].tool_call_id, 'call_original');
    assert.equal(protocol.messages[0].tool_calls[0].function.arguments, messages[0].tool_calls[0].function.arguments);
    assert.equal(protocol.toolChoice({ type: 'function', function: { name: 'tools.execute' } }).function.name, protocol.name('tools.execute'));
    assert.equal(protocol.toolChoice('auto'), 'auto');
    assert.equal(JSON.stringify(messages), snapshot);
    assert.equal(buildOpenAiToolsPayload([{ name: 'tools.execute' }])[0].function.name, protocol.name('tools.execute'));
});

test('分段工具函数名在流结束后还原到受控目录名称', () => {
    const protocol = createModelToolProtocol([{ name: 'tools.execute' }]);
    const alias = protocol.name('tools.execute');
    const accumulator = createToolCallAccumulator({ resolveToolName: protocol.canonicalName });
    accumulator.ingest({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_' + 'x'.repeat(80), function: { name: alias.slice(0, 10), arguments: '{"input":' } }] } }] });
    accumulator.ingest({ choices: [{ delta: { tool_calls: [{ index: 0, function: { name: alias.slice(10), arguments: '{}}' } }] }, finish_reason: 'tool_calls' }] });
    assert.equal(accumulator.snapshot().partialToolCalls[0].name, 'tools.execute');
    const call = accumulator.finalize().toolCalls[0];
    assert.equal(call.name, 'tools.execute');
    assert.equal(call.id, 'call_' + 'x'.repeat(80));
    assert.deepEqual(call.arguments, { input: {} });
    accumulator.ingest({ choices: [{ message: { tool_calls: [{ index: 0, id: call.id, function: { name: alias, arguments: '{"input":{}}' } }] }, finish_reason: 'tool_calls' }] });
    assert.equal(accumulator.finalize().toolCalls[0].name, 'tools.execute');
    assert.deepEqual(accumulator.finalize().toolCalls[0].arguments, { input: {} });
});

test('内部步骤标识适配64字符边界，同时保留既有短标识和稳定恢复关联', () => {
    const runId = 'run_' + 'r'.repeat(24), callId = 'call_' + 'c'.repeat(32);
    assert.equal(`${runId}:1:${callId}`.length, 68);
    assert.equal(normalizeAgentStepId('short:1:call'), 'short:1:call');
    assert.equal(normalizeAgentStepId('x'.repeat(64)), 'x'.repeat(64));
    const step = agentToolStepId(runId, 1, callId);
    assert.equal(step.length, 64);
    assert.equal(step, agentToolStepId(runId, 1, callId));
    assert.notEqual(step, agentToolStepId(runId, 2, callId));
    assert.notEqual(normalizeAgentStepId('x'.repeat(100) + 'a'), normalizeAgentStepId('x'.repeat(100) + 'b'));
    assert.equal(normalizeAgentOperationKey('x'.repeat(255)), 'x'.repeat(255));
    assert.ok(normalizeAgentOperationKey('x'.repeat(256)).length <= 255);
    assert.notEqual(normalizeAgentOperationKey('x'.repeat(256) + 'a'), normalizeAgentOperationKey('x'.repeat(256) + 'b'));
});

test('提供方省略调用ID时补全一次，历史和工具结果引用保持一致', () => {
    const accumulator = createToolCallAccumulator();
    accumulator.ingest({ choices: [{ delta: { function_call: { name: 'read', arguments: '{}' } }, finish_reason: 'function_call' }] });
    const result = accumulator.finalize(), repeated = accumulator.finalize();
    assert.match(result.toolCalls[0].id, /^call_[a-f0-9]{32}$/);
    assert.equal(repeated.toolCalls[0].id, result.toolCalls[0].id);
    const assistant = buildAssistantToolMessage(result), tool = buildToolResultMessage(result.toolCalls[0].id, { read: true });
    assert.equal(assistant.tool_calls[0].id, tool.tool_call_id);
});
