const path = require('path');
const fs = require('fs');
const os = require('os');
const { duckReadAll, sqlLiteral, normalizeHeader, normalizeCell } = require('./data-analysis/shared');
const { readSpreadsheet, importCsvToParquet, importSqliteToParquet } = require('./data-analysis/datasets');
const { createParquetFromRows } = require('./data-analysis/shared');

const SUPPORTED_FORMATS = new Set(['csv', 'parquet', 'xlsx', 'xls', 'json', 'sqlite']);

function detectDataSource(filePath) {
    const extension = path.extname(String(filePath || '')).replace(/^\./, '').toLowerCase();
    return { extension, supported: SUPPORTED_FORMATS.has(extension), kind: extension || 'unknown' };
}

function resolveJailedPath(filePath, jail) {
    const raw = String(filePath || '');
    if (!jail) return path.resolve(raw);
    const candidate = path.resolve(raw);
    const relative = path.relative(jail.workspace, candidate);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        return jail.resolve(raw); // raises the canonical workspace escape error
    }
    return jail.resolve(relative);
}

function buildDuckDbReadExpression(filePath, format) {
    const source = sqlLiteral(path.resolve(String(filePath || '')));
    const kind = String(format || detectDataSource(filePath).kind).toLowerCase();
    if (kind === 'csv') return `read_csv_auto(${source}, header=true, union_by_name=true)`;
    if (kind === 'parquet') return `read_parquet(${source})`;
    if (kind === 'json') return `read_json_auto(${source}, format='auto')`;
    throw new Error(`DuckDB 不直接读取 ${kind || 'unknown'}，请先转换为 Parquet。`);
}

async function queryDataSource(filePath, options = {}) {
    if (options.autonomous === true && !options.jail) {
        const error = new Error('自主任务读取数据源必须绑定工作区沙箱。');
        error.code = 'AGENT_WORKSPACE_JAIL_REQUIRED';
        throw error;
    }
    const detected = detectDataSource(filePath);
    if (!detected.supported) throw new Error(`不支持的数据源格式：${detected.extension || '-'}。`);
    const materialized = await materializeDataSource(filePath, options);
    const queryPath = materialized.path;
    const limit = Math.min(Math.max(Number(options.limit) || 5000, 1), 5000);
    const offset = Math.max(Number(options.offset) || 0, 0);
    const where = String(options.where || '').trim();
    if (where && !/^[\w\s.()=<>!,'"%+*/-]+$/.test(where)) throw new Error('数据源过滤表达式包含不允许的字符。');
    const sql = `SELECT * FROM ${buildDuckDbReadExpression(queryPath, 'parquet')}${where ? ` WHERE ${where}` : ''} LIMIT ${limit} OFFSET ${offset}`;
    try {
        return { source: detected, materializedPath: queryPath, rows: await duckReadAll(sql), limit, offset };
    } finally {
        if (materialized.cleanup) {
            try { fs.rmSync(queryPath, { force: true }); } catch (_) {}
        }
    }
}

async function materializeDataSource(filePath, options = {}) {
    const detected = detectDataSource(filePath);
    const sourcePath = resolveJailedPath(filePath, options.jail);
    if (detected.kind === 'parquet') return { path: sourcePath, cleanup: false };
    const root = options.jail
        ? options.jail.resolve('tmp/data')
        : path.resolve(options.workspaceRoot || options.workspace || path.join(os.tmpdir(), 'pivot-agent-data'));
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    const target = path.join(root, `${Date.now()}-${Math.random().toString(16).slice(2)}.parquet`);
    if (detected.kind === 'csv') await importCsvToParquet(sourcePath, target);
    else if (detected.kind === 'xlsx' || detected.kind === 'xls') {
        const parsed = readSpreadsheet(sourcePath, sourcePath);
        await createParquetFromRows(parsed.columns, parsed.rows, target);
    } else if (detected.kind === 'sqlite') await importSqliteToParquet(sourcePath, target);
    else if (detected.kind === 'json') {
        const parsed = JSON.parse(fs.readFileSync(sourcePath, 'utf8'));
        const rows = Array.isArray(parsed) ? parsed : (Array.isArray(parsed?.rows) ? parsed.rows : []);
        const normalized = normalizeTabularRows(rows);
        const keys = [...new Set(normalized.flatMap(row => Object.keys(row)))];
        await createParquetFromRows(keys.map((name, index) => ({ key: `c_${index + 1}`, name, index })), normalized.map(row => Object.fromEntries(keys.map((key, index) => [`c_${index + 1}`, row[key] ?? null]))), target);
    } else throw new Error(`不支持的数据源格式：${detected.extension || '-'}。`);
    return { path: target, cleanup: true };
}

function normalizeTabularRows(rows = []) {
    if (!Array.isArray(rows)) return [];
    return rows.map(row => Object.fromEntries(Object.entries(row || {}).map(([key, value]) => [normalizeHeader(key), normalizeCell(value)])));
}

module.exports = { SUPPORTED_FORMATS, buildDuckDbReadExpression, detectDataSource, materializeDataSource, normalizeTabularRows, queryDataSource };
