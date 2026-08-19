
const fs = require('fs');
const path = require('path');
const XLSX = require('@e965/xlsx');
const Sqlite = require('better-sqlite3');
const { query, queryOne, execute } = require('../../db/client');
const {
    logger,
    datasetRoot,
    exportRoot,
    tempRoot,
    MAX_PREVIEW_ROWS,
    MAX_UPLOAD_ROWS,
    MAX_UPLOAD_COLUMNS,
    EXPORT_RETENTION_MS,
    TMP_RETENTION_MS,
    ensureAnalysisDirs,
    analysisId,
    resolveInside,
    toProjectRelative,
    fromProjectRelative,
    jsonParse,
    sqlLiteral,
    sqlIdent,
    normalizeDatasetName,
    normalizeHeader,
    normalizeCell,
    bestEffortRemove,
    moveUploadedFile,
    serializeDataset,
    getDatasetForUser,
    getDatasetPaths,
    createDuckConnection,
    withAnalysisSlot,
    parquetToRows,
    createParquetFromRows,
    getBeijingTimestamp
} = require('./shared');
const { profileViaSql } = require('./profile');

function sanitizeRows(rows) {
    const sourceRows = Array.isArray(rows) ? rows : [];
    const firstUseful = sourceRows.find(row => Array.isArray(row) && row.some(cell => String(cell ?? '').trim() !== ''));
    if (!firstUseful) {
        const err = new Error('未识别到有效表头或数据行。');
        err.status = 400;
        throw err;
    }
    const headerIndex = sourceRows.indexOf(firstUseful);
    const seen = new Set();
    const headers = firstUseful.slice(0, MAX_UPLOAD_COLUMNS).map((cell, index) => normalizeHeader(cell, index, seen));
    const columns = headers.map((header, index) => ({
        key: `c_${index + 1}`,
        name: header,
        index
    }));
    const dataRows = sourceRows.slice(headerIndex + 1)
        .filter(row => Array.isArray(row) && row.some(cell => String(cell ?? '').trim() !== ''))
        .slice(0, MAX_UPLOAD_ROWS)
        .map(row => {
            const item = {};
            columns.forEach(column => {
                item[column.key] = normalizeCell(row[column.index]);
            });
            return item;
        });
    if (!dataRows.length) {
        const err = new Error('表格中没有可分析的数据行。');
        err.status = 400;
        throw err;
    }
    return { columns, rows: dataRows, truncated: sourceRows.length > MAX_UPLOAD_ROWS + headerIndex + 1 };
}

function readSpreadsheet(filePath, originalName) {
    const workbook = XLSX.readFile(filePath, { cellDates: true });
    const sheetName = workbook.SheetNames[0];
    if (!sheetName) {
        const err = new Error('工作簿中没有可读取的工作表。');
        err.status = 400;
        throw err;
    }
    const sheet = workbook.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', raw: false, blankrows: false });
    return { ...sanitizeRows(rows), sheetName, sourceType: path.extname(originalName || filePath).toLowerCase().replace(/^\./, '') || 'xlsx' };
}

// CSV 原生导入：用 DuckDB read_csv_auto 直接把整表 COPY 成 Parquet（列名归一为 c_N），
// 整表数据不经过 JS 内存。表头取首行（positional column0..），其后数据 OFFSET 1 写入。
async function importCsvToParquet(sourcePath, parquetPath) {
    const { instance, connection } = await createDuckConnection();
    try {
        const headerRows = (await connection.runAndReadAll(
            `SELECT * FROM read_csv_auto(${sqlLiteral(sourcePath)}, header=false, all_varchar=true) LIMIT 1`
        )).getRowObjectsJson();
        if (!headerRows.length) {
            const err = new Error('未识别到有效表头或数据行。');
            err.status = 400;
            throw err;
        }
        const firstRow = headerRows[0];
        const fieldKeys = Object.keys(firstRow);
        const seen = new Set();
        const columns = fieldKeys.slice(0, MAX_UPLOAD_COLUMNS).map((fieldKey, index) => ({
            key: `c_${index + 1}`,
            name: normalizeHeader(firstRow[fieldKey], index, seen),
            index
        }));
        const selectList = columns.map(column => `${sqlIdent(`column${column.index}`)} AS ${sqlIdent(column.key)}`).join(', ');
        await connection.run(
            `COPY (SELECT ${selectList} FROM read_csv_auto(${sqlLiteral(sourcePath)}, header=false, all_varchar=true) OFFSET 1 LIMIT ${MAX_UPLOAD_ROWS}) TO ${sqlLiteral(parquetPath)} (FORMAT PARQUET, COMPRESSION ZSTD)`
        );
        const rowCount = Number((await connection.runAndReadAll(
            `SELECT COUNT(*) AS n FROM read_parquet(${sqlLiteral(parquetPath)})`
        )).getRowObjectsJson()[0]?.n || 0);
        if (!rowCount) {
            const err = new Error('表格中没有可分析的数据行。');
            err.status = 400;
            throw err;
        }
        return { columns, rowCount };
    } finally {
        connection.closeSync();
        instance.closeSync();
    }
}

