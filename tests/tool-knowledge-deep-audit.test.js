'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { validateValueAgainstSchema } = require('../server/services/agent-dag-contracts');
const { normalizeToolContract, validateToolInput } = require('../server/services/agent-contracts');
const { evaluateToolPolicy } = require('../server/services/agent-policy');
const { canonicalReference } = require('../server/services/tool-reference-input');
const { knowledgeEvidenceManifest, revalidateKnowledgeToolEvidence, digest } = require('../server/services/knowledge-tool-results');
const { executeReadOnlyDiscoveredBatch } = require('../server/services/agent-tools-discovery');
const { createToolDiscoveryState, rememberSearch, rememberDescription } = require('../server/services/agent-tool-progressive-discovery');
const { executeToolCallsInOrder } = require('../server/services/agent-tool-scheduler');
const { progressFingerprint } = require('../server/services/agent-execution-progress');
const { assertAgentKnowledgeCurrent } = require('../server/services/agent-knowledge-boundary');
const { createRoundRunner } = require('./helpers/agent-round-runner');

const row = { chunk_id: 1, doc_id: 2, citation_key: 'kb:4:v5:b6', content: '报销需十日内提交。' };
const source = { chunkId: 1, legacyDocumentId: 2, citationKey: row.citation_key, contentDigest: digest(row.content) };
const knowledge = { knowledgeSourceVersion: 1, sources: [source], matches: [{ source, content: row.content }], context: '[引用 1 | citation:kb:4:v5:b6 | 来源:制度]: 报销需十日内提交。' };

