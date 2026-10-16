'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { buildKnowledgeRetrievalPlan } = require('../server/services/knowledge-query-planner');
const { validateKnowledgeAnswer, verifyKnowledgeAnswerSemantics, verifyKnowledgeAnswerWithRepair } = require('../server/services/knowledge-grounding');
const { retrieveKnowledgeEvidence } = require('../server/services/knowledge-answer-service');
const { createChatRagResponseFlow } = require('../server/services/chat-rag-grounding');
const { resolveKnowledgeTopK } = require('../server/services/rag-index');
const { resolveAccessibleAnswerModelAsync } = require('../server/services/models');

test('知识问答未指定模型时选个人默认，并在默认缺失时使用可授权模型', async () => {
    const user = { id: 7, default_model_id: 2 };
    const calls = [];
    const getModel = async id => {
        calls.push(id);
        return id === 2 ? { id: 2 } : id === 9 ? { id: 9 } : null;
    };
    assert.equal((await resolveAccessibleAnswerModelAsync(null, user, { getModel, listModels: async () => [{ id: 9 }] })).id, 2);
    assert.deepEqual(calls, [2]);
    calls.length = 0;
    const fallback = await resolveAccessibleAnswerModelAsync(null, { id: 7, default_model_id: 3 }, { getModel, listModels: async () => [{ id: 9 }] });
    assert.equal(fallback.id, 9);
    assert.deepEqual(calls, [3, null, 9]);
    assert.equal(await resolveAccessibleAnswerModelAsync(99, user, { getModel, listModels: async () => [{ id: 9 }] }), null);
});

test('知识库短追问会结合上一轮问题生成完整检索式', () => {
    const plan = buildKnowledgeRetrievalPlan({
        question: '那期限呢？',
        history: [
            { role: 'user', content: '公司的差旅报销审批流程是什么？' },
            { role: 'assistant', content: '请先提交出差申请单。' }
        ]
    });
    assert.equal(plan.followUpResolved, true);
    assert.match(plan.rewrittenQuery, /差旅报销审批流程/);
    assert.match(plan.rewrittenQuery, /期限/);
});

test('知识库复合问题会拆出有限数量的子查询，避免单一长句压低召回率', () => {
    const plan = buildKnowledgeRetrievalPlan({ question: '差旅报销需要哪些材料；审批流程是什么；多久提交？' });
    assert.ok(plan.retrievalQueries.length >= 2);
    assert.ok(plan.retrievalQueries.length <= 3);
});

test('知识库法律问答会抽取罪名核心词作为检索锚点，避免泛词召回无关条文', () => {
    const plan = buildKnowledgeRetrievalPlan({ question: '触犯抢劫罪，可以判刑几年？' });
    assert.ok(plan.requiredTerms.includes('抢劫罪'));
    assert.ok(plan.requiredTerms.includes('抢劫'));
    assert.ok(plan.retrievalQueries.includes('抢劫罪'));
});

test('知识库严格回答核验拒绝没有来源引用的模型正文', () => {
    const context = '[引用 1 | citation:kb:1:v1:b1 | 来源:制度.md · 片段 1]: 报销申请应在返岗后十个工作日内提交。';
    const result = validateKnowledgeAnswer({
        answer: '报销申请应在十个工作日内提交。',
        ragContext: context,
        strict: true
    });
    assert.equal(result.grounding.accepted, false);
    assert.equal(result.grounding.status, 'citation_required');
});

