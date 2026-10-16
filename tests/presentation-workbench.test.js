const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const unzipper = require('unzipper');
const JSZip = require('jszip');
const { PDFDocument } = require('pdf-lib');
const sharp = require('sharp');
const {
    MAX_SLIDES,
    collectPresentationAssetRefs,
    computePresentationDigest,
    defaultPresentation,
    normalizePresentation,
    validatePresentation
} = require('../server/services/presentations/presentation-schema');
const { getBuiltInTemplate, listBuiltInTemplates, STANDARD_LAYOUTS } = require('../server/services/presentations/presentation-templates');
const { assertSensitiveExportAllowed, exportRendererVersion, normalizeExportOptions } = require('../server/services/presentations/presentation-export-service');
const { runPresentationValidation } = require('../server/services/presentations/presentation-validation');
const { renderPresentation } = require('../server/services/presentations/presentation-renderer');
const { parsePresentationProposal, parseValidationProposal, buildOutlineMessages, buildSlidesMessages, buildRewriteMessages, buildContinueMessages, buildValidationMessages, filterOutlineSourceRefs, repairAiPresentationProposal } = require('../server/services/presentations/presentation-ai');
const { normalizeTemplatePackage, applyTemplateBrandControls, inferPresentationAssetType, presentationFromArtifactText } = require('../server/services/presentations/presentation-service');
const { scanVbaSource } = require('../server/services/presentations/presentation-vba');
const { recordPresentationOutcome, getPresentationMetricsSnapshot } = require('../server/services/presentations/presentation-metrics');
const { importPptxTemplatePackage } = require('../server/services/presentations/presentation-pptx-template-import');
const { normalizeMaterials, sha256 } = require('../server/services/presentations/presentation-evidence');
const { buildSlideChangeImpact, mergeLockedElements } = require('../server/services/presentations/presentation-change-impact');
const { buildPresentationDataNarrative } = require('../server/services/presentations/presentation-data-narrative');
const { buildPresentationDeliveryGuide } = require('../server/services/presentations/presentation-delivery-guide');
const { runRenderedPresentationQuality } = require('../server/services/presentations/presentation-render-quality');
const { buildSlideLayoutVariants } = require('../server/services/presentations/presentation-layout-variants');

function testPresentation() {
    return defaultPresentation({ title: '季度项目汇报', template: getBuiltInTemplate('business-blue') });
}

test('内置 PPT 模板覆盖八套主题与十个标准布局', () => {
    assert.equal(listBuiltInTemplates().length, 8);
    assert.equal(STANDARD_LAYOUTS.length, 10);
    assert.ok(getBuiltInTemplate('business-blue').snapshotDigest);
    assert.equal(getBuiltInTemplate('does-not-exist'), null);
});

test('PPT IR 规范化稳定且拒绝页面越界元素', () => {
    const presentation = testPresentation();
    const first = normalizePresentation(presentation);
    const second = normalizePresentation(first);
    assert.deepEqual(second, first);
    assert.equal(computePresentationDigest(first), computePresentationDigest(second));
    presentation.slides[0].elements[0].width = 9999;
    const result = validatePresentation(presentation);
    assert.equal(result.valid, false);
    assert.match(result.errors.join('\n'), /元素宽度超出允许范围|超出页面边界/);
});

test('PPT IR 对受控素材引用进行收集，拒绝外部图片地址', () => {
    const presentation = testPresentation();
    presentation.slides[0].elements.push({
        id: 'cover-image', type: 'image', x: 720, y: 150, width: 400, height: 320,
        assetRef: 'artifact-cas://0123456789abcdef', fit: 'cover', opacity: 1, rotation: 0, zIndex: 4, locked: false, visible: true, sourceRefs: []
    });
    assert.deepEqual(collectPresentationAssetRefs(presentation), ['artifact-cas://0123456789abcdef']);
    presentation.slides[0].elements[2].assetRef = 'https://example.invalid/image.png';
    assert.equal(validatePresentation(presentation).valid, false);
});

test('PPT IR 仅允许存在的结构化材料来源被页面和元素引用', () => {
    const presentation = testPresentation();
    presentation.sources = [{ id: 'source_1', title: '项目周报', type: 'material', locator: '第 1 页', digest: '' }];
    presentation.slides[0].sourceRefs = ['source_1'];
    presentation.slides[0].elements[0].sourceRefs = ['source_1'];
    assert.equal(validatePresentation(presentation).valid, true);
    presentation.slides[0].elements[0].sourceRefs = ['unknown-source'];
    const checked = validatePresentation(presentation);
    assert.equal(checked.valid, false);
    assert.match(checked.errors.join('\n'), /不存在的来源/);
});

