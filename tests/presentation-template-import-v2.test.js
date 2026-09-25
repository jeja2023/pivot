'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const JSZip = require('jszip');
const { defaultPresentation } = require('../server/services/presentations/presentation-schema');
const { getBuiltInTemplate } = require('../server/services/presentations/presentation-templates');
const { importPptxTemplatePackage } = require('../server/services/presentations/presentation-pptx-template-import');
const { normalizeTemplateDefinition, applyTemplateLayoutLayers, parsePptxTemplateInWorker } = require('../server/services/presentations/presentation-service');
const { buildSlidesMessages, parsePresentationProposal } = require('../server/services/presentations/presentation-ai');
const { renderPresentation } = require('../server/services/presentations/presentation-renderer');

async function relatedPptx() {
    const zip = new JSZip();
    zip.file('[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/></Types>');
    zip.file('ppt/presentation.xml', '<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldMasterIdLst><p:sldMasterId id="1" r:id="rId1"/></p:sldMasterIdLst><p:sldSz cx="12192000" cy="6858000"/></p:presentation>');
    zip.file('ppt/_rels/presentation.xml.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/></Relationships>');
    zip.file('ppt/slideMasters/slideMaster1.xml', '<p:sldMaster xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:cSld name="企业母版"><p:bg><p:bgPr><a:solidFill><a:schemeClr val="lt1"/></a:solidFill></p:bgPr></p:bg><p:spTree><p:nvGrpSpPr/><p:grpSpPr/><p:pic><p:nvPicPr><p:cNvPr id="2" name="品牌图"/><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="rIdImage"/></p:blipFill><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="1200000" cy="600000"/></a:xfrm></p:spPr></p:pic></p:spTree></p:cSld><p:sldLayoutIdLst><p:sldLayoutId id="2" r:id="rIdLayout"/></p:sldLayoutIdLst></p:sldMaster>');
    zip.file('ppt/slideMasters/_rels/slideMaster1.xml.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdLayout" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/><Relationship Id="rIdTheme" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="../theme/theme1.xml"/><Relationship Id="rIdImage" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/logo.png"/></Relationships>');
    zip.file('ppt/slideLayouts/slideLayout1.xml', '<p:sldLayout xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld name="企业标题页"><p:spTree><p:nvGrpSpPr/><p:grpSpPr/><p:sp><p:nvSpPr><p:cNvPr id="3" name="标题"/><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:spPr><a:xfrm><a:off x="1000000" y="800000"/><a:ext cx="9500000" cy="900000"/></a:xfrm></p:spPr><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr sz="3200" b="1"><a:solidFill><a:schemeClr val="accent1"/></a:solidFill></a:rPr><a:t>标题</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sldLayout>');
    zip.file('ppt/theme/theme1.xml', '<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:themeElements><a:clrScheme name="企业"><a:dk1><a:srgbClr val="102030"/></a:dk1><a:lt1><a:srgbClr val="F5F6F7"/></a:lt1><a:dk2><a:srgbClr val="111111"/></a:dk2><a:lt2><a:srgbClr val="EEEEEE"/></a:lt2><a:accent1><a:srgbClr val="123456"/></a:accent1><a:accent2><a:srgbClr val="234567"/></a:accent2><a:accent3><a:srgbClr val="345678"/></a:accent3><a:accent4><a:srgbClr val="456789"/></a:accent4><a:accent5><a:srgbClr val="56789A"/></a:accent5><a:accent6><a:srgbClr val="6789AB"/></a:accent6></a:clrScheme><a:fontScheme name="企业字体"><a:majorFont><a:latin typeface="Aptos Display"/><a:ea typeface="Microsoft YaHei"/></a:majorFont><a:minorFont><a:latin typeface="Aptos"/><a:ea typeface="Microsoft YaHei"/></a:minorFont></a:fontScheme></a:themeElements></a:theme>');
    zip.file('ppt/media/logo.png', Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    return await zip.generateAsync({ type: 'nodebuffer' });
}

test('PPTX template import follows OOXML relationships for theme, master, layout and image assets', async () => {
    const parsed = await importPptxTemplatePackage(await relatedPptx(), { filename: '企业模板.pptx' });
    assert.equal(parsed.definition.schemaVersion, '2.0');
    assert.equal(parsed.definition.theme.colors.primary, '#123456');
    assert.equal(parsed.definition.theme.colors.text, '#102030');
    assert.equal(parsed.definition.masters.length, 1);
    assert.equal(parsed.definition.layouts.length, 1);
    assert.equal(parsed.definition.layouts[0].placeholders[0].role, 'title');
    assert.equal(parsed.definition.layouts[0].placeholders[0].style.color, '#123456');
    assert.equal(parsed.assets.length, 1);
    assert.equal(parsed.assets[0].mimeType, 'image/png');
    assert.equal(parsed.definition.masters[0].decorations[0].locked, false);
    assert.ok(parsed.report.some(item => item.code === 'FONT_SUBSTITUTION_RISK'));
    const fidelity = await importPptxTemplatePackage(await relatedPptx(), { filename: '企业模板.pptx', importMode: 'fidelity' });
    assert.equal(fidelity.definition.masters[0].decorations[0].locked, true);
});

test('PPTX preflight worker returns the same controlled template structure without a database connection', async () => {
    const parsed = await parsePptxTemplateInWorker(await relatedPptx(), { filename: '工作进程模板.pptx' });
    assert.equal(parsed.definition.schemaVersion, '2.0');
    assert.equal(parsed.definition.layouts.length, 1);
    assert.equal(parsed.assets[0].buffer.subarray(0, 4).toString('hex'), '89504e47');
});

test('PPTX template import maps a sample slide transition and placeholder entrance animation to its layout', async () => {
    const zip = await JSZip.loadAsync(await relatedPptx());
    const presentation = await zip.file('ppt/presentation.xml').async('string');
    zip.file('ppt/presentation.xml', presentation.replace('</p:presentation>', '<p:sldIdLst><p:sldId id="256" r:id="rIdSlide"/></p:sldIdLst></p:presentation>'));
    const relations = await zip.file('ppt/_rels/presentation.xml.rels').async('string');
    zip.file('ppt/_rels/presentation.xml.rels', relations.replace('</Relationships>', '<Relationship Id="rIdSlide" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/></Relationships>'));
    zip.file('ppt/slides/slide1.xml', '<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:nvGrpSpPr/><p:grpSpPr/><p:sp><p:nvSpPr><p:cNvPr id="3" name="标题"/><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:spPr><a:xfrm><a:off x="1000000" y="800000"/><a:ext cx="9500000" cy="900000"/></a:xfrm></p:spPr></p:sp></p:spTree></p:cSld><p:transition spd="med"><p:fade/></p:transition><p:timing><p:tnLst><p:par><p:cTn id="1"><p:childTnLst><p:animEffect filter="fade"><p:cBhvr><p:cTn id="2" dur="650"/><p:tgtEl><p:spTgt spid="3"/></p:tgtEl></p:cBhvr></p:animEffect></p:childTnLst></p:cTn></p:par></p:tnLst></p:timing></p:sld>');
    zip.file('ppt/slides/_rels/slide1.xml.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdLayout" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/></Relationships>');
    const parsed = await importPptxTemplatePackage(await zip.generateAsync({ type: 'nodebuffer' }), { filename: '动画模板.pptx' });
    assert.equal(parsed.definition.layouts[0].defaultTransition.type, 'fade');
    assert.equal(parsed.definition.layouts[0].slotAnimations.title.type, 'fade');
    assert.equal(parsed.definition.layouts[0].slotAnimations.title.durationMs, 650);
    assert.equal(parsed.report.some(item => item.code === 'PPTX_COMPATIBILITY_WARNING' && /动画/.test(item.message)), false);
});

test('PPTX template import rejects a high compression ratio package before parsing its content', async () => {
    const zip = new JSZip();
    zip.file('[Content_Types].xml', '<Types/>');
    zip.file('ppt/presentation.xml', '<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"/>');
    zip.file('ppt/media/payload.bin', Buffer.alloc(1024 * 1024));
    const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    await assert.rejects(() => importPptxTemplatePackage(buffer), error => error?.code === 'PRESENTATION_PPTX_TEMPLATE_COMPRESSION_RATIO');
});

test('PPTX template import reports and ignores an external relationship without fetching it', async () => {
    const zip = await JSZip.loadAsync(await relatedPptx());
    const relations = await zip.file('ppt/slideMasters/_rels/slideMaster1.xml.rels').async('string');
    zip.file('ppt/slideMasters/_rels/slideMaster1.xml.rels', relations.replace('</Relationships>', '<Relationship Id="rIdExternal" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="https://example.invalid/brand.png" TargetMode="External"/></Relationships>'));
    const parsed = await importPptxTemplatePackage(await zip.generateAsync({ type: 'nodebuffer' }), { filename: '外部关系模板.pptx' });
    assert.ok(parsed.report.some(item => item.code === 'EXTERNAL_RELATIONSHIP_IGNORED'));
    assert.equal(parsed.assets.some(asset => /example\.invalid/.test(asset.path)), false);
});

test('template v2 validates master assets and creates a locked layout layer with reflowed content', () => {
    const ref = 'artifact-cas://0123456789abcdef';
    const definition = normalizeTemplateDefinition({
        aspectRatio: '16:9',
        definition: {
            schemaVersion: '2.0', theme: getBuiltInTemplate('business-blue').theme,
            masters: [{ id: 'master_1', background: { fill: '#F7F9FC', imageAssetRef: ref, opacity: 1 }, decorations: [{ id: 'logo', type: 'image', x: 30, y: 24, width: 150, height: 60, assetRef: ref, fit: 'contain', opacity: 1, rotation: 0, zIndex: 1, locked: true, visible: true, sourceRefs: [] }] }],
            layouts: [{ id: 'layout_cover', name: '企业封面', masterId: 'master_1', slots: ['title', 'subtitle'], placeholders: [{ id: 'slot_title', role: 'title', kind: 'text', x: 160, y: 210, width: 960, height: 120, style: { fontSize: 42, fontWeight: 700, color: '#123456', align: 'center' }, required: true }, { id: 'slot_subtitle', role: 'subtitle', kind: 'text', x: 220, y: 360, width: 840, height: 60, style: { fontSize: 20, color: '#234567', align: 'center' } }] }]
        }
    });
    const template = { id: 'corporate', version: 1, snapshotDigest: 'snapshot', aspectRatio: '16:9', definition };
    const content = defaultPresentation({ title: '企业汇报', template });
    const layered = applyTemplateLayoutLayers(content, template, { reflow: true });
    assert.equal(layered.slides[0].layoutId, 'layout_cover');
    assert.equal(layered.slides[0].background.imageAssetRef, ref);
    assert.equal(layered.slides[0].elements.find(item => item.id === 'title').x, 160);
    assert.ok(layered.slides[0].elements.some(item => item.id.startsWith('pivotTemplate_') && item.locked));
});

test('Pivot template package v2 remains import-compatible with master and placeholder definitions', () => {
    const template = getBuiltInTemplate('business-blue');
    const normalized = require('../server/services/presentations/presentation-service').normalizeTemplatePackage({
        schemaVersion: '2.0', kind: 'pivot-presentation-template',
        template: { name: 'v2 模板', aspectRatio: '16:9', definition: { schemaVersion: '2.0', theme: template.theme, masters: [{ id: 'master_1', background: { fill: '#F7F9FC' }, decorations: [] }], layouts: [{ id: 'layout_1', masterId: 'master_1', slots: ['title'], placeholders: [{ id: 'title_slot', role: 'title', kind: 'text', x: 80, y: 80, width: 1000, height: 100, style: { fontSize: 32, color: '#1F2937' }, required: true }] }] } }
    });
    assert.equal(normalized.definition.schemaVersion, '2.0');
    assert.equal(normalized.definition.layouts[0].masterId, 'master_1');
});

test('AI template context retains a supplied custom template instead of falling back to a built-in theme', () => {
    const template = { id: 'corporate', name: '企业模板', version: 7, snapshotDigest: 'digest', definition: { theme: getBuiltInTemplate('business-blue').theme, layouts: [{ id: 'corporate_cover', name: '企业封面', placeholders: [{ role: 'title', kind: 'text', required: true }] }] } };
    const prompt = buildSlidesMessages({ templateId: template.id, template, outline: { title: '汇报', slides: [] } }).at(-1).content;
    assert.match(prompt, /企业模板/);
    assert.match(prompt, /corporate_cover/);
    const parsed = parsePresentationProposal(JSON.stringify({ title: '汇报', slides: [{ id: 's1', type: 'cover', layoutId: 'corporate_cover', elements: [{ id: 'title', type: 'text', x: 80, y: 80, width: 1000, height: 100, content: { text: '标题' }, style: { fontSize: 32, color: '#1F2937' } }], sourceRefs: [] }] }), { templateId: template.id, template });
    assert.equal(parsed.presentation.template.id, 'corporate');
    assert.equal(parsed.presentation.template.version, 7);
});

test('AI proposal replaces an unsupported layout hint with a layout from the supplied custom template', () => {
    const template = { id: 'corporate', name: '企业模板', version: 7, snapshotDigest: 'digest', definition: { theme: getBuiltInTemplate('business-blue').theme, layouts: [{ id: 'corporate_cover', name: '企业封面', legacyLayoutId: 'cover', placeholders: [] }, { id: 'corporate_content', name: '企业内容', legacyLayoutId: 'title-content', placeholders: [] }] } };
    const parsed = parsePresentationProposal(JSON.stringify({ title: '汇报', slides: [{ id: 's1', type: 'content', layoutId: 'unknown_layout', elements: [{ id: 'title', type: 'text', x: 80, y: 80, width: 1000, height: 100, content: { text: '标题' }, style: { fontSize: 32, color: '#1F2937' } }], sourceRefs: [] }] }), { templateId: template.id, template });
    assert.equal(parsed.presentation.slides[0].layoutId, 'corporate_cover');
});

test('template v2 applies mapped layout transitions and slot animations when reflowing', () => {
    const definition = normalizeTemplateDefinition({
        definition: {
            schemaVersion: '2.0', theme: getBuiltInTemplate('business-blue').theme,
            masters: [{ id: 'master_1', background: { fill: '#F7F9FC' }, decorations: [] }],
            layouts: [{ id: 'animated_cover', masterId: 'master_1', slots: ['title'], defaultTransition: { type: 'fade', durationMs: 700 }, slotAnimations: { title: { type: 'zoom', durationMs: 500 } }, placeholders: [{ id: 'slot_title', role: 'title', kind: 'text', x: 120, y: 180, width: 1040, height: 100, style: { fontSize: 40, color: '#123456' }, required: true }] }]
        }
    });
    const template = { id: 'animated', version: 1, snapshotDigest: 'digest', aspectRatio: '16:9', definition };
    const layered = applyTemplateLayoutLayers(defaultPresentation({ title: '动画封面', template }), template, { reflow: true });
    assert.equal(layered.slides[0].transition.type, 'fade');
    assert.equal(layered.slides[0].elements.find(item => item.id === 'title').animation.type, 'zoom');
});

test('PPTX export writes supported element entrance animations against deterministic object identifiers', async () => {
    const presentation = defaultPresentation({ title: '动画导出', template: getBuiltInTemplate('business-blue') });
    presentation.slides[0].elements[0].animation = { type: 'fade', durationMs: 500, delayMs: 0, direction: '' };
    const rendered = await renderPresentation(presentation, 'pptx');
    const zip = await JSZip.loadAsync(rendered.buffer);
    const xml = await zip.file('ppt/slides/slide1.xml').async('string');
    assert.match(xml, /name="pivotAnim_title"/);
    assert.match(xml, /<p:timing>/);
    assert.match(xml, /<p:animEffect transition="in" filter="fade">/);
});
