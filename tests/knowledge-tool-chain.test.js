'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { intersectScopes, resolveKnowledgeToolScope, executeKnowledgeSearch, revalidateKnowledgeToolEvidence } = require('../server/services/knowledge-tool-results');
const { failureStage, resultStage } = require('../server/services/tool-chain-status');
const { presentTaskEvent } = require('../server/services/chat-task-presentation');
const user = { id: 7, role: 'user' };
const row = { chunk_id: 1, doc_id: 2, collection_id: 3, document_id: 4, version_id: 5, block_id: 6, citation_key: 'kb:4:v5:b6', name: '测试制度', char_start: 0, char_end: 1800, content: '有效内容'.repeat(450) };

test('会话与项目资料包求交集，非法或无权范围不能回退为全库', async () => {
    assert.deepEqual(intersectScopes({ collectionIds: [1, 2], tagNames: ['制度'] }, { collectionIds: [2, 3] }).collectionIds, [2]);
    assert.throws(() => intersectScopes({ collectionIds: [1] }, { collectionIds: [2] }), error => error.code === 'KNOWLEDGE_SCOPE_DENIED');
    const context = { run: { metadata: JSON.stringify({ chatBridge: { ragScope: { collectionIds: [1, 2] } } }), context_config: JSON.stringify({ collectionIds: [2] }) } };
    assert.deepEqual((await resolveKnowledgeToolScope(user, {}, context, { getCollectionForUser: async () => ({}) })).collectionIds, [2]);
    await assert.rejects(resolveKnowledgeToolScope(user, { collectionIds: [2] }, context, { getCollectionForUser: async () => null }), error => error.code === 'KNOWLEDGE_SCOPE_DENIED');
    await assert.rejects(resolveKnowledgeToolScope(user, { collectionIds: [-1] }, {}, {}), error => error.code === 'KNOWLEDGE_SCOPE_DENIED');
});

test('知识工具仅返回可信入选片段，包含可复核引用和截断信息', async () => {
    let ids;
    const result = await executeKnowledgeSearch({ query: '制度期限' }, user, {}, {
        debugRetrieveContext: async () => ({ matches: [{ chunkId: 1, score: .9, selected: true }, { chunkId: 9, score: .95, selected: false }], ranking: { mode: 'keyword_fallback' } }),
        readSourceChunks: async values => { ids = values; return [row]; }
    });
    assert.deepEqual(ids, [1]);
    assert.equal(result.matches.length, 1);
    assert.equal(result.matches[0].hit, true);
    assert.equal(result.matches[0].content.length, 1600);
    assert.equal(result.sources[0].truncated, true);
    assert.equal(result.sources[0].versionId, 5);
    assert.match(result.context, /citation: kb:4:v5:b6/);
    assert.equal(result.retrieval.completeDocument, false);
    assert.equal(result.retrieval.status, 'partial');
    assert.equal(resultStage(result).stage, 'knowledge');
    assert.equal(await revalidateKnowledgeToolEvidence([{ output: result }], user, { readSourceChunks: async () => [row], validateCitationKeys: async () => true }), true);
    assert.equal(await revalidateKnowledgeToolEvidence([{ output: result }], user, { readSourceChunks: async () => [{ ...row, content: '已修改' }] }), false);
    assert.equal(await revalidateKnowledgeToolEvidence([{ output: result }], user, { readSourceChunks: async () => [] }), false);
});

test('无可靠命中与检索服务失败区分，已撤权候选不返回正文', async () => {
    const empty = await executeKnowledgeSearch({ query: '未知' }, user, {}, { debugRetrieveContext: async () => ({ matches: [{ chunkId: 9, selected: false }] }), readSourceChunks: async () => [] });
    assert.equal(empty.retrieval.reasonCode, 'KNOWLEDGE_NO_RELIABLE_MATCH');
    const revoked = await executeKnowledgeSearch({ query: '未知' }, user, {}, { debugRetrieveContext: async () => ({ matches: [{ chunkId: 9, selected: true }] }), readSourceChunks: async () => [] });
    assert.equal(revoked.retrieval.reasonCode, 'KNOWLEDGE_SOURCE_UNAVAILABLE');
    assert.deepEqual(revoked.sources, []);
    await assert.rejects(executeKnowledgeSearch({ query: '未知' }, user, {}, { debugRetrieveContext: async () => { throw new Error('token=private-secret'); } }), error => error.code === 'KNOWLEDGE_RETRIEVAL_UNAVAILABLE' && !error.message.includes('secret'));
});