test('PPT 材料证据在 IR 中保留摘要、定位和内容指纹，供后续 AI 改写继续使用', () => {
    const raw = '第一季度收入增长 10%，客户续约率为 92%。';
    const [material] = normalizeMaterials([{ id: '经营材料', title: '一季度经营报告', type: 'file', locator: '文件 Q1-经营报告.docx', text: raw }]);
    assert.equal(material.digest, sha256(raw));
    assert.equal(material.excerpt, raw);
    const proposal = parsePresentationProposal(JSON.stringify({
        title: '经营复盘',
        slides: [{ id: 'slide_1', type: 'content', layoutId: 'title-content', sourceRefs: [material.id], elements: [{ id: 'title', type: 'text', x: 80, y: 80, width: 900, height: 100, content: { text: '一季度经营复盘' }, style: { fontSize: 32, color: '#1F2937' }, sourceRefs: [material.id] }], speakerNotes: '' }]
    }), { title: '经营复盘', sources: [material] });
    const source = proposal.presentation.sources[0];
    assert.equal(source.locator, '文件 Q1-经营报告.docx');
    assert.equal(source.digest, sha256(raw));
    assert.equal(source.excerpt, raw);
    const rewrite = buildRewriteMessages({ title: '经营复盘', slide: proposal.presentation.slides[0], instruction: '保留数据', materials: proposal.presentation.sources }).at(-1).content;
    assert.match(rewrite, /客户续约率为 92%/);
    assert.equal(runPresentationValidation(proposal.presentation).issues.some(issue => issue.code === 'SOURCE_EVIDENCE_MISSING'), false);
});

test('PPT IR 保存已确认大纲及其来源关联，供版本审计和后续追溯', () => {
    const presentation = testPresentation();
    presentation.sources = [{ id: 'source_1', title: '经营材料', type: 'material', locator: '第 2 页', digest: 'a'.repeat(64), excerpt: '经营数据摘录' }];
    presentation.metadata.planApproval = {
        approvalMethod: 'interactive_outline_review', approvedAt: '2026-10-11T01:00:00.000Z', approvedBy: '1001', outlineDigest: 'b'.repeat(64),
        outline: { title: '季度项目汇报', outline: [{ section: '结论', slides: [{ title: '经营结论', purpose: '确认行动事项', layoutHint: 'summary', keyPoints: ['收入增长'], sourceRefs: ['source_1'] }] }] }
    };
    const normalized = normalizePresentation(presentation);
    assert.equal(normalized.metadata.planApproval.status, 'approved');
    assert.equal(normalized.metadata.planApproval.outline.sections[0].slides[0].sourceRefs[0], 'source_1');
    presentation.metadata.planApproval.outline.outline[0].slides[0].sourceRefs = ['unknown'];
    assert.throws(() => normalizePresentation(presentation), /大纲引用了不存在的来源/);
});

test('质量检查提示已引用但没有可回溯证据的旧来源', () => {
    const presentation = testPresentation();
    presentation.sources = [{ id: 'legacy_source', title: '历史材料', type: 'material', locator: '', digest: '', excerpt: '' }];
    presentation.slides[0].sourceRefs = ['legacy_source'];
    const result = runPresentationValidation(presentation);
    assert.ok(result.issues.some(issue => issue.code === 'SOURCE_EVIDENCE_MISSING'));
});

test('AI 页面改写差异会汇总增删改，并保留锁定品牌元素', () => {
    const presentation = testPresentation();
    const current = presentation.slides[0];
    current.elements.push({ id: 'locked_logo', type: 'shape', x: 40, y: 40, width: 80, height: 40, rotation: 0, zIndex: 20, locked: true, visible: true, sourceRefs: [], shapeType: 'rect', style: { fill: '#1769AA', stroke: '#1769AA', strokeWidth: 1, opacity: 1, radius: 0 } });
    const proposal = JSON.parse(JSON.stringify(current));
    proposal.elements = proposal.elements.filter(element => element.id !== 'locked_logo');
    proposal.elements.find(element => element.id === 'title').content.text = 'AI 改写标题';
    proposal.elements.push({ id: 'new_body', type: 'text', x: 120, y: 520, width: 600, height: 80, rotation: 0, zIndex: 8, locked: false, visible: true, sourceRefs: [], content: { text: '新增结论' }, style: { fontSize: 20, color: '#1F2937' } });
    const merged = mergeLockedElements(current, proposal);
    const impact = buildSlideChangeImpact(current, merged);
    assert.ok(merged.elements.some(element => element.id === 'locked_logo' && element.locked));
    assert.equal(impact.counts.protectedLocked, 1);
    assert.equal(impact.counts.added, 1);
    assert.ok(impact.changes.some(change => change.elementId === 'title' && change.kind === 'updated' && change.fields.includes('文字内容')));
});

test('页面审核状态只能使用草稿或批准，并会被规范化保留', () => {
    const presentation = testPresentation();
    presentation.slides[0].review = { status: 'approved', approvedAt: '2026-10-11T01:00:00.000Z', approvedBy: '1001' };
    assert.equal(normalizePresentation(presentation).slides[0].review.status, 'approved');
    presentation.slides[0].review = { status: 'unknown' };
    assert.throws(() => normalizePresentation(presentation), /页面审核状态无效/);
});

