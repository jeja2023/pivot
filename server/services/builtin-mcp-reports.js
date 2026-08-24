/* 内置 MCP 能力 - 报表与数据文件 Built-in Reports MCP
 *
 * 负责局域网/共享目录下报表与数据文件的列出、摘要读取、抽样查询与对比。
 * 由 builtin-mcp.js 拆分而来，逻辑保持不变。
 */
const fs = require('fs');
const path = require('path');
const { StringDecoder } = require('string_decoder');
let XLSX = null;
function getXlsx() {
    if (!XLSX) XLSX = require('@e965/xlsx');
    return XLSX;
}
const {
    getRequiredBuiltinConfigAsync,
    isPathInside,
    getExtension,
    buildReportDataSource
} = require('./builtin-mcp-common');

function listReportTools() {
    return [
        {
            name: 'reports.list_files',
            title: '查找报表文件',
            description: '列出配置目录下可访问的报表/数据文件。',
            inputSchema: {
                type: 'object',
                properties: {
                    query: { type: 'string' },
                    limit: { type: 'number', minimum: 1, maximum: 200 }
                }
            }
        },
        {
            name: 'reports.read_file_summary',
            title: '读取报表摘要',
            description: '读取单个报表/数据文件的元数据、工作表和样本行。',
            inputSchema: {
                type: 'object',
                properties: {
                    path: { type: 'string' },
                    sheet: { type: 'string' },
                    sampleRows: { type: 'number', minimum: 1, maximum: 200 }
                },
                required: ['path']
            }
        },
        {
            name: 'reports.query_table',
            title: '查询表格数据',
            description: '按列筛选并限制行数，查询 CSV/XLS/XLSX 表格。',
            inputSchema: {
                type: 'object',
                properties: {
                    path: { type: 'string' },
                    sheet: { type: 'string' },
                    columns: { type: 'array', items: { type: 'string' } },
                    filters: { type: 'object' },
                    limit: { type: 'number', minimum: 1, maximum: 1000 }
                },
                required: ['path']
            }
        },
        {
            name: 'reports.compare_files',
            title: '对比数据文件',
            description: '对比两个报表/数据文件的工作表、表头和样本行。',
            inputSchema: {
                type: 'object',
                properties: {
                    leftPath: { type: 'string' },
                    rightPath: { type: 'string' },
                    sheet: { type: 'string' },
                    sampleRows: { type: 'number', minimum: 1, maximum: 100 }
                },
                required: ['leftPath', 'rightPath']
            }
        }
    ];
}

async function resolveReportFile(config, fileRef) {
    const raw = String(fileRef || '').trim();
    if (!raw) {
        const err = new Error('报表文件路径为必填项。');
        err.status = 400;
        throw err;
    }
    const tokenMatch = raw.match(/^(\d+):(.*)$/);
    const candidates = tokenMatch
        ? [{ root: config.roots[Number(tokenMatch[1])], relative: tokenMatch[2] }]
        : config.roots.map(root => ({ root, relative: raw }));

    for (const item of candidates) {
        if (!item.root) continue;
        const configuredRoot = path.resolve(item.root);
        let root;
        try {
            root = await fs.promises.realpath(configuredRoot);
        } catch (e) {
            continue;
        }
        const target = path.resolve(root, String(item.relative || '').replace(/^[/\\]+/, ''));
        if (!isPathInside(root, target)) continue;
        let stat;
        try {
            const linkStat = await fs.promises.lstat(target);
            if (linkStat.isSymbolicLink?.()) continue;
            stat = await fs.promises.stat(target);
        } catch (e) {
            continue;
        }
        if (!stat.isFile()) continue;
        let realTarget;
        try { realTarget = await fs.promises.realpath(target); } catch (e) { continue; }
        if (!isPathInside(root, realTarget)) continue;
        const ext = getExtension(target);
        if (!config.extensions.includes(ext)) {
            const err = new Error(`当前报表文件能力不允许读取 .${ext} 文件。`);
            err.status = 400;
            throw err;
        }
        if (stat.size > config.maxFileMb * 1024 * 1024) {
            const err = new Error(`文件大小超出配置的最大限制 ${config.maxFileMb} MB。`);
            err.status = 413;
            throw err;
        }
        return { root, target: realTarget, relative: path.relative(root, realTarget), ext, size: stat.size, updatedAt: stat.mtime.toISOString() };
    }
    const err = new Error('在已配置的报表目录中未找到指定文件。');
    err.status = 404;
    throw err;
}

