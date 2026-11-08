'use strict';

const PptxGenJS = require('pptxgenjs');
const Zip = require('jszip');
const { DOMParser, XMLSerializer } = require('@xmldom/xmldom');

async function fixture() {
    const pptx = new PptxGenJS(); pptx.layout = 'LAYOUT_WIDE'; pptx.author = '离线验收';
    const first = pptx.addSlide();
    first.addText([{ text: '离线', options: { bold: true, color: '17324D' } }, { text: '原生编辑验收', options: { italic: true, color: '1769AA' } }], { x: 0.8, y: 0.5, w: 10, h: 0.8, fontFace: 'Noto Sans CJK SC', fontSize: 30, objectName: '验收富文本' });
    first.addShape(pptx.ShapeType.rect, { x: 1, y: 2, w: 3, h: 1.8, fill: { color: '1769AA' }, objectName: '验收渐变' });
    first.addShape(pptx.ShapeType.rect, { x: 5, y: 2, w: 3, h: 1.8, fill: { color: '1769AA' }, objectName: '验收自由路径' });
    first.addText('a/b', { x: 1, y: 4.5, w: 6, h: 1.2, fontSize: 30, objectName: '验收公式' });
    const second = pptx.addSlide();
    second.addText('原生表格与图表', { x: 0.8, y: 0.4, w: 10, h: 0.6, fontFace: 'Noto Sans CJK SC', fontSize: 28 });
    second.addTable([['部门', '收入'], ['研发', '120'], ['服务', '80']], { x: 0.8, y: 1.5, w: 4.2, h: 3, fontFace: 'Noto Sans CJK SC', fontSize: 18, objectName: '验收表格' });
    second.addChart(pptx.ChartType.bar, [{ name: '营收', labels: ['第一季', '第二季'], values: [120, 100] }, { name: '成本', labels: ['第一季', '第二季'], values: [80, -5] }], { x: 6, y: 1.5, w: 6, h: 4, catAxisLabelFontFace: 'Noto Sans CJK SC', showLegend: true, objectName: '验收图表' });
    const third = pptx.addSlide(); third.addText('此页保持原始XML', { x: 1, y: 1, w: 10, h: 1, fontFace: 'Noto Sans CJK SC', fontSize: 30, objectName: '保持原页' });
    const zip = await Zip.loadAsync(await pptx.write({ outputType: 'nodebuffer' }));
    const NS = { p: 'http://schemas.openxmlformats.org/presentationml/2006/main', a: 'http://schemas.openxmlformats.org/drawingml/2006/main' };
    const parser = new DOMParser(), xml = parser.parseFromString(await zip.file('ppt/slides/slide1.xml').async('string'), 'application/xml');
    const byName = name => Array.from(xml.getElementsByTagNameNS(NS.p, 'sp')).find(shape => shape.getElementsByTagNameNS(NS.p, 'cNvPr')[0].getAttribute('name') === name);
    const fragment = source => parser.parseFromString(source, 'application/xml').documentElement;
    const gradient = byName('验收渐变').getElementsByTagNameNS(NS.p, 'spPr')[0], solid = gradient.getElementsByTagNameNS(NS.a, 'solidFill')[0];
    gradient.replaceChild(xml.importNode(fragment(`<a:gradFill xmlns:a="${NS.a}"><a:gsLst><a:gs pos="0"><a:srgbClr val="1769AA"/></a:gs><a:gs pos="100000"><a:srgbClr val="A6D9F7"/></a:gs></a:gsLst><a:lin ang="0" scaled="1"/></a:gradFill>`), true), solid);
    const freeform = byName('验收自由路径').getElementsByTagNameNS(NS.a, 'prstGeom')[0];
    freeform.parentNode.replaceChild(xml.importNode(fragment(`<a:custGeom xmlns:a="${NS.a}"><a:avLst/><a:gdLst/><a:ahLst/><a:cxnLst/><a:rect l="0" t="0" r="r" b="b"/><a:pathLst><a:path w="1000" h="1000"><a:moveTo><a:pt x="0" y="1000"/></a:moveTo><a:lnTo><a:pt x="500" y="0"/></a:lnTo><a:lnTo><a:pt x="1000" y="1000"/></a:lnTo><a:close/></a:path></a:pathLst></a:custGeom>`), true), freeform);
    const body = byName('验收公式').getElementsByTagNameNS(NS.p, 'txBody')[0], paragraph = body.getElementsByTagNameNS(NS.a, 'p')[0];
    body.replaceChild(xml.importNode(fragment(`<a:p xmlns:a="${NS.a}" xmlns:a14="http://schemas.microsoft.com/office/drawing/2010/main" xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"><a14:m><m:oMath><m:f><m:num><m:r><m:t>a</m:t></m:r></m:num><m:den><m:r><m:t>b</m:t></m:r></m:den></m:f></m:oMath></a14:m></a:p>`), true), paragraph);
    const formulaParagraph = body.getElementsByTagNameNS(NS.a, 'p')[0];
    formulaParagraph.insertBefore(xml.importNode(fragment(`<a:pPr xmlns:a="${NS.a}"><a:defRPr sz="3000"/></a:pPr>`), true), formulaParagraph.firstChild);
    const formulaRuns = formulaParagraph.getElementsByTagNameNS('http://schemas.openxmlformats.org/officeDocument/2006/math', 'r');
    for (const run of Array.from(formulaRuns)) run.insertBefore(xml.importNode(fragment(`<a:rPr xmlns:a="${NS.a}" sz="3000"><a:latin typeface="Cambria Math"/></a:rPr>`), true), run.firstChild);
    const tree = xml.getElementsByTagNameNS(NS.p, 'spTree')[0];
    const group = xml.importNode(fragment(`<p:grpSp xmlns:p="${NS.p}" xmlns:a="${NS.a}"><p:nvGrpSpPr><p:cNvPr id="100" name="验收组合"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="914400" y="1828800"/><a:ext cx="6400800" cy="1645920"/><a:chOff x="914400" y="1828800"/><a:chExt cx="6400800" cy="1645920"/></a:xfrm></p:grpSpPr></p:grpSp>`), true);
    const firstShape = byName('验收渐变'), secondShape = byName('验收自由路径'); tree.insertBefore(group, firstShape); group.appendChild(firstShape); group.appendChild(secondShape);
    zip.file('ppt/slides/slide1.xml', new XMLSerializer().serializeToString(xml));
    return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}
module.exports = { fixture };
