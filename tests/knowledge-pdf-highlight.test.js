'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { PDFDocument } = require('pdf-lib');
const sharp = require('sharp');
const { renderCitationHighlight, findUniqueTextBoxes, findOcrTextBoxes } = require('../server/services/knowledge-pdf-highlight');

test('原文精确匹配才返回对应文字框，重复和无匹配不会猜测', () => {
    const items = [{ str: 'The policy applies', transform: [10, 0, 0, 10, 10, 30], width: 70 }];
    const viewport = { transform: [1, 0, 0, 1, 0, 0], scale: 1, width: 200, height: 100 };
    const transform = (_viewport, matrix) => matrix;
    assert.equal(findUniqueTextBoxes(items, 'policy applies', viewport, transform).length, 1);
    assert.equal(findUniqueTextBoxes([...items, items[0]], 'policy applies', viewport, transform).length, 0);
    assert.equal(findUniqueTextBoxes(items, 'missing text', viewport, transform).length, 0);
});

test('扫描页仅使用可信边界框及唯一匹配生成高亮', () => {
    const location = { width: 320, height: 240, blocks: [{ text: '扫描文件第一条规定', bbox: [[30, 40], [200, 40], [200, 60], [30, 60]] }] };
    assert.deepEqual(findOcrTextBoxes(location, '扫描文件第一条规定', 1600, 1200), [{ x: 150, y: 200, width: 850, height: 100 }]);
    assert.deepEqual(findOcrTextBoxes({ ...location, blocks: [...location.blocks, ...location.blocks] }, '扫描文件第一条规定', 1600, 1200), []);
    assert.deepEqual(findOcrTextBoxes({ ...location, blocks: [{ ...location.blocks[0], bbox: [[-1, 0], [5, 0], [5, 5], [0, 5]] }] }, '扫描文件第一条规定', 1600, 1200), []);
});

test('真实扫描 PDF 在有 OCR 坐标时生成高亮', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pivot-ocr-highlight-'));
    const file = path.join(root, 'scan.pdf');
    try {
        const pdf = await PDFDocument.create();
        pdf.addPage([320, 240]);
        const bytes = Buffer.from(await pdf.save());
        await fs.writeFile(file, bytes);
        const image = await renderCitationHighlight({ filePath: file, page: 1, quote: '扫描文件第一条规定', expectedHash: crypto.createHash('sha256').update(bytes).digest('hex'),
            ocrLocation: { width: 1600, height: 1200, blocks: [{ text: '扫描文件第一条规定', bbox: [[150, 200], [1000, 200], [1000, 300], [150, 300]] }] } });
        assert.equal((await sharp(image).metadata()).format, 'png');
    } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('真实 PDF 可渲染有高亮的页图，来源哈希变化时拒绝', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pivot-pdf-highlight-'));
    const file = path.join(root, 'sample.pdf');
    try {
        const pdf = await PDFDocument.create();
        pdf.addPage([320, 240]).drawText('The policy applies to all staff.', { x: 30, y: 180, size: 16 });
        const bytes = Buffer.from(await pdf.save());
        await fs.writeFile(file, bytes);
        const hash = crypto.createHash('sha256').update(bytes).digest('hex');
        const image = await renderCitationHighlight({ filePath: file, page: 1, quote: 'The policy applies to all staff.', expectedHash: hash });
        assert.equal((await sharp(image).metadata()).format, 'png');
        await assert.rejects(() => renderCitationHighlight({ filePath: file, page: 1, quote: 'The policy applies to all staff.', expectedHash: 'a'.repeat(64) }), /已变化/);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
});
