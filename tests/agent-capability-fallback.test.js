'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeToolInput } = require('../server/services/agent-policy');
const { getToolDiscoveryDefinitions, executeToolDiscoveryMeta } = require('../server/services/agent-tools-discovery');
const { normalizeToolContract, validateToolInput } = require('../server/services/agent-contracts');
const { validateToolOutput } = require('../server/services/tool-policy-engine');
const { createToolDiscoveryState, rememberSearch } = require('../server/services/agent-tool-progressive-discovery');
const { finishCapabilityFallback } = require('../server/services/agent-capability-fallback');
const { TaskBudget } = require('../server/services/agent-budget');

test('工具引用别名在输入契约校验前修复，空引用不会执行业务且返回可操作提示', async () => {
    const definitions = getToolDiscoveryDefinitions((properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false }));
    const definition = normalizeToolContract(definitions.find(tool => tool.name === 'tools.execute'));
    for (const input of [{ toolRef: { name: 'rag.search' } }, { tool_ref: { tool_name: 'rag.search' } }, { toolRef: {}, toolName: 'rag.search' },
        { toolRef: { toolRef: { fullName: 'rag.search' } } }]) {
        const normalized = normalizeToolInput('tools.execute', input);
        assert.equal(normalized.toolRef.toolName, 'rag.search');
        assert.deepEqual(validateToolInput(definition, normalized), []);
    }
    assert.throws(() => normalizeToolInput('tools.execute', { toolRef: { toolName: 'a' }, toolName: 'b' }), error => error.code === 'TOOL_DISCOVERY_REFERENCE_CONFLICT');
    const state = createToolDiscoveryState();
    rememberSearch(state, { candidates: [{ toolRef: { toolName: 'rag.search', definitionDigest: 'digest' } }] });
    for (const name of ['tools.execute', 'tools.describe']) {
        const input = normalizeToolInput(name, { toolRef: {}, input: {} });
        const result = await executeToolDiscoveryMeta(name, input, { id: 7 }, { toolDiscoveryState: state });
        assert.equal(result.value.executed, false);
        assert.equal(result.value.reason, 'TOOL_DISCOVERY_REFERENCE_REQUIRED');
        assert.equal(result.value.candidates[0].toolName, 'rag.search');
        assert.deepEqual(validateToolOutput(definitions.find(tool => tool.name === name), null, result.value), []);
    }
});

function fixture(metadata = {}, overrides = {}) {
    const updates = [], summaries = [], steps = [];
    const options = { run: { id: 'fallback', user_id: 7, goal: '解释流程并给出建议', metadata }, user: { id: 7 }, modelCfg: { id: 3 },
        observations: [], error: { code: 'AGENT_NO_PROGRESS' }, budget: new TaskBudget({ max_tokens_total: 10000 }) };
    const deps = { getBeijingTimestamp: () => new Date().toISOString(), assertRunNotCancelled: async () => {}, revalidate: async () => true,
        withTimeout: async operation => operation(new AbortController().signal), synthesizeFinalAnswer: async (_model, _goal, _obs, _user, _run, context) => { summaries.push(context); return '可先整理目标与步骤，再逐项核对。'; },
        updateRun: async (_id, patch) => updates.push(patch), setRunMetadata: async () => {}, listSteps: async () => steps,
        insertStep: async (_id, _index, step) => steps.push(step), verifyAgentOutcome: async () => ({ outcomeStatus: 'partial', hardFailures: [] }), ...overrides };
    return { options, deps, updates, summaries, steps, start: () => finishCapabilityFallback(options, deps) };
}

test('一般概念任务即使找不到工具，也提供标明边界的模型答复', async () => {
    const skillInstructions = '业务说明。'.repeat(4000) + '最后列出限制。';
    const current = fixture({ skillInstructions, capabilityConstraints: { capabilities: ['agent.execute', 'conversation.read_source'] } });
    assert.equal(await current.start(), true);
    assert.equal(current.summaries.length, 1);
    assert.match(current.summaries[0].capabilityFallback.instruction, /停止搜索和工具调用/);
    assert.equal(current.summaries[0].skillInstructions, skillInstructions);
    assert.match(current.updates[0].final_answer, /基于模型知识回答[\s\S]*整理目标与步骤/);
    assert.equal(current.updates[0].status, 'partial');
});