async function listReportFiles(config, query = '', limit = 50) {
    const needle = String(query || '').trim().toLowerCase();
    const max = Math.min(Math.max(Number(limit) || 50, 1), 200);
    const results = [];
    const queue = [];
    const visitedDirectories = new Set();
    for (const [rootIndex, configuredRoot] of config.roots.entries()) {
        try {
            const root = await fs.promises.realpath(path.resolve(configuredRoot));
            queue.push({ dir: root, root, rootIndex });
        } catch (e) { /* ignore unavailable roots */ }
    }
    const extensionSet = new Set(config.extensions);
    let scanned = 0;
    for (let queueIndex = 0; queueIndex < queue.length && results.length < max && scanned < 5000; queueIndex += 1) {
        const current = queue[queueIndex];
        if (visitedDirectories.has(current.dir)) continue;
        visitedDirectories.add(current.dir);
        scanned += 1;
        let entries = [];
        try {
            entries = await fs.promises.readdir(current.dir, { withFileTypes: true });
        } catch (e) {
            continue;
        }
        for (const entry of entries) {
            if (entry.name.startsWith('.')) continue;
            const absolute = path.resolve(current.dir, entry.name);
            if (!isPathInside(current.root, absolute)) continue;
            let linkStat;
            try { linkStat = await fs.promises.lstat(absolute); } catch (e) { continue; }
            if (linkStat.isSymbolicLink?.()) continue;
            let realAbsolute;
            try { realAbsolute = await fs.promises.realpath(absolute); } catch (e) { continue; }
            if (!isPathInside(current.root, realAbsolute)) continue;
            if (entry.isDirectory()) {
                queue.push({ ...current, dir: realAbsolute });
                continue;
            }
            if (!entry.isFile()) continue;
            const ext = getExtension(realAbsolute);
            if (!extensionSet.has(ext)) continue;
            const relative = path.relative(current.root, realAbsolute);
            if (needle && !relative.toLowerCase().includes(needle)) continue;
            let stat;
            try {
                stat = await fs.promises.stat(realAbsolute);
            } catch (e) {
                continue;
            }
            if (stat.size > config.maxFileMb * 1024 * 1024) continue;
            results.push({
                path: current.rootIndex + ':' + relative,
                name: entry.name,
                relativePath: relative,
                rootIndex: current.rootIndex,
                extension: ext,
                size: stat.size,
                updatedAt: stat.mtime.toISOString()
            });
            if (results.length >= max) break;
        }
    }
    return { files: results, scanned };
}
function normalizeReportHeaders(row = []) {
    const usedHeaders = new Map();
    return row.map((cell, index) => {
        const base = String(cell ?? `column_${index + 1}`).trim() || `column_${index + 1}`;
        const count = (usedHeaders.get(base) || 0) + 1;
        usedHeaders.set(base, count);
        return count === 1 ? base : `${base}_${count}`;
    });
}

function reportRowsToObjects(rows) {
    const headers = normalizeReportHeaders(rows[0] || []);
    const objects = rows.slice(1).map(row => {
        const item = {};
        headers.forEach((header, index) => { item[header] = row[index] ?? ''; });
        return item;
    });
    return { headers, objects };
}

// 增量 CSV 解析器：支持逗号、双引号转义和跨行字段；只保留 header + maxRows 行。
async function readCsvRowsStream(filePath, maxRows) {
    const stream = fs.createReadStream(filePath);
    const decoder = new StringDecoder('utf8');
    const rows = [];
    let row = [];
    let field = '';
    let inQuotes = false;
    let pendingQuote = false;
    let firstCharacter = true;
    let pendingCarriageReturn = false;
    let stopped = false;

    const pushRow = () => {
        // 与 xlsx 的 sheet_to_json(header: 1) 保持一致：忽略文件末尾的空行。
        if (row.length > 1 || row[0] !== '' || field !== '') rows.push([...row, field]);
        row = [];
        field = '';
        return rows.length >= Math.max(1, Number(maxRows) || 1) + 1;
    };
    const consume = text => {
        for (let index = 0; index < text.length; index += 1) {
            let char = text[index];
            if (firstCharacter) {
                firstCharacter = false;
                if (char === '\uFEFF') continue;
            }
            if (pendingQuote) {
                pendingQuote = false;
                if (char === '"') { field += '"'; continue; }
                inQuotes = false;
            }
            if (inQuotes) {
                if (char === '"') {
                    if (text[index + 1] === '"') { field += '"'; index += 1; }
                    else if (index === text.length - 1) pendingQuote = true;
                    else inQuotes = false;
                } else field += char;
                continue;
            }
            if (pendingCarriageReturn) {
                pendingCarriageReturn = false;
                if (char === '\n') continue;
            }
            if (char === '"' && field === '') { inQuotes = true; continue; }
            if (char === ',') { row.push(field); field = ''; continue; }
            if (char === '\n' || char === '\r') {
                if (char === '\r') {
                    if (text[index + 1] === '\n') index += 1;
                    else pendingCarriageReturn = true;
                }
                if (pushRow()) return true;
                continue;
            }
            field += char;
        }
        return false;
    };

    try {
        for await (const chunk of stream) {
            if (consume(decoder.write(chunk))) {
                stopped = true;
                stream.destroy();
                break;
            }
        }
        if (!stopped) {
            const tail = decoder.end();
            if (tail && consume(tail)) stopped = true;
            if (!stopped && (field !== '' || row.length)) pushRow();
        }
    } catch (error) {
        if (!stopped) throw error;
    }
    return rows;
}

