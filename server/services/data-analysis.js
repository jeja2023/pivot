const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const XLSX = require('@e965/xlsx');
const { DuckDBInstance } = require('@duckdb/node-api');
const { db, dataDir } = require('../db');
const { getBeijingTimestamp } = require('../time');
const { logger } = require('../logger');
const { analysisSemaphore } = require('./concurrency');

const projectRoot = path.resolve(__dirname, '../..');
const analysisRoot = process.env.PIVOT_ANALYSIS_DIR
    ? path.resolve(process.env.PIVOT_ANALYSIS_DIR)
    : path.join(dataDir, 'analysis');
const datasetRoot = path.join(analysisRoot, 'datasets');
const exportRoot = path.join(analysisRoot, 'exports');
const tempRoot = path.join(analysisRoot, 'tmp');

const MAX_PREVIEW_ROWS = 100;
const MAX_PROFILE_DISTINCT = 20;
const MAX_UPLOAD_ROWS = Math.max(1000, Number.parseInt(process.env.DATA_ANALYSIS_MAX_ROWS || '200000', 10) || 200000);
const MAX_UPLOAD_COLUMNS = Math.max(5, Number.parseInt(process.env.DATA_ANALYSIS_MAX_COLUMNS || '120', 10) || 120);
const MAX_QUERY_LIMIT = 5000;
const MAX_SQL_LEN = 5000;
const MAX_PIVOT_ROWS = 200;
const MAX_PIVOT_COLS = 50;
const CHART_PALETTES = {
    teal: ['#0f766e', '#2563eb', '#d97706', '#dc2626', '#7c3aed', '#0891b2'],
    business: ['#2563eb', '#0f766e', '#7c3aed', '#0891b2', '#d97706', '#dc2626'],
    warm: ['#d97706', '#dc2626', '#be123c', '#a16207', '#ea580c', '#b45309'],
    soft: ['#14b8a6', '#60a5fa', '#f59e0b', '#f87171', '#a78bfa', '#22d3ee']
};
const CHART_COLORS = CHART_PALETTES.teal;
// 工作区文件保留期：导出文件默认 7 天、临时文件默认 1 天，超期由维护任务清理。
const EXPORT_RETENTION_MS = Math.max(60 * 60 * 1000, Number.parseInt(process.env.DATA_ANALYSIS_EXPORT_RETENTION_MS || '', 10) || 7 * 24 * 60 * 60 * 1000);
const TMP_RETENTION_MS = Math.max(60 * 60 * 1000, Number.parseInt(process.env.DATA_ANALYSIS_TMP_RETENTION_MS || '', 10) || 24 * 60 * 60 * 1000);

function ensureAnalysisDirs() {
    [analysisRoot, datasetRoot, exportRoot, tempRoot].forEach(dir => {
        fs.mkdirSync(dir, { recursive: true });
    });
}

function analysisId(prefix) {
    return `${prefix}_${Date.now().toString(36)}_${crypto.randomBytes(5).toString('hex')}`;
}