test('数据图表可生成可编辑的结论注释与备份页数据，演讲指南可估算时长和问题', () => {
    const chart = { chartType: 'bar', title: '季度收入', data: { columns: ['季度', '收入'], rows: [['Q1', 100], ['Q2', 130], ['Q3', 150]] } };
    const narrative = buildPresentationDataNarrative(chart);
    assert.equal(narrative.recommendation, 'line');
    assert.match(narrative.headline, /Q3/);
    assert.match(narrative.annotation, /增加 50/);
    assert.deepEqual(narrative.backupRows, [['Q1', '100'], ['Q2', '130'], ['Q3', '150']]);
    const presentation = testPresentation();
    presentation.slides[0].elements.push({ id: 'chart_guide', type: 'chart', x: 100, y: 400, width: 600, height: 200, rotation: 0, zIndex: 6, locked: false, visible: true, sourceRefs: [], ...chart, options: { showLegend: false, showLabels: true, colors: ['#1769AA'] } });
    const guide = buildPresentationDeliveryGuide(normalizePresentation(presentation));
    assert.ok(guide.estimatedMinutes >= 1);
    assert.ok(guide.questions.some(item => /数据来源/.test(item)));
    assert.equal(guide.backupSlides.length, 1);
});

test('渲染质检逐页走真实 PNG 输出，并保留结构化版式问题', async () => {
    const presentation = testPresentation();
    const second = JSON.parse(JSON.stringify(presentation.slides[0]));
    second.id = 'slide_2'; second.index = 1; second.elements = second.elements.map((element, index) => ({ ...element, id: `${element.id}_2_${index}` }));
    presentation.slides.push(second);
    const result = await runRenderedPresentationQuality(presentation);
    assert.equal(result.summary.renderedSlides, 2);
    assert.equal(result.issues.some(issue => issue.code === 'RENDER_FAILED'), false);
});

test('页面版式探索生成三种可编辑候选，并保持锁定元素坐标不变', () => {
    const presentation = testPresentation();
    const slide = presentation.slides[0];
    slide.elements.push({ id: 'hero_chart', type: 'chart', x: 120, y: 320, width: 500, height: 250, rotation: 0, zIndex: 5, locked: false, visible: true, sourceRefs: [], chartType: 'bar', title: '趋势', data: { columns: ['阶段', '数值'], rows: [['Q1', 1], ['Q2', 2]] }, options: { showLegend: false, showLabels: true, colors: ['#1769AA'] } });
    slide.elements.push({ id: 'locked_logo', type: 'shape', x: 20, y: 20, width: 50, height: 30, rotation: 0, zIndex: 20, locked: true, visible: true, sourceRefs: [], shapeType: 'rect', style: { fill: '#1769AA', stroke: '#1769AA', strokeWidth: 1, opacity: 1, radius: 0 } });
    const variants = buildSlideLayoutVariants(slide);
    assert.deepEqual(variants.map(item => item.id), ['executive-summary', 'evidence-focus', 'balanced-comparison']);
    variants.forEach(variant => {
        const logo = variant.slide.elements.find(element => element.id === 'locked_logo');
        assert.equal(logo.x, 20);
        assert.equal(logo.y, 20);
        assert.equal(variant.slide.elements.find(element => element.id === 'title').y, 58);
    });
});

test('质量检查识别文本溢出、占位符和内容密度', () => {
    const presentation = testPresentation();
    const body = presentation.slides[0].elements[1];
    body.content.text = '请填写 '.repeat(180);
    body.height = 12;
    const result = runPresentationValidation(presentation);
    assert.equal(result.status, 'blocked');
    assert.ok(result.issues.some(issue => issue.code === 'TEXT_OVERFLOW'));
    assert.ok(result.issues.some(issue => issue.code === 'PLACEHOLDER_REMAINS'));
});

test('质量检查提示页面和演讲者备注中的敏感信息', () => {
    const presentation = testPresentation();
    presentation.slides[0].elements[1].content.text = '联系人手机号：13800138000';
    presentation.slides[0].speakerNotes = '密码：not-for-demo';
    const result = runPresentationValidation(presentation);
    assert.ok(result.issues.some(issue => issue.code === 'SENSITIVE_CONTENT'));
    assert.ok(result.issues.some(issue => issue.code === 'SENSITIVE_NOTES'));
    assert.throws(() => assertSensitiveExportAllowed(result, { allowSensitiveExport: false }), /敏感内容/);
    assert.equal(assertSensitiveExportAllowed(result, { allowSensitiveExport: true }).length, 2);
});

test('模板包必须具备版本、类型和受控主题/布局定义', () => {
    const template = getBuiltInTemplate('business-blue');
    const pack = normalizeTemplatePackage({
        schemaVersion: '1.0', kind: 'pivot-presentation-template',
        template: { name: '导入模板', description: '测试', aspectRatio: '16:9', tags: ['测试'], definition: { theme: template.theme, layouts: template.layouts } }
    });
    assert.equal(pack.name, '导入模板');
    assert.equal(pack.definition.layouts.length, 10);
    assert.throws(() => normalizeTemplatePackage({ schemaVersion: '1.0', kind: 'other', template: {} }), /模板包/);
});