async function readWorkbookRows(file, sheetName, maxRows) {
    if (file.ext === 'csv') {
        const rows = await readCsvRowsStream(file.target, maxRows);
        const parsed = reportRowsToObjects(rows);
        const selectedSheet = 'Sheet1';
        const requestedSheet = String(sheetName || '').trim();
        return {
            workbook: { SheetNames: [selectedSheet], Sheets: { [selectedSheet]: {} } },
            selectedSheet,
            headers: parsed.headers,
            rows: parsed.objects,
            warnings: requestedSheet && requestedSheet !== selectedSheet
                ? [`CSV 文件没有工作表 ${requestedSheet}，已使用默认工作表 ${selectedSheet}。`]
                : []
        };
    }
    const xlsx = getXlsx();
    const buffer = await fs.promises.readFile(file.target);
    const workbook = xlsx.read(buffer, { type: 'buffer', cellDates: true, sheetRows: maxRows + 1 });
    const requestedSheet = String(sheetName || '').trim();
    const selectedSheet = requestedSheet && workbook.Sheets[requestedSheet] ? requestedSheet : workbook.SheetNames[0];
    const warnings = requestedSheet && selectedSheet !== requestedSheet
        ? [`工作表 ${requestedSheet} 不存在，已使用第一个工作表 ${selectedSheet || '(空)' }。`]
        : [];
    const sheet = workbook.Sheets[selectedSheet];
    if (!sheet) {
        return { workbook, selectedSheet: '', headers: [], rows: [], warnings: [...warnings, '工作簿没有可读取的工作表。'] };
    }
    const rows = xlsx.utils.sheet_to_json(sheet, { header: 1, defval: '', raw: false });
    const parsed = reportRowsToObjects(rows);
    return { workbook, selectedSheet, headers: parsed.headers, rows: parsed.objects, warnings };
}

async function readTextPreview(file, maxRows) {
    const stream = fs.createReadStream(file.target);
    const decoder = new StringDecoder('utf8');
    const sampleLines = [];
    let lineCount = 0;
    let pending = '';
    let endedWithNewline = false;
    const collect = text => {
        if (text) endedWithNewline = /[\r\n]$/.test(text);
        const lines = `${pending}${text}`.split(/\r?\n/);
        pending = lines.pop() || '';
        lines.forEach(line => {
            lineCount += 1;
            if (sampleLines.length < maxRows) sampleLines.push(line);
        });
    };
    for await (const chunk of stream) collect(decoder.write(chunk));
    collect(decoder.end());
    if (pending || lineCount === 0 || endedWithNewline) {
        lineCount += 1;
        if (sampleLines.length < maxRows) sampleLines.push(pending);
    }
    return {
        lineCount,
        sample: sampleLines.join('\n').slice(0, 12000)
    };
}

function matchesReportFilters(row, filters) {
    return Object.entries(filters).every(([key, value]) => {
        const actual = String(row[key] ?? '').toLowerCase();
        const expected = String(value ?? '').toLowerCase();
        return expected === '' || actual.includes(expected);
    });
}

async function queryReportTable(config, input = {}) {
    const file = await resolveReportFile(config, input.path);
    if (!['csv', 'xls', 'xlsx'].includes(file.ext)) {
        const err = new Error('reports.query_table 仅支持 CSV、XLS、XLSX 格式文件。');
        err.status = 400;
        throw err;
    }
    const limit = Math.min(Math.max(Number(input.limit) || 50, 1), Math.min(config.maxRows, 1000));
    const table = await readWorkbookRows(file, input.sheet, Math.max(limit, config.maxRows));
    const filters = input.filters && typeof input.filters === 'object' ? input.filters : {};
    const wantedColumns = Array.isArray(input.columns) ? input.columns.map(String).filter(Boolean) : [];
    const filteredRows = table.rows.filter(row => matchesReportFilters(row, filters));
    const rows = filteredRows.slice(0, limit).map(row => {
        if (!wantedColumns.length) return row;
        const item = {};
        wantedColumns.forEach(col => { item[col] = row[col] ?? ''; });
        return item;
    });
    return {
        source: buildReportDataSource('服务器报表目录'),
        file: { path: input.path, relativePath: file.relative, extension: file.ext },
        selectedSheet: table.selectedSheet,
        columns: wantedColumns.length ? wantedColumns : table.headers,
        rowCount: rows.length,
        warnings: table.warnings || [],
        provenance: { file: file.relative, sheet: table.selectedSheet || '', generatedAt: new Date().toISOString() },
        rows,
        allRows: filteredRows
    };
}

