const test = require('node:test');
const assert = require('node:assert/strict');
const unzipper = require('unzipper');
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
const { runPresentationValidation } = require('../server/services/presentations/presentation-validation');
const { renderPresentation } = require('../server/services/presentations/presentation-renderer');
const { parsePresentationProposal } = require('../server/services/presentations/presentation-ai');
const { normalizeTemplatePackage } = require('../server/services/presentations/presentation-service');

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

test('PPT 页数上限保持产品防护边界', () => {
    const presentation = testPresentation();
    presentation.slides = Array.from({ length: MAX_SLIDES + 1 }, (_, index) => ({ ...presentation.slides[0], id: `slide_${index}` }));
    assert.equal(validatePresentation(presentation).valid, false);
});