test('PPT 导出器从同一 IR 生成 PNG、PDF 和 PPTX 二进制', async () => {
    const presentation = testPresentation();
    presentation.slides[0].elements.push({
        id: 'chart', type: 'chart', x: 100, y: 480, width: 500, height: 180, rotation: 0, zIndex: 8, locked: false, visible: true, sourceRefs: [],
        chartType: 'bar', title: '完成率', data: { columns: ['季度', '完成率'], rows: [['Q1', 65], ['Q2', 85]] }, options: { showLegend: false, showLabels: true, colors: ['#1769AA', '#5B8FF9'] }
    });
    const png = await renderPresentation(presentation, 'png');
    const pdf = await renderPresentation(presentation, 'pdf');
    const pptx = await renderPresentation(presentation, 'pptx');
    assert.ok(png.buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])));
    assert.equal(pdf.buffer.subarray(0, 4).toString(), '%PDF');
    assert.equal(pptx.buffer.subarray(0, 2).toString(), 'PK');
    assert.equal(pptx.mimeType, 'application/vnd.openxmlformats-officedocument.presentationml.presentation');
    assert.equal((await sharp(png.buffer).metadata()).format, 'png');
    assert.equal((await PDFDocument.load(pdf.buffer)).getPageCount(), 1);
    const packageDirectory = await unzipper.Open.buffer(pptx.buffer);
    assert.ok(packageDirectory.files.some(file => file.path === 'ppt/presentation.xml'));
    assert.ok(packageDirectory.files.some(file => file.path === 'ppt/slides/slide1.xml'));
});

test('PPT 渲染器可将背景素材和 WebP 素材统一输出为三种交付格式', async () => {
    const presentation = testPresentation();
    const png = await sharp({ create: { width: 4, height: 4, channels: 4, background: '#1769AA' } }).png().toBuffer();
    const webp = await sharp(png).webp().toBuffer();
    const ref = 'artifact-cas://fedcba9876543210';
    presentation.slides[0].background.imageAssetRef = ref;
    presentation.slides[0].background.opacity = 0.4;
    const resolver = async requested => requested === ref ? { buffer: webp, mimeType: 'image/webp' } : null;
    const [pngOut, pdfOut, pptxOut] = await Promise.all(['png', 'pdf', 'pptx'].map(format => renderPresentation(presentation, format, { assetResolver: resolver })));
    assert.ok(pngOut.buffer.length > 100);
    assert.equal(pdfOut.buffer.subarray(0, 4).toString(), '%PDF');
    assert.equal(pptxOut.buffer.subarray(0, 2).toString(), 'PK');
});

test('AI 页面提案必须经过受控 PPT IR 校验', () => {
    const proposal = parsePresentationProposal(JSON.stringify({
        title: '测试文稿',
        slides: [{
            id: 'slide_1', type: 'cover', layoutId: 'cover',
            elements: [{ id: 'title', type: 'text', x: 80, y: 180, width: 1120, height: 80, content: { text: '测试标题' }, style: { fontSize: 40, fontWeight: 700, color: '#1F2937', align: 'center' } }],
            speakerNotes: '', sourceRefs: []
        }]
    }), { title: '测试文稿', templateId: 'business-blue' });
    assert.equal(proposal.presentation.slides.length, 1);
    assert.equal(proposal.presentation.theme.name, '商务蓝汇报');
});

test('AI 页面提案兼容代码围栏、尾随逗号和字符串中的原始换行', () => {
    const source = JSON.stringify({
        title: 'JSON 容错演示',
        slides: [{
            id: 'slide_1', type: 'content', layoutId: 'title-content',
            elements: [{ id: 'title', type: 'text', x: 80, y: 80, width: 900, height: 100, content: { text: '有效标题' }, style: { fontSize: 32, color: '#1F2937' } }],
            speakerNotes: '稳定备注', sourceRefs: []
        }]
    });
    const malformed = source.replace('稳定备注', '第一行\n第二行').replace(/}$/, ',}');
    const fenced = '模型附言\n' + String.fromCharCode(96).repeat(3) + 'json\n' + malformed + '\n' + String.fromCharCode(96).repeat(3);
    const proposal = parsePresentationProposal(fenced, { title: 'JSON 容错演示' });
    assert.equal(proposal.presentation.title, 'JSON 容错演示');
    assert.equal(proposal.presentation.slides[0].speakerNotes, '第一行\n第二行');
});

test('AI 页面紧凑重试使用更小的受控输出契约', () => {
    const messages = buildSlidesMessages({ topic: '紧凑页面', templateId: 'business-blue', outline: { title: '紧凑页面', slides: [] }, compact: true });
    const prompt = messages.at(-1).content;
    assert.match(prompt, /紧凑输出模式/);
    assert.match(prompt, /每页使用 2 至 3 个元素/);
});

