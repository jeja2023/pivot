const test = require('node:test');
const assert = require('node:assert/strict');

const { buildDagErrorInfo, prepareDagFallbackOutput, runAgentDag } = require('../server/services/agent-dag-runtime');

test('DAG 节点失败生成可诊断错误对象，并且只接受满足输出契约的兜底输出', () => {
    const timeout = Object.assign(new Error('upstream timeout'), { code: 'AGENT_NODE_TIMEOUT' });
    const errorInfo = buildDagErrorInfo(timeout, { id: 'query', tool: 'reports.query' }, { attempt: 2, timedOut: true });
    assert.deepEqual(errorInfo, {
        category: 'timeout', code: 'AGENT_NODE_TIMEOUT', message: 'AGENT_NODE_TIMEOUT Error upstream timeout',
        nodeId: 'query', retryable: true, remediation: '拆分任务、降低单步复杂度或优化算法后重试。', attempt: 2, timedOut: true
    });

    const schema = { type: 'object', required: ['text'], properties: { text: { type: 'string' } } };
    const accepted = prepareDagFallbackOutput({ id: 'query', fallbackOutput: { text: '暂时不可用' } }, schema, errorInfo);
    assert.equal(accepted.usable, true);
    assert.equal(accepted.errorInfo.fallbackApplied, true);
    const rejected = prepareDagFallbackOutput({ id: 'query', fallbackOutput: { code: 'empty' } }, schema, errorInfo);
    assert.equal(rejected.usable, false);
    assert.match(rejected.issues[0], /为必填项/);
});

test('运行时仅在兜底值符合输出契约时继续下游，并保留错误诊断', async () => {
    const persisted = new Map();
    const updates = [];
    const run = {
        id: 'fallback-run', goal: '测试兜底', tool_timeout_ms: 30000,
        metadata: {
            dagSpec: {
                nodes: [{
                    id: 'unstable', title: '不稳定服务', tool: 'test.unstable', input: {}, dependsOn: [],
                    onError: 'fallback', fallbackOutput: { text: '备用结果' },
                    outputSchema: { type: 'object', required: ['text'], properties: { text: { type: 'string' } } }
                }, {
                    id: 'delivery', title: '交付', tool: 'workflow.template', input: { template: '{{nodes.unstable.output.text}}' }, dependsOn: ['unstable']
                }]
            }
        }
    };
    const deps = {
        getRunMetadata: value => value.metadata,
        listDagNodes: async () => [...persisted.values()], listSteps: async () => [],
        upsertDagNode: async (_runId, node, patch) => persisted.set(node.id, { ...patch, node_key: node.id, tool_name: node.tool }),
        assertRunNotCancelled: async () => {}, assertRunWithinBudget: () => {}, insertStep: async () => {},
        updateRun: async (_runId, patch) => { updates.push(patch); }, createAgentNotification: async () => {},
        getAgentRunTitle: () => '测试兜底', dagNodeConcurrency: 2, agentToolTimeoutMs: 30000,
        maybePauseForApproval: async () => false, isApprovalGranted: () => false,
        withTimeout: async operation => operation(new AbortController().signal), recordAgentToolCall: async () => {},
        executeToolByName: async name => {
            if (name === 'test.unstable') throw Object.assign(new Error('upstream timeout'), { code: 'AGENT_NODE_TIMEOUT' });
            if (name === 'workflow.template') return { text: '备用结果' };
            throw new Error(`未预期的工具：${name}`);
        }
    };
    await runAgentDag({
        run, user: { id: 1 }, modelCfg: null,
        toolList: [{ name: 'test.unstable', output_schema: run.metadata.dagSpec.nodes[0].outputSchema }, { name: 'workflow.template' }],
        deadline: Date.now() + 30000, assertRunWithinBudget: () => {}
    }, deps);
    assert.equal(persisted.get('unstable').status, 'continued_error');
    assert.equal(persisted.get('unstable').output.text, '备用结果');
    assert.equal(persisted.get('unstable').errorInfo.category, 'timeout');
    assert.equal(persisted.get('unstable').errorInfo.fallbackApplied, true);
    assert.equal(persisted.get('delivery').status, 'completed');
    assert.equal(updates.at(-1).status, 'completed_with_errors');
});