function isPathInside(parent, target) {
    const relative = path.relative(parent, target);
    return relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

function resolveInside(parent, ...parts) {
    const target = path.resolve(parent, ...parts);
    if (!isPathInside(parent, target)) {
        const err = new Error('Unsafe analysis file path.');
        err.status = 400;
        throw err;
    }
    return target;
}

function toProjectRelative(targetPath) {
    const relative = path.relative(projectRoot, path.resolve(targetPath)).replace(/\\/g, '/');
    return relative && !relative.startsWith('..') ? relative : '';
}

function fromProjectRelative(relativePath) {
    const target = path.resolve(projectRoot, String(relativePath || ''));
    if (!isPathInside(projectRoot, target)) {
        const err = new Error('Unsafe stored analysis path.');
        err.status = 400;
        throw err;
    }
    return target;
}

function jsonParse(value, fallback) {
    try {
        return value ? JSON.parse(value) : fallback;
    } catch (_err) {
        return fallback;
    }
}

function sqlLiteral(value) {
    return `'${String(value ?? '').replace(/'/g, "''").replace(/\\/g, '/')}'`;
}

function sqlIdent(value) {
    return `"${String(value ?? '').replace(/"/g, '""')}"`;
}

function normalizeDatasetName(fileName, providedName) {
    const base = String(providedName || fileName || '数据集')
        .replace(/\.[^.]+$/, '')
        .replace(/[\0\r\n\t]/g, ' ')
        .trim();
    return (base || '数据集').slice(0, 120);
}

function normalizeHeader(value, index, seen) {
    const raw = String(value ?? '').trim();
    const base = raw || `字段${index + 1}`;
    let name = base.slice(0, 80);
    let suffix = 2;
    while (seen.has(name)) {
        name = `${base.slice(0, 70)}_${suffix}`;
        suffix += 1;
    }
    seen.add(name);
    return name;
}

function normalizeCell(value) {
    if (value === null || value === undefined) return '';
    if (value instanceof Date) return Number.isNaN(value.getTime()) ? '' : value.toISOString();
    if (typeof value === 'number') return Number.isFinite(value) ? value : '';
    if (typeof value === 'boolean') return value ? 'true' : 'false';
    return String(value).trim();
}

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

function bestEffortRemove(targetPath, { recursive = false } = {}) {
    if (!targetPath) return;
    try {
        fs.rmSync(targetPath, { force: true, recursive, maxRetries: 4, retryDelay: 100 });
        return;
    } catch (err) {
        const timer = setTimeout(() => {
            fs.promises.rm(targetPath, { force: true, recursive, maxRetries: 4, retryDelay: 150 })
                .catch(cleanupErr => logger.warn({ err: cleanupErr.message, targetPath }, 'Analysis temporary file cleanup failed'));
        }, 250);
        if (typeof timer.unref === 'function') timer.unref();
        logger.warn({ err: err.message, targetPath }, 'Analysis temporary file cleanup deferred');
    }
}

function moveUploadedFile(sourcePath, targetPath) {
    try {
        fs.renameSync(sourcePath, targetPath);
    } catch (err) {
        if (!['EXDEV', 'EPERM', 'EACCES'].includes(err?.code)) throw err;
        fs.copyFileSync(sourcePath, targetPath);
        bestEffortRemove(sourcePath);
    }
}

// 数值清洗表达式：镜像旧 toFiniteNumber 的去千分位/货币符号/百分号/空白逻辑（近似，
// 不处理百分比 /100 与括号负数）。日期形态只认明确的 YYYY-(MM)-(DD)，与旧 inferKind 对齐。
const SQL_NUMERIC_CLEAN = "regexp_replace(v, '[,￥¥$%[:space:]]', '', 'g')";
const SQL_DATE_PATTERN = '[0-9]{4}[-/][0-9]{1,2}[-/][0-9]{1,2}([ T][0-9]{1,2}:[0-9]{2}(:[0-9]{2})?)?(Z|[+-][0-9]{2}:?[0-9]{2})?';

// 统一画像：直接在 DuckDB 内对 parquet 计算字段画像，CSV/Excel 两条导入路径共用，
// 输出形状与历史 buildProfile 完全一致（type/filled/empty/fillRate/distinct/samples/topValues/numeric）。
async function profileViaSql(parquetPath, columns, totalRows) {
    const { instance, connection } = await createDuckConnection();
    try {
        const profile = [];
        for (const column of columns) {
            const ident = sqlIdent(column.key);
            const nonEmpty = `SELECT CAST(${ident} AS VARCHAR) AS v FROM read_parquet(${sqlLiteral(parquetPath)}) WHERE trim(CAST(${ident} AS VARCHAR)) <> ''`;
            const aggSql = `
                WITH base AS (${nonEmpty}),
                prepared AS (
                    SELECT v,
                        TRY_CAST(${SQL_NUMERIC_CLEAN} AS DOUBLE) AS numv,
                        regexp_full_match(v, '${SQL_DATE_PATTERN}') AS is_date_raw,
                        lower(v) IN ('true', 'false', '是', '否', 'yes', 'no') AS is_bool
                    FROM base
                )
                SELECT
                    COUNT(*) AS filled,
                    COUNT(DISTINCT v) AS distinct_count,
                    COUNT(numv) AS number_count,
                    COUNT(*) FILTER (WHERE numv IS NULL AND is_date_raw) AS date_count,
                    COUNT(*) FILTER (WHERE is_bool) AS boolean_count,
                    MIN(numv) AS min_v, MAX(numv) AS max_v, AVG(numv) AS avg_v, SUM(numv) AS sum_v,
                    MEDIAN(numv) AS median_v, QUANTILE_CONT(numv, 0.25) AS p25_v,
                    QUANTILE_CONT(numv, 0.75) AS p75_v, STDDEV_POP(numv) AS stddev_v
                FROM prepared
            `;
            const agg = (await connection.runAndReadAll(aggSql)).getRowObjectsJson()[0] || {};
            const topRows = (await connection.runAndReadAll(
                `SELECT v, COUNT(*) AS cnt FROM (${nonEmpty}) GROUP BY v ORDER BY cnt DESC, v LIMIT ${MAX_PROFILE_DISTINCT}`
            )).getRowObjectsJson();

            const filled = Number(agg.filled) || 0;
            const numberCount = Number(agg.number_count) || 0;
            const dateCount = Number(agg.date_count) || 0;
            const booleanCount = Number(agg.boolean_count) || 0;
            const threshold = Math.max(1, Math.floor(filled * 0.75));
            let type = 'text';
            if (!filled) type = 'empty';
            else if (numberCount >= threshold) type = 'number';
            else if (dateCount >= threshold) type = 'date';
            else if (booleanCount >= threshold) type = 'boolean';

            const topValues = topRows.map(item => ({ value: item.v, count: Number(item.cnt) || 0 }));
            profile.push({
                key: column.key,
                name: column.name,
                type,
                filled,
                empty: Math.max(0, (Number(totalRows) || 0) - filled),
                fillRate: totalRows ? filled / totalRows : 0,
                distinct: Number(agg.distinct_count) || 0,
                samples: topValues.slice(0, 5).map(item => item.value),
                topValues,
                numeric: numberCount ? {
                    count: numberCount,
                    min: Number(agg.min_v),
                    max: Number(agg.max_v),
                    avg: Number(agg.avg_v),
                    sum: Number(agg.sum_v),
                    median: Number(agg.median_v),
                    p25: Number(agg.p25_v),
                    p75: Number(agg.p75_v),
                    stddev: Number(agg.stddev_v)
                } : null
            });
        }
        return profile;
    } finally {
        connection.closeSync();
        instance.closeSync();
    }
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

function serializeDataset(row) {
    if (!row) return null;
    return {
        id: row.id,
        name: row.name,
        originalName: row.original_name,
        fileType: row.file_type,
        fileSize: row.file_size,
        rowCount: row.row_count,
        columnCount: row.column_count,
        status: row.status,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        columns: jsonParse(row.columns_json, []),
        profile: jsonParse(row.profile_json, []),
        previewRows: jsonParse(row.preview_json, []),
        sheetName: row.sheet_name || ''
    };
}

function getDatasetForUser(userId, datasetId) {
    const row = db.prepare(`
        SELECT * FROM analysis_datasets
        WHERE id = ? AND user_id = ? AND deleted_at IS NULL
    `).get(datasetId, userId);
    if (!row) {
        const err = new Error('数据集不存在或无权访问。');
        err.status = 404;
        throw err;
    }
    return row;
}

function getDatasetPaths(row) {
    const parquetPath = fromProjectRelative(row.parquet_path);
    const sourcePath = row.source_path ? fromProjectRelative(row.source_path) : '';
    return { parquetPath, sourcePath };
}

async function createDuckConnection() {
    const instance = await DuckDBInstance.create(':memory:', {
        threads: String(Math.max(1, Math.min(os.cpus()?.length || 2, Number.parseInt(process.env.DATA_ANALYSIS_DUCKDB_THREADS || '4', 10) || 4)))
    });
    const connection = await instance.connect();
    await connection.run(`SET temp_directory=${sqlLiteral(tempRoot)}`);
    return { instance, connection };
}

async function duckReadAll(sql) {
    const { instance, connection } = await createDuckConnection();
    try {
        const reader = await connection.runAndReadAll(sql);
        return reader.getRowObjectsJson();
    } finally {
        connection.closeSync();
        instance.closeSync();
    }
}

// 重型 DuckDB 操作的并发闸：限制同时执行的查询数，过载时把信号量的 503
// 透传为带 status 的错误，交由路由层 asyncHandler 返回友好提示。
async function withAnalysisSlot(fn) {
    try {
        await analysisSemaphore.acquire();
    } catch (e) {
        const err = new Error(e.message || '数据分析服务繁忙，请稍后重试。');
        err.status = e.statusCode || 503;
        err.code = e.code || 'ANALYSIS_OVERLOADED';
        throw err;
    }
    try {
        return await fn();
    } finally {
        analysisSemaphore.release();
    }
}

async function parquetToRows(parquetPath, { limit = 100, offset = 0 } = {}) {
    const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), MAX_QUERY_LIMIT);
    const safeOffset = Math.max(Number(offset) || 0, 0);
    return duckReadAll(`
        SELECT *
        FROM read_parquet(${sqlLiteral(parquetPath)})
        LIMIT ${safeLimit} OFFSET ${safeOffset}
    `);
}