test('AI 演示大纲只保留本轮实际提供材料的来源引用', () => {
    const outline = {
        title: '无材料演示',
        outline: [{
            section: '方案',
            slides: [{ title: '现状', purpose: '', layoutHint: 'title-content', keyPoints: ['关键结论'], sourceRefs: ['source_1', 'unknown_source'] }]
        }]
    };
    const withoutMaterials = filterOutlineSourceRefs(outline, []);
    assert.deepEqual(withoutMaterials.outline[0].slides[0].sourceRefs, []);
    const withUploadedSource = filterOutlineSourceRefs(outline, [{ id: 'source_1720000000000' }]);
    assert.deepEqual(withUploadedSource.outline[0].slides[0].sourceRefs, ['source_1720000000000']);
    const withMultipleSources = filterOutlineSourceRefs(outline, [{ id: 'source_1720000000000' }, { id: 'source_1720000000001' }]);
    assert.deepEqual(withMultipleSources.outline[0].slides[0].sourceRefs, []);
    assert.deepEqual(outline.outline[0].slides[0].sourceRefs, ['source_1', 'unknown_source']);
});

test('AI 页面提案会安全跳过缺少列的表格和不完整图表，不阻断整份演示生成', () => {
    const proposal = {
        title: 'AI 生成容错验证',
        slides: [{
            id: 'slide_1', type: 'content', layoutId: 'title-content', background: { fill: '#FFFFFF' },
            elements: [
                { id: 'title', type: 'text', x: 80, y: 60, width: 1120, height: 80, content: { text: '有效页面标题' }, style: { fontSize: 32, fontWeight: 700, color: '#1F2937', align: 'left' } },
                { id: 'empty_table', type: 'table', x: 80, y: 180, width: 500, height: 260, columns: [], rows: [] },
                { id: 'empty_chart', type: 'chart', x: 620, y: 180, width: 500, height: 260, chartType: 'bar', data: { columns: ['类别'], rows: [] } }
            ], speakerNotes: '', sourceRefs: []
        }]
    };
    const repaired = repairAiPresentationProposal(proposal);
    assert.equal(repaired.slides[0].elements.some(element => element.id === 'empty_table'), false);
    assert.equal(repaired.slides[0].elements.some(element => element.id === 'empty_chart'), false);
    assert.match(repaired.warnings.join('\n'), /表格缺少有效列/);
    assert.match(repaired.warnings.join('\n'), /图表缺少可核实的数据/);
    const parsed = parsePresentationProposal(JSON.stringify(proposal), { title: proposal.title });
    assert.equal(parsed.presentation.slides[0].elements.some(element => element.type === 'table'), false);
    assert.equal(parsed.presentation.slides[0].elements.some(element => element.type === 'chart'), false);
});

test('AI 页面提案会修复模型常见的标识、边界与来源引用问题', () => {
    const proposal = {
        title: '模型容错矩阵',
        slides: [{
            id: '重复页面', type: 'content', layoutId: 'title-content', sourceRefs: ['source_1', 'unknown'],
            elements: [
                { id: '重复元素', type: 'text', x: -120, y: 20, width: 5000, height: 90, content: { text: '第一页标题' }, style: { color: '#fff', fontSize: 180, fontWeight: 9999 }, sourceRefs: ['source_1', 'unknown'] },
                { id: '重复元素', type: 'table', x: 80, y: 180, width: 500, height: 220, data: { columns: ['事项', '状态'], rows: [['需求', '完成'], ['联调']] }, sourceRefs: ['source_1'] },
                { id: 'unsupported', type: 'image', x: 80, y: 420, width: 200, height: 120, assetRef: 'https://example.invalid/x.png' }
            ], speakerNotes: ''
        }, {
            id: '重复页面', type: 'content', layoutId: 'title-content',
            elements: [{ id: 'chart', type: 'chart', x: 700, y: 120, width: 800, height: 520, chartType: 'unknown', data: { columns: ['月份', '数量'], rows: [['一月', 12], ['二月', 24]] }, sourceRefs: ['source_1'] }], sourceRefs: []
        }]
    };
    const parsed = parsePresentationProposal(JSON.stringify(proposal), { title: proposal.title, aspectRatio: '4:3', sources: [{ id: 'source_1', title: '项目材料', type: 'material' }] });
    const [first, second] = parsed.presentation.slides;
    assert.notEqual(first.id, second.id);
    assert.equal(first.sourceRefs.join(','), 'source_1');
    assert.equal(first.elements.some(element => element.type === 'image'), false);
    assert.equal(first.elements[0].x, 0);
    assert.ok(first.elements[0].width <= 960);
    assert.equal(first.elements[0].style.color, '#FFFFFF');
    assert.equal(first.elements[0].style.fontSize, 96);
    const table = first.elements.find(element => element.type === 'table');
    assert.deepEqual(table.columns, ['事项', '状态']);
    assert.deepEqual(table.rows[1], ['联调', '']);
    const chart = second.elements.find(element => element.type === 'chart');
    assert.equal(chart.chartType, 'bar');
    assert.equal(chart.sourceRefs.join(','), 'source_1');
});

test('PPT 页数上限保持产品防护边界', () => {
    const presentation = testPresentation();
    presentation.slides = Array.from({ length: MAX_SLIDES + 1 }, (_, index) => ({ ...presentation.slides[0], id: `slide_${index}` }));
    assert.equal(validatePresentation(presentation).valid, false);
});