function sqliteIdent(value) {
    return `"${String(value ?? '').replace(/"/g, '""')}"`;
}

function readSqliteTableColumns(sqliteDb, tableName) {
    try {
        return sqliteDb.prepare(`PRAGMA table_info(${sqliteIdent(tableName)})`).all()
            .map(item => String(item.name || '').trim())
            .filter(Boolean);
    } catch (_err) {
        return [];
    }
}

function selectSqliteImportTable(sqliteDb) {
    const candidates = sqliteDb.prepare(`
        SELECT name, type
        FROM sqlite_schema
        WHERE type IN ('table', 'view')
          AND name NOT LIKE 'sqlite_%'
        ORDER BY CASE type WHEN 'table' THEN 0 ELSE 1 END, name COLLATE NOCASE
    `).all();
    let firstReadable = null;
    for (const item of candidates) {
        const tableName = String(item.name || '').trim();
        if (!tableName) continue;
        const rawColumns = readSqliteTableColumns(sqliteDb, tableName);
        if (!rawColumns.length) continue;
        const selectedColumns = rawColumns.slice(0, MAX_UPLOAD_COLUMNS);
        const readable = { tableName, rawColumns, selectedColumns, objectType: item.type || 'table' };
        if (!firstReadable) firstReadable = readable;
        try {
            const hasRow = sqliteDb.prepare(`SELECT 1 AS ok FROM ${sqliteIdent(tableName)} LIMIT 1`).get();
            if (hasRow) return readable;
        } catch (_err) {
            // 单个视图或表不可读时跳过，继续尝试其它候选对象。
        }
    }
    return firstReadable;
}

async function importSqliteToParquet(sourcePath, parquetPath) {
    let sqliteDb;
    try {
        sqliteDb = new Sqlite(sourcePath, { readonly: true, fileMustExist: true });
        sqliteDb.pragma('query_only = ON');
    } catch (_err) {
        const err = new Error('SQLite 文件无法打开，请确认文件未损坏且不是加密数据库。');
        err.status = 400;
        throw err;
    }

    let selected;
    try {
        selected = selectSqliteImportTable(sqliteDb);
    } catch (_err) {
        sqliteDb.close();
        const err = new Error('SQLite 文件无法读取表结构，请确认文件未损坏且不是加密数据库。');
        err.status = 400;
        throw err;
    }
    if (!selected) {
        sqliteDb.close();
        const err = new Error('SQLite 文件中没有可导入的数据表或视图。');
        err.status = 400;
        throw err;
    }

    const seen = new Set();
    const columns = selected.selectedColumns.map((name, index) => ({
        key: `c_${index + 1}`,
        name: normalizeHeader(name, index, seen),
        index,
        sourceKey: name
    }));
    const selectList = selected.selectedColumns.map(sqliteIdent).join(', ');
    const rowsStatement = sqliteDb.prepare(`SELECT ${selectList} FROM ${sqliteIdent(selected.tableName)} LIMIT ?`).raw(true);
    const { instance, connection } = await createDuckConnection();
    let appender = null;
    let rowCount = 0;
    let truncated = false;
    try {
        const schema = columns.map(column => `${sqlIdent(column.key)} VARCHAR`).join(', ');
        await connection.run(`CREATE TABLE imported (${schema})`);
        appender = await connection.createAppender('imported');
        for (const row of rowsStatement.iterate(MAX_UPLOAD_ROWS + 1)) {
            if (rowCount >= MAX_UPLOAD_ROWS) {
                truncated = true;
                break;
            }
            columns.forEach(column => {
                const value = normalizeCell(row[column.index]);
                appender.appendVarchar(String(value ?? ''));
            });
            appender.endRow();
            rowCount += 1;
        }
        if (!rowCount) {
            const err = new Error('SQLite 数据表中没有可分析的数据行。');
            err.status = 400;
            throw err;
        }
        appender.closeSync();
        appender = null;
        await connection.run(`COPY imported TO ${sqlLiteral(parquetPath)} (FORMAT PARQUET, COMPRESSION ZSTD)`);
        return {
            columns,
            rowCount,
            tableName: selected.tableName,
            tableCount: 1,
            truncated
        };
    } finally {
        if (appender) appender.closeSync();
        connection.closeSync();
        instance.closeSync();
        sqliteDb.close();
    }
}
// 持久化上传文件作为数据集源，并生成 Parquet、画像与预览数据
// 调用方已使用 withAnalysisSlot 包装以管理 DuckDB 计算负载
async function ingestUpload({ datasetDir, file, ext }) {
    const sourceName = path.basename(file.originalname || `dataset${ext}`).replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').slice(0, 160);
    const sourcePath = resolveInside(datasetDir, sourceName);
    moveUploadedFile(file.path, sourcePath);
    const parquetPath = resolveInside(datasetDir, 'data.parquet');
    let columns;
    let rowCount;
    let sheetName = '';
    let sourceType;
    if (ext === '.csv') {
        const meta = await importCsvToParquet(sourcePath, parquetPath);
        columns = meta.columns;
        rowCount = meta.rowCount;
        sourceType = 'csv';
    } else if (['.sqlite', '.sqlite3', '.db'].includes(ext)) {
        const meta = await importSqliteToParquet(sourcePath, parquetPath);
        columns = meta.columns;
        rowCount = meta.rowCount;
        sheetName = meta.tableName || '';
        sourceType = 'sqlite';
    } else {
        const parsed = readSpreadsheet(sourcePath, sourceName);
        await createParquetFromRows(parsed.columns, parsed.rows, parquetPath);
        columns = parsed.columns;
        rowCount = parsed.rows.length;
        sheetName = parsed.sheetName || '';
        sourceType = parsed.sourceType;
        parsed.rows = null; // 释放整表行数组，降低后续内存峰值。
    }
    const profile = await profileViaSql(parquetPath, columns, rowCount);
    const previewRows = await parquetToRows(parquetPath, { limit: MAX_PREVIEW_ROWS });
    const fileSize = file.size || fs.statSync(sourcePath).size;
    return { sourceName, sourcePath, parquetPath, columns, rowCount, sheetName, sourceType, profile, previewRows, fileSize };
}

