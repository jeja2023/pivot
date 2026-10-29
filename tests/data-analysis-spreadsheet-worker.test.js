'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const XLSX = require('@e965/xlsx');
const { importSpreadsheetInWorker } = require('../server/services/data-analysis/spreadsheet-import');
const { readSpreadsheet } = require('../server/services/data-analysis/datasets');
const { parquetToRows } = require('../server/services/data-analysis/shared');

test('Excel 导入工作线程保留旧解析结果并生成可读取的 Parquet', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pivot-spreadsheet-worker-'));
    try {
        const input = path.join(root, 'source.xlsx');
        const output = path.join(root, 'output.parquet');
        const book = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([['部门', '金额'], ['华东', 123], ['华南', 456]]), '数据');
        XLSX.writeFile(book, input);
        const expected = await readSpreadsheet(input, 'source.xlsx');
        const actual = await importSpreadsheetInWorker(input, 'source.xlsx', output);
        assert.deepEqual(actual.columns, expected.columns);
        assert.equal(actual.rowCount, expected.rows.length);
        assert.equal(actual.sourceRowCount, expected.sourceRowCount);
        assert.equal(actual.truncated, expected.truncated);
        assert.equal(actual.sheetName, '数据');
        assert.deepEqual(await parquetToRows(output, { limit: 10 }), expected.rows);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('Excel 导入工作线程向调用方传递无有效数据的错误', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pivot-spreadsheet-empty-'));
    try {
        const input = path.join(root, 'empty.xlsx');
        const book = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([]), '空');
        XLSX.writeFile(book, input);
        await assert.rejects(importSpreadsheetInWorker(input, 'empty.xlsx', path.join(root, 'out.parquet')), /未识别到有效表头/);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
});
