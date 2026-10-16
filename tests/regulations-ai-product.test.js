'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { buildRegulationAiQueryPlan } = require('../server/services/regulations/ai-planning');
const { buildRegulationEvidenceExcerpt } = require('../server/services/regulations/evidence');
const { validateRegulationAiGrounding } = require('../server/services/regulations/grounding');

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

