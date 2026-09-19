const test = require('node:test');
const assert = require('node:assert/strict');

const { normalizeToolContract } = require('../server/services/agent-contracts');
const { normalizeDagSpec } = require('../server/services/agent-validators');
const { buildWorkflowVersionDiff } = require('../server/services/agent-workflows');
const { snapshotEvaluationCase } = require('../server/services/agent-evaluations');
const { executeBuiltInTool, getBuiltInToolDefinitions } = require('../server/services/agent-tools');

test('工作流升级基础：缓存声明、定义归一化与版本差异保持执行语义', async () => {
    const cacheable = normalizeToolContract({
        name: 'workflow.template',
        cacheable: true,
        input_schema: { type: 'object' }
    });
    assert.equal(cacheable.cacheable, true);

    const sideEffect = normalizeToolContract({
        name: 'mcp.1.db.insert',
        cacheable: true,
        side_effect: true,
        input_schema: { type: 'object' }
    });
    assert.equal(sideEffect.cacheable, false);
    assert.equal(normalizeToolContract({ name: 'mcp.1.db.insert', input_schema: { type: 'object' } }).side_effect, true);

    const approval = normalizeToolContract({
        name: 'workflow.approval',
        cacheable: true,
        alwaysRequiresApproval: true,
        input_schema: { type: 'object' }
    });
    assert.equal(approval.cacheable, false);

    const normalized = normalizeDagSpec({
        cacheEnabled: false,
        nodes: [{
            id: 'summary', tool: 'workflow.template', cache: false,
            retryLimit: 2, timeoutMs: 1500, onError: 'fallback', fallbackOutput: { text: '服务暂不可用' },
            inputSchema: { type: 'object', properties: { template: { type: 'string' } } },
            outputSchema: { type: 'object', properties: { text: { type: 'string' } } }
        }]
    });
    assert.equal(normalized.cacheEnabled, false);
    assert.equal(normalized.nodes[0].cache, false);
    assert.equal(normalized.nodes[0].retryLimit, 2);
    assert.equal(normalized.nodes[0].timeoutMs, 1500);
    assert.equal(normalized.nodes[0].onError, 'fallback');
    assert.deepEqual(normalized.nodes[0].fallbackOutput, { text: '服务暂不可用' });

    const before = {
        schemaVersion: 'pivot.dag.v2',
        cacheEnabled: true,
        nodes: [{
            id: 'check', title: '检查', tool: 'workflow.condition', input: { value: '{{inputs.ok}}', operator: 'is_true' },
            inputSchema: { type: 'object', properties: { value: {} } }, outputSchema: { type: 'object' },
            dependsOn: [], retryLimit: 0, timeoutMs: 0, onError: 'skip_dependents', cache: true
        }, {
            id: 'yes', title: '通过', tool: 'workflow.template', input: { template: '通过' }, dependsOn: ['check'],
            inputSchema: { type: 'object' }, outputSchema: { type: 'object' }, retryLimit: 0, timeoutMs: 0,
            onError: 'skip_dependents', cache: true
        }],
        edges: [{ from: 'check', to: 'yes', route: 'true' }]
    };
    const reordered = JSON.parse(JSON.stringify(before));
    reordered.nodes[0].input = { operator: 'is_true', value: '{{inputs.ok}}' };
    assert.equal(buildWorkflowVersionDiff(before, reordered).summary.changed, 0);

    const after = JSON.parse(JSON.stringify(before));
    after.cacheEnabled = false;
    after.nodes[1].retryLimit = 3;
    after.nodes[1].timeoutMs = 2500;
    after.nodes[1].onError = 'continue';
    after.nodes[1].joinMode = 'any_active';
    after.nodes[1].cache = false;
    after.nodes[1].outputSchema = { type: 'object', properties: { text: { type: 'string' } } };
    after.edges = [{ from: 'check', to: 'yes', route: 'false' }];
    const diff = buildWorkflowVersionDiff(before, after);
    assert.deepEqual(diff.changed[0].changes, ['输出契约', '重试', '超时', '失败策略', '汇聚方式', '缓存']);
    assert.deepEqual(diff.workflowChanges.map(item => item.label), ['路由边', '工作流缓存']);
    assert.equal(diff.summary.changed, 3);

    const evaluationCase = snapshotEvaluationCase({
        id: 5,
        name: '发布前固定用例',
        input: '生成固定结果',
        input_variables: { department: '研发部' },
        expected_output: '固定结果',
        assertions: { requiredPhrases: ['固定'], maxTokens: 123 },
        sort_order: 2
    });
    assert.deepEqual(evaluationCase, {
        id: 5,
        name: '发布前固定用例',
        input: '生成固定结果',
        inputVariables: { department: '研发部' },
        expectedOutput: '固定结果',
        assertions: {
            requiredPhrases: ['固定'], forbiddenPhrases: [], minLength: 0, maxDurationMs: 0,
            maxTokens: 123, requireJson: false, outputSchema: {}
        },
        sortOrder: 2
    });

    const iteration = getBuiltInToolDefinitions({ id: 1 }).find(tool => tool.name === 'workflow.iteration');
    assert.ok(iteration);
    assert.deepEqual(iteration.input_schema.required, ['items', 'workflowId']);
    const iterationResult = await executeBuiltInTool('workflow.iteration', { items: [1], workflowId: 9 }, { id: 1 }, {
        executeIteration: async input => ({ items: [{ inputIndex: 0, status: 'completed', value: input.items[0] }], count: 1, inputCount: 1, errors: [], stoppedOnError: false })
    });
    assert.equal(iterationResult.items[0].value, 1);
});
