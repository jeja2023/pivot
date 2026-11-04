'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeToolContract, validateToolInput } = require('../server/services/agent-contracts');
const { enforceToolPolicy } = require('../server/services/agent-policy');
const { createToolPolicyEngine } = require('../server/services/tool-policy-engine');
const { createToolOrchestrator } = require('../server/services/agent-tool-orchestrator');
const { buildToolExecutionPlan } = require('../server/services/agent-tool-execution-plan');
const { diagnoseError, shouldRetryDiagnosis } = require('../server/services/agent-diagnosis');
const { toolInputFeedback, ToolInputValidationError } = require('../server/services/tool-input-validation');

const tool = normalizeToolContract({ name: 'orders.search', network: false, risk_level: 1, idempotent: true,
    input_schema: { type: 'object', required: ['query'], properties: { query: { type: 'string', minLength: 2 }, limit: { type: 'integer', minimum: 1, maximum: 20 } } } });

test('缺失、类型、范围和多余字段返回可修复反馈，完整保留参数约束', async () => {
    let executions = 0;
    const engine = createToolPolicyEngine({ formatToolList: async () => [tool], recordToolInvocationEvent: async () => {} });
    for (const input of [{}, { query: '订单', limit: '3' }, { query: '订单', limit: 99 }, { query: '订单', extra: true }]) {
        await assert.rejects(engine.invoke({ actor: { id: 7 }, toolName: tool.name, input }, async () => { executions++; }), error => {
            const feedback = toolInputFeedback(error);
            assert.equal(error.status, 400);
            assert.equal(feedback.executed, false);
            assert.equal(feedback.retryable, false);
            assert.equal(feedback.repairable, true);
            assert.ok(feedback.issues.length);
            assert.equal(feedback.inputSchema.properties.limit.maximum, 20);
            assert.equal(feedback.inputSchema.additionalProperties, false);
            const diagnosis = diagnoseError(error);
            assert.equal(diagnosis.category, 'schema');
            assert.equal(diagnosis.repairable, true);
            assert.equal(shouldRetryDiagnosis(diagnosis, 0), false, '原参数不会自动重放');
            return true;
        });
    }
    assert.equal(executions, 0);
    await engine.invoke({ actor: { id: 7 }, toolName: tool.name, input: { query: '订单', limit: 3 } }, async () => { executions++; return { rows: [] }; });
    assert.equal(executions, 1);
});

test('混合参数和权限拒绝不会变成参数修复授权，合法参数仍需审批', async () => {
    const engine = createToolPolicyEngine({ formatToolList: async () => [tool], recordToolInvocationEvent: async () => {} });
    await assert.rejects(engine.invoke({ actor: { id: 7 }, run: { tool_allowlist: ['other.read'] }, toolName: tool.name, input: {} }, async () => assert.fail('不得执行')), error => {
        assert.equal(error.code, 'TOOL_POLICY_DENIED');
        assert.ok(error.details.reasonCodes.includes('task_tool_allowlist'));
        assert.equal(toolInputFeedback(error), null);
        return true;
    });
    assert.throws(() => enforceToolPolicy({ tool: { ...tool, approval_required: true }, input: { query: '订单' } }), error => error.code === 'AGENT_APPROVAL_REQUIRED');
    assert.throws(() => enforceToolPolicy({ tool, run: { network_policy: { enabled: false } }, input: {} }), error => error.code === 'TOOL_INPUT_INVALID');
    assert.throws(() => enforceToolPolicy({ tool: { ...tool, network: true }, run: { network_policy: { enabled: false } }, input: {} }), error => error.code === 'AGENT_POLICY_DENIED');
});

test('独立策略和编排器使用相同参数错误分类，执行器伪造同名错误不取得修复豁免', async () => {
    assert.throws(() => enforceToolPolicy({ tool, input: {} }), error => toolInputFeedback(error)?.executed === false);
    const plan = await buildToolExecutionPlan({ tool, input: {} });
    const orchestrator = createToolOrchestrator({ recordAgentEvent: async () => {} });
    await assert.rejects(orchestrator.execute({ tool, input: {}, executionPlan: plan, execute: async () => assert.fail('不得执行') }), error => toolInputFeedback(error)?.executed === false);
    assert.equal(toolInputFeedback(Object.assign(new Error('业务执行后失败'), { code: 'TOOL_INPUT_INVALID', details: { inputValidation: { executed: false } } })), null);
});

test('必填文本按存在性校验，空文本只由明确的最短长度约束拒绝', () => {
    const emptyAllowed = normalizeToolContract({ name: 'text.read', input_schema: { type: 'object', required: ['text'], properties: { text: { type: 'string' } } } });
    assert.deepEqual(validateToolInput(emptyAllowed, { text: '' }), []);
    assert.ok(validateToolInput(emptyAllowed, {}).length);
    assert.ok(validateToolInput(emptyAllowed, { text: null }).length);
    assert.ok(validateToolInput(tool, { query: '' }).some(issue => issue.includes('长度不能少于 2')));
});

test('修复反馈剥离默认值与说明，过大契约有界且不谎称完整', () => {
    const error = new ToolInputValidationError({ name: 'demo.read', input_schema: { type: 'object', description: '说明', properties: { token: { type: 'string', default: 'secret-placeholder', examples: ['private-example'] } } } }, ['缺少字段']);
    assert.doesNotMatch(JSON.stringify(toolInputFeedback(error)), /secret-placeholder|private-example|description/);
    const large = new ToolInputValidationError({ input_schema: { type: 'object', properties: Object.fromEntries(Array.from({ length: 500 }, (_, i) => [`field${i}`, { type: 'string' }])) } }, ['缺少字段']);
    assert.equal(toolInputFeedback(large).schemaTruncated, true);
    assert.ok(JSON.stringify(toolInputFeedback(large)).length < 14000);
});

test('渐进式执行透传目标参数错误与契约，不在恢复引用时重复执行业务', async () => {
    const { executeToolDiscoveryMeta } = require('../server/services/agent-tools-discovery');
    const { executeDiscoveredTool, toolRef } = require('../server/services/tool-discovery');
    const { createToolDiscoveryState, rememberSearch, rememberDescription } = require('../server/services/agent-tool-progressive-discovery');
    const state = createToolDiscoveryState(), reference = toolRef(tool);
    rememberSearch(state, { candidates: [{ toolRef: reference }] });
    rememberDescription(state, reference);
    let executions = 0;
    const engine = createToolPolicyEngine({ formatToolList: async () => [tool], recordToolInvocationEvent: async () => {} });
    const deps = { toolDiscovery: { executeDiscoveredTool: (actor, input, context) => executeDiscoveredTool(actor, input, context, {
        formatToolList: async () => [tool], executeToolByName: (name, params) => engine.invoke({ actor, toolName: name, input: params }, async () => { executions++; return { rows: [1] }; })
    }) } };
    await assert.rejects(executeToolDiscoveryMeta('tools.execute', { toolRef: reference, input: { query: '订单', limit: '3' } }, { id: 7 }, { toolDiscoveryState: state }, deps), error => {
        assert.equal(toolInputFeedback(error).toolName, tool.name);
        assert.equal(toolInputFeedback(error).inputSchema.properties.limit.type, 'integer');
        return true;
    });
    assert.equal(executions, 0);
    const result = await executeToolDiscoveryMeta('tools.execute', { toolRef: reference, input: { query: '订单', limit: 3 } }, { id: 7 }, { toolDiscoveryState: state }, deps);
    assert.deepEqual(result.value, { rows: [1] });
    assert.equal(executions, 1);
});
