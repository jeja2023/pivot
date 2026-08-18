
const fs = require('fs');
const XLSX = require('@e965/xlsx');
const {
    exportRoot,
    tempRoot,
    MAX_QUERY_LIMIT,
    ensureAnalysisDirs,
    getDatasetForUser,
    jsonParse,
    getDatasetPaths,
    resolveInside,
    analysisId,
    sqlIdent,
    sqlLiteral,
    createDuckConnection,
    parquetToRows,
    withAnalysisSlot,
    bestEffortRemove,
    recordArtifact
} = require('./shared');

// \u7528 DuckDB \u76F4\u63A5\u628A parquet COPY \u6210\u4E34\u65F6 CSV\uFF08\u5E26\u8868\u5934\uFF09\uFF0C\u518D\u4EE5\u6D41\u5F0F\u65B9\u5F0F\u5728\u524D\u9762\u8865 UTF-8 BOM
// \u5199\u5165\u6700\u7EC8\u6587\u4EF6\uFF0C\u5168\u7A0B\u5E38\u91CF\u5185\u5B58\uFF0C\u907F\u514D\u628A\u6574\u8868\u884C\u8F7D\u5165 JS \u540E\u518D\u62FC\u5B57\u7B26\u4E32\u3002
async function duckCopyToCsv(parquetPath, columns, targetPath) {
    const selectList = columns.length
        ? columns.map(column => `${sqlIdent(column.key)} AS ${sqlIdent(column.name)}`).join(', ')
        : '*';
    const sql = `
        COPY (
            SELECT ${selectList}
            FROM read_parquet(${sqlLiteral(parquetPath)})
        ) TO ${sqlLiteral(targetPath)} (FORMAT CSV, HEADER, DELIMITER ',')
    `;
    const { instance, connection } = await createDuckConnection();
    try {
        await connection.run(sql);
    } finally {
        connection.closeSync();
        instance.closeSync();
    }
}

function prependBomStream(sourcePath, targetPath) {
    return new Promise((resolve, reject) => {
        const out = fs.createWriteStream(targetPath, { encoding: 'utf8' });
        out.on('error', reject);
        out.on('finish', resolve);
        out.write('\uFEFF');
        const input = fs.createReadStream(sourcePath);
        input.on('error', reject);
        input.pipe(out);
    });
}

// 直接把整张数据集的 parquet 拷贝为新的 parquet 导出文件，全程在 DuckDB 内完成。
async function duckCopyToParquet(parquetPath, columns, targetPath) {
    const selectList = columns.length
        ? columns.map(column => `${sqlIdent(column.key)} AS ${sqlIdent(column.name)}`).join(', ')
        : '*';
    const sql = `
        COPY (
            SELECT ${selectList}
            FROM read_parquet(${sqlLiteral(parquetPath)})
        ) TO ${sqlLiteral(targetPath)} (FORMAT PARQUET, COMPRESSION ZSTD)
    `;
    const { instance, connection } = await createDuckConnection();
    try {
        await connection.run(sql);
    } finally {
        connection.closeSync();
        instance.closeSync();
    }
}

// 写 XLSX：以 MAX_QUERY_LIMIT 为页大小从 parquet 分页读出整表，累积为 AOA 后一次性成表写盘。
// 列名使用人类可读显示名。对工作台量级（默认 ≤20 万行）内存可接受。
async function duckWriteXlsx(parquetPath, columns, targetPath, displayName) {
    const pageSize = MAX_QUERY_LIMIT;
    let offset = 0;
    const aoa = [];
    if (columns.length) aoa.push(columns.map(column => column.name));
    for (;;) {
        const page = await parquetToRows(parquetPath, { limit: pageSize, offset });
        if (!page.length) break;
        // parquet 列以 c_N 为键（createParquetFromRows），表头用显示名、取值用 key。
        page.forEach(record => {
            aoa.push(columns.length ? columns.map(column => record[column.key] ?? '') : Object.values(record));
        });
        offset += pageSize;
        if (page.length < pageSize) break;
    }
    const workbook = XLSX.utils.book_new();
    const sheet = XLSX.utils.aoa_to_sheet(aoa);
    const sheetName = String(displayName || 'Sheet1').replace(/[\\/?*[\]:]/g, '_').slice(0, 31) || 'Sheet1';
    XLSX.utils.book_append_sheet(workbook, sheet, sheetName);
    XLSX.writeFile(workbook, targetPath, { bookType: 'xlsx' });
    return aoa.length - (columns.length ? 1 : 0);
}

const EXPORT_FORMATS = {
    csv: { ext: 'csv' },
    xlsx: { ext: 'xlsx' },
    parquet: { ext: 'parquet' }
};

async function exportDataset(userId, datasetId, format = 'csv') {
    ensureAnalysisDirs();
    const fmt = String(format || 'csv').toLowerCase();
    if (!EXPORT_FORMATS[fmt]) {
        const err = new Error('仅支持导出 CSV、XLSX 或 Parquet 格式。');
        err.status = 400;
        throw err;
    }
    const row = await getDatasetForUser(userId, datasetId);
    const columns = jsonParse(row.columns_json, []);
    const { parquetPath } = getDatasetPaths(row);
    const exportDir = resolveInside(exportRoot, String(userId));
    fs.mkdirSync(exportDir, { recursive: true });
    const baseName = row.name.replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').slice(0, 80);
    const ext = EXPORT_FORMATS[fmt].ext;
    const fileName = `${baseName}-${Date.now()}.${ext}`;
    const filePath = resolveInside(exportDir, fileName);
    await withAnalysisSlot(async () => {
        if (fmt === 'csv') {
            const tmpPath = resolveInside(tempRoot, `${analysisId('csv')}.csv`);
            try {
                await duckCopyToCsv(parquetPath, columns, tmpPath);
                await prependBomStream(tmpPath, filePath);
            } finally {
                bestEffortRemove(tmpPath);
            }
        } else if (fmt === 'parquet') {
            await duckCopyToParquet(parquetPath, columns, filePath);
        } else {
            await duckWriteXlsx(parquetPath, columns, filePath, row.name);
        }
    });
    await recordArtifact({
        userId,
        datasetId,
        type: 'export',
        title: fileName,
        filePath,
        metadata: { format: fmt, rows: row.row_count }
    });
    return { filePath, fileName };
}

// 兼容旧入口：保留 exportDatasetCsv 作为 exportDataset(..., 'csv') 的薄封装。
async function exportDatasetCsv(userId, datasetId) {
    return exportDataset(userId, datasetId, 'csv');
}

module.exports = {
    exportDataset,
    exportDatasetCsv
};
