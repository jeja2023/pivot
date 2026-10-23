'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { compareDocuments, comparisonIr } = require('../server/services/document-comparison');
const { normalizeMindmap, mindmapSvg } = require('../server/services/mindmap');
const { renderDocumentIr } = require('../server/services/document-rendering');
const { normalizeCrawlConfig, crawlKnowledgePages } = require('../server/services/knowledge-web-crawler');

test('字符比较可以准确还原新旧文档，移动段落有定位，复杂输入受限', () => {
    for (const [before, after] of [['第一条：执行。', '第一条：暂缓执行！'], ['甲\n乙\n丙', '丙\n甲\n乙'], ['😀甲', '😀乙'], ['', '新增']]) {
        const result = compareDocuments(before, after);
        assert.equal(result.changes.filter(p => p.type !== 'add').map(p => p.text).join(''), before);
        assert.equal(result.changes.filter(p => p.type !== 'delete').map(p => p.text).join(''), after);
    }
    assert.equal(compareDocuments('甲\n乙\n丙', '丙\n甲\n乙').moves.length, 1);
    assert.throws(() => compareDocuments('x'.repeat(30001), 'b'), /30000/);
});

test('DOCX 包含真正插入删除修订，确定性导出保留文字与 HTML 标记', async () => {
    const ir = comparisonIr(compareDocuments('实施原条款。', '实施新条款。'));
    const first = await renderDocumentIr(ir, 'docx'), second = await renderDocumentIr(ir, 'docx');
    assert.deepEqual(first.buffer, second.buffer);
    const zip = await require('jszip').loadAsync(first.buffer);
    const xml = await zip.file('word/document.xml').async('string');
    assert.match(xml, /<w:ins /); assert.match(xml, /<w:del /); assert.match(xml, /w:delText/);
    assert.match(xml, /原/); assert.match(xml, /新/);
    const html = await renderDocumentIr(ir, 'html');
    assert.match(html.buffer.toString(), /<ins>/); assert.match(html.buffer.toString(), /<del>/);
    await assert.rejects(renderDocumentIr(ir, 'xlsx'), /修订语义/);
    const paragraphIr = comparisonIr(compareDocuments('甲\n乙', '甲乙'));
    const paragraphDocx = await renderDocumentIr(paragraphIr, 'docx');
    const paragraphZip = await require('jszip').loadAsync(paragraphDocx.buffer);
    const paragraphXml = await paragraphZip.file('word/document.xml').async('string');
    assert.match(paragraphXml, /<w:pPr>[\s\S]*?<w:rPr>[\s\S]*?<w:del /);
});

test('脑图验证树结构，导出不执行节点文字，拒绝循环和重复标识', () => {
    const tree = { id: 'root', text: '项目', children: [{ id: 'child', text: '<script>检查</script>', children: [] }] };
    assert.equal(normalizeMindmap(tree).children.length, 1);
    assert.match(mindmapSvg(tree), /&lt;script&gt;/); assert.doesNotMatch(mindmapSvg(tree), /<script>/);
    assert.throws(() => normalizeMindmap({ ...tree, children: [{ id: 'root', text: '重复' }] }), /无效/);
    const circular = { id: 'x', text: '循环' }; circular.children = [circular];
    assert.throws(() => normalizeMindmap(circular), /无效/);
});

test('真实浏览器渲染动态 OA 内容，拒绝跨域请求并去除导航噪音', { timeout: 30000 }, async () => {
    const requested = [];
    const result = await crawlKnowledgePages({ url: 'http://kb.internal/policies/', pathPrefix: '/policies/', selector: 'main', waitForSelector: '#ready', maxPages: 2 }, { id: 1, role: 'admin' }, {
        request: async config => {
            requested.push(config.url);
            return { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, data: Buffer.from('<meta charset="utf-8"><title>制度</title><nav>无关导航</nav><main></main><a href="https://external.invalid/leak">外站</a><script>document.querySelector("main").innerHTML="<article id=ready>动态政策正文</article>";fetch("https://external.invalid/secret")</script>') };
        }
    });
    assert.equal(result.items.length, 1); assert.match(result.items[0].content, /动态政策正文/);
    assert.doesNotMatch(result.items[0].content, /无关导航/);
    assert.ok(requested.every(url => new URL(url).origin === 'http://kb.internal'));
    await assert.rejects(crawlKnowledgePages({ url: 'http://kb.internal/' }, { id: 2, role: 'user' }), /管理员/);
    assert.throws(() => normalizeCrawlConfig({ url: 'file:///etc/passwd' }));
});
