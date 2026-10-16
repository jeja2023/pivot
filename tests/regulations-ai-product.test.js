'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { buildRegulationAiQueryPlan } = require('../server/services/regulations/ai-planning');
const { buildRegulationEvidenceExcerpt } = require('../server/services/regulations/evidence');
const { buildRegulationUnverifiedModelAnswer, validateRegulationAiGrounding } = require('../server/services/regulations/grounding');

test('法规问答查询规划会把短追问补全为上一轮主题，并保留条号/法名锚点', () => {
    const plan = buildRegulationAiQueryPlan({
        question: '那期限呢？',
        history: [{ question: '《测试办法》对审批流程有哪些要求？', answer: '已检索到流程条文。' }]
    });
    assert.equal(plan.followUpResolved, true);
    assert.ok(plan.retrievalQueries.some(query => query.includes('审批流程')));

    const articlePlan = buildRegulationAiQueryPlan({ question: '《测试办法》第十二条的生效日期是什么？' });
    assert.equal(articlePlan.articleReference, '第十二条');
    assert.equal(articlePlan.namedRegulation, '《测试办法》');

    const crimePlan = buildRegulationAiQueryPlan({ question: '抢劫罪最高可以判处多少年有期徒刑' });
    assert.ok(crimePlan.retrievalQueries.includes('抢劫'));
    assert.ok(crimePlan.retrievalQueries.includes('抢劫罪'));
});

test('法规证据窗口优先保留长条文中真正命中的句子', () => {
    const content = `第一条 ${'前置说明。'.repeat(160)}关键期限审查：应在三十日内完成。${'补充说明。'.repeat(30)}`;
    const result = buildRegulationEvidenceExcerpt(content, ['关键期限审查', '三十日内完成'], { maxLength: 900, before: 120 });
    assert.match(result.excerpt, /关键期限审查/);
    assert.match(result.excerpt, /三十日内完成/);
    assert.ok(result.charStart > 0);
});

test('法规结构化问答必须逐条提供候选编号和原文短引', () => {
    const sources = [{
        index: 1,
        label: '测试办法 / v1 / 第一条 审批期限',
        contextExcerpt: '审批事项应当在三十日内完成。'
    }];
    const accepted = validateRegulationAiGrounding({
        question: '审批期限是多少？',
        sources,
        answer: JSON.stringify({
            answerability: 'adequate',
            claims: [{ text: '审批事项应当在三十日内完成', sourceIds: [1], quote: '审批事项应当在三十日内完成。' }],
            answer: '应留出内部复核时间。'
        })
    });
    assert.equal(accepted.grounding.accepted, true);
    assert.equal(accepted.grounding.format, 'structured');
    assert.match(accepted.answer, /三十日内完成/);

    const rejected = validateRegulationAiGrounding({
        question: '审批期限是多少？',
        sources,
        answer: JSON.stringify({
            answerability: 'adequate',
            claims: [{ text: '审批期限为十五日', sourceIds: [1], quote: '审批期限为十五日。' }],
            answer: ''
        })
    });
    assert.equal(rejected.grounding.accepted, false);
    assert.equal(rejected.grounding.status, 'candidate_conflict');
});

test('法规模型在 JSON 前输出说明时仍可核验真实条文引用', () => {
    const result = validateRegulationAiGrounding({
        question: '审批期限是多少？',
        sources: [{ index: 1, label: '测试办法 / 第一条', contextExcerpt: '审批事项应当在三十日内完成。' }],
        answer: '以下是依据：\n' + JSON.stringify({
            answerability: 'adequate',
            claims: [{ text: '审批事项应当在三十日内完成', sourceIds: [1], quote: '审批事项应当在三十日内完成。' }],
            answer: '请核对具体起算日。'
        })
    });
    assert.equal(result.grounding.accepted, true);
});

test('法规缺少条文或模型引用格式时保留显式未核验的参考回答', () => {
    const answer = buildRegulationUnverifiedModelAnswer(JSON.stringify({ answer: '具体刑罚应结合情节判断。' }), { hasCandidates: true });
    assert.match(answer, /未核验的模型参考回答/);
    assert.match(answer, /具体刑罚应结合情节判断/);
    assert.match(answer, /模型未提供可核验引用/);
    assert.doesNotMatch(answer, /"answer"/);
    const missingIndex = buildRegulationUnverifiedModelAnswer('请核对法规', { indexStatus: 'no_recorded_articles' });
    assert.match(missingIndex, /检查导入和索引状态/);
});