test('PPT AI 扩展协议支持继续生成、页面改写和事实校验结果归一化', () => {
    const proposal = parsePresentationProposal(JSON.stringify({ title: '扩展测试', slides: [{ id: 's1', type: 'content', layoutId: 'title-content', elements: [{ id: 't', type: 'text', x: 80, y: 80, width: 800, height: 100, content: { text: '改写后' }, style: { fontSize: 30, color: '#1F2937' } }], sourceRefs: [] }] }), { title: '扩展测试', templateId: 'business-blue' });
    assert.equal(buildContinueMessages({ outline: { title: '扩展测试' } }).length, 2);
    assert.equal(buildRewriteMessages({ title: '扩展测试', slide: proposal.presentation.slides[0], instruction: '精简' }).length, 2);
    assert.equal(buildValidationMessages({ presentation: proposal.presentation }).length, 2);
    const validation = parseValidationProposal(JSON.stringify({ status: 'warning', issues: [{ severity: 'warning', slideId: 's1', code: 'FACT_UNVERIFIED', message: '数字待核实' }], assumptions: ['需补充来源'] }));
    assert.equal(validation.status, 'warning');
    assert.equal(validation.issues[0].code, 'FACT_UNVERIFIED');
});


test('组织品牌控制会锁定 Logo、页脚、页码和字体，保存时可重新施加', () => {
    const presentation = testPresentation();
    presentation.slides[0].elements[0].style.fontFamily = 'Unapproved Font';
    const controlled = applyTemplateBrandControls(presentation, {
        definition: {
            theme: presentation.theme,
            brandControls: {
                footerText: 'Pivot 组织内部资料',
                logoAssetRef: 'artifact-cas://0123456789abcdef',
                lockBrandElements: true,
                lockFonts: true,
                showPageNumber: true
            }
        }
    });
    const elements = controlled.slides[0].elements;
    assert.ok(elements.some(item => item.id === 'pivotBrand_footer' && item.locked));
    assert.ok(elements.some(item => item.id === 'pivotBrand_page' && item.locked));
    assert.ok(elements.some(item => item.id === 'pivotBrand_logo' && item.locked && item.assetRef === 'artifact-cas://0123456789abcdef'));
    assert.equal(elements.find(item => item.id === 'title').style.fontFamily, presentation.theme.fonts.heading);
    const cleared = applyTemplateBrandControls(controlled, { definition: { theme: presentation.theme, brandControls: {} } });
    assert.equal(cleared.slides[0].elements.some(item => item.id.startsWith('pivotBrand_')), false);
});


test('受限 PPTX 模板导入提取主题、比例和布局，并拒绝非 OOXML 包', async () => {
    const pptx = await renderPresentation(testPresentation(), 'pptx');
    const imported = await importPptxTemplatePackage(pptx.buffer, { filename: '外部汇报模板.pptx' });
    assert.equal(imported.name, '外部汇报模板');
    assert.equal(imported.aspectRatio, '16:9');
    assert.ok(imported.definition.theme.colors.primary.startsWith('#'));
    assert.ok(imported.definition.layouts.length >= 1);
    await assert.rejects(() => importPptxTemplatePackage(Buffer.from('not a pptx')), /PPTX|OOXML/);
});


test('八套内置主题均可生成固定尺寸的 PNG 视觉回归基准', async () => {
    const templates = listBuiltInTemplates();
    const results = await Promise.all(templates.map(async template => {
        const presentation = defaultPresentation({ title: template.name + '基准页', template });
        const rendered = await renderPresentation(presentation, 'png');
        const metadata = await sharp(rendered.buffer).metadata();
        return { id: template.id, width: metadata.width, height: metadata.height, format: metadata.format, bytes: rendered.buffer.length, sha256: crypto.createHash('sha256').update(rendered.buffer).digest('hex') };
    }));
    assert.equal(results.length, 8);
    const baselinePath = path.join(__dirname, 'fixtures', 'presentation-template-visual-baselines.json');
    const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
    results.forEach(result => {
        assert.equal(result.width, baseline.templates[result.id]?.width, result.id);
        assert.equal(result.height, baseline.templates[result.id]?.height, result.id);
        assert.equal(result.format, 'png', result.id);
        assert.ok(result.bytes > 1000, result.id);
        const expectedSha = baseline.platforms?.[process.platform]?.[result.id]?.sha256 || (process.platform === 'win32' ? baseline.templates[result.id]?.sha256 : null);
        if (expectedSha) {
            assert.equal(result.sha256, expectedSha, result.id + ' 的视觉基准发生变化；如为有意设计更新，请重新生成基准。');
        } else {
            assert.match(result.sha256, /^[0-9a-f]{64}$/, result.id + ' 应生成有效的 SHA-256 校验和');
        }
    });
});


