'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { defaultPresentation, normalizePresentation, computePresentationDigest } = require('../server/services/presentations/presentation-schema');
const { prepare, messages } = require('../server/services/presentations/storyline/plan');
const profile = require('../server/services/presentations/presentation-production-profile');
const ai = require('../server/services/presentations/presentation-ai');
const master = require('../server/services/presentations/master/contract');
const { getBuiltInTemplate } = require('../server/services/presentations/presentation-templates');

function document() {
    const content = defaultPresentation({ title: '经营情况' });
    content.slides[0].elements[1].content.text = '收入120万元';
    content.slides.push({ ...globalThis.structuredClone(content.slides[0]), id: 'slide_2', index: 1 });
    content.metadata.productionProfile = profile.fromRequest({ audience: '决策人员', purpose: '确定后续行动', consumptionMode: 'reading', duration: 12 });
    return { content: normalizePresentation(content) };
}
function plan() { return { summary: '先说明情况，再安排具体行动', slideOrder: ['slide_1', 'slide_2'], updates: [{ slideId: 'slide_1', reason: '突出已提供材料中的结论', intent: { purpose: '说明经营情况', takeaway: '收入120万元', bridgeToNext: '转入后续行动', stage: 'evidence', relation: 'sequence', durationSeconds: 40 }, textEdits: [{ elementId: 'title', text: '收入120万元' }] }] }; }

test('故事线建议可重复校验和摘要核对，保留几何、事实登记及制作目标且不修改原稿', () => {
    const source = document(), before = JSON.stringify(source), proposal = prepare(JSON.stringify(plan()), source);
    assert.equal(JSON.stringify(source), before);
    assert.equal(proposal.content.slides[0].elements[0].content.text, '收入120万元');
    assert.equal(proposal.content.slides[0].elements[0].width, source.content.slides[0].elements[0].width);
    assert.deepEqual(proposal.content.metadata.productionProfile, source.content.metadata.productionProfile);
    assert.equal(proposal.preview.changes[0].textEdits[0].before, '经营情况');
    assert.equal(prepare(proposal.plan, source).planDigest, proposal.planDigest);
    assert.equal(proposal.sourceDigest, computePresentationDigest(source.content));
    assert.equal(proposal.preview.changes[0].intentAfter.bridgeToNext, '转入后续行动');
});

test('故事线拒绝越界字段、删页、重复页、数值注入、锁定元素和批准页修改', () => {
    for (const mutate of [value => value.extra = true, value => value.slideOrder.pop(), value => value.slideOrder[1] = 'slide_1',
        value => value.updates[0].textEdits[0].text = '收入999万元', value => value.updates[0].textEdits[0].elementId = 'missing',
        value => value.updates[0].intent.claims = [], value => value.updates[0].textEdits[0].text = '']) {
        const value = plan(); mutate(value); assert.throws(() => prepare(value, document()));
    }
    const locked = document(); locked.content.slides[0].elements[0].locked = true;
    assert.throws(() => prepare(plan(), locked), /锁定/);
    const approved = document(); approved.content.slides[0].review = { status: 'approved', reviewedBy: '1', reviewedAt: new Date().toISOString() };
    assert.throws(() => prepare(plan(), approved), /批准/);
    const reorder = plan(); reorder.slideOrder.reverse(); reorder.updates = [];
    assert.throws(() => prepare(reorder, approved), /移动已批准/);
});

test('单页方案不能改动别页或页序，整稿可重排且预览标明原页码', () => {
    const reordered = plan(); reordered.slideOrder.reverse();
    assert.throws(() => prepare(reordered, document(), 'page', 'slide_1'), /单页/);
    assert.throws(() => prepare(plan(), document(), 'page', 'slide_2'), /范围外/);
    assert.equal(prepare(reordered, document()).preview.order[0].before, 2);
    assert.throws(() => prepare({ summary: '不需要改动', slideOrder: ['slide_1', 'slide_2'], updates: [] }, document()), /未提出实际修改/);
});

test('统一目标进入创建、续写和Master契约，标准与语义生成结果保留目标和逐页衔接', async () => {
    const source = document(), productionProfile = source.content.metadata.productionProfile;
    for (const builder of [ai.buildOutlineMessages, ai.buildSlidesMessages]) assert.ok(JSON.stringify(builder({ topic: '经营安排', productionProfile })).includes('确定后续行动'));
    assert.ok(JSON.stringify(ai.buildContinueMessages({ presentation: source.content })).includes('决策人员'));
    const normal = ai.parsePresentationProposal(JSON.stringify({ title: '标准生成', slides: source.content.slides }), { productionProfile });
    assert.deepEqual(normal.presentation.metadata.productionProfile, productionProfile);
    const semantic = await ai.compilePresentationProposal(JSON.stringify({ title: '语义生成', slides: [{ title: '说明经营情况', layout: 'content', points: ['收入120万元'], intent: plan().updates[0].intent }] }), { template: getBuiltInTemplate('learning-studio'), productionProfile });
    assert.deepEqual(semantic.presentation.metadata.productionProfile, productionProfile);
    assert.equal(semantic.presentation.slides[0].intent.bridgeToNext, '转入后续行动');
    const request = master.normalize({ title: '制作目标', instruction: '生成经营安排', modelId: '1', productionProfile });
    assert.deepEqual(request.productionProfile, productionProfile);
    assert.notEqual(request.sourceDigest, master.normalize({ title: '制作目标', instruction: '生成经营安排', modelId: '1' }).sourceDigest);
    assert.throws(() => profile.fromRequest({ productionProfile: { targetDurationSeconds: -1 } }));
    assert.ok(messages(source, 'page', 'slide_1', '突出结论')[1].content.includes('确定后续行动'));
});
