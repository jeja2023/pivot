'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const Zip = require('jszip');
const { listBuiltInTemplates, getBuiltInTemplate } = require('../server/services/presentations/presentation-templates');
const { buildTaskPresentation } = require('../server/services/presentations/presentation-task-content');
const { applyTemplateLayoutLayers } = require('../server/services/presentations/presentation-template-reflow');
const { normalizePresentation } = require('../server/services/presentations/presentation-schema');
const { fitDesignPresentation, createTextMetrics } = require('../server/services/presentations/presentation-text-metrics');
const { runRenderedPresentationQuality } = require('../server/services/presentations/presentation-render-quality');
const { renderPresentation } = require('../server/services/presentations/presentation-renderer');
const { reviewPresentationSlide } = require('../server/services/presentations/presentation-design-review');
const { getPresentationDesignSkill } = require('../server/services/presentations/presentation-design-skill');
const { validateSkillManifest } = require('../server/services/agent-skills');
const { buildSlidesMessages } = require('../server/services/presentations/presentation-ai');

const input = { title: '季度经营复盘', slides: [
    { title: '季度经营复盘', layout: 'cover', points: ['本期经营情况与下期工作安排', '示例数据：收入120万元、成本80万元'] },
    { title: '本次汇报的主要内容', layout: 'agenda', points: ['经营结果与关键指标', '交付与回款问题', '下期工作安排'] },
    { title: '收入120万元，成本80万元', layout: 'key-metrics', metrics: [{ value: '120万元', label: '本期收入' }, { value: '80万元', label: '本期成本' }] },
    { title: '经营情况与执行安排', layout: 'executive-summary', left: ['收入120万元、成本80万元', '交付周期延长'], right: ['每周跟踪交付', '按账龄推进回款'] },
    { title: '识别风险并对应处理', layout: 'risk-actions', left: ['交付周期延长', '应收账款回收偏慢'], right: ['建立每周交付跟踪', '按账龄逐项推进回收'] },
    { title: '下期工作分步推进', layout: 'timeline', points: ['第一步\n核对交付与回款清单', '第二步\n明确责任与时限', '第三步\n每周跟踪处理', '第四步\n复盘执行效果'] },
    { title: '收入与成本口径一致', layout: 'chart', points: ['金额单位：万元', '来源：示例材料'], chart: { type: 'bar', columns: ['指标', '万元'], rows: [['收入', 120], ['成本', 80]] } },
    { title: '把问题落实到交付与回款', layout: 'summary', points: ['建立每周交付跟踪机制', '按账龄推进应收款回收'], speakerNotes: '示例材料，用于检查设计与导出。' }
] };

async function compile(id = 'executive-clean') {
    const template = getBuiltInTemplate(id);
    const content = buildTaskPresentation(input, template);
    return fitDesignPresentation(applyTemplateLayoutLayers(content, template, { reflow: true, normalizePresentation }));
}

test('三套设计模板有不同构图，技能复用既有清单协议与真实工具声明', () => {
    const templates = listBuiltInTemplates().filter(template => ['executive-clean', 'institutional-report', 'learning-studio'].includes(template.id));
    assert.equal(templates.length, 3);
    for (const template of templates) assert.equal(template.layouts.length, 18);
    assert.notDeepEqual(templates[0].layouts[0].placeholders, templates[1].layouts[0].placeholders);
    assert.notDeepEqual(templates[1].layouts[0].placeholders, templates[2].layouts[0].placeholders);
    assert.notDeepEqual(templates[0].layouts.find(layout => layout.id === 'design-process').placeholders, templates[2].layouts.find(layout => layout.id === 'design-process').placeholders);
    const skill = getPresentationDesignSkill();
    const check = validateSkillManifest(skill.manifest, { strictSpec: true });
    assert.equal(check.valid, true, JSON.stringify(check.errors));
    const prompt = JSON.stringify(buildSlidesMessages({ templateId: 'learning-studio' }));
    assert.match(prompt, /中文|18pt/); assert.match(prompt, /design-timeline/); assert.doesNotMatch(prompt, /每页最多 4 个元素/);
});

test('八页完整样稿在三种设计中均可渲染，PPTX保留原生图表与所有页面', { timeout: 90000 }, async () => {
    for (const id of ['executive-clean', 'institutional-report', 'learning-studio']) {
        const content = await compile(id);
        const quality = await runRenderedPresentationQuality(content);
        assert.equal(quality.summary.blocking, 0, JSON.stringify(quality.issues));
        assert.equal(quality.textMeasurement, 'controlled_font');
        assert.equal(quality.visualReview.status, 'not_requested');
        const pptx = await renderPresentation(content, 'pptx');
        const zip = await Zip.loadAsync(pptx.buffer);
        assert.equal(Object.keys(zip.files).filter(name => /^ppt\/slides\/slide\d+\.xml$/.test(name)).length, 8);
        assert.equal(Object.keys(zip.files).filter(name => /^ppt\/charts\/chart\d+\.xml$/.test(name)).length, 1);
        const directory = path.resolve('output/ppt-design-upgrade', id);
        await fs.mkdir(directory, { recursive: true });
        await fs.writeFile(path.join(directory, '季度经营复盘.pptx'), pptx.buffer);
        for (let index = 0; index < content.slides.length; index++) await fs.writeFile(path.join(directory, `slide-${index + 1}.png`), (await renderPresentation(content, 'png', { slideIndex: index })).buffer);
    }
});

test('实际字体测量区分中文与拉丁字符，并拒绝超出页面容量的长正文', async () => {
    const metrics = await createTextMetrics();
    assert.ok(metrics.measure('中文正文', 28) > metrics.measure('iiii', 28));
    const content = await compile();
    const body = content.slides[3].elements.find(element => element.id === 'body');
    body.content.text = '不能静默截断的完整中文材料'.repeat(100);
    const quality = await runRenderedPresentationQuality(content);
    assert.ok(quality.issues.some(issue => issue.code === 'MEASURED_TEXT_OVERFLOW' && issue.elementId === 'body'));
});

test('视觉复核使用真实页面图，未配置、非法响应和撤回请求不能冒充通过', async () => {
    const content = await compile(); let called = false;
    const unavailable = await reviewPresentationSlide(content, { id: 1 }, { slideIndex: 0 }, { resolveModel: async () => ({ id: 1, supports_vision: 0 }), callModel: async () => { called = true; } });
    assert.equal(unavailable.status, 'unavailable'); assert.equal(called, false);
    const deps = { resolveModel: async () => ({ id: 1, supports_vision: 1, name: '测试视觉模型' }), callModel: async (_model, messages) => {
        assert.match(messages[1].content[1].image_url.url, /^data:image\/png;base64,/); return { issues: [] };
    } };
    const result = await reviewPresentationSlide(content, { id: 1 }, { slideIndex: 3 }, deps);
    assert.equal(result.status, 'passed'); assert.equal(result.slideId, content.slides[3].id); assert.ok(result.contentDigest);
    await assert.rejects(() => reviewPresentationSlide(content, { id: 1 }, { slideIndex: 0 }, { ...deps, callModel: async () => ({ issues: [{ level: 'warning', elementId: 'forged', message: '问题' }] }) }), /无效问题|元素编号/);
    const controller = new AbortController(); controller.abort();
    await assert.rejects(() => reviewPresentationSlide(content, { id: 1 }, { slideIndex: 0, signal: controller.signal }, deps), /abort/i);
});