async function importDataset({ user, file, name }) {
    ensureAnalysisDirs();
    if (!file?.path) {
        const err = new Error('未收到上传文件。');
        err.status = 400;
        throw err;
    }
    const ext = path.extname(file.originalname || file.filename || '').toLowerCase();
    if (!['.csv', '.xlsx', '.xls', '.sqlite', '.sqlite3', '.db'].includes(ext)) {
        const err = new Error('数据分析支持 CSV、XLSX、XLS、SQLite 文件。');
        err.status = 400;
        throw err;
    }
    const datasetId = analysisId('ds');
    const datasetDir = resolveInside(datasetRoot, String(user.id), datasetId);
    fs.mkdirSync(datasetDir, { recursive: true });
    let committed = false;
    try {
        // 导入分流由 ingestUpload 内部完成（CSV 走 DuckDB 快路径，XLSX/XLS 走 JS 解析），
        // 两路最终都把数据落成 c_N 列的 Parquet，并统一用 profileViaSql 计算画像（口径一致）。
        const ingest = await withAnalysisSlot(() => ingestUpload({ datasetDir, file, ext }));
        const now = getBeijingTimestamp();
        const datasetName = normalizeDatasetName(ingest.sourceName, name);
        await execute(`
            INSERT INTO analysis_datasets (
                id, user_id, name, original_name, file_type, file_size, source_path, parquet_path,
                row_count, column_count, columns_json, profile_json, preview_json,
                sheet_name, status, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ready', ?, ?)
        `, [
            datasetId,
            user.id,
            datasetName,
            ingest.sourceName,
            ingest.sourceType,
            ingest.fileSize,
            toProjectRelative(ingest.sourcePath),
            toProjectRelative(ingest.parquetPath),
            ingest.rowCount,
            ingest.columns.length,
            JSON.stringify(ingest.columns),
            JSON.stringify(ingest.profile),
            JSON.stringify(ingest.previewRows),
            ingest.sheetName,
            now,
            now
        ]);
        committed = true;
        return serializeDataset(await getDatasetForUser(user.id, datasetId));
    } catch (err) {
        if (!committed) bestEffortRemove(datasetDir, { recursive: true });
        throw err;
    }
}

async function listDatasets(userId) {
    const rows = await query(`
        SELECT * FROM analysis_datasets
        WHERE user_id = ? AND deleted_at IS NULL
        ORDER BY updated_at DESC, created_at DESC
    `, [userId]);
    return rows.map(serializeDataset);
}

