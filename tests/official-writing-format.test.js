const test = require('node:test');
const assert = require('node:assert/strict');
const JSZip = require('jszip');
const { PDFDocument, PDFName } = require('pdf-lib');
const { PDFParse } = require('pdf-parse');
const { DOMParser } = require('@xmldom/xmldom');
const format = require('../client/common/official-writing-format');
const { validateDocumentIr } = require('../server/services/document-ir');
const { renderDocx } = require('../server/services/document-rendering/docx-renderer');
const { renderPdf } = require('../server/services/document-rendering/pdf-renderer');
const { readOfficialFonts } = require('../server/services/document-rendering/official-fonts');
const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const attr = (node, name) => node.getAttributeNS(W, name);
const elements = (node, name) => [...node.getElementsByTagNameNS(W, name)];
const text = paragraph => elements(paragraph, 't').map(node => node.textContent).join('');

function fixture() {
    const result = validateDocumentIr({ ir_version: '1', doc_type: 'official_document', meta: {
        title: '关于开展年度教育教学质量检查与专项督导工作的通知', recipient: '各县（市、区）教育行政部门、各直属学校：',
        signoff: '示例市教育局', issued_at: '2026-11-04', layout: 'plain', security_level: 'public'
    }, blocks: [
        { type: 'heading', level: 1, text: '一、总体安排' },
        { type: 'heading', level: 2, text: '（一）工作目标' },
        { type: 'heading', level: 3, text: '1. 主要任务' },
        { type: 'heading', level: 4, text: '（1）具体要求' },
        { type: 'paragraph', runs: [{ text: '本段核对阿拉伯数字20261104和28项任务。' }] },
        { type: 'paragraph', runs: [{ text: '附件：1. 年度检查工作安排和教育教学质量专项督导任务分解及责任落实情况汇总表' }], style: { official_role: 'attachment_note', attachment_prefix: '附件：1. ' } },
        { type: 'paragraph', runs: [{ text: '　　　2. 检查结果反馈说明' }], style: { official_role: 'attachment_note', attachment_prefix: '　　　2. ' } },
        { type: 'page_break' },
        { type: 'paragraph', runs: [{ text: '附件1' }], style: { official_role: 'attachment_label' } },
        { type: 'paragraph', runs: [{ text: '检查结果反馈说明' }], style: { official_role: 'attachment_title' } },
        { type: 'paragraph', runs: [{ text: '附件正文与主文连续编排页码。' }] }
    ] });
    assert.equal(result.valid, true, result.errors.join('；'));
    return result.ir;
}

test('截图标准 DOCX 精确页边距、22×28网格、28磅行距和两项网格开关', async () => {
    const zip = await JSZip.loadAsync(await renderDocx(fixture()));
    const doc = new DOMParser().parseFromString(await zip.file('word/document.xml').async('string'), 'text/xml');
    const margins = elements(doc, 'pgMar')[0];
    for (const [key, expected] of Object.entries({ top: 2097, bottom: 1984, left: 1530, right: 1530, header: 850, footer: 1700 })) assert.equal(Number(attr(margins, key)), expected, key);
    const grid = elements(doc, 'docGrid')[0];
    assert.equal(attr(grid, 'type'), 'linesAndChars'); assert.equal(attr(grid, 'linePitch'), '560');
    const charSpace = Number(attr(grid, 'charSpace'));
    const size = elements(doc, 'pgSz')[0];
    const available = Number(attr(size, 'w')) - 3060;
    assert.ok(Math.abs(available / 20 / (16 + charSpace / 4096) - 28) < 0.01);
    const paragraphs = elements(doc, 'p').filter(paragraph => text(paragraph));
    for (const paragraph of paragraphs) {
        const spacing = elements(paragraph, 'spacing')[0];
        assert.equal(attr(spacing, 'line'), '560', text(paragraph));
        assert.equal(attr(spacing, 'lineRule'), 'exact', text(paragraph));
        for (const name of ['adjustRightInd', 'snapToGrid']) {
            const option = elements(paragraph, name)[0];
            assert.ok(option, name); assert.notEqual(attr(option, 'val'), 'false');
        }
    }
});