test('知识库严格回答核验接受有效引用并拒绝不存在的引用编号', () => {
    const context = '[引用 1 | citation:kb:1:v1:b1 | 来源:制度.md · 片段 1]: 报销申请应在返岗后十个工作日内提交。';
    const accepted = validateKnowledgeAnswer({
        answer: '报销申请应在返岗后十个工作日内提交。[引用 1 | citation:kb:1:v1:b1]',
        ragContext: context,
        strict: true
    });
    assert.equal(accepted.grounding.accepted, true);
    assert.deepEqual(accepted.grounding.citedSourceIndexes, [1]);

    const rejected = validateKnowledgeAnswer({
        answer: '报销申请应在返岗后十个工作日内提交。[引用 2]',
        ragContext: context,
        strict: true
    });
    assert.equal(rejected.grounding.accepted, false);
    assert.deepEqual(rejected.grounding.invalidSourceIndexes, [2]);
});

test('知识库严格回答核验会拒绝引用存在但结论与来源片段无关的内容', () => {
    const context = '[引用 1 | citation:kb:1:v1:b1 | 来源:制度.md · 片段 1]: 报销申请应在返岗后十个工作日内提交。';
    const result = validateKnowledgeAnswer({
        answer: '采购合同必须经过法务会签。[引用 1 | citation:kb:1:v1:b1]',
        ragContext: context,
        strict: true
    });
    assert.equal(result.grounding.accepted, false);
    assert.equal(result.grounding.status, 'claim_not_supported');
    assert.equal(result.grounding.unsupportedClaims.length, 1);
});

test('知识库严格回答核验拒绝在已引用结论旁夹带未引用事实句', () => {
    const context = '[引用 1 | citation:kb:1:v1:b1 | 来源:制度.md · 片段 1]: 报销申请应在返岗后十个工作日内提交。';
    const result = validateKnowledgeAnswer({
        answer: '报销申请应在返岗后十个工作日内提交。[引用 1 | citation:kb:1:v1:b1]\n采购合同还必须经过法务会签。',
        ragContext: context,
        strict: true
    });
    assert.equal(result.grounding.accepted, false);
    assert.equal(result.grounding.status, 'citation_required');
    assert.equal(result.grounding.unsupportedClaims[0].reason, 'missing_citation');
});

test('知识库语义复核拒绝模型判定不被来源蕴含的结论', async () => {
    const context = '[引用 1 | citation:kb:1:v1:b1 | 来源:制度.md · 片段 1]: 报销申请应在返岗后十个工作日内提交。';
    const result = await verifyKnowledgeAnswerSemantics({
        answer: '报销申请应在返岗后十个工作日内提交。[引用 1 | citation:kb:1:v1:b1]',
        ragContext: context,
        modelCfg: { id: 1, model_name: 'test' },
        user: { id: 1 },
        enabled: true,
        callModel: async () => ({ content: JSON.stringify({ claims: [{ index: 1, supported: false, sourceIds: [1] }] }) })
    });
    assert.equal(result.grounding.accepted, false);
    assert.equal(result.grounding.status, 'claim_not_semantically_supported');
});

test('知识库语义复核接受模型判定被同一来源蕴含的结论', async () => {
    const context = '[引用 1 | citation:kb:1:v1:b1 | 来源:制度.md · 片段 1]: 报销申请应在返岗后十个工作日内提交。';
    const result = await verifyKnowledgeAnswerSemantics({
        answer: '报销申请应在返岗后十个工作日内提交。[引用 1 | citation:kb:1:v1:b1]',
        ragContext: context,
        modelCfg: { id: 1, model_name: 'test' },
        user: { id: 1 },
        enabled: true,
        callModel: async () => ({ content: JSON.stringify({ claims: [{ index: 1, supported: true, sourceIds: [1] }] }) })
    });
    assert.equal(result.grounding.accepted, true);
    assert.equal(result.grounding.status, 'semantically_verified');
});

