const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const XLSX = require('@e965/xlsx');
const { DuckDBInstance } = require('@duckdb/node-api');
const { db, dataDir } = require('../db');
const { getBeijingTimestamp } = require('../time');
const { logger } = require('../logger');
const { escapeCsvCell } = require('../security');

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
const CHART_COLORS = ['#0f766e', '#2563eb', '#d97706', '#dc2626', '#7c3aed', '#0891b2'];

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

function toFiniteNumber(value) {
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    const text = String(value ?? '').trim();
    if (!text) return null;
    const percent = text.endsWith('%');
    let normalized = text
        .replace(/,/g, '')
        .replace(/[￥¥$]/g, '')
        .replace(/\s+/g, '');
    if (/^\((.*)\)$/.test(normalized)) normalized = `-${RegExp.$1}`;
    normalized = normalized.replace(/%/g, '');
    const parsed = Number(normalized);
    if (!Number.isFinite(parsed)) return null;
    return percent ? parsed / 100 : parsed;
}

function inferKind(values) {
    const filled = values.filter(value => String(value ?? '').trim() !== '');
    if (!filled.length) return 'empty';
    let numberCount = 0;
    let dateCount = 0;
    let booleanCount = 0;
    filled.forEach(value => {
        const text = String(value).trim();
        if (toFiniteNumber(text) !== null) numberCount += 1;
        if (/^\d{4}[-/]\d{1,2}[-/]\d{1,2}/.test(text) || !Number.isNaN(Date.parse(text))) dateCount += 1;
        if (/^(true|false|是|否|yes|no)$/i.test(text)) booleanCount += 1;
    });
    const threshold = Math.max(1, Math.floor(filled.length * 0.75));
    if (numberCount >= threshold) return 'number';
    if (dateCount >= threshold) return 'date';
    if (booleanCount >= threshold) return 'boolean';
    return 'text';
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

function buildProfile(columns, rows) {
    return columns.map(column => {
        const values = rows.map(row => row[column.key]);
        const filled = values.filter(value => String(value ?? '').trim() !== '');
        const kind = inferKind(filled);
        const distinctMap = new Map();
        filled.forEach(value => {
            const key = String(value);
            distinctMap.set(key, (distinctMap.get(key) || 0) + 1);
        });
        const topValues = Array.from(distinctMap.entries())
            .sort((a, b) => b[1] - a[1])
            .slice(0, MAX_PROFILE_DISTINCT)
            .map(([value, count]) => ({ value, count }));
        const nums = filled.map(toFiniteNumber).filter(value => value !== null);
        return {
            key: column.key,
            name: column.name,
            type: kind,
            filled: filled.length,
            empty: rows.length - filled.length,
            fillRate: rows.length ? filled.length / rows.length : 0,
            distinct: distinctMap.size,
            samples: Array.from(distinctMap.keys()).slice(0, 5),
            topValues,
            numeric: nums.length ? {
                count: nums.length,
                min: Math.min(...nums),
                max: Math.max(...nums),
                avg: nums.reduce((sum, value) => sum + value, 0) / nums.length,
                sum: nums.reduce((sum, value) => sum + value, 0)
            } : null
        };
    });
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
        activeVersion: row.active_version,
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
    const version = 1;
    const versionDir = resolveInside(datasetDir, `v${version}`);
    fs.mkdirSync(versionDir, { recursive: true });
    let committed = false;
    try {
        const sourceName = path.basename(file.originalname || `dataset${ext}`).replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').slice(0, 160);
        const sourcePath = resolveInside(versionDir, sourceName);
        moveUploadedFile(file.path, sourcePath);
        const parquetPath = resolveInside(versionDir, 'data.parquet');

        const parsed = readSpreadsheet(sourcePath, sourceName);
        await createParquetFromRows(parsed.columns, parsed.rows, parquetPath);

        const profile = buildProfile(parsed.columns, parsed.rows);
        const previewRows = parsed.rows.slice(0, MAX_PREVIEW_ROWS);
        const now = getBeijingTimestamp();
        const datasetName = normalizeDatasetName(sourceName, name);
        db.prepare(`
            INSERT INTO analysis_datasets (
                id, user_id, name, original_name, file_type, file_size, source_path, parquet_path,
                row_count, column_count, columns_json, profile_json, preview_json,
                sheet_name, active_version, status, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ready', ?, ?)
        `).run(
            datasetId,
            user.id,
            datasetName,
            sourceName,
            parsed.sourceType,
            file.size || fs.statSync(sourcePath).size,
            toProjectRelative(sourcePath),
            toProjectRelative(parquetPath),
            parsed.rows.length,
            parsed.columns.length,
            JSON.stringify(parsed.columns),
            JSON.stringify(profile),
            JSON.stringify(previewRows),
            parsed.sheetName || '',
            version,
            now,
            now
        );
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
    dataset.previewRows = await parquetToRows(parquetPath, { limit: MAX_PREVIEW_ROWS });
    return dataset;
}

function softDeleteDataset(userId, datasetId) {
    const row = getDatasetForUser(userId, datasetId);
    db.prepare(`
        UPDATE analysis_datasets
        SET deleted_at = ?, status = 'deleted', updated_at = ?
        WHERE id = ? AND user_id = ?
    `).run(getBeijingTimestamp(), getBeijingTimestamp(), datasetId, userId);
    return serializeDataset(row);
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

function buildChartOption({ chartType, title, labels, series, xName, yName }) {
    if (chartType === 'pie') {
        return {
            title: { text: title, left: 18, top: 16, textStyle: { fontSize: 15, fontWeight: 700, color: '#334155' } },
            color: CHART_COLORS,
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
        color: CHART_COLORS,
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
    const groupCol = groupField ? getColumn(row, groupField) : null;
    const chartType = ['bar', 'line', 'area', 'pie'].includes(String(input.chartType || '').toLowerCase())
        ? String(input.chartType).toLowerCase()
        : 'bar';
    const aggregation = normalizeAggregation(input.aggregation, Boolean(yCol));
    const limit = Math.min(Math.max(Number(input.limit) || 30, 1), 80);
    const { parquetPath } = getDatasetPaths(row);
    const valueExpr = aggregation === 'count'
        ? 'COUNT(*)'
        : `${aggregation.toUpperCase()}(TRY_CAST(${sqlIdent(yCol.key)} AS DOUBLE))`;
    const groupSelect = groupCol ? `, COALESCE(NULLIF(${sqlIdent(groupCol.key)}, ''), '(empty)') AS group_label` : '';
    const groupBy = groupCol ? 'GROUP BY label, group_label' : 'GROUP BY label';
    const orderBy = chartType === 'line' || chartType === 'area' ? 'ORDER BY label ASC' : 'ORDER BY value DESC';
    const sql = `
        SELECT COALESCE(NULLIF(${sqlIdent(xCol.key)}, ''), '(empty)') AS label${groupSelect}, ${valueExpr} AS value
        FROM read_parquet(${sqlLiteral(parquetPath)})
        ${groupBy}
        ${orderBy}
        LIMIT ${limit * (groupCol ? 20 : 1)}
    `;
    const rows = await duckReadAll(sql);
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
        source: { datasetId, rows: row.row_count }
    };
    chart.echartsOption = buildChartOption({
        chartType,
        title,
        labels,
        series,
        xName: xCol.name,
        yName: chart.yAxis.label
    });
    recordArtifact({
        userId,
        datasetId,
        type: 'chart',
        title,
        content: JSON.stringify(chart),
        metadata: { chartType, xField: xCol.key, yField: yCol?.key || '', aggregation }
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
        UNION ALL SELECT 'only_left', key, NULL, NULL FROM only_left
        UNION ALL SELECT 'only_right', key, NULL, NULL FROM only_right
        UNION ALL SELECT 'changed', key, left_value, right_value FROM changed
        UNION ALL SELECT 'duplicate_left', key, left_value, right_value FROM duplicate_left
        UNION ALL SELECT 'duplicate_right', key, left_value, right_value FROM duplicate_right
    `;
    const rows = await duckReadAll(sql);
    const matched = Number(rows.find(item => item.section === 'matched')?.key || 0);
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

function rowsToDisplay(rows, columns) {
    return rows.map(row => {
        const item = {};
        columns.forEach(column => {
            item[column.name] = row[column.key] ?? '';
        });
        return item;
    });
}

async function exportDatasetCsv(userId, datasetId) {
    ensureAnalysisDirs();
    const row = getDatasetForUser(userId, datasetId);
    const columns = jsonParse(row.columns_json, []);
    const { parquetPath } = getDatasetPaths(row);
    const rows = await duckReadAll(`SELECT * FROM read_parquet(${sqlLiteral(parquetPath)})`);
    const exportDir = resolveInside(exportRoot, String(userId));
    fs.mkdirSync(exportDir, { recursive: true });
    const fileName = `${row.name.replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').slice(0, 80)}-${Date.now()}.csv`;
    const filePath = resolveInside(exportDir, fileName);
    const displayRows = rowsToDisplay(rows, columns);
    const header = columns.map(column => escapeCsvCell(column.name)).join(',');
    const lines = [
        header,
        ...displayRows.map(item => columns.map(column => escapeCsvCell(item[column.name])).join(','))
    ];
    fs.writeFileSync(filePath, `\uFEFF${lines.join(os.EOL)}`, 'utf8');
    recordArtifact({
        userId,
        datasetId,
        type: 'export',
        title: fileName,
        filePath,
        metadata: { format: 'csv', rows: rows.length }
    });
    return { filePath, fileName };
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

module.exports = {
    MAX_PREVIEW_ROWS,
    analysisRoot,
    buildAiContext,
    buildChart,
    compareDatasets,
    ensureAnalysisDirs,
    exportDatasetCsv,
    getDatasetDetail,
    importDataset,
    listDatasets,
    runSummary,
    serializeDataset,
    softDeleteDataset
};
