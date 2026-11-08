'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Zip = require('jszip');
const sample = require('./fixtures/presentation-design-acceptance.json');
const { getBuiltInTemplate } = require('../server/services/presentations/presentation-templates');
const { compileDesignPlan } = require('../server/services/presentations/presentation-design-compiler');
const { createTextMetrics } = require('../server/services/presentations/presentation-text-metrics');
const { renderPresentation } = require('../server/services/presentations/presentation-renderer');
const { applyTemplateLayoutLayers, normalizeTemplateDefinition } = require('../server/services/presentations/presentation-service');
const { normalizePresentation } = require('../server/services/presentations/presentation-schema');

test('新版目录与结论保留完整标题，问题和安排按相同的行对齐，原版本仍可读取', async () => {
    const template = getBuiltInTemplate('learning-studio');
    assert.equal(template.version, 3); assert.equal(getBuiltInTemplate('learning-studio', 1).version, 1); assert.equal(getBuiltInTemplate('learning-studio', 2).version, 2);
    assert.equal(getBuiltInTemplate('learning-studio', 99), null);
    const content = (await compileDesignPlan(sample, template)).presentation;
    const metrics = await createTextMetrics(content);
    for (const index of [1, 3]) {
        const title = content.slides[index].elements.find(element => element.id === 'title');
        assert.ok(title.width >= 1000);
        assert.equal(metrics.lines(title).length, 1);
    }
    const conclusion = content.slides[3];
    assert.equal(conclusion.elements.find(element => element.id === 'body').y, conclusion.elements.find(element => element.id === 'evidence').y);
    assert.equal(conclusion.elements.find(element => element.id === 'body_2').y, conclusion.elements.find(element => element.id === 'evidence_2').y);
    for (const fact of sample.facts) assert.ok(JSON.stringify(content).includes(fact));
    assert.doesNotThrow(() => normalizeTemplateDefinition({ definition: template, aspectRatio: '16:9' }));
});

test('PPTX文本使用与预览相同的显式断行与行距，不再由Office重新自动换行或缩字', async () => {
    const content = (await compileDesignPlan(sample, getBuiltInTemplate('learning-studio'))).presentation;
    const zip = await Zip.loadAsync((await renderPresentation(content, 'pptx')).buffer);
    for (const file of Object.keys(zip.files).filter(name => /^ppt\/slides\/slide\d+\.xml$/.test(name))) {
        const xml = await zip.file(file).async('string');
        assert.match(xml, /wrap="none"/); assert.doesNotMatch(xml, /<a:normAutofit/);
        assert.match(xml, /<a:spcPct val="132000"|<a:spcPct val="115000"/);
    }
    const chart = await zip.file(Object.keys(zip.files).find(name => /^ppt\/charts\/chart\d+\.xml$/.test(name))).async('string');
    assert.match(chart, /sz="1800"/);
});

test('旧稿主动重套新版可拆出原有段落，内容和来源保留，标题不进入窄栏', async () => {
    const previous = (await compileDesignPlan(sample, getBuiltInTemplate('learning-studio', 1))).presentation;
    const before = previous.slides[3].elements.filter(element => !element.locked && element.type === 'text').map(element => element.content.text).join('\n\n');
    const template = getBuiltInTemplate('learning-studio');
    const updated = applyTemplateLayoutLayers({ ...previous, template: { id: template.id, version: template.version, snapshotDigest: template.snapshotDigest } }, template, { reflow: true, normalizePresentation });
    const after = updated.slides[3].elements.filter(element => !element.locked && element.type === 'text').map(element => element.content.text).join('\n\n');
    assert.equal(before, after);
    assert.ok(updated.slides[3].elements.find(element => element.id === 'title').width >= 1000);
});