test('要求文件时先交付文本草稿，不伪造生成文件；内部事实无证据不使用模型知识补填', async () => {
    const draft = fixture({ taskContract: { acceptance: { artifactRequired: true } } });
    await draft.start(); assert.equal(draft.summaries.length, 1); assert.match(draft.updates[0].final_answer, /尚未生成要求的文件/);
    for (const metadata of [{ taskContract: { acceptance: { requireEvidence: true } } }, { capabilityConstraints: { capabilities: ['data.query'] } },
        { capabilityConstraints: { capabilities: ['knowledge.search'] } }, { capabilityConstraints: { capabilities: ['message.send'] } }]) {
        const current = fixture(metadata); await current.start();
        assert.equal(current.summaries.length, 0);
        assert.equal(current.updates[0].status, 'needs_input');
        assert.ok(current.updates[0].final_answer);
    }
});

test('来源失效、模型不可用和取消均不会变成假成功或无正文的停止', async () => {
    const revoked = fixture({}, { revalidate: async () => false }); await revoked.start();
    assert.equal(revoked.summaries.length, 0); assert.match(revoked.updates[0].final_answer, /来源已变化/);
    const unavailable = fixture({}, { synthesizeFinalAnswer: async () => { throw new Error('模型不可用'); } }); await unavailable.start();
    assert.match(unavailable.updates[0].final_answer, /尚未生成完整答复/);
    const cancelled = fixture({}, { assertRunNotCancelled: async () => { throw Object.assign(new Error('用户已暂停'), { code: 'AGENT_RUN_PAUSED' }); } });
    await assert.rejects(cancelled.start(), error => error.code === 'AGENT_RUN_PAUSED'); assert.deepEqual(cancelled.updates, []);
    const denial = fixture(); denial.options.error.code = 'TOOL_POLICY_DENIED';
    assert.equal(await denial.start(), false); assert.deepEqual(denial.updates, []);
});

test('连续工具失败后的收尾只使用预留 Token，仍保留工具与累计资源约束', async () => {
    const current = fixture(); current.options.budget.counts.consecutive_errors = 4;
    await current.start(); assert.equal(current.summaries.length, 1);
    assert.equal(current.options.budget.counts.consecutive_errors, 4);
});

test('受限答复生成期间再次撤权时不发布旧正文，批量知识上下文仍纳入引用核验', async () => {
    let checks = 0;
    const current = fixture({}, { revalidate: async () => ++checks === 1 });
    await current.start();
    assert.equal(current.updates[0].status, 'needs_input');
    assert.doesNotMatch(current.updates[0].final_answer, /整理目标与步骤/);
    assert.match(current.updates[0].final_answer, /答复生成期间已变化/);
    const context = '[引用 1 | citation:kb:1:v1:b1 | 来源:制度]: 报销应在十日内提交。';
    const batch = fixture({ taskContract: { acceptance: { requireEvidence: true } } }, { synthesizeFinalAnswer: async () => '报销应在十日内提交。[引用 1 | citation:kb:1:v1:b1]' });
    batch.options.observations = [{ tool: 'tools.batch_read', knowledgeEvidence: { sources: [{ citationKey: 'kb:1:v1:b1' }] },
        output: { type: 'tools_batch_read', results: [{ output: { knowledgeSourceVersion: 1, sources: [{ citationKey: 'kb:1:v1:b1' }], context } }] } }];
    await batch.start();
    assert.equal(batch.updates[0].status, 'partial');
    assert.match(batch.updates[0].final_answer, /十日内提交/);
});

test('已有知识片段可用于受限答复，未配对或无依据的事实不会通过收尾', async () => {
    const context = '[引用 1 | citation:kb:1:v1:b1 | 来源:制度]: 报销应在十日内提交。';
    const current = fixture({ taskContract: { acceptance: { requireEvidence: true } } }, { synthesizeFinalAnswer: async () => '报销应在十日内提交。[引用 1 | citation:kb:1:v1:b1]' });
    current.options.observations = [{ tool: 'rag.search', output: { knowledgeSourceVersion: 1, sources: [{ citationKey: 'kb:1:v1:b1' }], context } }];
    await current.start(); assert.match(current.updates[0].final_answer, /十日内提交/); assert.equal(current.updates[0].status, 'partial');
    const invented = fixture({ taskContract: { acceptance: { requireEvidence: true } } }, { synthesizeFinalAnswer: async () => '可以延迟三百天提交。' });
    invented.options.observations = current.options.observations;
    await invented.start(); assert.doesNotMatch(invented.updates[0].final_answer, /三百天/); assert.equal(invented.updates[0].status, 'needs_input');
});