test('截图标准 DOCX 标题/四层级/附件/落款/页码的字体字号与位置独立校验', async () => {
    const zip = await JSZip.loadAsync(await renderDocx(fixture()));
    const xml = await zip.file('word/document.xml').async('string');
    const doc = new DOMParser().parseFromString(xml, 'text/xml');
    const paragraphs = elements(doc, 'p');
    const find = value => paragraphs.find(paragraph => text(paragraph).includes(value));
    for (const [value, font, size] of [
        ['关于开展', '方正小标宋_GBK', '44'], ['一、总体', '方正黑体_GBK', '32'], ['（一）工作', '方正楷体_GBK', '32'],
        ['1. 主要', '方正仿宋_GBK', '32'], ['（1）具体', '方正仿宋_GBK', '32'], ['本段核对', '方正仿宋_GBK', '32'], ['附件1', '方正黑体_GBK', '32']
    ]) {
        const paragraph = find(value), fonts = elements(paragraph, 'rFonts')[0];
        assert.equal(attr(fonts, 'eastAsia'), font, value); assert.equal(attr(fonts, 'ascii'), 'Times New Roman', value);
        assert.equal(attr(elements(paragraph, 'sz')[0], 'val'), size, value);
        if (/^一|^（一）/.test(value)) assert.equal(elements(paragraph, 'b').length, 0, '字体原字重不额外伪加粗');
    }
    const recipient = find('各县');
    assert.equal(attr(elements(recipient, 'spacing')[0], 'before'), '0');
    assert.equal(attr(elements(recipient, 'jc')[0], 'val'), 'left');
    assert.equal(text(recipient).endsWith('：'), true);
    assert.equal(elements(recipient, 'ind').length, 0);
    const body = find('本段核对'); assert.equal(attr(elements(body, 'ind')[0], 'firstLineChars'), '200');
    const attachment = find('附件：1.');
    assert.ok(Number(attr(elements(attachment, 'ind')[0], 'hanging')) > 1000);
    assert.equal(attr(elements(attachment, 'spacing')[0], 'before'), '0');
    assert.equal(elements(attachment, 'keepLines').length, 1);
    assert.equal(text(attachment).endsWith('。'), false);
    const date = find('2026年11月4日'); assert.ok(Number(attr(elements(date, 'ind')[0], 'right')) > 1200);
    const signoff = find('示例市教育局'); assert.equal(attr(elements(signoff, 'jc')[0], 'val'), 'center');
    assert.ok(xml.indexOf('2026年11月4日') < xml.indexOf('附件1'));
    assert.ok(elements(doc, 'br').some(node => attr(node, 'type') === 'page'));
    const footer = new DOMParser().parseFromString(await zip.file('word/footer1.xml').async('string'), 'text/xml');
    assert.equal(attr(elements(footer, 'rFonts')[0], 'eastAsia'), '宋体'); assert.equal(attr(elements(footer, 'rFonts')[0], 'ascii'), '宋体');
    assert.equal(attr(elements(footer, 'sz')[0], 'val'), '28');
    assert.ok(elements(footer, 'instrText').some(node => /PAGE/.test(node.textContent)));
    assert.match(elements(footer, 't').map(node => node.textContent).join(''), /—\s*—/);
});

