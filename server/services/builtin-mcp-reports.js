/* 内置 MCP 能力 - 报表与数据文件 Built-in Reports MCP
 *
 * 负责局域网/共享目录下报表与数据文件的列出、摘要读取、抽样查询与对比。
 * 由 builtin-mcp.js 拆分而来，逻辑保持不变。
 */
const fs = require('fs');
const path = require('path');
const XLSX = require('@e965/xlsx');
const {
    getRequiredBuiltinConfig,
    isPathInside,
    getExtension
} = require('./builtin-mcp-common');

function listReportTools() {
    return [
        {
            name: 'reports.list_files',
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
        const err = new Error('Report file path is required.');
        err.status = 400;
        throw err;
    }
    const tokenMatch = raw.match(/^(\d+):(.*)$/);
    const candidates = tokenMatch
        ? [{ root: config.roots[Number(tokenMatch[1])], relative: tokenMatch[2] }]
        : config.roots.map(root => ({ root, relative: raw }));

    for (const item of candidates) {
        if (!item.root) continue;
        const root = path.resolve(item.root);
        const target = path.resolve(root, String(item.relative || '').replace(/^[/\\]+/, ''));
        if (!isPathInside(root, target)) continue;
        let stat;
        try {
            stat = await fs.promises.stat(target);
        } catch (e) {
            continue;
        }
        if (!stat.isFile()) continue;
        const ext = getExtension(target);
        if (!config.extensions.includes(ext)) {
            const err = new Error(`当前报表文件能力不允许读取 .${ext} 文件。`);
            err.status = 400;
            throw err;
        }
        if (stat.size > config.maxFileMb * 1024 * 1024) {
            const err = new Error(`File exceeds configured max size of ${config.maxFileMb} MB.`);
            err.status = 413;
            throw err;
        }
        return { root, target, relative: path.relative(root, target), ext, size: stat.size, updatedAt: stat.mtime.toISOString() };
    }
    const err = new Error('Report file was not found under configured directories.');
    err.status = 404;
    throw err;
}

async function listReportFiles(config, query = '', limit = 50) {
    const needle = String(query || '').trim().toLowerCase();
    const max = Math.min(Math.max(Number(limit) || 50, 1), 200);
    const results = [];
    const queue = config.roots.map((root, rootIndex) => ({ dir: root, root: path.resolve(root), rootIndex }));
    let scanned = 0;
    while (queue.length && results.length < max && scanned < 5000) {
        const current = queue.shift();
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
            if (entry.isDirectory()) {
                queue.push({ ...current, dir: absolute });
                continue;
            }
            if (!entry.isFile()) continue;
            const ext = getExtension(entry.name);
            if (!config.extensions.includes(ext)) continue;
            const relative = path.relative(current.root, absolute);
            if (needle && !relative.toLowerCase().includes(needle)) continue;
            let stat;
            try {
                stat = await fs.promises.stat(absolute);
            } catch (e) {
                continue;
            }
            if (stat.size > config.maxFileMb * 1024 * 1024) continue;
            results.push({
                path: `${current.rootIndex}:${relative}`,
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

async function readWorkbookRows(file, sheetName, maxRows) {
    const buffer = await fs.promises.readFile(file.target);
    const workbook = XLSX.read(buffer, { type: 'buffer', cellDates: true, sheetRows: maxRows + 1 });
    const selectedSheet = sheetName && workbook.Sheets[sheetName] ? sheetName : workbook.SheetNames[0];
    const sheet = workbook.Sheets[selectedSheet];
    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', raw: false });
    const headers = (rows[0] || []).map((cell, index) => String(cell || `column_${index + 1}`).trim() || `column_${index + 1}`);
    const objects = rows.slice(1).map(row => {
        const item = {};
        headers.forEach((header, index) => { item[header] = row[index] ?? ''; });
        return item;
    });
    return { workbook, selectedSheet, headers, rows: objects };
}

async function readTextPreview(file, maxRows) {
    const text = await fs.promises.readFile(file.target, 'utf8');
    const lines = text.split(/\r?\n/);
    return {
        lineCount: lines.length,
        sample: lines.slice(0, maxRows).join('\n').slice(0, 12000)
    };
}

async function queryReportTable(config, input = {}) {
    const file = await resolveReportFile(config, input.path);
    if (!['csv', 'xls', 'xlsx'].includes(file.ext)) {
        const err = new Error('reports.query_table supports CSV/XLS/XLSX files only.');
        err.status = 400;
        throw err;
    }
    const limit = Math.min(Math.max(Number(input.limit) || 50, 1), Math.min(config.maxRows, 1000));
    const table = await readWorkbookRows(file, input.sheet, Math.max(limit, config.maxRows));
    const filters = input.filters && typeof input.filters === 'object' ? input.filters : {};
    const wantedColumns = Array.isArray(input.columns) ? input.columns.map(String).filter(Boolean) : [];
    const rows = table.rows.filter(row => Object.entries(filters).every(([key, value]) => {
        const actual = String(row[key] ?? '').toLowerCase();
        const expected = String(value ?? '').toLowerCase();
        return expected === '' || actual.includes(expected);
    })).slice(0, limit).map(row => {
        if (!wantedColumns.length) return row;
        const item = {};
        wantedColumns.forEach(col => { item[col] = row[col] ?? ''; });
        return item;
    });
    return {
        file: { path: input.path, relativePath: file.relative, extension: file.ext },
        selectedSheet: table.selectedSheet,
        columns: wantedColumns.length ? wantedColumns : table.headers,
        rowCount: rows.length,
        rows,
        allRows: table.rows.filter(row => Object.entries(filters).every(([key, value]) => {
            const actual = String(row[key] ?? '').toLowerCase();
            const expected = String(value ?? '').toLowerCase();
            return expected === '' || actual.includes(expected);
        }))
    };
}

async function executeReportTool(server, name, input = {}) {
    const { config } = getRequiredBuiltinConfig(server, 'reports');
    if (name === 'reports.list_files') {
        return await listReportFiles(config, input.query, input.limit);
    }
    if (name === 'reports.read_file_summary') {
        const file = await resolveReportFile(config, input.path);
        const sampleRows = Math.min(Math.max(Number(input.sampleRows) || 20, 1), Math.min(config.maxRows, 200));
        if (['csv', 'xls', 'xlsx'].includes(file.ext)) {
            const table = await readWorkbookRows(file, input.sheet, sampleRows);
            return {
                file: { path: input.path, relativePath: file.relative, extension: file.ext, size: file.size, updatedAt: file.updatedAt },
                sheets: table.workbook.SheetNames,
                selectedSheet: table.selectedSheet,
                columns: table.headers,
                sampleRows: table.rows.slice(0, sampleRows)
            };
        }
        if (file.ext === 'json') {
            const value = JSON.parse(await fs.promises.readFile(file.target, 'utf8'));
            return {
                file: { path: input.path, relativePath: file.relative, extension: file.ext, size: file.size, updatedAt: file.updatedAt },
                type: Array.isArray(value) ? 'array' : typeof value,
                keys: value && typeof value === 'object' && !Array.isArray(value) ? Object.keys(value).slice(0, 100) : [],
                sample: Array.isArray(value) ? value.slice(0, sampleRows) : value
            };
        }
        const preview = await readTextPreview(file, sampleRows);
        return {
            file: { path: input.path, relativePath: file.relative, extension: file.ext, size: file.size, updatedAt: file.updatedAt },
            ...preview
        };
    }
    if (name === 'reports.query_table') {
        const result = await queryReportTable(config, input);
        delete result.allRows;
        return result;
    }
    if (name === 'reports.compare_files') {
        const left = await executeReportTool(server, 'reports.read_file_summary', {
            path: input.leftPath,
            sheet: input.sheet,
            sampleRows: input.sampleRows || 20
        });
        const right = await executeReportTool(server, 'reports.read_file_summary', {
            path: input.rightPath,
            sheet: input.sheet,
            sampleRows: input.sampleRows || 20
        });
        return {
            left: { file: left.file, sheets: left.sheets || [], columns: left.columns || [] },
            right: { file: right.file, sheets: right.sheets || [], columns: right.columns || [] },
            commonColumns: (left.columns || []).filter(col => (right.columns || []).includes(col)),
            onlyLeftColumns: (left.columns || []).filter(col => !(right.columns || []).includes(col)),
            onlyRightColumns: (right.columns || []).filter(col => !(left.columns || []).includes(col))
        };
    }
    throw new Error(`Unsupported reports MCP tool: ${name}`);
}

module.exports = {
    listReportTools,
    resolveReportFile,
    listReportFiles,
    readWorkbookRows,
    readTextPreview,
    queryReportTable,
    executeReportTool
};
