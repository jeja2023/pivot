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
const { runPresentationValidation } = require('../server/services/presentations/presentation-validation');
const { renderPresentation } = require('../server/services/presentations/presentation-renderer');
const { parsePresentationProposal, parseValidationProposal, buildRewriteMessages, buildContinueMessages, buildValidationMessages } = require('../server/services/presentations/presentation-ai');
const { normalizeTemplatePackage, applyTemplateBrandControls, inferPresentationAssetType, presentationFromArtifactText } = require('../server/services/presentations/presentation-service');
const { scanVbaSource } = require('../server/services/presentations/presentation-vba');
const { recordPresentationOutcome, getPresentationMetricsSnapshot } = require('../server/services/presentations/presentation-metrics');
const { importPptxTemplatePackage } = require('../server/services/presentations/presentation-pptx-template-import');
const { buildOutlineMessages, buildSlidesMessages } = require('../server/services/presentations/presentation-ai');

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