test('DOCX 两行标题后空一行、附件前空一行、署名日期整体前空三行', async () => {
    for (const recipient of ['', '各单位：']) {
        const checked = validateDocumentIr({ ir_version: '1', doc_type: 'official_document', meta: {
            title: '首行标题\n第二行标题', recipient, signoff: '署名单位', issued_at: '2026-11-04', layout: 'plain', security_level: 'public'
        }, blocks: [
            { type: 'paragraph', runs: [{ text: '正文结束标记' }] },
            { type: 'paragraph', runs: [{ text: '附件：附件说明标记' }], style: { official_role: 'attachment_note', attachment_prefix: '附件：' } }
        ] });
        assert.equal(checked.valid, true);
        const zip = await JSZip.loadAsync(await renderDocx(checked.ir));
        const doc = new DOMParser().parseFromString(await zip.file('word/document.xml').async('string'), 'text/xml');
        const paragraphs = elements(doc, 'p');
        const indexOf = value => paragraphs.findIndex(paragraph => text(paragraph).includes(value));
        const before = index => {
            let count = 0;
            while (index - count - 1 >= 0 && !text(paragraphs[index - count - 1])) {
                const spacing = elements(paragraphs[index - count - 1], 'spacing')[0];
                assert.equal(attr(spacing, 'line'), '560');
                assert.equal(attr(spacing, 'lineRule'), 'exact');
                assert.ok(elements(paragraphs[index - count - 1], 'keepNext').length);
                count++;
            }
            return count;
        };
        assert.equal(before(indexOf(recipient || '正文结束标记')), 1, '标题只在最后一行之后空一行');
        assert.equal(before(indexOf('附件：')), 1, '附件说明前空一行');
        assert.equal(before(indexOf('署名单位')), 3, '署名和日期作为整体，前空三行');
        assert.equal(before(indexOf('2026年11月4日')), 0, '署名与日期之间不增加空行');
        const title = paragraphs[indexOf('首行标题')];
        assert.equal(elements(title, 'br').length, 1, '两行标题共享同一段，不在标题内部插入空行');
    }
});

test('PDF 实际坐标验证标题末行后一行、附件前一行、署名日期前三行', async (t) => {
    const status = await require('../server/services/document-rendering/official-fonts').officialFontStatus();
    if (!status.available) { t.skip('缺少公文原字体，跳过 PDF 坐标验证'); return; }
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const sources = await require('../server/services/document-rendering/official-fonts').loadOfficialFonts();
    for (const recipient of ['', '各单位：']) {
        const checked = validateDocumentIr({ ir_version: '1', doc_type: 'official_document', meta: {
            title: '首行标题\n第二行标题', recipient, signoff: '署名单位', issued_at: '2026-11-04', layout: 'plain', security_level: 'public'
        }, blocks: [
            { type: 'paragraph', runs: [{ text: '正文结束标记' }] },
            { type: 'paragraph', runs: [{ text: '附件：附件说明标记' }], style: { official_role: 'attachment_note', attachment_prefix: '附件：' } }
        ] });
        const pdf = await pdfjs.getDocument({ data: new Uint8Array(await renderPdf(checked.ir)), isEvalSupported: false }).promise;
        try {
            assert.equal(pdf.numPages, 1);
            const content = await (await pdf.getPage(1)).getTextContent();
            const rows = new Map();
            for (const item of content.items) {
                if (!item.str.trim()) continue;
                const baseline = item.transform[5], key = baseline.toFixed(3);
                if (!rows.has(key)) rows.set(key, { baseline, items: [] });
                rows.get(key).items.push(item);
            }
            const values = [...rows.values()].map(row => ({ ...row, text: row.items.sort((a, b) => a.transform[4] - b.transform[4]).map(item => item.str).join('') }));
            const find = value => values.find(row => row.text.replace(/\s/g, '').includes(value));
            const lastTitle = find('第二行标题');
            const next = find(recipient ? '各单位：' : '正文结束标记');
            const top = (row, role, size) => row.baseline + (28 - size) / 2 + sources[role].face.ascent / sources[role].face.unitsPerEm * size;
            assert.ok(Math.abs(top(lastTitle, 'title', 22) - top(next, 'body', 16) - 56) < 0.01);
            assert.ok(Math.abs(find('正文结束标记').baseline - find('附件：').baseline - 56) < 0.01);
            assert.ok(Math.abs(find('附件：').baseline - find('署名单位').baseline - 112) < 0.01);
            assert.ok(Math.abs(find('署名单位').baseline - find('2026年11月4日').baseline - 28) < 0.01);
        } finally { await pdf.destroy(); }
    }
});