test('知识库回答缺少引用时只接受修复后通过来源核验的正文', async () => {
    const context = '[引用 1 | citation:kb:1:v1:b1 | 来源:制度.md · 片段 1 | 检索可信度: 82%]: 报销申请应在返岗后十个工作日内提交。';
    const result = await verifyKnowledgeAnswerWithRepair({
        answer: '报销申请应在返岗后十个工作日内提交。',
        ragContext: context,
        question: '报销申请什么时候提交？',
        modelCfg: { id: 1 },
        user: { id: 1 },
        enabled: false,
        callModel: async () => ({ content: '报销申请应在返岗后十个工作日内提交。[引用 1 | citation:kb:1:v1:b1]' })
    });
    assert.equal(result.grounding.accepted, true);
    assert.equal(result.grounding.citationRepaired, true);
    assert.deepEqual(result.grounding.citedSourceIndexes, [1]);

    const rejected = await verifyKnowledgeAnswerWithRepair({
        answer: '采购合同必须经过法务会签。',
        ragContext: context,
        modelCfg: { id: 1 },
        user: { id: 1 },
        enabled: false,
        callModel: async () => ({ content: '采购合同必须经过法务会签。[引用 1]' })
    });
    assert.equal(rejected.grounding.accepted, false);
    assert.match(rejected.answer, /未能通过知识库来源核验/);

    const corrected = await verifyKnowledgeAnswerWithRepair({
        answer: '采购合同必须经过法务会签。[引用 1]',
        ragContext: context,
        modelCfg: { id: 1 },
        user: { id: 1 },
        enabled: false,
        callModel: async () => ({ content: '报销申请应在返岗后十个工作日内提交。[引用 1 | citation:kb:1:v1:b1]' })
    });
    assert.equal(corrected.grounding.accepted, true);
    assert.equal(corrected.grounding.citationRepaired, true);
});

test('知识库复杂问题自动扩大检索 Top-K，简单问题保持默认规模', () => {
    assert.equal(resolveKnowledgeTopK('你好', 3, 10), 3);
    assert.equal(resolveKnowledgeTopK('请比较差旅报销和采购报销的审批流程、材料以及时限？', 3, 10), 5);
});

test('知识库统一证据服务合并复合问题的多路召回，并保留受门控的真实依据', async () => {
    const calls = [];
    const evidence = await retrieveKnowledgeEvidence({
        user: { id: 7 },
        query: '差旅报销需要哪些材料；审批流程是什么；多久提交？',
        retrieve: async (_userId, query) => {
            calls.push(query);
            const isMaterial = query.includes('材料');
            return {
                matches: [{
                    chunkId: isMaterial ? 101 : 102,
                    selected: true,
                    citationKey: isMaterial ? 'kb:7:v1:b101' : 'kb:7:v1:b102',
                    rank: 1
                }],
                ranking: { mode: 'hybrid_rrf' },
                injectedContext: `【参考内部知识库信息如下】：\n[引用 1 | citation:kb:7:v1:b${isMaterial ? 101 : 102} | 来源:差旅制度]: ${isMaterial ? '材料包括申请单。' : '返岗后十个工作日内提交。'}\n请基于上述参考信息回答我的问题。`,
                scope: { collectionId: 3 }
            };
        }
    });
    assert.ok(calls.length >= 2 && calls.length <= 3);
    assert.equal(evidence.selected.length, 2);
    assert.equal(evidence.candidateCount, 2);
    assert.match(evidence.injectedContext, /\[引用 1/);
    assert.match(evidence.injectedContext, /\[引用 2/);
});

test('普通聊天流在未要求知识库依据核验时保持原有内容输出与无审计行为', async () => {
    const events = [];
    const flow = createChatRagResponseFlow({
        contextResult: { ragGrounding: { required: false } },
        splitStreamTextForDisplay: value => [value],
        writeSse: value => events.push(JSON.parse(value))
    });
    flow.writeContent('普通回答');
    const grounded = await flow.ground('普通回答');
    const audit = await flow.audit('普通回答', null, {});
    assert.deepEqual(events, [{ content: '普通回答' }]);
    assert.equal(grounded.assistantContent, '普通回答');
    assert.equal(grounded.ragGrounding, null);
    assert.equal(audit, null);
});

