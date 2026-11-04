'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const JSZip = require('jszip');
const { extractDocPreview, parseDocxXml, parseTextToDocHtml, wrapDocumentPage } = require('../server/services/doc-preview');

test('DOCX XML 解析可保留原文件标题居中、段落缩进、落款居右及表格结构', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
    <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
        <w:body>
            <w:p>
                <w:pPr><w:jc w:val="center"/></w:pPr>
                <w:r><w:rPr><w:b/><w:sz w:val="44"/><w:rFonts w:eastAsia="方正小标宋简体"/></w:rPr><w:t>关于2026年度业务总结的报告</w:t></w:r>
            </w:p>
            <w:p>
                <w:pPr><w:pStyle w:val="Heading1"/></w:pPr>
                <w:r><w:t>一、总体进展情况</w:t></w:r>
            </w:p>
            <w:p>
                <w:r><w:rPr><w:sz w:val="32"/><w:rFonts w:eastAsia="仿宋_GB2312"/></w:rPr><w:t>今年各项业务运行良好，完成了预定发展目标。</w:t></w:r>
            </w:p>
            <w:tbl>
                <w:tr>
                    <w:tc><w:p><w:r><w:t>指标</w:t></w:r></w:p></w:tc>
                    <w:tc><w:p><w:r><w:t>完成率</w:t></w:r></w:p></w:tc>
                </w:tr>
                <w:tr>
                    <w:tc><w:p><w:r><w:t>核心系统迁移</w:t></w:r></w:p></w:tc>
                    <w:tc><w:p><w:r><w:t>100%</w:t></w:r></w:p></w:tc>
                </w:tr>
            </w:tbl>
            <w:p>
                <w:pPr><w:jc w:val="right"/></w:pPr>
                <w:r><w:rPr><w:sz w:val="32"/><w:rFonts w:eastAsia="仿宋_GB2312"/></w:rPr><w:t>综合办公室</w:t></w:r>
            </w:p>
            <w:p>
                <w:pPr><w:jc w:val="right"/></w:pPr>
                <w:r><w:rPr><w:sz w:val="32"/><w:rFonts w:eastAsia="仿宋_GB2312"/></w:rPr><w:t>2026年11月4日</w:t></w:r>
            </w:p>
        </w:body>
    </w:document>`;

    const html = parseDocxXml(xml);
    assert.match(html, /<h1 class="doc-title">[\s\S]*?关于2026年度业务总结的报告[\s\S]*?<\/h1>/);
    assert.match(html, /font-size:22pt/);
    assert.match(html, /方正小标宋简体/);
    assert.match(html, /<h2 class="doc-heading doc-heading-1">一、总体进展情况<\/h2>/);
    assert.match(html, /<p class="doc-p doc-paragraph">[\s\S]*?今年各项业务运行良好/);
    assert.match(html, /<table class="doc-tbl">/);
    assert.match(html, /<td>[\s\S]*?核心系统迁移[\s\S]*?<\/td>/);
    assert.match(html, /<p class="doc-p doc-align-right doc-signoff">[\s\S]*?综合办公室[\s\S]*?<\/p>/);
    assert.match(html, /<p class="doc-p doc-align-right doc-signoff">[\s\S]*?2026年11月4日[\s\S]*?<\/p>/);
});

test('纯文本或 .doc 文本转换能自动还原标题、段落缩进与末尾落款，并对 XSS 进行转义', () => {
    const rawText = `
    关于开展2026年检查的通知 <script>alert("xss")</script>

    各部门：
    现开展全面安全检查。

    一、自查阶段
    按要求认真自查。

    办公室
    2026年11月4日
    `;

    const html = parseTextToDocHtml(rawText);
    assert.match(html, /<h1 class="doc-title">关于开展2026年检查的通知 &lt;script&gt;alert\(&quot;xss&quot;\)&lt;\/script&gt;<\/h1>/);
    assert.doesNotMatch(html, /<script>/);
    assert.match(html, /<h2 class="doc-heading doc-heading-1">一、自查阶段<\/h2>/);
    assert.match(html, /<p class="doc-p doc-paragraph">各部门：<\/p>/);
    assert.match(html, /<p class="doc-p doc-align-right doc-signoff">办公室<\/p>/);
    assert.match(html, /<p class="doc-p doc-align-right doc-signoff">2026年11月4日<\/p>/);
});

test('包装后的文档页面采用白底纸张样式并具备仿宋正文与小标宋标题，且无深色黑底', () => {
    const pageHtml = wrapDocumentPage('<p>测试正文</p>', '测试文档');
    assert.match(pageHtml, /background:\s*#ffffff/);
    assert.match(pageHtml, /box-shadow:/);
    assert.match(pageHtml, /--doc-font-fangsong/);
    assert.match(pageHtml, /--doc-font-title/);
    assert.doesNotMatch(pageHtml, /background:\s*#(?:0f172a|000000|1e293b|000)/); // 无终端黑底背景
});

test('真实 DOCX 文件读取能成功生成带样式的完整 HTML 页面', async () => {
    const tmpDir = path.resolve(__dirname, '..', 'tmp');
    fs.mkdirSync(tmpDir, { recursive: true });
    const tmpDocx = path.join(tmpDir, `test_preview_${Date.now()}.docx`);

    try {
        const zip = new JSZip();
        zip.file('word/document.xml', `<?xml version="1.0" encoding="UTF-8"?>
        <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
            <w:body>
                <w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:t>立项申请报告</w:t></w:r></w:p>
                <w:p><w:r><w:t>本项目旨在优化系统架构。</w:t></w:r></w:p>
                <w:p><w:pPr><w:jc w:val="right"/></w:pPr><w:r><w:t>研发部</w:t></w:r></w:p>
                <w:p><w:pPr><w:jc w:val="right"/></w:pPr><w:r><w:t>2026年11月4日</w:t></w:r></w:p>
            </w:body>
        </w:document>`);
        const buffer = await zip.generateAsync({ type: 'nodebuffer' });
        fs.writeFileSync(tmpDocx, buffer);

        const result = await extractDocPreview(tmpDocx, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', '立项申请.docx');
        assert.ok(result.html.includes('立项申请报告'));
        assert.ok(result.html.includes('doc-align-right doc-signoff'));
        assert.ok(result.html.includes('doc-page'));
    } finally {
        if (fs.existsSync(tmpDocx)) fs.unlinkSync(tmpDocx);
    }
});
