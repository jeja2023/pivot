'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Zip = require('jszip');
const { DOMParser } = require('@xmldom/xmldom');
const graphics = require('../client/chat/presentation-graphics');
const { normalizePresentation } = require('../server/services/presentations/presentation-schema');
const { renderPresentation } = require('../server/services/presentations/presentation-renderer');
const { verifyPptxExport } = require('../server/services/presentations/presentation-export-verification');

const chart = { id: 'operating', type: 'chart', x: 80, y: 160, width: 1100, height: 440, visible: true, chartType: 'bar',
    title: '两条序列及负数', data: { columns: ['季度', '收入', '净变化'], rows: [['Q1', 120, -35], ['Q2', -20, 80], ['Q3', 200, 0]] },
    options: { showLegend: true, showLabels: true, colors: ['#1769AA', '#C84A4A'] } };
function documentWith(element) { return normalizePresentation({ title: '跨格式验收', slides: [{ id: 'slide_1', elements: [element] }] }); }
function parse(xml) { return new DOMParser({ onError: message => { throw new Error(message); } }).parseFromString(xml, 'application/xml'); }

test('多序列及负数在共享图表场景中保留分类和方向，所有标记位于绘图区', () => {
    const scene = graphics.chartScene(chart);
    assert.equal(scene.series.length, 2); assert.equal(scene.marks.length, 6);
    assert.deepEqual(scene.marks.map(mark => mark.value), [120, -20, 200, -35, 80, 0]);
    for (const mark of scene.marks) {
        assert.ok(mark.y >= scene.plot.y - 1e-9 && mark.y <= scene.plot.y + scene.plot.height + 1e-9);
        assert.ok(mark.height >= 0);
        if (mark.value < 0) assert.ok(mark.y > scene.zero);
    }
    const svg = parse(graphics.chartSvg(chart));
    assert.equal(Array.from(svg.getElementsByTagName('rect')).filter(node => node.hasAttribute('data-series')).length, 6);
    assert.match(svg.documentElement.textContent, /收入/); assert.match(svg.documentElement.textContent, /净变化/);
    assert.match(svg.documentElement.textContent, /-35/);
    const pie = graphics.chartSvg({ ...chart, chartType: 'pie', data: { columns: ['分类', '数量'], rows: [['唯一项', 100]] } });
    assert.equal(parse(pie).getElementsByTagName('circle').length, 1, '单个非零扇区不能退化成不可见路径');
    assert.throws(() => documentWith({ ...chart, chartType: 'pie' }), /单个非负/);
    assert.throws(() => documentWith({ ...chart, data: { columns: ['季度', '收入'], rows: [['Q1', '']] } }), /不能为空/);
    assert.throws(() => documentWith({ ...chart, data: { columns: ['季度', '收入'], rows: [['Q1', 1e308]] } }), /有限数字/);
});

test('循环具有闭合边，层级按显式父子关系布局，无效端点和层级循环被拒绝', () => {
    const cycle = { id: 'cycle', type: 'diagram', diagramType: 'cycle', x: 40, y: 160, width: 1100, height: 450, items: ['规划', '执行', '复盘'] };
    const scene = graphics.diagramScene(documentWith(cycle).slides[0].elements[0]);
    assert.equal(scene.edges.length, 3); assert.equal(scene.edges[2].to, scene.nodes[0].id);
    assert.ok(new Set(scene.nodes.map(node => Math.round(node.y))).size > 1);
    const hierarchy = { ...cycle, diagramType: 'hierarchy', items: undefined, graph: {
        nodes: [{ id: 'board', label: '决策层' }, { id: 'delivery', label: '交付组' }, { id: 'finance', label: '财务组' }, { id: 'ops', label: '执行组' }],
        edges: [{ from: 'board', to: 'delivery' }, { from: 'board', to: 'finance' }, { from: 'delivery', to: 'ops' }]
    } };
    const tree = graphics.diagramScene(documentWith(hierarchy).slides[0].elements[0]);
    const byId = new Map(tree.nodes.map(node => [node.id, node]));
    assert.equal(byId.get('delivery').y, byId.get('finance').y);
    assert.ok(byId.get('board').y < byId.get('delivery').y && byId.get('delivery').y < byId.get('ops').y);
    assert.throws(() => documentWith({ ...hierarchy, graph: { ...hierarchy.graph, edges: [{ from: 'missing', to: 'ops' }] } }), /端点/);
    assert.throws(() => documentWith({ ...hierarchy, graph: { ...hierarchy.graph, edges: [{ from: 'board', to: 'delivery' }, { from: 'delivery', to: 'board' }] } }), /循环/);
});

test('真实PPTX保留全部多序列数值、图示原生节点与闭合边和表头样式', async () => {
    const content = documentWith(chart);
    content.slides.push({ id: 'graph', elements: [{ id: 'cycle', type: 'diagram', diagramType: 'cycle', x: 80, y: 100, width: 1100, height: 500, items: ['规划', '执行', '复盘'] }] });
    content.slides.push({ id: 'table', elements: [{ id: 'data', type: 'table', x: 80, y: 100, width: 1000, height: 400, columns: ['责任人', '进度'], rows: [['交付组', '进行中']], style: { headerFill: '#123456', headerColor: '#ABCDEF' } }] });
    const normalized = normalizePresentation(content), rendered = await renderPresentation(normalized, 'pptx');
    const report = await verifyPptxExport(rendered.buffer, normalized);
    assert.equal(report.status, 'passed', JSON.stringify(report.issues));
    const zip = await Zip.loadAsync(rendered.buffer);
    const graphXml = await zip.file('ppt/slides/slide2.xml').async('string');
    assert.equal((graphXml.match(/name="pivotAnim_cycle__edge_edge_\d+"/g) || []).length, 3);
    assert.equal((graphXml.match(/name="pivotAnim_cycle__node_node_\d+"/g) || []).length, 3);
    for (const label of ['规划', '执行', '复盘']) assert.ok(graphXml.includes(label));
    assert.equal(parse(graphXml).getElementsByTagName('p:pic').length, 0, '图示不应被展平成图片');
    const tableXml = await zip.file('ppt/slides/slide3.xml').async('string');
    assert.match(tableXml, /val="123456"/); assert.match(tableXml, /val="ABCDEF"/);
});

test('共享SVG渲染不会将图示标签或分类文字解析成可执行节点', () => {
    const label = '<script>alert(1)</script><image href="https://example.invalid"/>';
    const svg = parse(graphics.diagramSvg({ diagramType: 'process', width: 1000, height: 300, items: [label, '完成'], style: {} }));
    assert.equal(svg.getElementsByTagName('script').length, 0); assert.equal(svg.getElementsByTagName('image').length, 0);
    assert.ok(svg.documentElement.textContent.replace(/\s/g, '').includes(label.replace(/\s/g, '')));
});
