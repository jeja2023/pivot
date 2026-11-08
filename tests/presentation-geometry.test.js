'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Zip = require('jszip');
const { PDFDocument, PDFName } = require('pdf-lib');
const geometry = require('../server/services/presentations/presentation-geometry');
const { normalizePresentation } = require('../server/services/presentations/presentation-schema');
const { renderPresentation } = require('../server/services/presentations/presentation-renderer');
const { verifyPptxExport } = require('../server/services/presentations/presentation-export-verification');

function gallery() {
    const names = geometry.list(), slides = [];
    for (let index = 0; index < names.length; index += 40) slides.push({ id: `slide_${slides.length + 1}`, elements: names.slice(index, index + 40).map((name, offset) => ({
        id: 'shape_' + (index + offset), type: 'shape', shapeType: name, x: 22 + offset % 8 * 155, y: 30 + Math.floor(offset / 8) * 132,
        width: 120, height: 85, style: { fill: '#DDECF9', stroke: '#1769AA', radius: 12 }
    })) });
    return normalizePresentation({ title: '187类原生形状验收', slides });
}

test('187类形状在横向、正方形和纵向尺寸中求值，保留曲线、调整柄和完整中文目录', () => {
    assert.equal(geometry.list().length, 187);
    for (const name of geometry.list()) {
        assert.notEqual(geometry.label(name), name); assert.doesNotMatch(geometry.label(name), /undefined/);
        for (const [width, height] of [[300, 160], [200, 200], [100, 300]]) {
            const scene = geometry.shapeScene(name, width, height);
            assert.ok(scene.paths.length, name);
            assert.ok(scene.paths.every(path => !/NaN|Infinity|undefined/.test(path.d)), name);
            assert.ok(scene.connections.every(point => Number.isFinite(point.x) && Number.isFinite(point.y)), name);
        }
    }
    const arrow = geometry.shapeScene('rightArrow', 300, 160, { adj1: 25000 });
    assert.ok(arrow.controls.some(control => control.name === 'adj1' && control.value === 25000));
    assert.notEqual(arrow.paths[0].d, geometry.shapeScene('rightArrow', 300, 160).paths[0].d);
    assert.equal((geometry.shapeScene('ellipse', 300, 160).paths[0].d.match(/A /g) || []).length, 4);
    assert.throws(() => geometry.shapeScene('rightArrow', 300, 160, { unknown: 20 }), /调整参数/);
    assert.throws(() => geometry.shapeScene('rightArrow', 300, 160, { adj1: 'val 2' }), /调整参数/);
});

test('187类形状导出为真实原生对象，调整值保留，PDF保持矢量路径', async () => {
    const content = gallery();
    const arrow = content.slides.flatMap(slide => slide.elements).find(element => element.shapeType === 'rightArrow');
    arrow.adjustments = { adj1: 25000, adj2: 40000 };
    const [pptx, pdf] = await Promise.all([renderPresentation(content, 'pptx'), renderPresentation(content, 'pdf')]);
    const report = await verifyPptxExport(pptx.buffer, content);
    assert.equal(report.status, 'passed', JSON.stringify(report.issues)); assert.equal(report.shapes, 187);
    const zip = await Zip.loadAsync(pptx.buffer);
    const slides = await Promise.all(content.slides.map((_slide, index) => zip.file(`ppt/slides/slide${index + 1}.xml`).async('string')));
    assert.ok(slides.some(xml => /name="adj1" fmla="val 25000"/.test(xml)));
    assert.equal(slides.reduce((total, xml) => total + (xml.match(/<p:pic>/g) || []).length, 0), 0);
    const document = await PDFDocument.load(pdf.buffer);
    assert.equal(document.getPageCount(), content.slides.length);
    assert.equal(document.context.enumerateIndirectObjects().filter(([, value]) => value.dict?.get?.(PDFName.of('Subtype'))?.toString() === '/Image').length, 0);
});
