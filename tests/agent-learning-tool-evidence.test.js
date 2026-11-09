'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { executedToolEvidence, resolveLearningToolCalls } = require('../server/services/agent-learning-tool-evidence');

test('渐进式调用用服务端已确认的业务工具证据形成学习输入，契约读取和失败不算执行', () => {
    const tool = { name: 'models.list', capabilities: ['system.observe'], risk_level: 1, idempotent: true };
    const evidence = executedToolEvidence(tool, [{ id: 1 }]);
    assert.equal(executedToolEvidence(tool, { executed: false }), null);
    assert.equal(executedToolEvidence(tool, { isError: true }), null);
    assert.equal(executedToolEvidence({ ...tool, name: 'tools.describe' }, {}), null);
    const call = { tool_name: 'tools.execute', status: 'success', policy_decision: 'allow', idempotent: false,
        input_payload: { toolRef: { toolName: 'models.list' }, input: {} }, context_snapshot: { executedTool: evidence } };
    const [resolved] = resolveLearningToolCalls([call]);
    assert.equal(resolved.tool_name, 'models.list'); assert.equal(resolved.idempotent, true);
    assert.deepEqual(resolved.input_payload, {});
    for (const patch of [{ status: 'error' }, { policy_decision: 'denied' }, { context_snapshot: {} }, { context_snapshot: { executedTool: { ...evidence, sideEffect: true } } }]) {
        const raw = { ...call, ...patch };
        assert.equal(resolveLearningToolCalls([raw])[0], raw);
    }
});

test('批量只读结果的服务端契约证据逐项解析，不把失败项或副作用步骤纳入学习', () => {
    const output = { type: 'tools_batch_read', results: [
        { toolName: 'models.list', executedTool: executedToolEvidence({ name: 'models.list', idempotent: true, risk_level: 1 }, []) },
        { toolName: 'knowledge.list', executedTool: executedToolEvidence({ name: 'knowledge.list', idempotent: true, risk_level: 1 }, { isError: true }) }
    ] };
    const evidence = executedToolEvidence({ name: 'tools.batch_read' }, output);
    const calls = resolveLearningToolCalls([{ tool_name: 'tools.batch_read', status: 'success', policy_decision: 'allow', context_snapshot: { executedTool: evidence }, input_payload: { calls: [{ toolRef: { toolName: 'models.list' }, input: {} }] } }]);
    assert.equal(calls.length, 1); assert.equal(calls[0].tool_name, 'models.list'); assert.equal(calls[0].idempotent, true);
});