async function createParquetFromRows(columns, rows, parquetPath) {
    const { instance, connection } = await createDuckConnection();
    let appender = null;
    try {
        const schema = columns.map(column => `${sqlIdent(column.key)} VARCHAR`).join(', ');
        await connection.run(`CREATE TABLE imported (${schema})`);
        appender = await connection.createAppender('imported');
        rows.forEach(row => {
            columns.forEach(column => {
                const value = row[column.key];
                if (value === null || value === undefined) {
                    appender.appendNull();
                } else {
                    appender.appendVarchar(String(value));
                }
            });
            appender.endRow();
        });
        appender.closeSync();
        appender = null;
        await connection.run(`COPY imported TO ${sqlLiteral(parquetPath)} (FORMAT PARQUET, COMPRESSION ZSTD)`);
    } finally {
        if (appender) appender.closeSync();
        connection.closeSync();
        instance.closeSync();
    }
}

// Store one uploaded file as the dataset source and generate Parquet, profile, and preview data.
// Caller wraps this with withAnalysisSlot because DuckDB work is heavy.
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

function recordArtifact({ userId, datasetId = '', type, title, content = '', filePath = '', metadata = {} }) {
    const artifactId = analysisId('art');
    db.prepare(`
        INSERT INTO analysis_artifacts (id, user_id, dataset_id, type, title, content, file_path, metadata_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        artifactId,
        userId,
        datasetId,
        type,
        title,
        content,
        filePath ? toProjectRelative(filePath) : '',
        JSON.stringify(metadata),
        getBeijingTimestamp()
    );
    return artifactId;
}

async function importDataset({ user, file, name }) {
    ensureAnalysisDirs();
    if (!file?.path) {
        const err = new Error('未收到上传文件。');
        err.status = 400;
        throw err;
    }
    const ext = path.extname(file.originalname || file.filename || '').toLowerCase();
    if (!['.csv', '.xlsx', '.xls'].includes(ext)) {
        const err = new Error('数据分析仅支持 CSV、XLSX、XLS 文件。');
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
        const tx = db.transaction(() => {
            db.prepare(`
                INSERT INTO analysis_datasets (
                    id, user_id, name, original_name, file_type, file_size, source_path, parquet_path,
                    row_count, column_count, columns_json, profile_json, preview_json,
                    sheet_name, status, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ready', ?, ?)
            `).run(
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
            );
        });
        tx();
        committed = true;
        return serializeDataset(getDatasetForUser(user.id, datasetId));
    } catch (err) {
        if (!committed) bestEffortRemove(datasetDir, { recursive: true });
        throw err;
    }
}

function listDatasets(userId) {
    return db.prepare(`
        SELECT * FROM analysis_datasets
        WHERE user_id = ? AND deleted_at IS NULL
        ORDER BY updated_at DESC, created_at DESC
    `).all(userId).map(serializeDataset);
}

async function getDatasetDetail(userId, datasetId) {
    const row = getDatasetForUser(userId, datasetId);
    const dataset = serializeDataset(row);
    const { parquetPath } = getDatasetPaths(row);
    dataset.previewRows = await withAnalysisSlot(() => parquetToRows(parquetPath, { limit: MAX_PREVIEW_ROWS }));
    return dataset;
}

// 删除数据集关联的 artifacts：先移除导出等落地文件，再删行。best-effort，失败只告警。
function purgeDatasetArtifacts(userId, datasetId) {
    let artifacts = [];
    try {
        artifacts = db.prepare(`
            SELECT id, file_path FROM analysis_artifacts
            WHERE user_id = ? AND dataset_id = ?
        `).all(userId, datasetId);
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
    db.prepare('DELETE FROM analysis_artifacts WHERE user_id = ? AND dataset_id = ?').run(userId, datasetId);
}

function softDeleteDataset(userId, datasetId) {
    const row = getDatasetForUser(userId, datasetId);
    db.prepare(`
        UPDATE analysis_datasets
        SET deleted_at = ?, status = 'deleted', updated_at = ?
        WHERE id = ? AND user_id = ?
    `).run(getBeijingTimestamp(), getBeijingTimestamp(), datasetId, userId);
    // Soft delete also removes dataset files and related artifacts to avoid DB and disk growth.
    try {
        purgeDatasetArtifacts(userId, datasetId);
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
function listDatasetArtifacts(userId, datasetId, { limit = 30 } = {}) {
    getDatasetForUser(userId, datasetId); // 校验归属，越权抛 404
    const safeLimit = Math.min(Math.max(Number(limit) || 30, 1), 100);
    const rows = db.prepare(`
        SELECT id, type, title, content, file_path, metadata_json, created_at
        FROM analysis_artifacts
        WHERE user_id = ? AND dataset_id = ?
        ORDER BY created_at DESC
        LIMIT ?
    `).all(userId, datasetId, safeLimit);
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

function getColumn(row, key) {
    const columns = jsonParse(row.columns_json, []);
    const column = columns.find(item => item.key === key || item.name === key);
    if (!column) {
        const err = new Error(`字段不存在：${key}`);
        err.status = 400;
        throw err;
    }
    return column;
}

function normalizeAggregation(value, hasValueField) {
    const agg = String(value || '').toLowerCase();
    if (['sum', 'avg', 'min', 'max', 'count'].includes(agg)) return agg;
    return hasValueField ? 'sum' : 'count';
}

function normalizeChartPalette(value) {
    const palette = String(value || '').toLowerCase();
    return CHART_PALETTES[palette] ? palette : 'teal';
}

function normalizeChartSort(input, chartType) {
    const defaultSortBy = chartType === 'line' || chartType === 'area' ? 'label' : 'value';
    const sortBy = ['label', 'value'].includes(String(input.sortBy || '').toLowerCase())
        ? String(input.sortBy).toLowerCase()
        : defaultSortBy;
    const defaultSortOrder = sortBy === 'label' ? 'asc' : 'desc';
    const sortOrder = ['asc', 'desc'].includes(String(input.sortOrder || '').toLowerCase())
        ? String(input.sortOrder).toLowerCase()
        : defaultSortOrder;
    return { sortBy, sortOrder };
}

function buildChartOption({ chartType, title, labels, series, xName, yName, colors = CHART_COLORS }) {
    if (chartType === 'pie') {
        return {
            title: { text: title, left: 18, top: 16, textStyle: { fontSize: 15, fontWeight: 700, color: '#334155' } },
            color: colors,
            tooltip: { trigger: 'item' },
            legend: { top: 50, left: 'center', type: 'scroll' },
            series: [{
                name: yName,
                type: 'pie',
                radius: ['35%', '68%'],
                center: ['50%', '58%'],
                data: labels.map((label, index) => ({ name: label, value: series[0]?.data?.[index] || 0 }))
            }]
        };
    }
    const normalizedType = chartType === 'area' ? 'line' : chartType;
    return {
        title: { text: title, left: 18, top: 16, textStyle: { fontSize: 15, fontWeight: 700, color: '#334155' } },
        color: colors,
        tooltip: { trigger: 'axis', confine: true },
        legend: { top: 50, right: 18, type: 'scroll' },
        grid: { left: 68, right: 32, top: 96, bottom: 64, containLabel: true },
        xAxis: {
            type: 'category',
            name: xName,
            nameLocation: 'middle',
            nameGap: 38,
            axisLabel: { hideOverlap: true, margin: 12 },
            data: labels
        },
        yAxis: {
            type: 'value',
            name: yName,
            nameLocation: 'middle',
            nameRotate: 90,
            nameGap: 56
        },
        series: series.map(item => ({
            name: item.name,
            type: normalizedType,
            data: item.data,
            smooth: normalizedType === 'line',
            areaStyle: chartType === 'area' ? {} : undefined
        }))
    };
}

async function buildChart(userId, datasetId, input = {}) {
    const row = getDatasetForUser(userId, datasetId);
    const xCol = getColumn(row, input.xField || input.xAxis);
    const yField = String(input.yField || input.yAxis || '').trim();
    const yCol = yField ? getColumn(row, yField) : null;
    const groupField = String(input.groupField || input.groupBy || '').trim();
    let groupCol = groupField ? getColumn(row, groupField) : null;
    const chartType = ['bar', 'line', 'area', 'pie'].includes(String(input.chartType || '').toLowerCase())
        ? String(input.chartType).toLowerCase()
        : 'bar';
    if (chartType === 'pie') groupCol = null;
    const aggregation = normalizeAggregation(input.aggregation, Boolean(yCol));
    if (aggregation !== 'count' && !yCol) {
        const err = new Error('生成求和、平均、最小值或最大值图表时，请先选择数值字段；如果只统计数量，请使用“计数”。');
        err.status = 400;
        throw err;
    }
    const limit = Math.min(Math.max(Number(input.limit) || 30, 1), 80);
    const colorPalette = normalizeChartPalette(input.colorPalette || input.palette);
    const colors = CHART_PALETTES[colorPalette] || CHART_COLORS;
    const { sortBy, sortOrder } = normalizeChartSort(input, chartType);
    const { parquetPath } = getDatasetPaths(row);
    const valueExpr = aggregation === 'count'
        ? 'COUNT(*)'
        : `${aggregation.toUpperCase()}(TRY_CAST(${sqlIdent(yCol.key)} AS DOUBLE))`;
    const groupSelect = groupCol ? `, COALESCE(NULLIF(${sqlIdent(groupCol.key)}, ''), '(empty)') AS group_label` : '';
    const groupBy = groupCol ? 'GROUP BY label, group_label' : 'GROUP BY label';
    const orderBy = `ORDER BY ${sortBy === 'label' ? 'label' : 'value'} ${sortOrder.toUpperCase()}`;
    const sql = `
        SELECT COALESCE(NULLIF(${sqlIdent(xCol.key)}, ''), '(empty)') AS label${groupSelect}, ${valueExpr} AS value
        FROM read_parquet(${sqlLiteral(parquetPath)})
        ${groupBy}
        ${orderBy}
        LIMIT ${limit * (groupCol ? 20 : 1)}
    `;
    const rows = await withAnalysisSlot(() => duckReadAll(sql));
    const labels = Array.from(new Set(rows.map(item => String(item.label)))).slice(0, limit);
    const groups = groupCol ? Array.from(new Set(rows.map(item => String(item.group_label)))).slice(0, 12) : ['value'];
    const series = groups.map(group => ({
        name: groupCol ? group : (aggregation === 'count' ? '数量' : yCol?.name || '数值'),
        data: labels.map(label => {
            const item = rows.find(record => String(record.label) === label && (!groupCol || String(record.group_label) === group));
            return Number(item?.value) || 0;
        })
    }));
    const title = String(input.title || `${xCol.name}${groupCol ? `按${groupCol.name}` : ''}${aggregation === 'count' ? '数量' : yCol ? yCol.name : ''}分析`).slice(0, 120);
    const chart = {
        type: 'pivot_chart',
        version: 1,
        renderer: 'echarts',
        chartType,
        title,
        xAxis: { field: xCol.key, label: xCol.name },
        yAxis: { field: yCol?.key || '__count__', label: aggregation === 'count' ? '数量' : yCol?.name || '数值', aggregation },
        groupBy: groupCol ? { field: groupCol.key, label: groupCol.name } : null,
        labels,
        series,
        design: { limit, sortBy, sortOrder, colorPalette },
        source: { datasetId, rows: row.row_count }
    };
    chart.echartsOption = buildChartOption({
        chartType,
        title,
        labels,
        series,
        xName: xCol.name,
        yName: chart.yAxis.label,
        colors
    });
    recordArtifact({
        userId,
        datasetId,
        type: 'chart',
        title,
        content: JSON.stringify(chart),
        metadata: { chartType, xField: xCol.key, yField: yCol?.key || '', aggregation, limit, sortBy, sortOrder, colorPalette }
    });
    return { chart, rows };
}

async function runSummary(userId, datasetId) {
    const row = getDatasetForUser(userId, datasetId);
    const profile = jsonParse(row.profile_json, []);
    const numericColumns = profile.filter(column => column.type === 'number' && column.numeric);
    const completeness = profile.length
        ? profile.reduce((sum, column) => sum + Number(column.fillRate || 0), 0) / profile.length
        : 0;
    const highlights = [
        `共 ${row.row_count} 行、${row.column_count} 列`,
        `平均填充率 ${(completeness * 100).toFixed(1)}%`,
        numericColumns.length ? `${numericColumns.length} 个字段可按数值分析` : '暂未识别到稳定数值字段'
    ];
    const topColumns = profile
        .slice()
        .sort((a, b) => (Number(b.distinct) || 0) - (Number(a.distinct) || 0))
        .slice(0, 5)
        .map(column => ({
            name: column.name,
            type: column.type,
            distinct: column.distinct,
            fillRate: column.fillRate
        }));
    const suggestions = [];
    const dimension = profile.find(column => ['text', 'date', 'boolean'].includes(column.type) && column.distinct > 1 && column.distinct <= 80);
    if (dimension && numericColumns[0]) {
        suggestions.push({
            title: `按${dimension.name}汇总${numericColumns[0].name}`,
            chartType: dimension.type === 'date' ? 'line' : 'bar',
            xField: dimension.key,
            yField: numericColumns[0].key,
            aggregation: 'sum'
        });
    }
    const category = profile.find(column => column.type === 'text' && column.distinct > 1 && column.distinct <= 20);
    if (category) {
        suggestions.push({
            title: `${category.name}数量分布`,
            chartType: 'pie',
            xField: category.key,
            yField: '',
            aggregation: 'count'
        });
    }
    return {
        dataset: serializeDataset(row),
        highlights,
        topColumns,
        numericColumns: numericColumns.slice(0, 8),
        suggestions
    };
}

async function compareDatasets(userId, input = {}) {
    const left = getDatasetForUser(userId, input.leftDatasetId);
    const right = getDatasetForUser(userId, input.rightDatasetId);
    const leftKey = getColumn(left, input.leftKey);
    const rightKey = getColumn(right, input.rightKey);
    const compareField = String(input.compareField || '').trim();
    const leftCompare = compareField ? getColumn(left, compareField) : null;
    const rightCompare = compareField ? getColumn(right, String(input.rightCompareField || input.compareField || compareField)) : null;
    const leftPath = getDatasetPaths(left).parquetPath;
    const rightPath = getDatasetPaths(right).parquetPath;
    const leftValueExpr = leftCompare
        ? `STRING_AGG(DISTINCT COALESCE(CAST(${sqlIdent(leftCompare.key)} AS VARCHAR), ''), ' | ' ORDER BY COALESCE(CAST(${sqlIdent(leftCompare.key)} AS VARCHAR), '')) AS compare_value`
        : `NULL AS compare_value`;
    const rightValueExpr = rightCompare
        ? `STRING_AGG(DISTINCT COALESCE(CAST(${sqlIdent(rightCompare.key)} AS VARCHAR), ''), ' | ' ORDER BY COALESCE(CAST(${sqlIdent(rightCompare.key)} AS VARCHAR), '')) AS compare_value`
        : `NULL AS compare_value`;
    const changedWhere = leftCompare && rightCompare
        ? `WHERE COALESCE(l.compare_value, '') <> COALESCE(r.compare_value, '')`
        : 'WHERE 1 = 0';
    const sql = `
        WITH
        left_data AS (
            SELECT
                COALESCE(CAST(${sqlIdent(leftKey.key)} AS VARCHAR), '') AS join_key,
                COUNT(*) AS row_count,
                ${leftValueExpr}
            FROM read_parquet(${sqlLiteral(leftPath)})
            GROUP BY join_key
        ),
        right_data AS (
            SELECT
                COALESCE(CAST(${sqlIdent(rightKey.key)} AS VARCHAR), '') AS join_key,
                COUNT(*) AS row_count,
                ${rightValueExpr}
            FROM read_parquet(${sqlLiteral(rightPath)})
            GROUP BY join_key
        ),
        matched AS (
            SELECT COUNT(*) AS count
            FROM left_data l
            INNER JOIN right_data r ON l.join_key = r.join_key
        ),
        matched_keys AS (
            SELECT l.join_key AS key
            FROM left_data l
            INNER JOIN right_data r ON l.join_key = r.join_key
            LIMIT 100
        ),
        only_left AS (
            SELECT l.join_key AS key
            FROM left_data l
            LEFT JOIN right_data r ON l.join_key = r.join_key
            WHERE r.join_key IS NULL
            LIMIT 100
        ),
        only_right AS (
            SELECT r.join_key AS key
            FROM right_data r
            LEFT JOIN left_data l ON l.join_key = r.join_key
            WHERE l.join_key IS NULL
            LIMIT 100
        ),
        changed AS (
            SELECT l.join_key AS key, l.compare_value AS left_value, r.compare_value AS right_value
            FROM left_data l
            INNER JOIN right_data r ON l.join_key = r.join_key
            ${changedWhere}
            LIMIT 100
        ),
        duplicate_left AS (
            SELECT join_key AS key, row_count::VARCHAR AS left_value, NULL AS right_value
            FROM left_data
            WHERE row_count > 1
            ORDER BY row_count DESC
            LIMIT 50
        ),
        duplicate_right AS (
            SELECT join_key AS key, row_count::VARCHAR AS left_value, NULL AS right_value
            FROM right_data
            WHERE row_count > 1
            ORDER BY row_count DESC
            LIMIT 50
        )
        SELECT 'matched' AS section, count::VARCHAR AS key, NULL AS left_value, NULL AS right_value FROM matched
        UNION ALL SELECT 'matched_keys' AS section, key, NULL AS left_value, NULL AS right_value FROM matched_keys
        UNION ALL SELECT 'only_left', key, NULL, NULL FROM only_left
        UNION ALL SELECT 'only_right', key, NULL, NULL FROM only_right
        UNION ALL SELECT 'changed', key, left_value, right_value FROM changed
        UNION ALL SELECT 'duplicate_left', key, left_value, right_value FROM duplicate_left
        UNION ALL SELECT 'duplicate_right', key, left_value, right_value FROM duplicate_right
    `;
    const rows = await withAnalysisSlot(() => duckReadAll(sql));
    const matched = Number(rows.find(item => item.section === 'matched')?.key || 0);
    const matchedKeys = rows.filter(item => item.section === 'matched_keys').map(item => ({ key: item.key }));
    const onlyLeft = rows.filter(item => item.section === 'only_left').map(item => ({ key: item.key }));
    const onlyRight = rows.filter(item => item.section === 'only_right').map(item => ({ key: item.key }));
    const changed = rows.filter(item => item.section === 'changed').map(item => ({
        key: item.key,
        leftValue: item.left_value,
        rightValue: item.right_value
    }));
    const duplicateLeft = rows.filter(item => item.section === 'duplicate_left').map(item => ({ key: item.key, count: Number(item.left_value) || 0 }));
    const duplicateRight = rows.filter(item => item.section === 'duplicate_right').map(item => ({ key: item.key, count: Number(item.left_value) || 0 }));
    const result = {
        left: { id: left.id, name: left.name, key: leftKey.name },
        right: { id: right.id, name: right.name, key: rightKey.name },
        matched,
        matchedKeys,
        onlyLeft,
        onlyRight,
        changed,
        duplicateLeft,
        duplicateRight,
        compareField: leftCompare ? leftCompare.name : ''
    };
    recordArtifact({
        userId,
        datasetId: left.id,
        type: 'comparison',
        title: `${left.name} vs ${right.name}`,
        content: JSON.stringify(result),
        metadata: { rightDatasetId: right.id, leftKey: leftKey.key, rightKey: rightKey.key }
    });
    return result;
}

// \u900F\u89C6\u8868\uFF1A\u6309\u884C\u7EF4 + \u53EF\u9009\u5217\u7EF4\u4EA4\u53C9\u805A\u5408\u4E00\u4E2A\u6570\u503C\uFF08\u6216\u8BA1\u6570\uFF09\u3002\u7ED3\u679C\u5728 JS \u6574\u5F62\u4E3A\u77E9\u9635\uFF0C
// \u884C/\u5217\u5404\u8BBE\u4E0A\u9650\uFF0C\u8D85\u9650\u6309\u603B\u91CF\u6392\u5E8F\u622A\u65AD\u5E76\u6807\u6CE8 truncated\u3002
async function runPivot(userId, datasetId, input = {}) {
    const row = getDatasetForUser(userId, datasetId);
    const rowCol = getColumn(row, input.rowField);
    const colField = String(input.colField || '').trim();
    const colCol = colField ? getColumn(row, colField) : null;
    const valueField = String(input.valueField || '').trim();
    const valueCol = valueField ? getColumn(row, valueField) : null;
    const aggregation = normalizeAggregation(input.aggregation, Boolean(valueCol));
    const { parquetPath } = getDatasetPaths(row);
    const valueExpr = aggregation === 'count'
        ? 'COUNT(*)'
        : `${aggregation.toUpperCase()}(TRY_CAST(${sqlIdent(valueCol.key)} AS DOUBLE))`;
    const rowLabelExpr = `COALESCE(NULLIF(${sqlIdent(rowCol.key)}, ''), '(empty)')`;
    const colLabelExpr = colCol ? `COALESCE(NULLIF(${sqlIdent(colCol.key)}, ''), '(empty)')` : `'\u5408\u8BA1'`;
    const sql = `
        SELECT ${rowLabelExpr} AS row_label, ${colLabelExpr} AS col_label, ${valueExpr} AS value
        FROM read_parquet(${sqlLiteral(parquetPath)})
        GROUP BY row_label, col_label
    `;
    const records = await withAnalysisSlot(() => duckReadAll(sql));

    // \u884C/\u5217\u6309\u805A\u5408\u603B\u91CF\u6392\u5E8F\u540E\u622A\u65AD\u3002
    const rowTotals = new Map();
    const colTotals = new Map();
    records.forEach(record => {
        const value = Number(record.value) || 0;
        rowTotals.set(record.row_label, (rowTotals.get(record.row_label) || 0) + value);
        colTotals.set(record.col_label, (colTotals.get(record.col_label) || 0) + value);
    });
    const sortByTotalDesc = totals => Array.from(totals.entries()).sort((a, b) => b[1] - a[1]).map(entry => String(entry[0]));
    const allRowLabels = sortByTotalDesc(rowTotals);
    const allColLabels = colCol ? sortByTotalDesc(colTotals) : ['\u5408\u8BA1'];
    const rowLabels = allRowLabels.slice(0, MAX_PIVOT_ROWS);
    const colLabels = allColLabels.slice(0, MAX_PIVOT_COLS);
    const truncated = allRowLabels.length > rowLabels.length || allColLabels.length > colLabels.length;

    const cellMap = new Map();
    records.forEach(record => {
        cellMap.set(`${record.row_label} ${record.col_label}`, Number(record.value) || 0);
    });
    const rows = rowLabels.map(label => {
        const values = {};
        let total = 0;
        colLabels.forEach(col => {
            const value = cellMap.get(`${label} ${col}`) || 0;
            values[col] = value;
            total += value;
        });
        return { label, values, total };
    });
    const colTotalsObj = {};
    let grandTotal = 0;
    colLabels.forEach(col => {
        const sum = rows.reduce((acc, item) => acc + (item.values[col] || 0), 0);
        colTotalsObj[col] = sum;
        grandTotal += sum;
    });

    const result = {
        rowField: { key: rowCol.key, name: rowCol.name },
        colField: colCol ? { key: colCol.key, name: colCol.name } : null,
        valueField: valueCol ? { key: valueCol.key, name: valueCol.name } : null,
        aggregation,
        columns: colLabels,
        rows,
        colTotals: colTotalsObj,
        grandTotal,
        truncated
    };
    recordArtifact({
        userId,
        datasetId,
        type: 'pivot',
        title: `${rowCol.name}${colCol ? ` \u00D7 ${colCol.name}` : ''} ${aggregation === 'count' ? '\u8BA1\u6570' : valueCol?.name || ''}`.trim(),
        content: JSON.stringify({ rowField: rowCol.key, colField: colCol?.key || '', valueField: valueCol?.key || '', aggregation }),
        metadata: { aggregation, truncated }
    });
    return result;
}

// \u81EA\u5B9A\u4E49 SQL \u67E5\u8BE2\uFF1A\u7528\u6237\u4E66\u5199\u7684\u53EA\u8BFB SELECT/WITH\uFF0C\u9488\u5BF9\u5F53\u524D\u6570\u636E\u96C6\u6267\u884C\u3002
// \u5B89\u5168\u4E3A\u591A\u5C42\u7EB5\u6DF1\uFF1A\u2460\u8BED\u6CD5/\u9ED1\u540D\u5355\u6821\u9A8C \u2461\u628A\u6570\u636E\u96C6\u7269\u5316\u4E3A\u8868\u540E\u7981\u7528\u5916\u90E8\u8BBF\u95EE\uFF08\u7528\u6237 SQL \u65E0\u6CD5\u518D\u8BFB\u4EFB\u610F\u6587\u4EF6\uFF09
// \u2462\u5916\u5C42\u5305\u88F9\u5355\u6761\u5B50\u67E5\u8BE2 + \u5F3A\u5236 LIMIT\u3002\u5217\u540D\u4F7F\u7528\u4EBA\u7C7B\u53EF\u8BFB\u663E\u793A\u540D\uFF0C\u8868\u540D\u56FA\u5B9A\u4E3A data\u3002
const SQL_BLOCKLIST = /\b(ATTACH|DETACH|COPY|INSTALL|LOAD|PRAGMA|SET|RESET|EXPORT|IMPORT|CREATE|INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE|CALL|read_csv|read_csv_auto|read_parquet|read_json|read_json_auto|read_text|read_blob|parquet_scan|glob|system|getenv)\b/i;

function validateUserSql(sql) {
    const raw = String(sql || '').trim();
    if (!raw) {
        const err = new Error('\u8BF7\u8F93\u5165\u67E5\u8BE2\u8BED\u53E5\u3002');
        err.status = 400;
        throw err;
    }
    if (raw.length > MAX_SQL_LEN) {
        const err = new Error(`\u67E5\u8BE2\u8BED\u53E5\u8FC7\u957F\uFF08\u4E0A\u9650 ${MAX_SQL_LEN} \u5B57\u7B26\uFF09\u3002`);
        err.status = 400;
        throw err;
    }
    // \u53BB\u6389\u5355\u4E2A\u5C3E\u90E8\u5206\u53F7\u540E\uFF0C\u82E5\u4ECD\u542B\u5206\u53F7\u5219\u89C6\u4E3A\u591A\u8BED\u53E5\uFF0C\u62D2\u7EDD\u3002
    const stripped = raw.replace(/;\s*$/, '');
    if (stripped.includes(';')) {
        const err = new Error('\u4EC5\u652F\u6301\u5355\u6761\u67E5\u8BE2\u8BED\u53E5\u3002');
        err.status = 400;
        throw err;
    }
    if (!/^\s*(SELECT|WITH)\b/i.test(stripped)) {
        const err = new Error('\u4EC5\u652F\u6301\u4EE5 SELECT \u6216 WITH \u5F00\u5934\u7684\u53EA\u8BFB\u67E5\u8BE2\u3002');
        err.status = 400;
        throw err;
    }
    if (SQL_BLOCKLIST.test(stripped)) {
        const err = new Error('\u67E5\u8BE2\u5305\u542B\u4E0D\u5141\u8BB8\u7684\u5173\u952E\u5B57\uFF0C\u4EC5\u652F\u6301\u5BF9\u5F53\u524D\u6570\u636E\u96C6\u7684\u53EA\u8BFB\u67E5\u8BE2\u3002');
        err.status = 400;
        throw err;
    }
    return stripped;
}

async function runUserQuery(userId, datasetId, input = {}) {
    const row = getDatasetForUser(userId, datasetId);
    const userSql = validateUserSql(input.sql);
    const limit = Math.min(Math.max(Number(input.limit) || MAX_PREVIEW_ROWS, 1), MAX_QUERY_LIMIT);
    const columns = jsonParse(row.columns_json, []);
    const { parquetPath } = getDatasetPaths(row);
    const selectList = columns.length
        ? columns.map(column => `${sqlIdent(column.key)} AS ${sqlIdent(column.name)}`).join(', ')
        : '*';
    const result = await withAnalysisSlot(async () => {
        const { instance, connection } = await createDuckConnection();
        try {
            await connection.run(`CREATE TABLE data AS SELECT ${selectList} FROM read_parquet(${sqlLiteral(parquetPath)})`);
            // \u7269\u5316\u5B8C\u6210\u540E\u5207\u65AD\u5916\u90E8\u6587\u4EF6\u8BBF\u95EE\uFF0C\u4F7F\u7528\u6237 SQL \u65E0\u6CD5\u8BFB\u53D6\u6570\u636E\u96C6\u4EE5\u5916\u7684\u4EFB\u4F55\u6587\u4EF6\u3002
            await connection.run('SET enable_external_access=false');
            const reader = await connection.runAndReadAll(`SELECT * FROM (${userSql}) AS _q LIMIT ${limit + 1}`);
            return reader.getRowObjectsJson();
        } catch (err) {
            const wrapped = new Error(`\u67E5\u8BE2\u6267\u884C\u5931\u8D25\uFF1A${err.message || '\u8BED\u6CD5\u6216\u5B57\u6BB5\u6709\u8BEF'}`);
            wrapped.status = 400;
            throw wrapped;
        } finally {
            connection.closeSync();
            instance.closeSync();
        }
    });
    const truncated = result.length > limit;
    const rows = truncated ? result.slice(0, limit) : result;
    const resultColumns = rows.length
        ? Object.keys(rows[0])
        : (columns.length ? columns.map(column => column.name) : []);
    recordArtifact({
        userId,
        datasetId,
        type: 'query',
        title: userSql.slice(0, 120),
        content: JSON.stringify({ sql: userSql, rowCount: rows.length, truncated }),
        metadata: { rows: rows.length, truncated }
    });
    return { columns: resultColumns, rows, rowCount: rows.length, truncated };
}

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
    const row = getDatasetForUser(userId, datasetId);
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
    recordArtifact({
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

// Build a dataset from in-memory rows for non-file sources such as database imports.
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
        const datasetName = normalizeDatasetName('', name);
        const tx = db.transaction(() => {
            db.prepare(`
                INSERT INTO analysis_datasets (
                    id, user_id, name, original_name, file_type, file_size, source_path, parquet_path,
                    row_count, column_count, columns_json, profile_json, preview_json,
                    sheet_name, status, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ready', ?, ?)
            `).run(
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
            );
        });
        tx();
        committed = true;
        return serializeDataset(getDatasetForUser(user.id, datasetId));
    } catch (err) {
        if (!committed) bestEffortRemove(datasetDir, { recursive: true });
        throw err;
    }
}

const MAX_DB_IMPORT_ROWS = Math.min(MAX_UPLOAD_ROWS, Math.max(1000, Number.parseInt(process.env.DATA_ANALYSIS_DB_IMPORT_MAX_ROWS || '50000', 10) || 50000));

// 从已配置的 MCP 数据库连接导入：执行只读查询（或对整表的 SELECT），把返回行落成数据集。
// 安全：仅复用现有数据库 MCP 工具链（只读校验、白名单治理、脱敏、SSRF 守卫都在其中），
// 本函数不直接连库。limit 受 MAX_DB_IMPORT_ROWS 上限保护。
async function importFromDatabase({ user, mcpServerId, sql, table, schema, limit, name }) {
    // 延迟引入，避免与 mcp-client 之间形成模块加载环。
    const { getAccessibleMcpServer } = require('./mcp-client');
    const { executeDatabaseMcpTool } = require('./database-mcp');

    const serverId = Number(mcpServerId);
    if (!serverId) {
        const err = new Error('请选择一个数据库连接。');
        err.status = 400;
        throw err;
    }
    const server = getAccessibleMcpServer(serverId, user);
    if (!server || String(server.base_url || '').indexOf('pivot-db://') !== 0) {
        const err = new Error('数据库连接不存在或无权访问。');
        err.status = 404;
        throw err;
    }
    const safeLimit = Math.min(Math.max(Number(limit) || MAX_DB_IMPORT_ROWS, 1), MAX_DB_IMPORT_ROWS);
    let result;
    const trimmedSql = String(sql || '').trim();
    const trimmedTable = String(table || '').trim();
    if (trimmedSql) {
        result = await executeDatabaseMcpTool(server, 'db.run_readonly_query', { sql: trimmedSql, limit: safeLimit });
    } else if (trimmedTable) {
        // 无显式 SQL 时，对指定表做一次受限的全列 SELECT（由 db.run_readonly_query 内部治理与限行）。
        const safeIdent = `"${trimmedTable.replace(/"/g, '""')}"`;
        const qualified = schema ? `"${String(schema).replace(/"/g, '""')}".${safeIdent}` : safeIdent;
        result = await executeDatabaseMcpTool(server, 'db.run_readonly_query', { sql: `SELECT * FROM ${qualified}`, limit: safeLimit });
    } else {
        const err = new Error('请提供要导入的 SQL 查询或数据表名。');
        err.status = 400;
        throw err;
    }
    const rows = Array.isArray(result?.rows) ? result.rows : (Array.isArray(result) ? result : []);
    const datasetName = name || trimmedTable || `${server.name || '数据库'}导入`;
    return createDatasetFromRows({ user, name: datasetName, rows, sourceType: 'database' });
}

