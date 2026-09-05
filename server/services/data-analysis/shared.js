
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DuckDBInstance } = require('@duckdb/node-api');
const { queryOne, execute } = require('../../db/client');
const { getBeijingTimestamp } = require('../../time');
const { logger } = require('../../logger');
const { analysisSemaphore } = require('../concurrency');

const projectRoot = path.resolve(__dirname, '../../..');
const dataDir = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.resolve(__dirname, '../../../data');
const analysisRoot = process.env.PIVOT_ANALYSIS_DIR
    ? path.resolve(process.env.PIVOT_ANALYSIS_DIR)
    : path.join(dataDir, 'analysis');
const datasetRoot = path.join(analysisRoot, 'datasets');
const exportRoot = path.join(analysisRoot, 'exports');
const tempRoot = path.join(analysisRoot, 'tmp');
const EXTERNAL_ANALYSIS_PATH_PREFIX = '@analysis/';

const MAX_PREVIEW_ROWS = 100;
const MAX_PROFILE_DISTINCT = 20;
const MAX_UPLOAD_ROWS = Math.max(1000, Number.parseInt(process.env.DATA_ANALYSIS_MAX_ROWS || '200000', 10) || 200000);
const MAX_UPLOAD_COLUMNS = Math.max(5, Number.parseInt(process.env.DATA_ANALYSIS_MAX_COLUMNS || '120', 10) || 120);
const MAX_QUERY_LIMIT = 5000;
const MAX_SQL_LEN = 5000;
const MAX_PIVOT_ROWS = 200;
const MAX_PIVOT_COLS = 50;
const DATA_ANALYSIS_QUERY_TIMEOUT_MS = Math.max(1000, Number.parseInt(process.env.DATA_ANALYSIS_QUERY_TIMEOUT_MS || '60000', 10) || 60000);
const DATA_ANALYSIS_DUCKDB_MEMORY_LIMIT = /^[0-9]+(?:\.[0-9]+)?\s*(?:MB|GB|TB)$/i.test(String(process.env.DATA_ANALYSIS_DUCKDB_MEMORY_LIMIT || '1GB').trim())
    ? String(process.env.DATA_ANALYSIS_DUCKDB_MEMORY_LIMIT || '1GB').trim()
    : '1GB';
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

async function ensureAnalysisDirs() {
    await Promise.all([analysisRoot, datasetRoot, exportRoot, tempRoot]
        .map(dir => fs.promises.mkdir(dir, { recursive: true })));
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
        const err = new Error('不安全的数据分析文件路径。');
        err.status = 400;
        throw err;
    }
    return target;
}

function toProjectRelative(targetPath) {
    const resolved = path.resolve(targetPath);
    const projectRelative = path.relative(projectRoot, resolved).replace(/\\/g, '/');
    if (projectRelative && !projectRelative.startsWith('..') && !path.isAbsolute(projectRelative)) {
        return projectRelative;
    }
    // PIVOT_ANALYSIS_DIR 可配置到独立的数据盘。不能把绝对路径直接写入数据库，
    // 使用受控前缀保存相对 analysisRoot 的位置，并在读取时再次验证边界。
    const analysisRelative = path.relative(analysisRoot, resolved).replace(/\\/g, '/');
    if (analysisRelative && !analysisRelative.startsWith('..') && !path.isAbsolute(analysisRelative)) {
        return `${EXTERNAL_ANALYSIS_PATH_PREFIX}${analysisRelative}`;
    }
    return '';
}