async function getDatasetSummary(userId) {
    const row = await queryOne(`
        SELECT COUNT(*) AS count, COALESCE(SUM(row_count), 0) AS row_count
        FROM analysis_datasets
        WHERE user_id = ? AND deleted_at IS NULL
    `, [userId]);
    return {
        count: Number(row?.count) || 0,
        rowCount: Number(row?.row_count) || 0
    };
}

async function getDatasetDetail(userId, datasetId) {
    const row = await getDatasetForUser(userId, datasetId);
    const dataset = serializeDataset(row);
    const { parquetPath } = getDatasetPaths(row);
    dataset.previewRows = await withAnalysisSlot(() => parquetToRows(parquetPath, { limit: MAX_PREVIEW_ROWS }));
    return dataset;
}

// 删除数据集关联的 artifacts：先移除导出等落地文件，再删行。best-effort，失败只告警。
async function purgeDatasetArtifacts(userId, datasetId) {
    let artifacts = [];
    try {
        artifacts = await query(`
            SELECT id, file_path FROM analysis_artifacts
            WHERE user_id = ? AND dataset_id = ?
        `, [userId, datasetId]);
    } catch (err) {
        logger.warn({ err: err.message, datasetId }, '读取分析 artifacts 失败');
        return;
    }
    artifacts.forEach(item => {
        if (!item.file_path) return;
        try {
            bestEffortRemove(fromProjectRelative(item.file_path));
        } catch (err) {
            logger.warn({ err: err.message, datasetId, artifactId: item.id }, 'artifact 文件清理失败');
        }
    });
    await execute('DELETE FROM analysis_artifacts WHERE user_id = ? AND dataset_id = ?', [userId, datasetId]);
}

async function softDeleteDataset(userId, datasetId) {
    const row = await getDatasetForUser(userId, datasetId);
    await execute(`
        UPDATE analysis_datasets
        SET deleted_at = ?, status = 'deleted', updated_at = ?
        WHERE id = ? AND user_id = ?
    `, [getBeijingTimestamp(), getBeijingTimestamp(), datasetId, userId]);
    // 软删除同时清理数据集文件与关联产物，避免磁盘占用膨胀
    try {
        await purgeDatasetArtifacts(userId, datasetId);
        const datasetDir = resolveInside(datasetRoot, String(userId), datasetId);
        bestEffortRemove(datasetDir, { recursive: true });
    } catch (err) {
        logger.warn({ err: err.message, datasetId }, '数据集物理文件清理失败');
    }
    return serializeDataset(row);
}

function cleanupAnalysisWorkspace({ exportRetentionMs = EXPORT_RETENTION_MS, tmpRetentionMs = TMP_RETENTION_MS } = {}) {
    const now = Date.now();
    let removed = 0;
    const sweep = (root, retentionMs) => {
        let entries = [];
        try {
            entries = fs.readdirSync(root, { withFileTypes: true });
        } catch (_err) {
            return; // 目录尚未创建则跳过
        }
        entries.forEach(entry => {
            const target = path.join(root, entry.name);
            try {
                const stat = fs.statSync(target);
                if (now - stat.mtimeMs < retentionMs) return;
                fs.rmSync(target, { force: true, recursive: entry.isDirectory(), maxRetries: 2, retryDelay: 100 });
                removed += 1;
            } catch (err) {
                logger.warn({ err: err.message, target }, '工作区文件清理失败');
            }
        });
    };
    // 导出目录按用户分子目录：逐用户子目录扫描其中的导出文件。
    let userDirs = [];
    try {
        userDirs = fs.readdirSync(exportRoot, { withFileTypes: true }).filter(entry => entry.isDirectory());
    } catch (_err) {
        userDirs = [];
    }
    userDirs.forEach(dir => sweep(path.join(exportRoot, dir.name), exportRetentionMs));
    sweep(tempRoot, tmpRetentionMs);
    if (removed) logger.info({ removed }, '数据分析工作区清理完成');
    return { removed };
}