test('契约组合、动态字典和第 101 项继续校验，非法根参数不能转换为空对象放行', () => {
    const schema = { type: 'object', anyOf: [{ required: ['query'] }, { required: ['id'] }], properties: { query: { type: 'string' }, id: { type: 'integer' } } };
    assert.ok(validateValueAgainstSchema({}, schema).length);
    assert.deepEqual(validateValueAgainstSchema({ query: '制度' }, schema), []);
    assert.ok(validateValueAgainstSchema(2, { allOf: [{ type: 'integer' }, { minimum: 3 }] }).length);
    assert.ok(validateValueAgainstSchema(2, { oneOf: [{ type: 'integer' }, { type: 'number' }] }).length);
    assert.deepEqual(validateValueAgainstSchema('a', { oneOf: [{ type: 'integer' }, { type: 'string' }] }), []);
    assert.ok(validateValueAgainstSchema({ header: 1 }, { type: 'object', additionalProperties: { type: 'string' } }).length);
    assert.ok(validateValueAgainstSchema({ extra: true }, { type: 'object', additionalProperties: false }).length);
    assert.ok(validateValueAgainstSchema([...Array(100).fill(1), 'invalid'], { type: 'array', items: { type: 'integer' } }).some(issue => issue.includes('[100]')));
    assert.ok(validateValueAgainstSchema(1, false).length);
    const alternative = normalizeToolContract({ name: 'demo.alternative', input_schema: schema });
    assert.deepEqual(validateToolInput(alternative, { query: '制度' }), []);
    assert.ok(validateToolInput(alternative, {}).length);
    const combined = normalizeToolContract({ name: 'demo.combined', input_schema: { type: 'object', allOf: [
        { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
        { type: 'object', properties: { limit: { type: 'integer' } }, required: ['limit'] }
    ] } });
    assert.deepEqual(validateToolInput(combined, { query: '制度', limit: 3 }), []);
    assert.ok(validateToolInput(combined, { query: '制度', limit: '3' }).length);
    const tool = normalizeToolContract({ name: 'demo.read', input_schema: { type: 'object', properties: {} } });
    for (const value of [null, 7, 'invalid', []]) {
        assert.ok(validateToolInput(tool, value).length);
        assert.equal(evaluateToolPolicy({ tool, input: value }).decision, 'denied');
    }
});

test('分散工具引用的版本与摘要完整保留，冲突别名和非法版本均拒绝', () => {
    assert.deepEqual(canonicalReference({ toolRef: { toolName: 'rag.search' }, release_id: '7', definition_digest: 'digest' }), { toolName: 'rag.search', releaseId: 7, definitionDigest: 'digest' });
    for (const input of [{ toolRef: { toolName: 'a' }, tool_ref: { toolName: 'b' } },
        { toolRef: { toolName: 'a', releaseId: 7 }, releaseId: 8 }, { toolRef: { name: 'a', toolName: 'b' } },
        { toolName: 'a', releaseId: 'bad' }, { toolName: 'a', releaseId: -1 },
        { toolRef: { toolName: 'a', definitionDigest: 'old' }, definitionDigest: 'new' }]) {
        assert.throws(() => canonicalReference(input), error => error.code === 'TOOL_DISCOVERY_REFERENCE_CONFLICT');
    }
});

function batchFixture(execute) {
    const state = createToolDiscoveryState();
    const refs = ['rag.search', 'other.read'].map(toolName => ({ toolName, definitionDigest: toolName }));
    rememberSearch(state, { candidates: refs.map(toolRef => ({ toolRef })) });
    refs.forEach(ref => rememberDescription(state, ref));
    const deps = { toolDiscovery: { describeToolForUser: async refActor => refActor,
        executeDiscoveredTool: execute } };
    deps.toolDiscovery.describeToolForUser = async (_user, ref) => ({ name: ref.toolName, idempotent: true, sideEffect: false, concurrency: 'read', requiresApproval: false });
    return () => executeReadOnlyDiscoveredBatch({ id: 7 }, refs.map(toolRef => ({ toolRef, input: {} })), { toolDiscoveryState: state }, deps);
}

test('知识批读取保留来源与成功结果，单项业务失败不抹掉已取得的资料', async () => {
    const start = batchFixture(async (_user, input) => {
        if (input.toolRef.toolName === 'rag.search') return knowledge;
        throw Object.assign(new Error('private-error-detail'), { code: 'MCP_TOOL_EXECUTION_ERROR' });
    });
    const result = await start();
    assert.equal(result.partial, true);
    assert.equal(result.results[0].output, knowledge);
    assert.equal(result.results[1].output.isError, true);
    assert.doesNotMatch(JSON.stringify(result), /private-error-detail/);
    assert.equal(knowledgeEvidenceManifest(result).sources[0].citationKey, row.citation_key);
    for (const output of [result, { ...result, knowledgeEvidence: undefined }]) {
        assert.equal(await revalidateKnowledgeToolEvidence([{ output }], { id: 7 }, { readSourceChunks: async () => [], validateCitationKeys: async () => true }), false);
        assert.equal(await revalidateKnowledgeToolEvidence([{ output }], { id: 7 }, { readSourceChunks: async () => [row], validateCitationKeys: async () => true }), true);
    }
    await assert.rejects(batchFixture(async () => { throw Object.assign(new Error('授权已撤回'), { code: 'TOOL_POLICY_DENIED' }); })(), error => error.code === 'TOOL_POLICY_DENIED');
});

test('并发读取出错后等待在途操作，不启动后续项或提前交还控制权', async () => {
    let release, fail;
    const running = new Promise(resolve => { release = resolve; });
    const rejected = new Promise((_resolve, reject) => { fail = reject; });
    const calls = [];
    const result = executeToolCallsInOrder([1, 2, 3].map(id => ({ id, tool: { concurrency: 'read' } })), async item => {
        calls.push(item.id);
        if (item.id === 1) return await rejected;
        await running; return 'finished';
    }, { maxReadConcurrency: 2 });
    let settled = false;
    const completed = result.catch(error => { settled = true; return error; });
    fail(new Error('读取失败'));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(settled, false);
    assert.deepEqual(calls, [1, 2]);
    release();
    assert.equal((await completed).message, '读取失败');
    assert.deepEqual(calls, [1, 2]);
});

test('空行查询和全失败批次不构成新进展，元执行按实际目标身份判断', () => {
    assert.equal(progressFingerprint('data.query', {}, { rows: [] }), '');
    assert.equal(progressFingerprint('tools.execute', { toolRef: { toolName: 'data.query' } }, { structuredContent: { rows: [] } }), '');
    assert.equal(progressFingerprint('tools.batch_read', {}, { results: [{ toolName: 'read', output: { isError: true, code: 'a' } }] }), '');
    assert.equal(progressFingerprint('tools.execute', { toolRef: { toolName: 'tools.describe' } }, { name: 'x' }), '');
    assert.notEqual(progressFingerprint('tools.batch_read', {}, { results: [{ toolName: 'read', output: { rows: [1] } }] }), '');
});

test('模型使用历史知识之前重新检查版本、范围及聊天快照，撤权后不继续规划', async () => {
    const deps = { knowledge: { readSourceChunks: async () => [row], validateCitationKeys: async () => true } };
    await assertAgentKnowledgeCurrent({ user: { id: 7 }, observations: [{ tool: 'rag.search', error: '参数无效', output: { code: 'TOOL_INPUT_INVALID', executed: false } }] });
    await assertAgentKnowledgeCurrent({ run: {}, user: { id: 7 }, observations: [{ tool: 'tools.batch_read', output: { type: 'tools_batch_read', results: [{ toolName: 'rag.search', output: knowledge }] } }] }, deps);
    await assert.rejects(assertAgentKnowledgeCurrent({ run: {}, user: { id: 7 }, observations: [{ tool: 'rag.search', output: knowledge }] }, {
        knowledge: { ...deps.knowledge, readSourceChunks: async () => [] }
    }), error => error.code === 'KNOWLEDGE_SOURCE_UNAVAILABLE');
    await assert.rejects(assertAgentKnowledgeCurrent({ run: { id: 'x', metadata: { chatBridge: { ragContext: '旧上下文' } } }, user: { id: 7 } }, {
        inspectRunKnowledgeAccess: async () => ({ current: false })
    }), error => error.code === 'KNOWLEDGE_SOURCE_UNAVAILABLE');
    let calls = 0, readable = true;
    const current = createRoundRunner({ isStreamingToolsEnabled: () => false,
        callModelText: async () => { calls++; return JSON.stringify({ action: 'tool', tool: 'system.health', input: {} }); },
        executeToolByName: async () => knowledge,
        insertStep: async (_run, _index, step) => { if (step.type === 'tool') readable = false; },
        knowledge: { readSourceChunks: async () => readable ? [row] : [], validateCitationKeys: async () => true } });
    await current.start();
    assert.equal(calls, 1);
    assert.equal(current.run.status, 'needs_input');
    assert.equal(current.queued.length, 0);
});

test('审批过期、版本变化和发现授权撤回不进入工具纠错或模型降级', async () => {
    for (const code of ['AGENT_APPROVAL_STALE', 'AGENT_APPROVAL_EXPIRED', 'AGENT_DISCOVERY_SCOPE_REVOKED']) {
        let models = 0, tools = 0, summaries = 0;
        const current = createRoundRunner({ isStreamingToolsEnabled: () => false,
            callModelText: async () => { models++; return JSON.stringify({ action: 'tool', tool: 'system.health', input: {} }); },
            executeToolByName: async () => { tools++; throw Object.assign(new Error('需要重新确认授权'), { code }); },
            synthesizeFinalAnswer: async () => { summaries++; return '不得自动生成'; } });
        await current.start();
        assert.equal(models, 1); assert.equal(tools, 1); assert.equal(summaries, 0);
        assert.equal(current.run.status, 'needs_input');
        assert.equal(current.run.final_answer, '');
        assert.equal(JSON.parse(current.run.usage_stats).counts.consecutive_errors, 0);
    }
});

test('恢复时保留未进入近期观察的持久来源，观察压缩后仍检查较早来源', async () => {
    const { prepareAgentKnowledgeBoundary } = require('../server/services/agent-knowledge-boundary');
    const run = { id: 'persisted-source' }, user = { id: 7 };
    await prepareAgentKnowledgeBoundary(run, user, { inspectRunKnowledgeAccess: async () => ({ current: true, knowledgeEvidence: knowledge }) });
    await assert.rejects(assertAgentKnowledgeCurrent({ run, user, observations: [] }, {
        knowledge: { readSourceChunks: async () => [], validateCitationKeys: async () => true }
    }), error => error.code === 'KNOWLEDGE_SOURCE_UNAVAILABLE');
    const current = {};
    await assertAgentKnowledgeCurrent({ run: current, user, observations: [{ tool: 'rag.search', output: knowledge }] }, {
        knowledge: { readSourceChunks: async () => [row], validateCitationKeys: async () => true }
    });
    await assert.rejects(assertAgentKnowledgeCurrent({ run: current, user, observations: [] }, {
        knowledge: { readSourceChunks: async () => [], validateCitationKeys: async () => true }
    }), error => error.code === 'KNOWLEDGE_SOURCE_UNAVAILABLE');
});
