'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { Document, Packer, Paragraph, TextRun } = require('docx');
const XLSX = require('@e965/xlsx');
const { PDFDocument } = require('pdf-lib');
const JSZip = require('jszip');
const { extractDocumentText } = require('../server/document-text');
const { extractPdfTextWithPageFallback } = require('../server/services/document-processing/text-extraction');

test('基础文档格式使用真实文件解析并保留内容', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pivot-basic-formats-'));
    try {
        const textPath = path.join(directory, 'sample.txt');
        await fs.writeFile(textPath, '中文材料\n第二行', 'utf8');
        assert.match(await extractDocumentText(textPath, 'text/plain', 'sample.txt'), /中文材料\n第二行/);

        const wordPath = path.join(directory, 'sample.docx');
        const word = new Document({ sections: [{ children: [new Paragraph({ children: [new TextRun('中文文档测试')] })] }] });
        await fs.writeFile(wordPath, await Packer.toBuffer(word));
        assert.match(await extractDocumentText(wordPath, '', 'sample.docx'), /中文文档测试/);

        const sheetPath = path.join(directory, 'sample.xlsx');
        const workbook = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([['姓名', '金额'], ['测试', 123]]), '数据');
        XLSX.writeFile(workbook, sheetPath);
        const spreadsheet = await extractDocumentText(sheetPath, '', 'sample.xlsx');
        assert.match(spreadsheet, /姓名/);
        assert.match(spreadsheet, /123/);

        const pdfPath = path.join(directory, 'sample.pdf');
        const pdf = await PDFDocument.create();
        pdf.addPage([300, 200]).drawText('Native text sample', { x: 30, y: 120 });
        await fs.writeFile(pdfPath, await pdf.save());
        const result = await extractPdfTextWithPageFallback(pdfPath, { ocrImageFile: () => { throw new Error('已有文字不应调用 OCR'); } });
        assert.equal(result.pages[0].source, 'native');
        assert.match(result.pages[0].text, /Native text sample/);
        assert.equal(result.coverageComplete, true);
    } finally {
        await fs.rm(directory, { recursive: true, force: true });
    }
});

test('有效空白文档可解析，伪装成 Office 文档的 ZIP 不会被当作空白文档', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pivot-office-structure-'));
    try {
        const emptyWord = path.join(directory, 'empty.docx');
        await fs.writeFile(emptyWord, await Packer.toBuffer(new Document({ sections: [{ children: [new Paragraph('')] }] })));
        assert.equal(await extractDocumentText(emptyWord, '', 'empty.docx'), '');
        const emptySheet = path.join(directory, 'empty.xlsx');
        const workbook = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([]), '空白');
        XLSX.writeFile(workbook, emptySheet);
        assert.equal(await extractDocumentText(emptySheet, '', 'empty.xlsx'), '');
        const archive = new JSZip();
        archive.file('unrelated.txt', 'not an Office document');
        const fake = await archive.generateAsync({ type: 'nodebuffer' });
        for (const extension of ['docx', 'xlsx']) {
            const file = path.join(directory, `fake.${extension}`);
            await fs.writeFile(file, fake);
            await assert.rejects(() => extractDocumentText(file, '', `fake.${extension}`), /缺少/);
        }
    } finally {
        await fs.rm(directory, { recursive: true, force: true });
    }
});
