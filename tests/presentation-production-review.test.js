'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Zip = require('jszip');
const { normalizePresentation, computePresentationDigest } = require('../server/services/presentations/presentation-schema');
const { renderPresentation } = require('../server/services/presentations/presentation-renderer');
const { verifyPptxExport } = require('../server/services/presentations/presentation-export-verification');
const { NS, parse, all, objectRecords, serialize } = require('../server/services/presentations/presentation-pptx-xml');
const { currentVisualStatus, reviewPresentationProduction } = require('../server/services/presentations/presentation-production-review');

function sample() { return normalizePresentation({ title: '交付检查', slides: [{ id: 's1', elements: [
    { id: 'title', type: 'text', x: 88, y: 58, width: 1100, height: 80, content: { text: '检查最终原生文件' }, style: { fontSize: 36 } },
    { id: 'a', type: 'text', x: 88, y: 180, width: 480, height: 100, content: { text: '相同文字' }, style: { fontSize: 28 } },
    { id: 'b', type: 'text', x: 680, y: 180, width: 480, height: 100, content: { text: '相同文字' }, style: { fontSize: 28 } }
] }] }); }

test('相同文本出现在其他元素时不能掩盖对象丢失，图表嵌入工作簿被独立核验', async () => {
    const content = sample(), output = await renderPresentation(content, 'pptx'), zip = await Zip.loadAsync(output.buffer);
    const document = parse(await zip.file('ppt/slides/slide1.xml').async('string'));
    const record = objectRecords(document).find(record => record.name === 'pivotAnim_b'); record.node.parentNode.removeChild(record.node);
    zip.file('ppt/slides/slide1.xml', serialize(document));
    const missing = await verifyPptxExport(await zip.generateAsync({ type: 'nodebuffer' }), content);
    assert.ok(missing.issues.some(issue => issue.code === 'EXPORT_TEXT_MISSING' && issue.elementId === 'b'));
    const chartContent = sample(); chartContent.slides[0].elements.push({ id: 'chart', type: 'chart', x: 88, y: 350, width: 900, height: 300, chartType: 'bar', data: { columns: ['季度', '收入', '成本'], rows: [['Q1', 120, 80], ['Q2', 100, 0]] } });
    const normalized = normalizePresentation(chartContent), chartZip = await Zip.loadAsync((await renderPresentation(normalized, 'pptx')).buffer);
    const workbookName = Object.keys(chartZip.files).find(name => name.startsWith('ppt/embeddings/') && name.endsWith('.xlsx'));
    const workbook = await Zip.loadAsync(await chartZip.file(workbookName).async('nodebuffer'));
    const sheet = await workbook.file('xl/worksheets/sheet1.xml').async('string');
    assert.match(sheet, /r="C3"><v>0<\/v>/);
    workbook.file('xl/worksheets/sheet1.xml', sheet.replace(/(<c r="B2"><v>)120/, '$1999'));
    chartZip.file(workbookName, await workbook.generateAsync({ type: 'nodebuffer' }));
    const altered = await verifyPptxExport(await chartZip.generateAsync({ type: 'nodebuffer' }), normalized);
    assert.ok(altered.issues.some(issue => issue.code === 'EXPORT_CHART_WORKBOOK_MISMATCH'));
    assert.ok(!altered.issues.some(issue => issue.code === 'EXPORT_CHART_DATA_MISMATCH'), '缓存未变化也不能掩盖工作簿错误');
});

test('原生图示节点存在但连接被移除时交付核验失败', async () => {
    const content = sample(); content.slides[0].elements.push({ id: 'cycle', type: 'diagram', diagramType: 'cycle', x: 88, y: 330, width: 1000, height: 320, items: ['规划', '执行', '复盘'] });
    const normalized = normalizePresentation(content), zip = await Zip.loadAsync((await renderPresentation(normalized, 'pptx')).buffer);
    const document = parse(await zip.file('ppt/slides/slide1.xml').async('string'));
    const connector = all(document, NS.p, 'cxnSp')[0], endpoint = all(connector, NS.a, 'endCxn')[0]; endpoint.parentNode.removeChild(endpoint);
    zip.file('ppt/slides/slide1.xml', serialize(document));
    const report = await verifyPptxExport(await zip.generateAsync({ type: 'nodebuffer' }), normalized);
    assert.ok(report.issues.some(issue => issue.code === 'EXPORT_DIAGRAM_EDGE_MISMATCH'));
});

test('交付检查区分结构、原生文件、视觉和Office范围；旧版本报告不能满足要求', async () => {
    const content = sample(); content.metadata.productionProfile = { requireVisualReview: true, requireOfficeReview: true };
    const normalized = normalizePresentation(content), digest = computePresentationDigest(normalized);
    const without = await reviewPresentationProduction(normalized);
    assert.equal(without.checks.native.status, 'passed'); assert.equal(without.checks.visual.status, 'not_checked'); assert.equal(without.checks.office.status, 'not_checked');
    assert.ok(without.issues.some(issue => issue.code === 'PRODUCTION_VISUAL_PENDING')); assert.ok(without.issues.some(issue => issue.code === 'PRODUCTION_OFFICE_PENDING'));
    const visual = { checkedContentDigest: digest, reviews: [{ slideId: 's1', contentDigest: digest, status: 'passed' }] };
    const withEvidence = await reviewPresentationProduction(normalized, { visualReport: visual }, { officeReview: async (buffer, _presentation, options) => {
        assert.ok(buffer.length > 1000);
        return { status: 'passed', engine: 'test-fixture', contentDigest: digest, outputDigest: options.outputDigest };
    } });
    assert.equal(withEvidence.status, 'passed', JSON.stringify(withEvidence.issues));
    assert.equal(currentVisualStatus(normalized, { ...visual, checkedContentDigest: 'old' }).status, 'stale');
    normalized.slides[0].elements[0].content.text = '修改后';
    assert.equal(currentVisualStatus(normalized, visual).status, 'stale');
});

test('交付检查取消时不返回虚假的完成报告', async () => {
    const controller = new AbortController(); controller.abort();
    await assert.rejects(() => reviewPresentationProduction(sample(), { signal: controller.signal }), /abort/i);
});