function fromProjectRelative(relativePath) {
    const stored = String(relativePath || '');
    if (stored.startsWith(EXTERNAL_ANALYSIS_PATH_PREFIX)) {
        return resolveInside(analysisRoot, stored.slice(EXTERNAL_ANALYSIS_PATH_PREFIX.length));
    }
    const target = path.resolve(projectRoot, stored);
    if (!isPathInside(projectRoot, target)) {
        const err = new Error('不安全的数据分析存储路径。');
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

// 仅用于发送给大模型的观测数据。原始 Parquet、查询结果和导出结果保持不变。
const SENSITIVE_ANALYSIS_FIELD_RE = /(身份证|证件号|手机号|手机号码|电话|邮箱|email|e-mail|phone|mobile|password|密码|secret|token|api[_ -]?key|银行卡|卡号|住址|地址|姓名|真实姓名|出生日期|生日)/i;
const SENSITIVE_ANALYSIS_VALUE_RES = [
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/i,
    /^(?:\+?86[- ]?)?1[3-9]\d{9}$/,
    /^\d{17}[\dXx]$/
];

function isSensitiveAnalysisField(name) {
    return SENSITIVE_ANALYSIS_FIELD_RE.test(String(name || ''));
}

function redactAnalysisValue(value) {
    if (value === null || value === undefined || value === '') return value;
    const text = String(value);
    return SENSITIVE_ANALYSIS_VALUE_RES.some(pattern => pattern.test(text)) ? '[已脱敏]' : value;
}

function redactAnalysisRows(rows, columns = []) {
    const source = Array.isArray(rows) ? rows : [];
    const sensitiveKeys = new Set((Array.isArray(columns) ? columns : []).filter(column => isSensitiveAnalysisField(column?.name)).map(column => column.key));
    return source.map(row => {
        if (!row || typeof row !== 'object' || Array.isArray(row)) return row;
        return Object.fromEntries(Object.entries(row).map(([key, value]) => [
            key,
            sensitiveKeys.has(key) || isSensitiveAnalysisField(key) ? '[已脱敏]' : redactAnalysisValue(value)
        ]));
    });
}

const IDENTIFIER_FIELD_RE = /(^|[\s_-])(id|uuid|guid|code|no|num|number|key|编号|序号|学号|工号|账号|账户|单号|订单号|证件号|身份证|手机号|电话|卡号|条码|编码|代码)([\s_-]|$)/i;
const METRIC_FIELD_RE = /(成绩|分数|总分|得分|评分|金额|价格|单价|总价|数量|个数|人数|次数|销量|销售额|收入|利润|成本|费用|余额|库存|率|占比|比例|时长|耗时|年龄|高度|重量|面积|体积|温度|均值|平均|合计|小计|score|grade|amount|price|qty|quantity|count|total|sum|avg|average|rate|ratio|percent|cost|revenue|profit|sales|income|balance|duration|age|weight|height|area|volume|temperature)/i;
const CJK_IDENTIFIER_FIELD_RE = /(编号|序号|学号|工号|账号|账户|单号|订单号|证件号|身份证|手机号|电话|卡号|条码|编码|代码)/;

function isProfileNumberColumn(column) {
    return !!(column && column.type === 'number' && column.numeric);
}

function isIdentifierLikeColumn(column) {
    const name = `${column?.name || ''} ${column?.key || ''}`;
    return IDENTIFIER_FIELD_RE.test(name) || CJK_IDENTIFIER_FIELD_RE.test(name);
}

function isMetricNumericColumn(column) {
    if (!isProfileNumberColumn(column)) return false;
    const name = `${column?.name || ''} ${column?.key || ''}`;
    if (METRIC_FIELD_RE.test(name)) return true;
    return !isIdentifierLikeColumn(column);
}

function bestEffortRemove(targetPath, { recursive = false } = {}) {
    if (!targetPath) return;
    return fs.promises.rm(targetPath, { force: true, recursive, maxRetries: 4, retryDelay: 100 })
        .catch(err => {
            const timer = setTimeout(() => {
                fs.promises.rm(targetPath, { force: true, recursive, maxRetries: 4, retryDelay: 150 })
                    .catch(cleanupErr => logger.warn({ err: cleanupErr.message, targetPath }, '数据分析临时文件清理失败'));
            }, 250);
            if (typeof timer.unref === 'function') timer.unref();
            logger.warn({ err: err.message, targetPath }, '数据分析临时文件清理已推迟');
        });
}

async function moveUploadedFile(sourcePath, targetPath) {
    try {
        await fs.promises.rename(sourcePath, targetPath);
    } catch (err) {
        if (!['EXDEV', 'EPERM', 'EACCES'].includes(err?.code)) throw err;
        await fs.promises.copyFile(sourcePath, targetPath);
        await fs.promises.rm(sourcePath, { force: true, maxRetries: 4, retryDelay: 80 });
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
        sourceRowCount: row.source_row_count || row.row_count || 0,
        sourceColumnCount: row.source_column_count || row.column_count || 0,
        truncated: Number(row.truncated) === 1 || row.truncated === true,
        scopeUnknown: Number(row.truncated) === 2,
        truncationReason: row.truncation_reason || '',
        status: row.status,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        columns: jsonParse(row.columns_json, []),
        profile: jsonParse(row.profile_json, []),
        previewRows: jsonParse(row.preview_json, []),
        sheetName: row.sheet_name || '',
        derivedFromDatasetId: row.derived_from_dataset_id || '',
        cleaningRunId: row.cleaning_run_id || ''
    };
}

async function getDatasetForUser(userId, datasetId) {
    const row = await queryOne(`
        SELECT * FROM analysis_datasets
        WHERE id = ? AND user_id = ? AND deleted_at IS NULL
    `, [datasetId, userId]);
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
    await connection.run(`SET memory_limit=${sqlLiteral(DATA_ANALYSIS_DUCKDB_MEMORY_LIMIT)}`);
    return { instance, connection };
}

async function withDuckTimeout(connection, operation, timeoutMs = DATA_ANALYSIS_QUERY_TIMEOUT_MS) {
    let timer;
    try {
        return await Promise.race([
            operation(),
            new Promise((_, reject) => {
                timer = setTimeout(() => {
                    try { connection.interrupt?.(); } catch (_err) { /* connection is closed in caller finally */ }
                    const err = new Error(`数据分析查询超时（>${timeoutMs}ms），请缩小查询范围或增加筛选条件。`);
                    err.status = 408;
                    err.code = 'ANALYSIS_QUERY_TIMEOUT';
                    reject(err);
                }, timeoutMs);
                if (typeof timer.unref === 'function') timer.unref();
            })
        ]);
    } finally {
        if (timer) clearTimeout(timer);
    }
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

async function recordArtifact({ userId, datasetId = '', type, title, content = '', filePath = '', metadata = {} }) {
    const artifactId = analysisId('art');
    await execute(`
        INSERT INTO analysis_artifacts (id, user_id, dataset_id, type, title, content, file_path, metadata_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
        artifactId,
        userId,
        datasetId,
        type,
        title,
        content,
        filePath ? toProjectRelative(filePath) : '',
        JSON.stringify(metadata),
        getBeijingTimestamp()
    ]);
    return artifactId;
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

module.exports = {
    logger,
    projectRoot,
    analysisRoot,
    datasetRoot,
    exportRoot,
    tempRoot,
    MAX_PREVIEW_ROWS,
    MAX_PROFILE_DISTINCT,
    MAX_UPLOAD_ROWS,
    MAX_UPLOAD_COLUMNS,
    MAX_QUERY_LIMIT,
    MAX_SQL_LEN,
    MAX_PIVOT_ROWS,
    MAX_PIVOT_COLS,
    DATA_ANALYSIS_QUERY_TIMEOUT_MS,
    DATA_ANALYSIS_DUCKDB_MEMORY_LIMIT,
    CHART_PALETTES,
    CHART_COLORS,
    EXPORT_RETENTION_MS,
    TMP_RETENTION_MS,
    ensureAnalysisDirs,
    analysisId,
    isPathInside,
    resolveInside,
    toProjectRelative,
    fromProjectRelative,
    jsonParse,
    sqlLiteral,
    sqlIdent,
    normalizeDatasetName,
    normalizeHeader,
    normalizeCell,
    isSensitiveAnalysisField,
    redactAnalysisValue,
    redactAnalysisRows,
    isProfileNumberColumn,
    isIdentifierLikeColumn,
    isMetricNumericColumn,
    getBeijingTimestamp,
    bestEffortRemove,
    moveUploadedFile,
    serializeDataset,
    getDatasetForUser,
    getDatasetPaths,
    createDuckConnection,
    withDuckTimeout,
    duckReadAll,
    withAnalysisSlot,
    parquetToRows,
    createParquetFromRows,
    recordArtifact,
    getColumn,
    normalizeAggregation
};