test('阶段诊断在事件展示中使用安全文字，业务成功不冒充内容验收成功', () => {
    assert.equal(failureStage({ code: 'KNOWLEDGE_SCOPE_DENIED' }).status, 'blocked');
    assert.equal(failureStage({ code: 'TOOL_ARTIFACT_MATERIALIZATION_FAILED' }).stage, 'delivery');
    const chain = resultStage({ artifactId: 1, renditionId: 2 });
    assert.match(chain.message, /内容核验/);
    const event = presentTaskEvent({ id: 1, event_type: 'tool.failed', payload: { tool: 'rag.search', chain: failureStage({ code: 'KNOWLEDGE_SCOPE_DENIED' }), errorCode: 'KNOWLEDGE_SCOPE_DENIED', errorMessage: 'private-secret' } });
    assert.doesNotMatch(event.detail, /private-secret/);
    assert.equal(event.chain.stage, 'knowledge');
});

test('知识范围以资源 ID 继承，删除或显式清除后不回退全库', async () => {
    const { resolveChatKnowledgeSelection } = require('../server/services/chat-knowledge-selection');
    const state = { sessionId: 'session', modelContent: '这个专题有哪些制度？' };
    const selected = await resolveChatKnowledgeSelection(state, user, 10, { latestKnowledgeScope: async () => ({ collectionIds: [3], tagNames: ['制度'] }), getCollectionForUser: async () => ({ name: '已重命名专题' }) });
    assert.equal(selected.inherited, true);
    assert.deepEqual(selected.scope.collectionIds, [3]);
    await assert.rejects(resolveChatKnowledgeSelection(state, user, 10, { latestKnowledgeScope: async () => ({ collectionIds: [3] }), getCollectionForUser: async () => null }), /重新选择/);
    await assert.rejects(resolveChatKnowledgeSelection(state, user, 10, { latestKnowledgeScope: async () => ({ cleared: true }) }), /清除资料范围/);
    assert.equal(await resolveChatKnowledgeSelection({ ...state, modelContent: '普通新问题' }, user, 10), null);
});

test('业务同义词只排序现有目录，不能创建不存在的工具', () => {
    const { rankTools } = require('../server/services/tool-discovery');
    const diagram = { name: 'mcp.8.render_diagram', title: '自定义工具' };
    assert.equal(rankTools('画流程图', [diagram])[0].tool.name, diagram.name);
    assert.deepEqual(rankTools('画流程图', []), []);
});

test('长知识结果按完整片段压缩，独立清单仍能发现未显示来源的撤权', async () => {
    const { compactToolOutputForModel } = require('../server/services/agent-tool-runtime');
    const { knowledgeEvidenceManifest } = require('../server/services/knowledge-tool-results');
    const source = { chunkId: 1, legacyDocumentId: 2, citationKey: 'kb:4:v5:b6', contentDigest: require('../server/services/knowledge-tool-results').digest(row.content) };
    const value = { knowledgeSourceVersion: 1, query: '制度', sources: [source], matches: [{ docName: '测试制度', content: '很长的片段'.repeat(5000), source }], retrieval: { status: 'succeeded' } };
    const compact = compactToolOutputForModel(value, {}, { maxTokens: 600 });
    assert.equal(compact.__partial, true);
    assert.deepEqual(compact.matches, []);
    const manifest = knowledgeEvidenceManifest(value);
    assert.equal(await revalidateKnowledgeToolEvidence([{ output: compact, knowledgeEvidence: manifest }], user, { readSourceChunks: async () => [row], validateCitationKeys: async () => true }), true);
    assert.equal(await revalidateKnowledgeToolEvidence([{ output: { ...compact, knowledgeEvidence: manifest } }], user, { readSourceChunks: async () => [] }), false);
});

test('任务步骤只在当前证据有效时展示来源，旧数据或校验故障不泄露历史内容', async () => {
    const { presentKnowledgeSteps } = require('../server/services/knowledge-tool-results');
    const step = { tool_name: 'rag.search', output: { knowledgeSourceVersion: 1, sources: [{ title: '敏感资料' }], matches: [{ content: '私有正文' }] }, error_message: '敏感资料' };
    assert.equal((await presentKnowledgeSteps([step], user, { revalidate: async () => true }))[0], step);
    for (const revalidate of [async () => false, async () => { throw new Error('服务不可用'); }]) {
        const redacted = (await presentKnowledgeSteps([step], user, { revalidate }))[0];
        assert.doesNotMatch(JSON.stringify(redacted), /敏感资料|私有正文/);
        assert.equal(redacted.output.retrieval.reasonCode, 'KNOWLEDGE_SOURCE_UNAVAILABLE');
    }
    const legacy = await presentKnowledgeSteps([{ tool_name: 'rag.search', output: { matches: [{ content: '私有正文' }] } }], user);
    assert.doesNotMatch(JSON.stringify(legacy), /私有正文/);
    const other = { tool_name: 'other', output: { text: '正常结果' } };
    assert.equal((await presentKnowledgeSteps([other], user))[0], other);
});
