'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const XLSX = require('@e965/xlsx');
const { buildExport, exportResult } = require('../server/services/workflow-result-export');

test('用户按需导出完整数据，CSV 防止公式注入且 Excel 保持文本和数字类型', () => {
    const output = { name: 'result', format: 'json', presentation: 'table', table: { columns: ['名称', '数量', '可用'], truncated: true },
        value: Array.from({ length: 501 }, (_, index) => ({ 名称: index ? '普通' : '=1+1', 数量: index, 可用: false })) };
    const csv = buildExport(output, 'csv');
    assert.equal(csv.rowCount, 501);
    assert.match(csv.buffer.toString('utf8'), /^\ufeff"名称","数量","可用"\r\n"'=1\+1","0","false"/);
    assert.match(buildExport([{ 金额: -12, 编号: '-12' }], 'csv').buffer.toString('utf8'), /"-12","'-12"/);
    const excel = buildExport(output, 'xlsx');
    const sheet = XLSX.read(excel.buffer, { type: 'buffer' }).Sheets['工作流结果'];
    assert.equal(sheet.A2.v, '=1+1'); assert.equal(sheet.A2.t, 's'); assert.equal(sheet.A2.f, undefined);
    assert.equal(sheet.B2.v, 0); assert.equal(sheet.C2.v, false);
    assert.equal(XLSX.utils.sheet_to_json(sheet, { header: 1 }).length, 502);
});

test('上游截断、无表格、行数和格式越界时拒绝导出', () => {
    for (const output of [{ rows: [{ a: 1 }], truncated: true }, { structuredContent: { rows: [{ a: 1 }], __partial: true } }, { text: '报告' }, { rows: [] }, { rows: Array(10001).fill({ a: 1 }) }])
        assert.throws(() => buildExport(output, 'csv'));
    assert.throws(() => buildExport([{ a: 1 }], 'pdf'), /CSV/);
    assert.throws(() => buildExport([{ a: '长'.repeat(32768) }], 'xlsx'), /Excel/);
    assert.equal(buildExport([{ a: '长'.repeat(32768) }], 'csv').rowCount, 1);
});

test('下载只读取用户已完成的工作流输出并在生成后复核权限', async () => {
    let access = true;
    const runs = { getRunForUser: async () => ({ id: 'run', status: 'completed', run_mode: 'dag' }),
        listDagNodes: async () => [{ node_key: 'output', tool_name: 'workflow.output', status: 'completed' }],
        getDagNodeCompleteOutputForUser: async () => ({ complete: true, status: 'completed', output: { name: 'result', format: 'json', value: [{ a: 1 }] } }) };
    const deps = { runs, assertAccess: async () => { if (!access) throw new Error('权限已撤销'); } };
    assert.equal((await exportResult({ id: 1 }, 'run', 'output', 'csv', deps)).rowCount, 1);
    access = false;
    await assert.rejects(() => exportResult({ id: 1 }, 'run', 'output', 'csv', deps), /权限/);
    await assert.rejects(() => exportResult({ id: 1 }, 'run', 'output', 'csv', { ...deps, runs: { ...runs, getRunForUser: async () => null } }), /无权/);
    await assert.rejects(() => exportResult({ id: 1 }, 'run', 'output', 'csv', { ...deps, runs: { ...runs, getDagNodeCompleteOutputForUser: async () => ({ complete: false }) } }), /不可用/);
    await assert.rejects(() => exportResult({ id: 1 }, 'run', 'output', 'csv', { ...deps, runs: { ...runs, getRunForUser: async () => ({ id: 'run', status: 'running', run_mode: 'dag' }) } }), /完成/);
});
