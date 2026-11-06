'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Zip = require('jszip');
const { getBuiltInTemplate } = require('../server/services/presentations/presentation-templates');
const { compileDesignPlan } = require('../server/services/presentations/presentation-design-compiler');
const { compilePresentationProposal, buildSlidesMessages } = require('../server/services/presentations/presentation-ai');
const { optimizeDesignLayout } = require('../server/services/presentations/presentation-layout-optimizer');
const { runQualityTask } = require('../server/services/presentations/presentation-quality-tasks');
const { computePresentationDigest } = require('../server/services/presentations/presentation-schema');
const { renderPresentation } = require('../server/services/presentations/presentation-renderer');
const { verifyPptxExport } = require('../server/services/presentations/presentation-export-verification');

const template = getBuiltInTemplate('learning-studio');
async function sample() { return (await compileDesignPlan({ title: '培训说明', slides: [{ title: '课程目标', layout: 'content', points: ['先核对来源与事实', '再形成具体行动'] }, { title: '工作步骤', layout: 'process', points: ['完整读取材料', '逐页核对内容'] }] }, template)).presentation; }

test('新主题由语义计划生成页面，正文过密时保留全部要点拆页，数字与来源不丢失', async () => {
    const points = Array.from({ length: 8 }, (_, index) => `事项${index + 1}：` + '核对真实材料中的数据并记录处理结果。'.repeat(10));
    const source = { id: 'source_1', title: '示例材料', type: 'material', locator: '材料第1节', digest: 'known', excerpt: '核对结果' };
    const output = await compileDesignPlan({ title: '完整材料', slides: [{ title: '逐项处理安排', layout: 'content', points, speakerNotes: '原始讲稿完整保留。' }] }, template, [source]);
    assert.ok(output.generatedPages > 1); assert.equal(output.plannedPages, 1); assert.ok(output.warnings.length);
    const actual = output.presentation.slides.flatMap(slide => slide.elements.filter(element => !element.locked && element.type === 'text' && element.id !== 'title').map(element => element.content.text)).join('\n\n');
    for (const point of points) assert.ok(actual.includes(point));
    assert.equal(output.presentation.slides.map(slide => slide.speakerNotes).join(''), '原始讲稿完整保留。');
    assert.ok(output.presentation.slides.every(slide => slide.sourceRefs.includes('source_1')));
    const prompt = JSON.stringify(buildSlidesMessages({ templateId: 'learning-studio' }));
    assert.match(prompt, /不输出 elements|不输出.*坐标/);
    const parsed = await compilePresentationProposal(JSON.stringify({ title: '语义页', slides: [{ title: '工作目标', layout: 'content', points: ['完整保留目标内容'] }] }), { templateId: 'learning-studio' });
    assert.equal(parsed.presentation.slides[0].layoutId, 'design-title-content');
    await assert.rejects(() => compileDesignPlan({ title: '空页', slides: [{ title: '空页', layout: 'missing' }] }, template), /布局/);
});

test('排版优化保留文字、数字、来源、锁定对象和批准页，只接受可验证的改善', async () => {
    const content = await sample();
    const title = content.slides[0].elements.find(element => element.id === 'title');
    title.y = 200; title.height = 5;
    content.slides[1].review = { status: 'approved', approvedAt: '2026-11-06T00:00:00Z', approvedBy: '1' };
    const approved = JSON.stringify(content.slides[1]);
    const before = content.slides[0].elements.filter(element => !element.id.startsWith('pivotTemplate_')).map(element => ({ id: element.id, text: element.content?.text, sourceRefs: element.sourceRefs }));
    const result = await optimizeDesignLayout(content, template);
    assert.ok(result.changedSlides.includes(content.slides[0].id));
    assert.equal(JSON.stringify(result.content.slides[1]), approved);
    assert.deepEqual(result.content.slides[0].elements.filter(element => !element.id.startsWith('pivotTemplate_')).map(element => ({ id: element.id, text: element.content?.text, sourceRefs: element.sourceRefs })), before);
    assert.equal(result.validation.summary.blocking, 0);
});