// 历史记录：返回某数据集的图表/比对/导出 artifacts，供前端「历史」Tab 消费。
// chart 类型解析出 content 供前端一键重渲染；其余类型仅返回元信息。
async function listDatasetArtifacts(userId, datasetId, { limit = 30 } = {}) {
    await getDatasetForUser(userId, datasetId); // 校验归属，越权抛 404
    const safeLimit = Math.min(Math.max(Number(limit) || 30, 1), 100);
    const rows = await query(`
        SELECT id, type, title, content, file_path, metadata_json, created_at
        FROM analysis_artifacts
        WHERE user_id = ? AND dataset_id = ?
        ORDER BY created_at DESC
        LIMIT ?
    `, [userId, datasetId, safeLimit]);
    return rows.map(row => {
        const item = {
            id: row.id,
            type: row.type,
            title: row.title,
            createdAt: row.created_at,
            metadata: jsonParse(row.metadata_json, {}),
            hasFile: !!row.file_path
        };
        if (row.type === 'chart') item.chart = jsonParse(row.content, null);
        return item;
    });
}

// 从内存数据行构建数据集，用于数据库导入等非文件源
async function createDatasetFromRows({ user, name, rows, sourceType = 'database' }) {
    ensureAnalysisDirs();
    const sourceRows = Array.isArray(rows) ? rows : [];
    if (!sourceRows.length) {
        const err = new Error('查询结果为空，没有可导入的数据行。');
        err.status = 400;
        throw err;
    }
    // 列集合：按首批行的键并集，保持出现顺序，截断到列上限。
    const seen = new Set();
    const headerNames = [];
    sourceRows.slice(0, 200).forEach(record => {
        if (record && typeof record === 'object' && !Array.isArray(record)) {
            Object.keys(record).forEach(key => {
                if (!seen.has(key)) { seen.add(key); headerNames.push(key); }
            });
        }
    });
    if (!headerNames.length) {
        const err = new Error('查询结果不包含可识别的列。');
        err.status = 400;
        throw err;
    }
    const nameSeen = new Set();
    const columns = headerNames.slice(0, MAX_UPLOAD_COLUMNS).map((header, index) => ({
        key: `c_${index + 1}`,
        name: normalizeHeader(header, index, nameSeen),
        index,
        sourceKey: header
    }));
    const dataRows = sourceRows.slice(0, MAX_UPLOAD_ROWS).map(record => {
        const item = {};
        columns.forEach(column => {
            const raw = record && typeof record === 'object' ? record[column.sourceKey] : '';
            item[column.key] = normalizeCell(raw && typeof raw === 'object' ? JSON.stringify(raw) : raw);
        });
        return item;
    });

    const datasetId = analysisId('ds');
    const datasetName = normalizeDatasetName('', name);
    const datasetDir = resolveInside(datasetRoot, String(user.id), datasetId);
    fs.mkdirSync(datasetDir, { recursive: true });
    let committed = false;
    try {
        const parquetPath = resolveInside(datasetDir, 'data.parquet');
        const ingest = await withAnalysisSlot(async () => {
            const exportColumns = columns.map(({ key, name: colName, index }) => ({ key, name: colName, index }));
            await createParquetFromRows(exportColumns, dataRows, parquetPath);
            const profile = await profileViaSql(parquetPath, exportColumns, dataRows.length);
            const previewRows = await parquetToRows(parquetPath, { limit: MAX_PREVIEW_ROWS });
            return {
                sourceName: `${normalizeDatasetName('', name)}.${sourceType}`,
                sourcePath: '',
                parquetPath,
                columns: exportColumns,
                rowCount: dataRows.length,
                sheetName: '',
                sourceType,
                profile,
                previewRows,
                fileSize: fs.statSync(parquetPath).size
            };
        });
        const now = getBeijingTimestamp();
        await execute(`
            INSERT INTO analysis_datasets (
                id, user_id, name, original_name, file_type, file_size, source_path, parquet_path,
                row_count, column_count, columns_json, profile_json, preview_json,
                sheet_name, status, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ready', ?, ?)
        `, [
            datasetId,
            user.id,
            datasetName,
            ingest.sourceName,
            sourceType,
            ingest.fileSize,
            '',
            toProjectRelative(ingest.parquetPath),
            ingest.rowCount,
            ingest.columns.length,
            JSON.stringify(ingest.columns),
            JSON.stringify(ingest.profile),
            JSON.stringify(ingest.previewRows),
            '',
            now,
            now
        ]);
        committed = true;
        return serializeDataset(await getDatasetForUser(user.id, datasetId));
    } catch (err) {
        if (!committed) bestEffortRemove(datasetDir, { recursive: true });
        throw err;
    }
}

module.exports = {
    sanitizeRows,
    readSpreadsheet,
    importCsvToParquet,
    importSqliteToParquet,
    importDataset,
    listDatasets,
    getDatasetSummary,
    getDatasetDetail,
    purgeDatasetArtifacts,
    softDeleteDataset,
    cleanupAnalysisWorkspace,
    listDatasetArtifacts,
    createDatasetFromRows
};
