'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { executeKnowledgeGraphQuery } = require('../server/services/knowledge-graph-tool-results');
const { digest, revalidateKnowledgeToolEvidence, presentKnowledgeSteps } = require('../server/services/knowledge-tool-results');
const user = { id: 7, role: 'user' };
const row = { chunk_id: 1, doc_id: 2, collection_id: 3, document_id: 4, version_id: 5, block_id: 6,
    citation_key: 'kb:4:v5:b6', name: '当前制度', content: '运维中心负责测试平台。', char_start: 0, char_end: 12 };
const relation = { id: 10, source_entity_id: 11, target_entity_id: 12, source_name: '运维中心', target_name: '测试平台',
    relation_type: 'responsible_for', description: '依据制度划分职责', source_doc_id: 2, source_chunk_id: 1, confidence: .9, doc_name: '过时名称', excerpt_hash: `sha256:${digest(row.content)}` };
function dependencies(overrides = {}) {
    return { queryKnowledgeGraph: async () => ({ relations: [relation], entities: [{ name: '越界实体', description: '越界描述' }], context: '越界上下文' }),
        readSourceChunks: async () => [row], validateCitationKeys: async () => true, getCollectionForUser: async () => ({ id: 3 }), ...overrides };
}

test('图谱工具以统一契约返回当前引用与原文，原始上下文和聚合实体不外传', async () => {
    const result = await executeKnowledgeGraphQuery({ query: '平台由谁负责' }, user, {}, dependencies());
    assert.equal(result.knowledgeSourceVersion, 1);
    assert.equal(result.retrieval.status, 'succeeded');
    assert.equal(result.sources[0].versionId, 5);
    assert.equal(result.sources[0].contentDigest, digest(row.content));
    assert.equal(result.paths[0].citationKey, row.citation_key);
    assert.equal(result.paths[0].docName, row.name);
    assert.deepEqual(result.paths[0].locator, { charStart: 0, charEnd: 12 });
    assert.equal(result.matches[0].graphPaths.length, 1);
    assert.match(result.context, /citation: kb:4:v5:b6/);
    assert.doesNotMatch(JSON.stringify(result), /越界|过时名称/);
    assert.equal(await revalidateKnowledgeToolEvidence([{ output: result }], user, dependencies()), true);
    const compact = require('../server/services/agent-tool-runtime').compactToolOutputForModel(result, {}, { maxTokens: 4000 });
    assert.equal(compact.matches[0].graphPaths[0].citationKey, row.citation_key);
});

test('图谱按会话、任务及本次选择求交集，并在取回片段和复核时保持范围', async () => {
    const scopes = [];
    const run = { metadata: { chatBridge: { ragScope: { collectionIds: [3, 8] } } }, context_config: { collectionIds: [3] } };
    await executeKnowledgeGraphQuery({ query: '职责', collectionIds: [3, 9] }, user, { run }, dependencies({
        queryKnowledgeGraph: async input => { scopes.push(input.scope); return { relations: [relation] }; },
        readSourceChunks: async (_ids, _actor, scope) => { scopes.push(scope); return [row]; }
    }));
    assert.equal(scopes.length, 3);
    assert.ok(scopes.every(scope => JSON.stringify(scope.collectionIds) === '[3]'));
    await assert.rejects(executeKnowledgeGraphQuery({ query: '职责', collectionIds: [9] }, user, { run }, dependencies()), error => error.code === 'KNOWLEDGE_SCOPE_DENIED');
    await assert.rejects(executeKnowledgeGraphQuery({ query: '职责', collectionIds: [3] }, user, {}, dependencies({ getCollectionForUser: async () => null })), error => error.code === 'KNOWLEDGE_SCOPE_DENIED');
});

test('失效、无引用或文档不匹配的图谱关系不返回正文和实体，部分有效时明确降级', async () => {
    const hidden = { ...relation, id: 20, source_name: '受限部门', source_chunk_id: 99, source_doc_id: 98 };
    const partial = await executeKnowledgeGraphQuery({ query: '职责' }, user, {}, dependencies({ queryKnowledgeGraph: async () => ({ relations: [relation, hidden] }) }));
    assert.equal(partial.retrieval.status, 'partial');
    assert.equal(partial.paths.length, 1);
    assert.doesNotMatch(JSON.stringify(partial), /受限部门/);
    for (const rows of [[], [{ ...row, citation_key: '' }], [{ ...row, doc_id: 100 }]]) {
        const result = await executeKnowledgeGraphQuery({ query: '职责' }, user, {}, dependencies({ readSourceChunks: async () => rows }));
        assert.equal(result.retrieval.status, 'blocked');
        assert.equal(result.retrieval.reasonCode, 'KNOWLEDGE_SOURCE_UNAVAILABLE');
        assert.deepEqual(result.paths, []);
        assert.deepEqual(result.entities, []);
        assert.equal(result.context, '');
        assert.doesNotMatch(JSON.stringify(result), /运维中心|测试平台/);
    }
});