async function executeReportConfigTool(config, name, input = {}) {
    if (name === 'reports.list_files') {
        return await listReportFiles(config, input.query, input.limit);
    }
    if (name === 'reports.read_file_summary') {
        const file = await resolveReportFile(config, input.path);
        const sampleRows = Math.min(Math.max(Number(input.sampleRows) || 20, 1), Math.min(config.maxRows, 200));
        if (['csv', 'xls', 'xlsx'].includes(file.ext)) {
            const table = await readWorkbookRows(file, input.sheet, sampleRows);
            return {
                source: buildReportDataSource('服务器报表目录'),
                file: { path: input.path, relativePath: file.relative, extension: file.ext, size: file.size, updatedAt: file.updatedAt },
                sheets: table.workbook.SheetNames,
                selectedSheet: table.selectedSheet,
                columns: table.headers,
                warnings: table.warnings || [],
                provenance: { file: file.relative, sheet: table.selectedSheet || '', generatedAt: new Date().toISOString() },
                sampleRows: table.rows.slice(0, sampleRows)
            };
        }
        if (file.ext === 'json') {
            const value = JSON.parse(await fs.promises.readFile(file.target, 'utf8'));
            return {
                source: buildReportDataSource('服务器报表目录'),
                file: { path: input.path, relativePath: file.relative, extension: file.ext, size: file.size, updatedAt: file.updatedAt },
                type: Array.isArray(value) ? 'array' : typeof value,
                keys: value && typeof value === 'object' && !Array.isArray(value) ? Object.keys(value).slice(0, 100) : [],
                warnings: [],
                provenance: { file: file.relative, sheet: '', generatedAt: new Date().toISOString() },
                sample: Array.isArray(value) ? value.slice(0, sampleRows) : value
            };
        }
        const preview = await readTextPreview(file, sampleRows);
        return {
            source: buildReportDataSource('服务器报表目录'),
            file: { path: input.path, relativePath: file.relative, extension: file.ext, size: file.size, updatedAt: file.updatedAt },
            warnings: [],
            provenance: { file: file.relative, sheet: '', generatedAt: new Date().toISOString() },
            ...preview
        };
    }
    if (name === 'reports.query_table') {
        const result = await queryReportTable(config, input);
        delete result.allRows;
        return result;
    }
    if (name === 'reports.compare_files') {
        const [left, right] = await Promise.all([
            executeReportConfigTool(config, 'reports.read_file_summary', {
                path: input.leftPath,
                sheet: input.sheet,
                sampleRows: input.sampleRows || 20
            }),
            executeReportConfigTool(config, 'reports.read_file_summary', {
                path: input.rightPath,
                sheet: input.sheet,
                sampleRows: input.sampleRows || 20
            })
        ]);
        return {
            source: buildReportDataSource('服务器报表目录'),
            left: { source: left.source, file: left.file, sheets: left.sheets || [], columns: left.columns || [], warnings: left.warnings || [], provenance: left.provenance || null },
            right: { source: right.source, file: right.file, sheets: right.sheets || [], columns: right.columns || [], warnings: right.warnings || [], provenance: right.provenance || null },
            commonColumns: (left.columns || []).filter(col => (right.columns || []).includes(col)),
            onlyLeftColumns: (left.columns || []).filter(col => !(right.columns || []).includes(col)),
            onlyRightColumns: (right.columns || []).filter(col => !(left.columns || []).includes(col))
        };
    }
    throw new Error(`不支持的报表工具操作: ${name}`);
}

async function executeReportTool(server, name, input = {}) {
    const { config } = await getRequiredBuiltinConfigAsync(server, 'reports');
    return executeReportConfigTool(config, name, input);
}

module.exports = {
    executeReportConfigTool,
    listReportTools,
    resolveReportFile,
    listReportFiles,
    readWorkbookRows,
    readTextPreview,
    queryReportTable,
    executeReportTool
};
