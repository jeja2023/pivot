const test = require('node:test');
const assert = require('node:assert/strict');
const JSZip = require('jszip');
const { PDFParse } = require('pdf-parse');
const { validateDocumentIr } = require('../server/services/document-ir');
const { renderDocx } = require('../server/services/document-rendering/docx-renderer');
const { renderPdf } = require('../server/services/document-rendering/pdf-renderer');
const { fixture } = require('./helpers/official-writing-rendering');



test('真实 DOCX 保留全部发文要素，普通版式无红头，重复渲染字节一致', async () => {
    const ir = fixture();
    const first = await renderDocx(ir);
    assert.deepEqual(await renderDocx(ir), first);
    const zip = await JSZip.loadAsync(first);
    const xml = await zip.file('word/document.xml').async('string');
    for (const text of ['示例市教育局', '张某', '加急', '抄送：示例市政府办公室', '印发机关：示例市教育局办公室', '印发日期：2026年11月5日', '2026年11月4日']) assert.ok(xml.includes(text), text);
    const header = await zip.file('word/header1.xml').async('string');
    assert.ok(header.includes('秘密★1年'));
    const plainZip = await JSZip.loadAsync(await renderDocx(fixture('plain')));
    const plain = await plainZip.file('word/document.xml').async('string');
    assert.ok(!plain.includes('w:color="FF0000"'));
    assert.ok(plain.includes('抄送：示例市政府办公室'));
});

test('真实 PDF 可提取中文，成文日期与印发日期独立，完整保留抄送与密级期限', async () => {
    const pdf = await renderPdf(fixture());
    assert.deepEqual(await renderPdf(fixture()), pdf);
    const parser = new PDFParse({ data: pdf });
    try {
        const result = await parser.getText();
        const text = result.text.replace(/\s/g, '');
        for (const value of ['秘密★1年', '示例市教育局', '张某', '加急', '抄送：示例市政府办公室', '印发机关：示例市教育局办公室', '印发日期：2026年11月5日', '2026年11月4日']) assert.ok(text.includes(value), value);
    } finally { await parser.destroy(); }
});

test('普通公文可以没有红头机关，红头版式仍校验发文机关，印发日期拒绝无效日期', () => {
    const input = fixture('plain'); delete input.meta.issuer;
    assert.equal(validateDocumentIr(input).valid, true);
    input.meta.layout = 'red_header';
    assert.equal(validateDocumentIr(input).valid, false);
    input.meta.issuer = '发文机关'; input.meta.printed_at = '2026-02-30';
    assert.equal(validateDocumentIr(input).valid, false);
});