test('图谱查询后撤权、版本切换或正文改变时丢弃本次结果', async () => {
    for (const currentRows of [[], [{ ...row, content: '新内容' }], [{ ...row, citation_key: 'kb:4:v6:b7' }]]) {
        let reads = 0;
        const result = await executeKnowledgeGraphQuery({ query: '职责' }, user, {}, dependencies({ readSourceChunks: async () => ++reads === 1 ? [row] : currentRows }));
        assert.equal(result.retrieval.reasonCode, 'KNOWLEDGE_SOURCE_UNAVAILABLE');
        assert.deepEqual(result.sources, []);
        assert.doesNotMatch(JSON.stringify(result), /运维中心|测试平台/);
    }
    const old = await executeKnowledgeGraphQuery({ query: '职责' }, user, {}, dependencies({ validateCitationKeys: async () => false }));
    assert.equal(old.retrieval.status, 'blocked');
    assert.deepEqual(old.relations, []);
});

test('旧图谱依据不能绑定到新片段版本，缺少摘要的旧关系需重建', async () => {
    for (const excerpt_hash of ['', `sha256:${digest('旧正文')}`]) {
        const result = await executeKnowledgeGraphQuery({ query: '职责' }, user, {}, dependencies({ queryKnowledgeGraph: async () => ({ relations: [{ ...relation, excerpt_hash }] }) }));
        assert.equal(result.retrieval.status, 'blocked');
        assert.deepEqual(result.sources, []);
        assert.deepEqual(result.paths, []);
    }
    const excerpt = '运维中心负责测试平台';
    const result = await executeKnowledgeGraphQuery({ query: '职责' }, user, {}, dependencies({ queryKnowledgeGraph: async () => ({ relations: [{ ...relation, excerpt_hash: `sha256:${digest(excerpt)}`, excerpt_text: excerpt }] }) }));
    assert.equal(result.paths.length, 1);
});

test('无图谱命中与服务故障可区分，异常不暴露连接信息', async () => {
    const result = await executeKnowledgeGraphQuery({ query: '未知' }, user, {}, dependencies({ queryKnowledgeGraph: async () => ({ relations: [] }), readSourceChunks: async () => [] }));
    assert.equal(result.retrieval.reasonCode, 'KNOWLEDGE_NO_RELIABLE_MATCH');
    for (const dependency of ['queryKnowledgeGraph', 'readSourceChunks', 'validateCitationKeys']) {
        await assert.rejects(executeKnowledgeGraphQuery({ query: '职责' }, user, {}, dependencies({ [dependency]: async () => { throw new Error('token=private-secret'); } })),
            error => error.code === 'KNOWLEDGE_RETRIEVAL_UNAVAILABLE' && !error.message.includes('private-secret'));
    }
    await assert.rejects(executeKnowledgeGraphQuery({ query: '' }, user, {}, dependencies()), /填写/);
});

test('图谱历史和字符串节点结果重新复核，旧格式与空来源伪装不会外传', async () => {
    const result = await executeKnowledgeGraphQuery({ query: '职责' }, user, {}, dependencies());
    const step = { tool_name: 'knowledge.graph.query', output: JSON.stringify(result) };
    assert.equal((await presentKnowledgeSteps([step], user, { revalidate: async observations => revalidateKnowledgeToolEvidence(observations, user, dependencies()) }))[0], step);
    const redacted = await presentKnowledgeSteps([step, { tool_name: 'knowledge.graph.query', output: { context: '敏感旧图谱' } }], user, { revalidate: async () => false });
    assert.doesNotMatch(JSON.stringify(redacted), /运维中心|测试平台|敏感旧图谱/);
    const pending = { tool_name: 'knowledge.graph.query', status: 'pending', output: null };
    assert.equal((await presentKnowledgeSteps([pending], user))[0], pending);
    assert.equal((await presentKnowledgeSteps([{ ...pending, status: 'completed' }], user))[0].output.retrieval.reasonCode, 'KNOWLEDGE_SOURCE_UNAVAILABLE');
    assert.equal(await revalidateKnowledgeToolEvidence([{ output: { knowledgeSourceVersion: 1, sources: [], matches: [{ content: '伪造事实' }] } }], user), false);
    assert.equal(require('../server/services/knowledge-output-guard').holdKnowledgeOutput({}, [{ tool: 'knowledge.graph.query' }]), true);
});

test('来源清单的文档、版本、片段和索引代次不能与引用键错配', async () => {
    const result = await executeKnowledgeGraphQuery({ query: '职责' }, user, {}, dependencies());
    for (const patch of [{ documentId: 99 }, { versionId: 99 }, { blockId: 99 }, { collectionId: 99 }, { indexVersion: '其他索引' }]) {
        const changed = { ...result, sources: result.sources.map(source => ({ ...source, ...patch })) };
        assert.equal(await revalidateKnowledgeToolEvidence([{ output: changed }], user, dependencies()), false);
    }
    for (const patch of [{ relations: [{ description: '伪造事实' }] }, { entities: [{ name: '伪造实体' }] }]) {
        assert.equal(await revalidateKnowledgeToolEvidence([{ output: { knowledgeSourceVersion: 1, sources: [], ...patch } }], user), false);
    }
});
