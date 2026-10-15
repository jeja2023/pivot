const assert = require('node:assert/strict');
const test = require('node:test');
const {
    normalizeArticleKey,
    validateRegulationAiGrounding
} = require('../server/services/regulations/grounding');

const sources = [
    {
        index: 1,
        label: '中华人民共和国刑法 / v1 / 第十七条 刑事责任年龄',
        contextExcerpt: '已满十六周岁的人犯罪，应当负刑事责任。'
    },
    {
        index: 2,
        label: '中华人民共和国刑法 / v1 / 第二百三十六条 强奸罪',
        contextExcerpt: '以暴力、胁迫或者其他手段强奸妇女的，依照本条规定处罚。'
    }
];

test('法规问答依据核验接受存在于本轮候选且带来源编号的条文引用', () => {
    const result = validateRegulationAiGrounding({
        question: '已满十六周岁犯罪是否承担刑事责任？',
        sources,
        answer: '【核心法条】已满十六周岁的人犯罪，应当负刑事责任。《中华人民共和国刑法》第十七条。[1]\n\n【关联法条】无。\n\n【适用建议】仍需结合具体行为判断。[1]'
    });

    assert.equal(result.grounding.accepted, true);
    assert.equal(result.grounding.status, 'verified');
    assert.deepEqual(result.grounding.citedSourceIndexes, [1]);
    assert.equal(result.answer.includes('【核心法条】'), true);
});

test('法规问答依据核验拦截候选中不存在的法律条号并返回澄清答复', () => {
    const result = validateRegulationAiGrounding({
        question: '三年有期徒刑',
        sources: [sources[0]],
        answer: '建议查阅《中华人民共和国刑法》第二百三十六条并据此定罪量刑。[1]'
    });

    assert.equal(result.grounding.accepted, false);
    assert.equal(result.grounding.status, 'insufficient_evidence');
    assert.ok(result.grounding.ungroundedReferences.some(reference => reference.includes('第二百三十六条')));
    assert.match(result.answer, /检索得到 1 条直接检索候选/);
    assert.doesNotMatch(result.answer, /第二百三十六条/);
});

test('法规问答依据核验拒绝无来源编号的实质性回答，并统一短语型提问的说明', () => {
    const result = validateRegulationAiGrounding({
        question: '三年有期徒刑',
        sources: [sources[0]],
        answer: '已满十六周岁的人犯罪，应当负刑事责任。'
    });

    assert.equal(result.grounding.accepted, false);
    assert.ok(result.grounding.reasonCodes.includes('missing_source_citation'));
    assert.match(result.answer, /请补充具体罪名或业务事项/);
});

test('法规问答依据核验对无候选结果不允许模型自行补充法条', () => {
    const result = validateRegulationAiGrounding({
        question: '没有命中时能否直接引用刑法？',
        sources: [],
        answer: '《中华人民共和国刑法》第二百三十六条规定了相关处罚。'
    });

    assert.equal(result.grounding.accepted, false);
    assert.equal(result.grounding.status, 'no_candidates');
    assert.match(result.answer, /未返回可用的条文候选/);
});

test('法规问答依据核验统一中文和阿拉伯数字条号', () => {
    assert.equal(normalizeArticleKey('第二百三十六条'), '第236条');
    assert.equal(normalizeArticleKey('第236条之二'), '第236条之2');
});

test('法规问答依据核验允许法规全称与候选标题使用中华人民共和国前缀的差异', () => {
    const result = validateRegulationAiGrounding({
        question: '是否承担刑事责任？',
        sources: [{ ...sources[0], label: '刑法 / v1 / 第十七条 刑事责任年龄' }],
        answer: '已满十六周岁的人犯罪，应当负刑事责任。《中华人民共和国刑法》第十七条。[1]'
    });
    assert.equal(result.grounding.accepted, true);
});
