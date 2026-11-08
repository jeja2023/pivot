'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { compileDesignPlan } = require('../server/services/presentations/presentation-design-compiler');
const { getBuiltInTemplate } = require('../server/services/presentations/presentation-templates');
const { normalizeMaterials, materialToPresentationSource } = require('../server/services/presentations/presentation-evidence');
const { normalizePresentation, computePresentationDigest } = require('../server/services/presentations/presentation-schema');
const { analyzePresentationSemantics } = require('../server/services/presentations/presentation-semantics');
const { runRenderedPresentationQuality } = require('../server/services/presentations/presentation-render-quality');

const template = getBuiltInTemplate('executive-clean');
const quote = '本期收入120万元，成本80万元。';
function plan(result = 40) {
    return { title: '经营复盘', productionProfile: { requireCitations: true, audience: '经营负责人', targetDurationSeconds: 180 }, slides: [
        { title: '收入与成本差额为40万元', layout: 'chart', sourceRefs: ['finance'], intent: { purpose: '说明同口径差额', takeaway: '差额为40万元', stage: 'evidence', relation: 'comparison', durationSeconds: 60 },
            chart: { type: 'bar', columns: ['指标', '万元'], rows: [['收入', 120], ['成本', 80]] },
            claims: [{ id: 'margin', text: '收入与成本差额为40万元', type: 'calculation', sourceRefs: ['finance'], evidence: [{ sourceId: 'finance', quote, locator: '经营报告第3节' }], calculation: { operation: 'difference', values: [120, 80], result, unit: '万元' } }] }
    ] };
}

test('长材料中的精确证据绑定真实材料快照，保留定位并复算数据，不将所有来源关联每页', async () => {
    const sources = normalizeMaterials([{ id: 'finance', title: '经营报告', text: '材料前文。'.repeat(700) + quote }, { id: 'people', title: '人员安排', text: '交付组负责计划。' }]);
    const result = await compileDesignPlan(plan(), template, sources), content = result.presentation;
    assert.deepEqual(content.slides[0].sourceRefs, ['finance']);
    assert.ok(content.slides[0].elements.every(element => !element.sourceRefs.includes('people')));
    const slice = content.sources[0].evidenceSlices[0];
    assert.equal(sources[0].text.slice(slice.start, slice.end), quote);
    assert.equal(slice.sourceDigest, sources[0].digest);
    const report = analyzePresentationSemantics(content);
    assert.equal(report.status, 'passed', JSON.stringify(report.issues));
    assert.equal(report.receipts[0].evidence[0].status, 'snapshot_slice_matched');
    assert.equal(report.receipts[0].pageBinding, 'current'); assert.equal(report.summary.checkedCalculations, 1);
    assert.equal(content.sources[0].text, undefined, '源稿只保存所需片段，不复制整份长材料');
});

test('数值或讲稿改动使原论点绑定失效，单纯排版变化保留有效绑定', async () => {
    const sources = normalizeMaterials([{ id: 'finance', text: quote }]);
    const content = (await compileDesignPlan(plan(), template, sources)).presentation;
    const moved = globalThis.structuredClone(content); moved.slides[0].elements.find(element => element.type === 'chart').x += 4;
    assert.equal(analyzePresentationSemantics(moved).receipts[0].pageBinding, 'current');
    const changed = globalThis.structuredClone(content); changed.slides[0].elements.find(element => element.type === 'chart').data.rows[0][1] = 999;
    assert.notEqual(computePresentationDigest(content), computePresentationDigest(changed));
    assert.ok(analyzePresentationSemantics(changed).issues.some(issue => issue.code === 'CLAIM_PAGE_BINDING_STALE' && issue.level === 'blocking'));
    content.slides[0].speakerNotes = '口径已发生修改';
    assert.equal(analyzePresentationSemantics(content).receipts[0].pageBinding, 'stale');
});

test('错误计算、零分母、伪造引文和来源快照变化不能被判为通过', async () => {
    const sources = normalizeMaterials([{ id: 'finance', text: quote }]);
    const wrong = (await compileDesignPlan(plan(60), template, sources)).presentation;
    assert.ok(analyzePresentationSemantics(wrong).issues.some(issue => issue.code === 'CALCULATION_MISMATCH'));
    const raw = plan(); raw.slides[0].claims[0].calculation = { operation: 'percent_change', values: [0, 20], result: 100, unit: '%' };
    const division = (await compileDesignPlan(raw, template, sources)).presentation;
    assert.ok(analyzePresentationSemantics(division).issues.some(issue => issue.code === 'CALCULATION_MISMATCH'));
    const fake = plan(); fake.slides[0].claims[0].evidence[0].quote = '本期收入999万元。';
    const fabricated = (await compileDesignPlan(fake, template, sources)).presentation;
    assert.equal(analyzePresentationSemantics(fabricated).status, 'blocked');
    const valid = (await compileDesignPlan(plan(), template, sources)).presentation;
    valid.sources[0].digest = 'different';
    assert.throws(() => normalizePresentation(valid), /摘要无效/);
});

test('多材料未指定逐页来源时保留待核对状态，图示通过语义生成保持真实父子关系', async () => {
    const sources = normalizeMaterials([{ id: 'finance', text: quote }, { id: 'people', text: '交付组与财务组向负责人汇报。' }]).map(materialToPresentationSource);
    const content = (await compileDesignPlan({ title: '职责安排', slides: [{ title: '负责人统筹交付与财务', layout: 'process', sourceRefs: ['people'],
        diagram: { type: 'hierarchy', graph: { nodes: [{ id: 'lead', label: '负责人' }, { id: 'delivery', label: '交付组' }, { id: 'finance', label: '财务组' }], edges: [{ from: 'lead', to: 'delivery' }, { from: 'lead', to: 'finance' }] } } }] }, template, sources)).presentation;
    const diagram = content.slides[0].elements.find(element => element.type === 'diagram');
    assert.equal(diagram.graph.edges.length, 2); assert.deepEqual(diagram.items, ['负责人', '交付组', '财务组']);
    assert.equal((await runRenderedPresentationQuality(content)).summary.blocking, 0);
    const unassigned = (await compileDesignPlan({ title: '待核对', slides: [{ title: '交付安排', layout: 'content', points: ['请核对对应材料。'] }] }, template, sources)).presentation;
    assert.deepEqual(unassigned.slides[0].sourceRefs, []);
});
