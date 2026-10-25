'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const schema = require('../client/common/mindmap-document');
const formats = require('../server/services/mindmaps/formats');
function sample() {
    const document = schema.normalize({ id: 'root', text: '中心<&"主题', children: [{ id: 'a', text: '分支甲', children: [] }, { id: 'b', text: '分支乙', children: [] }] });
    document.presentation.nodes.a = { note: '第一行\n第二行', color: '#123456', expanded: false, hyperlink: 'https://example.invalid/reference' };
    document.relations = [{ from: 'a', to: 'b', text: '联系' }]; return document;
}
test('OPML 和 FreeMind 受限交换可往返，XML 外部实体与非法树明确拒绝', async () => {
    for (const format of ['opml', 'mm']) {
        const source = formats.exportXml(sample(), format);
        const restored = await formats.importDocument({ format, content: source });
        assert.deepEqual(restored.tree, sample().tree); assert.equal(restored.presentation.nodes.a.note, '第一行\n第二行');
        if (format === 'mm') { assert.deepEqual(restored.relations, sample().relations); assert.equal(restored.presentation.nodes.a.color, '#123456'); }
        await assert.rejects(formats.importDocument({ format, content: '<!DOCTYPE map [<!ENTITY x SYSTEM "file:///etc/passwd">]><map><node TEXT="&x;"/></map>' }), /声明/);
    }
    await assert.rejects(formats.importDocument({ format: 'mm', content: '<map><node ID="x" TEXT="x"><node ID="x" TEXT="重复"/></node></map>' }), /重复/);
    await assert.rejects(formats.importDocument({ format: 'opml', content: '<opml><body><outline text="a"/><outline text="b"/></body></opml>' }), /一个中心/);
    await assert.rejects(formats.importDocument({ format: 'mm', content: '<map><node TEXT="x"><richcontent TYPE="NODE"><html><body><img src="x"/></body></html></richcontent></node></map>' }), /富文本/);
});
test('XMind 包稳定生成，层级、关系、概要和备注经现代格式往返', async () => {
    const document = sample(); document.summaries = [{ id: 'summary-1', parentId: 'root', start: 0, end: 1, text: '概要' }];
    const buffer = await formats.exportXmind(document); const other = await formats.exportXmind(document); assert.deepEqual(buffer, other);
    const restored = await formats.importDocument({ format: 'xmind', contentBase64: buffer.toString('base64') });
    assert.deepEqual(restored.tree, document.tree); assert.deepEqual(restored.relations, document.relations); assert.deepEqual(restored.summaries, document.summaries);
    assert.equal(restored.presentation.nodes.a.note, document.presentation.nodes.a.note);
    assert.deepEqual(schema.fromEngine(schema.toEngine(document)), schema.normalize(document));
    const JSZip = require('jszip'); const zip = new JSZip(); zip.file('content.json', JSON.stringify([{ rootTopic: { id: 'root', title: 'x', image: { src: 'http://external.invalid' } } }]));
    await assert.rejects(formats.importDocument({ format: 'xmind', contentBase64: (await zip.generateAsync({ type: 'nodebuffer' })).toString('base64') }), /图片/);
    const bomb = new JSZip(); bomb.file('content.json', ' '.repeat(9 * 1024 * 1024));
    await assert.rejects(formats.importDocument({ format: 'xmind', contentBase64: (await bomb.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })).toString('base64') }), /大小/);
});
test('概要边界、悬空引用和未知格式拒绝，旧树结构编辑保留有效扩展', () => {
    const document = sample(); document.summaries = [{ id: 's', parentId: 'root', start: 0, end: 1, text: '概要' }];
    assert.throws(() => schema.normalize({ ...document, summaries: [{ ...document.summaries[0], end: 2 }] }), /范围/);
    assert.throws(() => schema.normalize({ ...document, summaries: [null] }), /概要/);
    assert.equal(schema.mergeLegacy(document.tree, document).summaries.length, 1);
    const native = schema.toEngine(document); native.root.children.pop(); native.root.data.generalization = [];
    const normalized = schema.fromEngine(native); assert.equal(normalized.relations.length, 0);
    const theme = { version: 1, label: '自定义验收', root: '#123456', line: '#234567', background: '#ffffff' };
    document.presentation.themeId = 'custom'; document.presentation.customTheme = theme;
    assert.deepEqual(schema.palette(schema.fromEngine(schema.toEngine(document), document)), theme);
    assert.throws(() => schema.themePack({ ...theme, line: 'url(http://external.invalid)' }), /颜色/);
    assert.throws(() => schema.themePack({ ...theme, css: 'body{}' }), /格式/);
    assert.notEqual(schema.foreground('#ffffff'), '#ffffff'); assert.equal(schema.foreground('#000000'), '#ffffff');
    assert.throws(() => schema.normalize({ id: '__proto__', text: '危险标识' }), /标识/);
    assert.throws(() => schema.fromEngine({ root: { data: { uid: '__proto__', text: '危险标识' } } }), /标识/);
    const reordered = JSON.parse(JSON.stringify(document)); reordered.presentation.nodes.a = { expanded: false, color: '#123456', note: '第一行\n第二行', hyperlink: 'https://example.invalid/reference' };
    assert.equal(JSON.stringify(schema.normalize(document)), JSON.stringify(schema.normalize(reordered)));
});
test('高级导出经既有渲染底座生成真实 PDF，所有布局含概要均通过 SVG 清洗', { timeout: 120000 }, async () => {
    const renderer = require('../server/services/mindmaps/renderer');
    const document = sample(); document.summaries = [{ id: 'summary-1', parentId: 'root', start: 0, end: 1, text: '概要' }];
    const pdf = await renderer.render(document, 'pdf'); assert.equal(pdf.buffer.subarray(0, 4).toString(), '%PDF');
    const parsed = await require('pdf-lib').PDFDocument.load(pdf.buffer); assert.ok(parsed.getPageCount() > 0);
    for (const layout of Object.keys(schema.LAYOUTS)) {
        const svg = await renderer.render({ ...document, presentation: { ...document.presentation, layout } }, 'svg');
        assert.match(svg.buffer.toString(), /分支甲/); assert.doesNotMatch(svg.buffer.toString(), /foreignObject|svgjs:data/);
    }
    for (const format of ['svg', 'xmind', 'opml', 'mm', 'pdf']) assert.ok(require('../server/services/agent-path-safety').buildDeliveryFilename('测试', format).endsWith('.' + format));
});