test('截图标准 PDF 嵌入全部原字体，纯正文22行28字与28磅基线，不带补零日期且附件续页码', async (t) => {
    const status = await require('../server/services/document-rendering/official-fonts').officialFontStatus();
    if (!status.available) { t.skip('缺少公文原字体，跳过 PDF 渲染验证'); return; }
    const ir = fixture();
    ir.blocks.splice(0, 0, { type: 'page_break' }, { type: 'paragraph', runs: [{ text: '甲'.repeat(28 * 23) }], style: { indent_chars: 0 } });
    const bytes = await renderPdf(ir);
    const parser = new PDFParse({ data: bytes });
    try {
        const extracted = await parser.getText();
        const fullPage = extracted.pages.find(page => page.text.includes('甲'.repeat(28)));
        const lines = fullPage.text.split('\n').filter(line => /^甲+$/.test(line));
        assert.equal(lines.length, 22); assert.equal(lines[0].length, 26); assert.ok(lines.slice(1).every(line => line.length === 28));
        const all = extracted.text.replace(/\s/g, '');
        assert.ok(all.includes('2026年11月4日')); assert.ok(!all.includes('2026年11月04日'));
        extracted.pages.forEach((page, index) => assert.ok(page.text.includes(`— ${index + 1} —`)));
    } finally { await parser.destroy(); }
    const doc = await PDFDocument.load(bytes);
    const names = new Set();
    for (const page of doc.getPages()) {
        const fonts = page.node.Resources().lookup(PDFName.of('Font'));
        if (fonts) for (const [, reference] of fonts.entries()) names.add(String(doc.context.lookup(reference).get(PDFName.of('BaseFont'))));
    }
    for (const font of ['FZXBSK--GBK1-0', 'FZFSK--GBK1-0', 'FZHTK--GBK1-0', 'FZKTK--GBK1-0', 'TimesNewRomanPSMT', 'SimSun']) assert.ok([...names].some(name => name.includes(font)), font);
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const pdf = await pdfjs.getDocument({ data: new Uint8Array(bytes), isEvalSupported: false }).promise;
    try {
        const page = await pdf.getPage(2), content = await page.getTextContent({ disableCombineTextItems: true });
        const baselines = [...new Set(content.items.filter(item => item.str.includes('甲')).map(item => item.transform[5]))].sort((a, b) => b - a);
        assert.equal(baselines.length, 22);
        for (let index = 1; index < baselines.length; index++) assert.ok(Math.abs(baselines[index - 1] - baselines[index] - 28) < 0.001);
    } finally { await pdf.destroy(); }
});

test('截图标题按语义边界分成梯形，多份附件自动编号，缺原字体拒绝替代', async () => {
    const title = '关于开展年度教育教学质量检查与专项督导工作的通知';
    const lines = format.arrangeTitle(title);
    assert.equal(lines.join(''), title); assert.ok(lines.length > 1); assert.notEqual(lines[0].length, lines[1].length);
    assert.ok(lines[1].startsWith('与'));
    assert.deepEqual([1, 2, 3, 4].map(index => format.headingLevel(['一、任务', '（一）目标', '1. 内容', '（1）要求'][index - 1])), [1, 2, 3, 4]);
    const notes = format.attachmentNotes([{ name: '第一份。' }, { name: '第二份；' }]);
    assert.equal(notes[0].text, '附件：1. 第一份'); assert.equal(notes[1].text, '　　　2. 第二份');
    await assert.rejects(() => readOfficialFonts([]), error => error.code === 'OFFICIAL_FONTS_UNAVAILABLE');
});