test('20 页普通文稿在本地受控渲染预算内生成 PDF 和 PPTX', async () => {
    const presentation = testPresentation();
    const original = JSON.parse(JSON.stringify(presentation.slides[0]));
    presentation.slides = Array.from({ length: 20 }, (_, index) => ({
        ...JSON.parse(JSON.stringify(original)), id: 'performance_slide_' + index, index,
        elements: JSON.parse(JSON.stringify(original.elements)).map((element, elementIndex) => ({
            ...element, id: element.id + '_' + index + '_' + elementIndex,
            ...(element.content ? { content: { ...element.content, text: (element.content.text || '') + ' ' + index } } : {})
        }))
    }));
    const pdfStartedAt = Date.now(); const pdf = await renderPresentation(presentation, 'pdf'); const pdfDuration = Date.now() - pdfStartedAt;
    const pptxStartedAt = Date.now(); const pptx = await renderPresentation(presentation, 'pptx'); const pptxDuration = Date.now() - pptxStartedAt;
    assert.equal(pdf.buffer.subarray(0, 4).toString(), '%PDF');
    assert.equal(pptx.buffer.subarray(0, 2).toString(), 'PK');
    assert.ok(pdfDuration < 15_000, '20 页 PDF 预览渲染超过 15 秒预算');
    assert.ok(pptxDuration < 30_000, '20 页 PPTX 导出超过 30 秒预算');
});


