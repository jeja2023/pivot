'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { once } = require('node:events');
const readline = require('node:readline');
const { escapeCsvCell } = require('../../../csv');
const { biError } = require('./errors');

function exportColumns(definition, query) {
    const dimensions = query.dimensions.map(id => definition.dimensions.find(item => item.id === id));
    const metrics = query.metrics.map(id => definition.metrics.find(item => item.id === id));
    return { headers: ['记录类型', '说明键', '说明值', ...dimensions.flatMap(item => [`${item.name}（${item.id}）`, `${item.id}：成员键`]), ...metrics.flatMap(item => [`${item.name}（${item.id}）`, `${item.id}：类型`, `${item.id}：单位`, `${item.id}：空值原因`])],
        values: row => [row.isTotal ? 'total' : 'data', '', '', ...dimensions.flatMap(item => [row.members[item.id]?.label ?? '', JSON.stringify(row.members[item.id]?.key ?? null)]),
            ...metrics.flatMap(item => { const value = row.values[item.id]; return [value?.value ?? '', value?.value === null ? 'null' : 'decimal_string', value?.unit || item.currency || item.unit || '', value?.nullReason || '']; })] };
}

async function exportModelResult({ definition, query, inputResult, outputRoot, format, metadata }) {
    if (!['csv', 'xlsx'].includes(format)) throw biError('ANALYSIS_MODEL_EXPORT_INVALID', '仅支持 CSV 或 XLSX 导出。');
    const columns = exportColumns(definition, query), output = path.join(outputRoot, `result.${format}`);
    const notes = Object.entries({ 运行ID: metadata.sourceRunId, 模型发布版本: metadata.publishedVersion, 来源清单: metadata.manifestId, 查询摘要: metadata.queryHash,
        数据截止: JSON.stringify(metadata.dataTimes), 时区: metadata.timezone, 完整性: metadata.coverage, 总计范围: '完整过滤结果，包含所有未展示分组', 导出状态: '完整结果',
        原计算时间: metadata.computedAt || '', 结果复用: metadata.reusedResult ? '复用相同数据和口径的已验证结果，本次重新核对当前权限' : '本次计算',
        精度与类型: '精确数值使用十进制字符串；成员键保持原编码；空值原因另列；CSV 危险公式前缀以单引号转义', 查询定义: JSON.stringify(query) });
    const workbookRows = [], writer = format === 'csv' ? fs.createWriteStream(output, { flags: 'wx', mode: 0o600 }) : null;
    let writeError = null, bytes = 0, rows = 0;
    writer?.on('error', error => { writeError = error; });
    const writeExportRow = async values => {
        if (writeError) throw writeError;
        const line = values.map(escapeCsvCell).join(',') + '\r\n'; bytes += Buffer.byteLength(line);
        if (bytes > 200 * 1024 * 1024) throw biError('ANALYSIS_MODEL_OUTPUT_LIMIT', '完整导出超过二百 MiB，请增加筛选条件。', 413);
        if (writer && !writer.write(line)) await once(writer, 'drain');
        if (!writer) workbookRows.push(values.map(value => value === null || value === undefined ? '' : String(value)));
    };
    try {
        if (writer) { writer.write('\uFEFF'); await writeExportRow(columns.headers); for (const [key, value] of notes) await writeExportRow(['metadata', key, String(value ?? ''), ...Array(columns.headers.length - 3).fill('')]); }
        const stream = fs.createReadStream(inputResult, { highWaterMark: 65536 });
        const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
        try {
            for await (const line of lines) {
                if (!line) continue;
                const record = JSON.parse(line);
                if (!record.isTotal && ++rows > 200000) throw biError('ANALYSIS_MODEL_OUTPUT_LIMIT', '完整导出超过二十万行，请增加筛选条件。', 413);
                await writeExportRow(columns.values(record));
            }
        } finally { lines.close(); stream.destroy(); }
        if (writer) { writer.end(); await once(writer, 'close'); if (writeError) throw writeError; }
        else {
            const XLSX = require('@e965/xlsx');
            const book = XLSX.utils.book_new();
            XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([columns.headers, ...workbookRows]), '分析结果');
            XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([['说明项', '说明值'], ...notes.map(([key, value]) => [key, String(value ?? '')])]), '运行说明');
            await fs.promises.writeFile(output, XLSX.write(book, { type: 'buffer', bookType: 'xlsx', compression: true }), { flag: 'wx', mode: 0o600 });
        }
        const stat = await fs.promises.stat(output);
        if (stat.size > 200 * 1024 * 1024) throw biError('ANALYSIS_MODEL_OUTPUT_LIMIT', '完整导出超过二百 MiB，请增加筛选条件。', 413);
        const file = await fs.promises.open(output, 'r+'); try { await file.sync(); } finally { await file.close(); }
        await fs.promises.chmod(output, 0o644);
        return { format, rowCount: rows, complete: true, sourceRunId: metadata.sourceRunId, metadata };
    } catch (error) { writer?.destroy(); await fs.promises.unlink(output).catch(() => {}); throw error; }
}

module.exports = { exportModelResult, exportColumns };
