'use strict';

const { escapeCsvCell } = require('../csv');

function invalid(message, status = 422, code = 'WORKFLOW_EXPORT_INVALID') {
    return Object.assign(new Error(message), { status, code, expose: true });
}

function tableFromOutput(output) {
    let value = output, columns = null;
    if (value?.presentation === 'file') throw invalid('文件产物请使用已有下载入口。');
    if (value?.presentation === 'table' && Array.isArray(value.table?.columns)) columns = value.table.columns;
    if (value && typeof value === 'object' && Object.hasOwn(value, 'value') && value.name && value.format) value = value.value;
    if (value?.structuredContent && typeof value.structuredContent === 'object') value = value.structuredContent;
    if (value && !Array.isArray(value) && (value.truncated === true || value.__partial === true || value.complete === false || value.hasMore === true))
        throw invalid('上游数据已截断或未完整返回，请调整查询范围后重新运行。', 409, 'WORKFLOW_EXPORT_INCOMPLETE');
    const rows = Array.isArray(value) ? value : value?.rows ?? value?.data ?? value?.items;
    if (!Array.isArray(rows) || !rows.length) throw invalid('当前结果没有可导出的表格数据。');
    if (rows.length > 10000) throw invalid('结果超过一万行，请缩小查询范围后重新运行。', 413, 'WORKFLOW_EXPORT_LIMIT');
    if (rows.some(row => !row || typeof row !== 'object' || Array.isArray(row))) throw invalid('表格数据须由字段对象组成，请检查工作流输出。');
    if (!columns?.length) columns = [...new Set(rows.flatMap(row => Object.keys(row)))];
    if (columns.length > 100 || columns.some(key => typeof key !== 'string' || !key || key.length > 255) || new Set(columns).size !== columns.length)
        throw invalid('导出字段无效或超过一百列，请调整工作流输出。');
    if (!columns.length) throw invalid('表格结果没有可导出的字段。');
    return { columns, rows };
}

function cell(value) {
    if (value === null || value === undefined) return '';
    if (typeof value === 'object') return JSON.stringify(value);
    return value;
}

function buildExport(output, format) {
    if (!['csv', 'xlsx'].includes(format)) throw invalid('请选择 CSV 或 Excel 格式。', 400);
    const { columns, rows } = tableFromOutput(output);
    const values = [columns, ...rows.map(row => columns.map(key => cell(row[key])))];
    if (Buffer.byteLength(JSON.stringify(values), 'utf8') > 10 * 1024 * 1024)
        throw invalid('结果超过十 MiB，请缩小查询范围后重新运行。', 413, 'WORKFLOW_EXPORT_LIMIT');
    if (format === 'csv') return { buffer: Buffer.from('\ufeff' + values.map(row => row.map(value => typeof value === 'number' && Number.isFinite(value) ? `"${value}"` : escapeCsvCell(value)).join(',')).join('\r\n') + '\r\n'), rowCount: rows.length, type: 'text/csv; charset=utf-8' };
    if (values.some(row => row.some(value => typeof value === 'string' && value.length > 32767)))
        throw invalid('单元格内容超过 Excel 限制，请选择 CSV 下载或缩小数据。', 413, 'WORKFLOW_EXPORT_LIMIT');
    const XLSX = require('@e965/xlsx');
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(values), '工作流结果');
    return { buffer: XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx', compression: true }), rowCount: rows.length,
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };
}

async function exportResult(user, runId, nodeId, format, deps = {}) {
    const runs = deps.runs || require('./agent-runs');
    const run = await runs.getRunForUser(runId, user);
    if (!run || run.run_mode !== 'dag') throw invalid('工作流运行不存在或无权访问。', 404);
    if (run.status !== 'completed') throw invalid('请等待工作流成功完成后再下载结果。', 409);
    const node = (await runs.listDagNodes(run.id)).find(item => String(item.node_key) === String(nodeId));
    if (!node || node.tool_name !== 'workflow.output' || node.status !== 'completed') throw invalid('工作流输出节点不存在或尚未完成。', 404);
    const result = await runs.getDagNodeCompleteOutputForUser(run.id, node.node_key, user);
    if (!result?.complete || result.status !== 'completed') throw invalid('完整结果不可用或资料权限已变化，请重新运行后下载。', 409, 'WORKFLOW_EXPORT_INCOMPLETE');
    const exported = buildExport(result.output, format);
    await (deps.assertAccess || require('./knowledge-run-access').assertRunKnowledgeAccess)(run.id, user, { fresh: true });
    return exported;
}

module.exports = { buildExport, exportResult, tableFromOutput };
