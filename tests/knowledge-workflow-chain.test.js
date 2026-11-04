'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { runAgentDag } = require('../server/services/agent-dag-runtime');
const { clearDagNodeCache } = require('../server/services/agent-dag-cache');
const { digest } = require('../server/services/knowledge-tool-results');
const row = { chunk_id: 1, doc_id: 2, collection_id: 3, version_id: 5, citation_key: 'kb:4:v5:b6', content: '当前有效制度' };
const source = { chunkId: 1, legacyDocumentId: 2, collectionId: 3, versionId: 5, citationKey: row.citation_key, contentDigest: digest(row.content) };
const output = { knowledgeSourceVersion: 1, sources: [source], matches: [{ content: row.content, source }], context: '当前有效制度', retrieval: { status: 'succeeded' } };

function fixture(overrides = {}) {
    const calls = [], writes = [], updates = [], steps = [], verifications = [];
    const nodes = [{ id: 'knowledge', tool: 'rag.search', input: { query: '制度', collectionIds: [3] }, dependsOn: [], onError: 'continue' },
        { id: 'delivery', tool: 'workflow.template', input: { template: '{{nodes.knowledge.output.context}}' }, dependsOn: ['knowledge'] }];
    const run = { id: 'knowledge-workflow', goal: '依据制度回答', metadata: { dagSpec: { nodes, cacheEnabled: true } }, retry_limit: 0 };
    const deps = { getRunMetadata: value => value.metadata, listDagNodes: async () => [], listSteps: async () => [],
        upsertDagNode: async (_id, node, patch) => writes.push({ node: node.id, ...patch }), assertRunNotCancelled: async () => {},
        insertStep: async (_id, _index, step) => steps.push(step), updateRun: async (_id, patch) => updates.push(patch),
        createAgentNotification: async () => {}, getAgentRunTitle: () => '知识工作流', dagNodeConcurrency: 1, agentToolTimeoutMs: 30000,
        maybePauseForApproval: async () => false, isApprovalGranted: () => true, withTimeout: async operation => operation(new AbortController().signal), recordAgentToolCall: async () => {},
        verifyAgentOutcome: async options => { verifications.push(options); return { outcomeStatus: 'verified', hardFailures: [] }; },
        executeToolByName: async (name, input) => { calls.push(name); return name === 'rag.search' ? output : { text: input.template }; },
        knowledge: { readSourceChunks: async () => [row], validateCitationKeys: async () => true, getCollectionForUser: async () => ({}) }, ...overrides };
    const start = () => runAgentDag({ run, user: { id: 7 }, modelCfg: null, toolList: [{ name: 'rag.search', cacheable: true }, { name: 'workflow.template' }],
        deadline: Date.now() + 10000, assertRunWithinBudget: () => {} }, deps);
    return { run, nodes, deps, start, calls, writes, updates, steps, verifications };
}
test.beforeEach(() => clearDagNodeCache());

test('工作流知识节点传递独立来源清单，持久化步骤保留完整引用', async () => {
    const current = fixture();
    await current.start();
    assert.deepEqual(current.calls, ['rag.search', 'workflow.template']);
    assert.equal(current.updates.at(-1).status, 'completed');
    assert.equal(require('../server/services/knowledge-evidence-lineage').unpackKnowledgeOutput(current.steps.find(step => step.toolName === 'rag.search').output).knowledgeEvidence.sources[0].citationKey, row.citation_key);
    assert.equal(current.verifications[0].observations[1].knowledgeEvidence.sources[0].citationKey, row.citation_key);
    assert.equal(current.verifications[0].observations[0].knowledgeEvidence.sources[0].contentDigest, digest(row.content));
});

test('检索后撤权阻断下游，不能把历史片段继续传入模型或输出节点', async () => {
    let allowed = true;
    const current = fixture({ knowledge: { readSourceChunks: async () => allowed ? [row] : [], validateCitationKeys: async () => true, getCollectionForUser: async () => ({}) },
        insertStep: async (_id, _index, step) => { if (step.toolName === 'rag.search') allowed = false; } });
    await assert.rejects(current.start(), error => error.code === 'KNOWLEDGE_SOURCE_UNAVAILABLE');
    assert.deepEqual(current.calls, ['rag.search']);
    assert.equal(current.updates.some(update => update.status === 'completed'), false);
});

test('恢复与跨运行复用复核当前版本和范围，旧格式必须重新检索', async () => {
    for (const stored of [output, { matches: [{ content: '旧制度事实' }] }, JSON.stringify(output), null, '']) {
        const current = fixture({ listDagNodes: async () => [{ node_key: 'knowledge', status: 'completed', output: stored }],
            knowledge: { readSourceChunks: async () => [{ ...row, citation_key: 'kb:4:v6:b7' }], validateCitationKeys: async () => true } });
        await assert.rejects(current.start(), error => error.code === 'KNOWLEDGE_SOURCE_UNAVAILABLE');
        assert.deepEqual(current.calls, []);
    }
    const current = fixture();
    current.run.context_config = { collectionIds: [9] };
    current.run.metadata.reusedDagNodes = { knowledge: { status: 'completed', input: { collectionIds: [3] }, output, reusedFromRunId: 'previous' } };
    await assert.rejects(current.start(), error => error.code === 'KNOWLEDGE_SOURCE_UNAVAILABLE');
    assert.deepEqual(current.calls, []);
    assert.equal(current.writes.some(write => write.output === output), false);
});

test('缓存命中也重新校验来源，继续或兜底策略不能绕过撤权', async () => {
    await fixture().start();
    for (const onError of ['continue', 'fallback']) {
        const current = fixture({ knowledge: { readSourceChunks: async () => [], validateCitationKeys: async () => true, getCollectionForUser: async () => ({}) } });
        current.nodes[0].onError = onError;
        current.nodes[0].fallbackOutput = { text: '备用事实' };
        await assert.rejects(current.start(), error => error.code === 'KNOWLEDGE_SOURCE_UNAVAILABLE');
        assert.deepEqual(current.calls, []);
        assert.equal(current.updates.some(update => update.status === 'completed'), false);
    }
});

test('恢复的合法来源纳入验收；验收期间失效时不发布最终答案', async () => {
    const restored = fixture({ listDagNodes: async () => [{ node_key: 'knowledge', status: 'completed', input: { collectionIds: [3] }, output }] });
    await restored.start();
    assert.deepEqual(restored.calls, ['workflow.template']);
    assert.equal(restored.verifications[0].observations[0].knowledgeEvidence.sources[0].citationKey, row.citation_key);
    let allowed = true;
    const revoked = fixture({ knowledge: { readSourceChunks: async () => allowed ? [row] : [], validateCitationKeys: async () => true, getCollectionForUser: async () => ({}) },
        verifyAgentOutcome: async () => { allowed = false; return { outcomeStatus: 'verified', hardFailures: [] }; } });
    await assert.rejects(revoked.start(), error => error.code === 'KNOWLEDGE_SOURCE_UNAVAILABLE');
    assert.equal(revoked.updates.some(update => Object.hasOwn(update, 'final_answer')), false);
});

test('来源复核服务失败时保守阻断，错误不泄露异常详情', async () => {
    const current = fixture({ listDagNodes: async () => [{ node_key: 'knowledge', status: 'completed', output }],
        knowledge: { readSourceChunks: async () => { throw new Error('token=private-secret'); } } });
    await assert.rejects(current.start(), error => error.code === 'KNOWLEDGE_SOURCE_UNAVAILABLE' && !error.message.includes('private-secret'));
    assert.deepEqual(current.calls, []);
});