function taskFixture(content, options = {}) {
    let status = 'working', result, error, controller;
    const published = [];
    const store = { beginExecution: () => { controller = new AbortController(); return controller; }, endExecution() {}, getForUser: async () => ({ status }),
        complete: async (_id, _user, value, failure) => { result = globalThis.structuredClone(value); status = failure?.failed ? 'failed' : 'completed'; error = failure; } };
    const deps = { store, getDocument: async () => ({ id: 'doc', version: 1, template: { id: template.id, version: 1 }, content }),
        publish: async (_id, _user, value) => { published.push(globalThis.structuredClone(value)); }, resolveAssets: async () => new Map(),
        resolveTemplate: async () => template, reviewSlide: async (_content, _user, input) => {
            if (options.cancel) { status = 'cancelled'; controller.abort(); }
            if (options.stale) content.title = '检查期间的新修改';
            return { slideId: content.slides[input.slideIndex].id, status: options.unavailable ? 'unavailable' : 'passed', issues: [] };
        } };
    return { deps, published, result: () => result, error: () => error };
}

test('整稿任务逐页复核并记录进度，缺少视觉能力、取消和内容变化均不能冒充通过', async () => {
    for (const options of [{}, { unavailable: true }, { cancel: true }, { stale: true }]) {
        const content = await sample(), fixture = taskFixture(content, options);
        await runQualityTask('task', { id: 1 }, { presentationId: 'doc', contentDigest: computePresentationDigest(content), mode: 'visual' }, fixture.deps);
        const result = fixture.result();
        if (!Object.keys(options).length) { assert.equal(result.visualStatus, 'passed'); assert.equal(result.reviews.length, 2); assert.equal(result.progress.completed, 2); }
        else { assert.notEqual(result.visualStatus, 'passed'); }
        if (options.stale) assert.equal(fixture.error().errorCode, 'PRESENTATION_CHECK_STALE');
        assert.ok(fixture.published.length);
    }
});

test('优化任务只产生建议，不在后台直接覆盖源稿；真实PPTX缺字时阻断交付', async () => {
    const content = await sample(), fixture = taskFixture(content);
    const original = JSON.stringify(content), candidate = globalThis.structuredClone(content);
    candidate.slides[0].elements.find(element => element.id === 'title').y = 60;
    fixture.deps.optimize = async () => ({ content: candidate, changedSlides: [content.slides[0].id], validation: { status: 'passed', issues: [] } });
    await runQualityTask('task', { id: 1 }, { presentationId: 'doc', contentDigest: computePresentationDigest(content), mode: 'layout' }, fixture.deps);
    assert.equal(JSON.stringify(content), original); assert.ok(fixture.result().proposal); assert.equal(fixture.result().visualStatus, 'not_requested');
    const pptx = await renderPresentation(content, 'pptx');
    assert.equal((await verifyPptxExport(pptx.buffer, content)).status, 'passed');
    const zip = await Zip.loadAsync(pptx.buffer);
    zip.file('ppt/slides/slide1.xml', (await zip.file('ppt/slides/slide1.xml').async('string')).replace(/课程目标/g, '已被改动'));
    const broken = await verifyPptxExport(await zip.generateAsync({ type: 'nodebuffer' }), content);
    assert.equal(broken.status, 'blocked'); assert.ok(broken.issues.some(issue => issue.code === 'EXPORT_TEXT_MISSING'));
});

test('父任务停止后不再调用视觉模型，图表数值改动能被真实PPTX核验发现', async () => {
    const content = await sample(), fixture = taskFixture(content);
    let calls = 0;
    fixture.deps.getRun = async () => ({ status: 'cancelled' });
    fixture.deps.reviewSlide = async () => { calls++; return { status: 'passed', issues: [] }; };
    await runQualityTask('task', { id: 1 }, { presentationId: 'doc', runId: 'parent', contentDigest: computePresentationDigest(content), mode: 'visual' }, fixture.deps);
    assert.equal(calls, 0); assert.equal(fixture.error().errorCode, 'PRESENTATION_PARENT_STOPPED');
    const chart = (await compileDesignPlan({ title: '原生图表', slides: [{ title: '收入成本', layout: 'chart', chart: { type: 'bar', columns: ['指标', '万元'], rows: [['收入', 120], ['成本', 80]] } }] }, template)).presentation;
    const pptx = await renderPresentation(chart, 'pptx');
    assert.equal((await verifyPptxExport(pptx.buffer, chart)).status, 'passed');
    const zip = await Zip.loadAsync(pptx.buffer);
    const chartFile = Object.keys(zip.files).find(name => /^ppt\/charts\/chart\d+\.xml$/.test(name));
    zip.file(chartFile, (await zip.file(chartFile).async('string')).replace(/>120</g, '>999<'));
    const altered = await verifyPptxExport(await zip.generateAsync({ type: 'nodebuffer' }), chart);
    assert.ok(altered.issues.some(issue => issue.code === 'EXPORT_CHART_DATA_MISMATCH'));
});
