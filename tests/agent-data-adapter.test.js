const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createWorkspaceJail } = require('../server/services/agent-sandbox');
const { queryDataSource } = require('../server/services/agent-data-adapter');
const XLSX = require('@e965/xlsx');

test('DuckDB data adapter reads CSV through a workspace jail and bounded query', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pivot-agent-data-'));
    const jail = createWorkspaceJail(root, 'task-data');
    const csv = jail.resolve('input.csv');
    fs.writeFileSync(csv, 'name,amount\nAlice,1\nBob,2\n', 'utf8');
    try {
        const result = await queryDataSource(csv, { autonomous: true, jail, limit: 1, where: "c_2 = '2'" });
        assert.equal(result.source.kind, 'csv');
        assert.equal(result.rows.length, 1);
        assert.equal(String(result.rows[0].c_1), 'Bob');
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('autonomous data adapter refuses unjailed sources and unsafe filters', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pivot-agent-data-'));
    const csv = path.join(root, 'input.csv');
    fs.writeFileSync(csv, 'name,amount\nAlice,1\n', 'utf8');
    try {
        await assert.rejects(() => queryDataSource(csv, { autonomous: true }), /工作区沙箱/);
        await assert.rejects(() => queryDataSource(csv, { where: 'amount; DROP TABLE data' }), /不允许/);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('DuckDB data adapter materializes Excel through the spreadsheet path', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pivot-agent-xlsx-'));
    const jail = createWorkspaceJail(root, 'task-xlsx');
    const xlsxPath = jail.resolve('input.xlsx');
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([['name', 'amount'], ['Alice', 1], ['Bob', 2]]), 'Sheet1');
    XLSX.writeFile(workbook, xlsxPath);
    try {
        const result = await queryDataSource(xlsxPath, { autonomous: true, jail, limit: 2 });
        assert.equal(result.source.kind, 'xlsx');
        assert.equal(result.rows.length, 2);
        assert.equal(result.rows[0].c_1, 'Alice');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