test('PPT 高级 IR 支持图示、媒体、附件、元素动画和页面转场', async () => {
    const presentation = testPresentation();
    const ref = 'artifact-cas://0123456789abcdef';
    presentation.slides[0].transition = { type: 'push', durationMs: 700, direction: 'left' };
    presentation.slides[0].elements.push({ id: 'diagram_1', type: 'diagram', x: 80, y: 420, width: 920, height: 150, rotation: 0, zIndex: 20, locked: false, visible: true, sourceRefs: [], diagramType: 'process', items: ['规划', '执行', '复盘'], style: { fill: '#EFF6FF', stroke: '#2563EB', textColor: '#1E3A8A', fontSize: 16 }, animation: { type: 'fade', durationMs: 500 } });
    presentation.slides[0].elements.push({ id: 'media_1', type: 'media', mediaType: 'audio', assetRef: ref, x: 100, y: 600, width: 300, height: 80, rotation: 0, zIndex: 21, locked: false, visible: true, sourceRefs: [], autoPlay: false, loop: false, showControls: true, alt: '提示音' });
    const normalized = normalizePresentation(presentation);
    assert.equal(normalized.slides[0].transition.type, 'push');
    assert.equal(normalized.slides[0].elements.find(item => item.id === 'diagram_1').animation.type, 'fade');
    assert.ok(collectPresentationAssetRefs(normalized).includes(ref));
    const wav = Buffer.alloc(44); wav.write('RIFF', 0); wav.writeUInt32LE(36, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(8000, 28); wav.writeUInt16LE(1, 32); wav.writeUInt16LE(8, 34); wav.write('data', 36); wav.writeUInt32LE(0, 40);
    const [png, pdf, pptx] = await Promise.all(['png', 'pdf', 'pptx'].map(format => renderPresentation(normalized, format, { assetResolver: async candidate => candidate === ref ? { buffer: wav, mimeType: 'audio/wav' } : null })));
    assert.equal(png.buffer.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    assert.equal(pdf.buffer.subarray(0, 4).toString(), '%PDF');
    const zip = await JSZip.loadAsync(pptx.buffer);
    assert.match(await zip.file('ppt/slides/slide1.xml').async('string'), /<p:transition\b/);
});

test('PPT 受控字体、宏静态扫描和运营指标具有安全边界', async () => {
    assert.equal(inferPresentationAssetType({ originalname: 'font.ttf', mimetype: 'application/octet-stream', buffer: Buffer.from([0, 1, 0, 0]) }), 'font');
    assert.equal(inferPresentationAssetType({ originalname: 'sound.wav', mimetype: 'application/octet-stream', buffer: Buffer.from('RIFFxxxxWAVE') }), 'audio');
    assert.equal(scanVbaSource(Buffer.from('Sub Demo()\nMsgBox "ok"\nEnd Sub'), 'demo.bas').allowed, true);
    assert.equal(scanVbaSource(Buffer.from('Sub Auto_Open()\nShell "cmd.exe"\nEnd Sub'), 'bad.bas').allowed, false);
    recordPresentationOutcome('test', { outcome: 'success', durationMs: 12, format: 'pptx' });
    assert.ok(getPresentationMetricsSnapshot().counters.some(item => item.labels.operation === 'test'));
});


test('自定义封面和 Agent 产物转换均保留受控来源引用', () => {
    const ref = 'artifact-cas://0123456789abcdef';
    const presentation = testPresentation();
    presentation.metadata.coverAssetRef = ref;
    assert.ok(collectPresentationAssetRefs(normalizePresentation(presentation)).includes(ref));
    const template = getBuiltInTemplate('business-blue');
    const converted = presentationFromArtifactText({ title: '产物转换', template: { ...template, definition: { theme: template.theme, layouts: template.layouts } }, text: '# 背景\n背景内容\n# 结论\n结论内容', artifactId: 7 });
    const checked = normalizePresentation(converted);
    assert.equal(checked.sources[0].type, 'agent_artifact');
    assert.ok(checked.slides.length >= 1);
});


test('质量检查覆盖来源、字体、图片清晰度和数据来源治理', () => {
    const presentation = testPresentation();
    presentation.sources = [{ id: 'source_1', title: '项目材料', type: 'material', locator: '第 1 页', digest: '' }];
    presentation.slides[0].elements[0].style.fontFamily = 'Uncontrolled Custom Font';
    presentation.slides[0].elements.push({ id: 'low_res', type: 'image', x: 700, y: 220, width: 300, height: 180, rotation: 0, zIndex: 8, locked: false, visible: true, sourceRefs: [], assetRef: 'artifact-cas://0123456789abcdef', fit: 'cover', opacity: 1, intrinsicWidth: 320, intrinsicHeight: 180, alt: '' });
    presentation.slides[0].elements.push({ id: 'chart_without_source', type: 'chart', x: 120, y: 460, width: 500, height: 180, rotation: 0, zIndex: 9, locked: false, visible: true, sourceRefs: [], chartType: 'bar', title: '趋势', data: { columns: ['阶段', '数值'], rows: [['一季度', 1]] }, options: { showLegend: false, showLabels: true, colors: ['#1769AA'] } });
    const result = runPresentationValidation(presentation);
    assert.ok(result.issues.some(issue => issue.code === 'SOURCE_ATTRIBUTION_MISSING'));
    assert.ok(result.issues.some(issue => issue.code === 'FONT_FALLBACK_RISK'));
    assert.ok(result.issues.some(issue => issue.code === 'IMAGE_LOW_RESOLUTION'));
    assert.ok(result.issues.some(issue => issue.code === 'DATA_SOURCE_MISSING'));
});

test('AI 创建协议传递语言、时长、图表、引用及内容边界', () => {
    const body = { topic: '年度经营复盘', audience: '管理层', purpose: '明确行动计划', duration: '20 分钟', pageCount: 8, language: 'zh-CN,en-US', style: '正式', needsCharts: true, retainSourceRefs: true, mustInclude: '收入、风险、行动', prohibitedContent: '未经核实数据', materials: [{ id: 'source_1', title: '经营材料', text: '收入增长 10%' }] };
    const outline = buildOutlineMessages(body).at(-1).content;
    const slides = buildSlidesMessages({ ...body, outline: { title: body.topic, slides: [] } }).at(-1).content;
    ['输出语言：zh-CN,en-US', '演示时长：20 分钟', '必须包含：收入、风险、行动', '禁止出现：未经核实数据', '数据图表：需要'].forEach(expected => assert.ok(outline.includes(expected), expected));
    assert.ok(slides.includes('来源引用：重要数字、结论和材料摘录必须保留 sourceRefs'));
});

test('AI 大纲提示词向模型提供上传材料的真实来源标识', () => {
    const uploadedSourceId = 'source_1720000000000';
    const prompt = buildOutlineMessages({ topic: '项目复盘', materials: [{ id: uploadedSourceId, title: '上传报告', text: '项目进度与风险。' }] }).at(-1).content;
    assert.ok(prompt.includes(`来源 ${uploadedSourceId} / 上传报告`));
    assert.ok(prompt.includes(`sourceRefs 只能使用本次材料的来源标识：${uploadedSourceId}`));
    assert.ok(prompt.includes(`"sourceRefs":["${uploadedSourceId}"]`));
    assert.equal(prompt.includes('"sourceRefs":["source_1"]'), false);
});

test('导出器遵守备注选项并继续生成三种受控格式', async () => {
    const presentation = testPresentation();
    presentation.slides[0].speakerNotes = '演讲者备注';
    const [pptxWithNotes, pptxWithoutNotes, pngHigh] = await Promise.all([
        renderPresentation(presentation, 'pptx', { includeNotes: true }),
        renderPresentation(presentation, 'pptx', { includeNotes: false }),
        renderPresentation(presentation, 'png', { imageQuality: 'high' })
    ]);
    const withNotes = await JSZip.loadAsync(pptxWithNotes.buffer);
    const withoutNotes = await JSZip.loadAsync(pptxWithoutNotes.buffer);
    const noteXmlWith = await withNotes.file('ppt/notesSlides/notesSlide1.xml')?.async('string') || '';
    const noteXmlWithout = await withoutNotes.file('ppt/notesSlides/notesSlide1.xml')?.async('string') || '';
    assert.ok(noteXmlWith.includes('演讲者备注'));
    assert.equal(noteXmlWithout.includes('演讲者备注'), false);
    assert.equal(pngHigh.buffer.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
});

test('导出缓存配置区分 PPTX 备注和 PNG 的页面及清晰度选项', () => {
    const pptxWithNotes = exportRendererVersion('pptx', normalizeExportOptions({ includeNotes: true }));
    const pptxWithoutNotes = exportRendererVersion('pptx', normalizeExportOptions({ includeNotes: false }));
    const pngStandard = exportRendererVersion('png', normalizeExportOptions({ slideIndex: 0, imageQuality: 'standard' }));
    const pngHigh = exportRendererVersion('png', normalizeExportOptions({ slideIndex: 0, imageQuality: 'high' }));
    const pngOtherSlide = exportRendererVersion('png', normalizeExportOptions({ slideIndex: 1, imageQuality: 'standard' }));
    assert.notEqual(pptxWithNotes, pptxWithoutNotes);
    assert.notEqual(pngStandard, pngHigh);
    assert.notEqual(pngStandard, pngOtherSlide);
});