async function buildAiContext(userId, datasetId) {
    const summary = await runSummary(userId, datasetId);
    const dataset = summary.dataset;
    return [
        `数据集：${dataset.name}`,
        `规模：${dataset.rowCount} 行，${dataset.columnCount} 列`,
        `字段：${dataset.columns.map(column => column.name).join('、')}`,
        `画像：${summary.highlights.join('；')}`,
        `建议图表：${summary.suggestions.map(item => item.title).join('；') || '暂无'}`
    ].join('\n');
}

function exportCompareExcel(data = {}) {
    const workbook = XLSX.utils.book_new();
    const leftKeyName = data.left?.key || '主键';
    const rightKeyName = data.right?.key || '主键';
    const compareField = data.compareField || '对比字段';
    
    let hasAnySheet = false;
    
    // 1. 相同项
    const matchedKeys = data.matchedKeys || [];
    if (matchedKeys.length > 0) {
        const rows = [[leftKeyName]];
        matchedKeys.forEach(item => {
            rows.push([item.key]);
        });
        const sheet = XLSX.utils.aoa_to_sheet(rows);
        XLSX.utils.book_append_sheet(workbook, sheet, '相同项');
        hasAnySheet = true;
    }
    
    // 2. 仅在A表
    const onlyLeft = data.onlyLeft || [];
    if (onlyLeft.length > 0) {
        const rows = [[leftKeyName]];
        onlyLeft.forEach(item => {
            rows.push([item.key]);
        });
        const sheet = XLSX.utils.aoa_to_sheet(rows);
        XLSX.utils.book_append_sheet(workbook, sheet, '仅在A表');
        hasAnySheet = true;
    }
    
    // 3. 仅在B表
    const onlyRight = data.onlyRight || [];
    if (onlyRight.length > 0) {
        const rows = [[rightKeyName]];
        onlyRight.forEach(item => {
            rows.push([item.key]);
        });
        const sheet = XLSX.utils.aoa_to_sheet(rows);
        XLSX.utils.book_append_sheet(workbook, sheet, '仅在B表');
        hasAnySheet = true;
    }
    
    // 4. 差异项
    const changed = data.changed || [];
    if (changed.length > 0) {
        const rows = [[leftKeyName, `左侧值 (${compareField})`, `右侧值 (${compareField})`]];
        changed.forEach(item => {
            rows.push([item.key, item.leftValue, item.rightValue]);
        });
        const sheet = XLSX.utils.aoa_to_sheet(rows);
        XLSX.utils.book_append_sheet(workbook, sheet, '差异项');
        hasAnySheet = true;
    }
    
    // 如果没有任何 sheet，至少放一个空白 sheet 避免报错
    if (!hasAnySheet) {
        const sheet = XLSX.utils.aoa_to_sheet([['无比对数据']]);
        XLSX.utils.book_append_sheet(workbook, sheet, '无数据');
    }
    
    return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
}

module.exports = {
    MAX_PREVIEW_ROWS,
    analysisRoot,
    buildAiContext,
    buildChart,
    cleanupAnalysisWorkspace,
    compareDatasets,
    createDatasetFromRows,
    ensureAnalysisDirs,
    exportDataset,
    exportDatasetCsv,
    exportCompareExcel,
    getDatasetDetail,
    importDataset,
    importFromDatabase,
    listDatasetArtifacts,
    listDatasets,
    runPivot,
    runSummary,
    runUserQuery,
    serializeDataset,
    softDeleteDataset
};
