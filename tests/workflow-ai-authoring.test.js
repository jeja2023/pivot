const assert = require('node:assert/strict');
const test = require('node:test');
const { propose } = require('../server/services/workflow-ai-authoring');

const user = { id: 7 };
const tool = { name: 'workflow.output', input_schema: { type: 'object', properties: { name: { type: 'string' }, value: {} }, required: ['name', 'value'] } };
const candidate = { name: '新的草稿', plan: '增加结果输出，未执行。', dagSpec: { nodes: [{ id: 'result', tool: 'workflow.output', input: { name: 'result', value: 'ok' } }] } };
function dependencies(output) {
    const calls = [];
    return { calls, getModel: async () => ({ id: 2 }), tools: async () => [tool, { name: 'send', sideEffect: true }],
        call: async (_model, messages, options) => { calls.push({ messages, options }); options.usageRef.usage = { input_tokens: 12, output_tokens: 8 }; return typeof output === 'string' ? output : JSON.stringify(output); },
        record: async (...args) => { calls.push({ usage: args }); } };
}

test('AI 方案只返回有计划的草稿，工具目录与用量记账使用既有边界', async () => {
    const deps = dependencies(candidate);
    const result = await propose(user, { prompt: '生成结果输出', modelId: 2 }, deps);
    assert.equal(result.executed, false); assert.equal(result.source, 'ai_draft');
    assert.equal(result.spec.nodes[0].tool, 'workflow.output');
    const sent = JSON.parse(deps.calls[0].messages[1].content);
    assert.equal(sent.tools.some(item => item.name === 'send'), false);
    assert.equal(deps.calls[1].usage[0].id, user.id);
    assert.equal(deps.calls[1].usage[4], 'workflow_authoring');
});

test('模型生成越权工具、凭据或无效结构时拒绝，保留原始草稿', async () => {
    const current = { nodes: [{ id: 'original' }] };
    for (const output of [
        { ...candidate, dagSpec: { nodes: [{ id: 'send', tool: 'send', input: {} }] } },
        { ...candidate, dagSpec: { nodes: [{ id: 'result', tool: 'workflow.output', input: { name: 'result', value: 'ok', password: 'real-secret' } }] } },
        { ...candidate, dagSpec: { nodes: [{ id: 'result', tool: 'workflow.output', input: {}, dependsOn: ['missing'] }] } },
        'invalid-json'
    ]) await assert.rejects(propose(user, { prompt: '修改这个已有流程', spec: current }, dependencies(output)), error => error.status === 422);
    assert.deepEqual(current, { nodes: [{ id: 'original' }] });
});
