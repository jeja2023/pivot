const fs = require('fs');
const path = require('path');
const axios = require('axios');
const XLSX = require('xlsx');
const { db } = require('../db');
const { decryptSecret, validateMcpEndpointUrl } = require('../security');

const BUILTIN_MCP_PREFIXES = {
    reports: 'pivot-reports://',
    visualization: 'pivot-visualization://',
    report: 'pivot-report://',
    im: 'pivot-im://'
};
const SUPPORTED_REPORT_EXTENSIONS = new Set(['csv', 'xlsx', 'xls', 'json', 'txt', 'md']);
const DEFAULT_REPORT_EXTENSIONS = ['csv', 'xlsx', 'xls', 'json', 'txt', 'md'];
const DEFAULT_MAX_FILE_MB = 20;
const DEFAULT_MAX_ROWS = 500;
const DEFAULT_MAX_MESSAGE_LENGTH = 2000;
const IM_TIMEOUT_MS = 15000;

function parseJson(value, fallback = {}) {
    try {
        return value ? JSON.parse(value) : fallback;
    } catch (e) {
        return fallback;
    }
}

function splitList(value) {
    if (Array.isArray(value)) return value.map(item => String(item || '').trim()).filter(Boolean);
    return String(value || '')
        .split(/[\n,;]+/)
        .map(item => item.trim())
        .filter(Boolean);
}

function normalizeReportConfig(input = {}) {
    const roots = splitList(input.roots || input.root_paths || input.rootPaths)
        .map(root => path.resolve(String(root)))
        .filter(Boolean);
    const extensions = splitList(input.extensions)
        .map(ext => ext.replace(/^\./, '').toLowerCase())
        .filter(ext => SUPPORTED_REPORT_EXTENSIONS.has(ext));
    return {
        roots,
        extensions: extensions.length ? Array.from(new Set(extensions)) : DEFAULT_REPORT_EXTENSIONS,
        maxFileMb: Math.min(Math.max(Number(input.maxFileMb || input.max_file_mb || DEFAULT_MAX_FILE_MB), 1), 200),
        maxRows: Math.min(Math.max(Number(input.maxRows || input.max_rows || DEFAULT_MAX_ROWS), 1), 5000)
    };
}

function normalizeImConfig(input = {}) {
    const endpointUrl = String(input.endpointUrl || input.endpoint_url || '').trim();
    if (endpointUrl) validateMcpEndpointUrl(endpointUrl);
    const method = String(input.method || 'POST').toUpperCase() === 'PUT' ? 'PUT' : 'POST';
    return {
        endpointUrl,
        method,
        authHeader: String(input.authHeader || input.auth_header || 'Authorization').trim() || 'Authorization',
        allowedTargets: Array.from(new Set(splitList(input.allowedTargets || input.allowed_targets))),
        defaultTarget: String(input.defaultTarget || input.default_target || '').trim(),
        allowAtAll: Boolean(input.allowAtAll || input.allow_at_all),
        maxMessageLength: Math.min(Math.max(Number(input.maxMessageLength || input.max_message_length || DEFAULT_MAX_MESSAGE_LENGTH), 100), 10000)
    };
}

function normalizeBuiltinPayload(serviceType, payload = {}) {
    const type = normalizeServiceType(serviceType || payload.service_type || payload.serviceType);
    if (type === 'reports') {
        const config = normalizeReportConfig(payload.config || payload);
        if (config.roots.length === 0) {
            const err = new Error('Please configure at least one report/data file directory.');
            err.status = 400;
            throw err;
        }
        return { serviceType: type, config, secret: '' };
    }
    if (type === 'visualization') {
        return { serviceType: type, config: {}, secret: '' };
    }
    if (type === 'report') {
        return { serviceType: type, config: {}, secret: '' };
    }
    if (type === 'im') {
        const config = normalizeImConfig(payload.config || payload);
        if (!config.endpointUrl) {
            const err = new Error('Please configure the LAN IM webhook/API endpoint.');
            err.status = 400;
            throw err;
        }
        return {
            serviceType: type,
            config,
            secret: String(payload.secret ?? payload.token ?? payload.api_token ?? '').trim()
        };
    }
    const err = new Error('Unsupported built-in MCP service type.');
    err.status = 400;
    throw err;
}

function normalizeServiceType(value) {
    const type = String(value || '').trim().toLowerCase();
    if (['reports', 'files', 'data_files'].includes(type)) return 'reports';
    if (['visualization', 'visualisation', 'viz', 'chart', 'charts'].includes(type)) return 'visualization';
    if (['report', 'reporting', 'composer', 'report_composer'].includes(type)) return 'report';
    if (['im', 'message', 'messages', 'notification', 'notifications'].includes(type)) return 'im';
    return '';
}

function getBuiltinServiceTypeFromUrl(baseUrl = '') {
    const url = String(baseUrl || '');
    if (url.startsWith(BUILTIN_MCP_PREFIXES.reports)) return 'reports';
    if (url.startsWith(BUILTIN_MCP_PREFIXES.visualization)) return 'visualization';
    if (url.startsWith(BUILTIN_MCP_PREFIXES.report)) return 'report';
    if (url.startsWith(BUILTIN_MCP_PREFIXES.im)) return 'im';
    return '';
}

function isInternalMcpUrl(baseUrl = '') {
    const url = String(baseUrl || '');
    return url.startsWith('pivot-db://') ||
        url.startsWith(BUILTIN_MCP_PREFIXES.reports) ||
        url.startsWith(BUILTIN_MCP_PREFIXES.visualization) ||
        url.startsWith(BUILTIN_MCP_PREFIXES.report) ||
        url.startsWith(BUILTIN_MCP_PREFIXES.im);
}

function getBuiltinConfigRow(serverId) {
    return db.prepare(`
        SELECT * FROM mcp_builtin_configs
        WHERE mcp_server_id = ? AND status != 'deleted'
    `).get(serverId) || null;
}

function getBuiltinConfigForServer(serverId, { includeSecret = false } = {}) {
    const row = getBuiltinConfigRow(serverId);
    if (!row) return null;
    const serviceType = normalizeServiceType(row.service_type);
    const rawConfig = parseJson(row.config);
    const config = serviceType === 'reports'
        ? normalizeReportConfig(rawConfig)
        : serviceType === 'im'
            ? normalizeImConfig(rawConfig)
            : {};
    return {
        id: row.id,
        mcp_server_id: row.mcp_server_id,
        service_type: serviceType,
        config,
        has_secret: Boolean(row.secret),
        secret: includeSecret && row.secret ? decryptSecret(row.secret) : undefined,
        status: row.status || 'active',
        updated_at: row.updated_at || ''
    };
}

function listBuiltinMcpTools(server) {
    const type = getBuiltinServiceTypeFromUrl(server.base_url);
    if (type === 'reports') return listReportTools();
    if (type === 'visualization') return listVisualizationTools();
    if (type === 'report') return listReportComposerTools();
    if (type === 'im') return listImTools();
    throw new Error('Unsupported built-in MCP server.');
}

async function executeBuiltinMcpTool(server, name, input = {}) {
    const type = getBuiltinServiceTypeFromUrl(server.base_url);
    if (type === 'reports') return executeReportTool(server, name, input);
    if (type === 'visualization') return executeVisualizationTool(server, name, input);
    if (type === 'report') return executeReportComposerTool(server, name, input);
    if (type === 'im') return executeImTool(server, name, input);
    throw new Error('Unsupported built-in MCP server.');
}

function listReportTools() {
    return [
        {
            name: 'reports.list_files',
            description: 'List report/data files under configured LAN directories.',
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
            description: 'Read metadata, sheets and a bounded sample from one report/data file.',
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
            description: 'Query a CSV/XLS/XLSX table with simple column filters and row limits.',
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
            description: 'Compare two report/data files by sheet names, headers and sampled rows.',
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

function listVisualizationTools() {
    return [
        {
            name: 'viz.build_chart',
            description: 'Build a pivot_chart visualization from provided tabular rows. This tool does not read databases or files; pass rows from another MCP step.',
            inputSchema: {
                type: 'object',
                properties: {
                    rows: { type: 'array', items: { type: 'object' } },
                    chartType: { type: 'string', enum: ['bar', 'line', 'area', 'pie'] },
                    title: { type: 'string' },
                    xAxis: { type: 'string' },
                    yAxis: { type: 'string' },
                    groupBy: { type: 'string' },
                    aggregation: { type: 'string', enum: ['sum', 'count', 'avg', 'min', 'max'] },
                    sortBy: { type: 'string', enum: ['label', 'value'] },
                    sortOrder: { type: 'string', enum: ['asc', 'desc'] },
                    limit: { type: 'number', minimum: 1, maximum: 1000 }
                },
                required: ['rows', 'xAxis']
            }
        },
        {
            name: 'viz.build_table',
            description: 'Build a markdown-ready table block from provided rows and optional columns. This tool does not read databases or files.',
            inputSchema: {
                type: 'object',
                properties: {
                    rows: { type: 'array', items: { type: 'object' } },
                    columns: { type: 'array', items: { type: 'string' } },
                    title: { type: 'string' },
                    limit: { type: 'number', minimum: 1, maximum: 1000 }
                },
                required: ['rows']
            }
        }
    ];
}

function listReportComposerTools() {
    return [
        {
            name: 'report.compose',
            description: 'Compose a fixed-format report from independent summary, table, chart, metric and markdown sections. This tool does not fetch data or build charts.',
            inputSchema: {
                type: 'object',
                properties: {
                    title: { type: 'string' },
                    subtitle: { type: 'string' },
                    sections: { type: 'array', items: { type: 'object' } },
                    footer: { type: 'string' }
                },
                required: ['title', 'sections']
            }
        },
        {
            name: 'report.validate_template',
            description: 'Validate a fixed report section template before running a multi-step workflow.',
            inputSchema: {
                type: 'object',
                properties: {
                    sections: { type: 'array', items: { type: 'object' } }
                },
                required: ['sections']
            }
        }
    ];
}

function listImTools() {
    return [
        {
            name: 'im.list_allowed_targets',
            description: 'List configured LAN IM targets the model is allowed to notify.',
            inputSchema: { type: 'object', properties: {} }
        },
        {
            name: 'im.send_user_message',
            description: 'Send a plain text message to one allowed LAN IM user.',
            inputSchema: {
                type: 'object',
                properties: {
                    target: { type: 'string' },
                    title: { type: 'string' },
                    message: { type: 'string' }
                },
                required: ['target', 'message']
            }
        },
        {
            name: 'im.send_group_message',
            description: 'Send a plain text message to one allowed LAN IM group.',
            inputSchema: {
                type: 'object',
                properties: {
                    target: { type: 'string' },
                    title: { type: 'string' },
                    message: { type: 'string' }
                },
                required: ['target', 'message']
            }
        },
        {
            name: 'im.send_markdown',
            description: 'Send a markdown-formatted message to one allowed LAN IM target.',
            inputSchema: {
                type: 'object',
                properties: {
                    target: { type: 'string' },
                    targetType: { type: 'string', enum: ['user', 'group'] },
                    title: { type: 'string' },
                    markdown: { type: 'string' }
                },
                required: ['target', 'markdown']
            }
        }
    ];
}

function getRequiredBuiltinConfig(server, expectedType) {
    const row = getBuiltinConfigForServer(server.id, { includeSecret: expectedType === 'im' });
    if (!row || row.service_type !== expectedType) {
        const err = new Error('Built-in MCP configuration is missing or mismatched.');
        err.status = 404;
        throw err;
    }
    return row;
}

function isPathInside(parent, target) {
    const relative = path.relative(parent, target);
    return relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

function getExtension(filePath) {
    return path.extname(filePath).replace(/^\./, '').toLowerCase();
}

function resolveReportFile(config, fileRef) {
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
        if (!fs.existsSync(target) || !fs.statSync(target).isFile()) continue;
        const ext = getExtension(target);
        if (!config.extensions.includes(ext)) {
            const err = new Error(`File extension .${ext} is not allowed for this report MCP service.`);
            err.status = 400;
            throw err;
        }
        const stat = fs.statSync(target);
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

function listReportFiles(config, query = '', limit = 50) {
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
            entries = fs.readdirSync(current.dir, { withFileTypes: true });
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
            const stat = fs.statSync(absolute);
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

function readWorkbookRows(file, sheetName, maxRows) {
    const workbook = XLSX.readFile(file.target, { cellDates: true, sheetRows: maxRows + 1 });
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

function readTextPreview(file, maxRows) {
    const text = fs.readFileSync(file.target, 'utf8');
    const lines = text.split(/\r?\n/);
    return {
        lineCount: lines.length,
        sample: lines.slice(0, maxRows).join('\n').slice(0, 12000)
    };
}

function queryReportTable(config, input = {}) {
    const file = resolveReportFile(config, input.path);
    if (!['csv', 'xls', 'xlsx'].includes(file.ext)) {
        const err = new Error('reports.query_table supports CSV/XLS/XLSX files only.');
        err.status = 400;
        throw err;
    }
    const limit = Math.min(Math.max(Number(input.limit) || 50, 1), Math.min(config.maxRows, 1000));
    const table = readWorkbookRows(file, input.sheet, Math.max(limit, config.maxRows));
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

function toFiniteNumber(value) {
    if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
    const text = String(value ?? '').replace(/,/g, '').trim();
    const percentFactor = text.endsWith('%') ? 0.01 : 1;
    const normalized = text
        .replace(/%$/, '')
        .replace(/[¥￥$€£]/g, '')
        .replace(/^\((.*)\)$/, '-$1');
    const parsed = Number(normalized);
    if (Number.isFinite(parsed)) return parsed * percentFactor;
    const fallback = normalized.match(/-?\d+(?:\.\d+)?/);
    const fallbackValue = fallback ? Number(fallback[0]) : NaN;
    if (Number.isFinite(fallbackValue)) return fallbackValue * percentFactor;
    return Number.isFinite(parsed) ? parsed : 0;
}

function aggregateValues(values, aggregation) {
    const nums = values.map(toFiniteNumber);
    if (aggregation === 'count') return values.length;
    if (aggregation === 'avg') return nums.length ? nums.reduce((sum, value) => sum + value, 0) / nums.length : 0;
    if (aggregation === 'min') return nums.length ? Math.min(...nums) : 0;
    if (aggregation === 'max') return nums.length ? Math.max(...nums) : 0;
    return nums.reduce((sum, value) => sum + value, 0);
}

function normalizeChartType(value) {
    const type = String(value || '').toLowerCase();
    return ['bar', 'line', 'area', 'pie'].includes(type) ? type : 'bar';
}

function normalizeSortOption(value, fallback) {
    const option = String(value || '').toLowerCase();
    return ['label', 'value'].includes(option) ? option : fallback;
}

function normalizeSortOrder(value, fallback = 'desc') {
    const order = String(value || '').toLowerCase();
    return ['asc', 'desc'].includes(order) ? order : fallback;
}

function buildChartSpec(queryResult, input = {}) {
    const sourceRows = Array.isArray(queryResult?.allRows)
        ? queryResult.allRows
        : Array.isArray(queryResult?.rows) ? queryResult.rows : [];
    const xField = String(input.xAxis || input.x_axis || '').trim();
    const yField = String(input.yAxis || input.y_axis || '').trim();
    const groupField = String(input.groupBy || input.group_by || '').trim();
    const chartType = normalizeChartType(input.chartType);
    const aggregation = ['sum', 'count', 'avg', 'min', 'max'].includes(input.aggregation) ? input.aggregation : (yField ? 'sum' : 'count');
    const sortBy = normalizeSortOption(input.sortBy || input.sort_by, chartType === 'line' || chartType === 'area' ? 'label' : 'value');
    const sortOrder = normalizeSortOrder(input.sortOrder || input.sort_order, sortBy === 'label' ? 'asc' : 'desc');
    if (!xField) {
        const err = new Error('xAxis is required for viz.build_chart.');
        err.status = 400;
        throw err;
    }
    if (aggregation !== 'count' && !yField) {
        const err = new Error('yAxis is required unless aggregation is count.');
        err.status = 400;
        throw err;
    }
    const bucketMap = new Map();
    sourceRows.forEach(row => {
        const label = String(row[xField] ?? '').trim() || '(empty)';
        const group = groupField ? (String(row[groupField] ?? '').trim() || '(empty)') : 'value';
        const key = `${label}\u0000${group}`;
        if (!bucketMap.has(key)) bucketMap.set(key, { label, group, values: [] });
        bucketMap.get(key).values.push(aggregation === 'count' ? 1 : row[yField]);
    });
    const labels = Array.from(new Set(Array.from(bucketMap.values()).map(item => item.label)));
    const groups = Array.from(new Set(Array.from(bucketMap.values()).map(item => item.group))).slice(0, 20);
    const series = groups.map(group => ({
        name: groupField ? group : (aggregation === 'count' ? '数量' : yField),
        data: labels.map(label => {
            const item = bucketMap.get(`${label}\u0000${group}`);
            return item ? Number(aggregateValues(item.values, aggregation).toFixed(4)) : 0;
        })
    }));
    const topLimit = Math.min(Math.max(Number(input.limit) || labels.length || 20, 1), 80);
    const labelIndexes = labels.map((label, index) => {
        const total = series.reduce((sum, item) => sum + (Number(item.data[index]) || 0), 0);
        return { label, index, total };
    }).sort((a, b) => {
        const result = sortBy === 'label'
            ? String(a.label).localeCompare(String(b.label), 'zh-Hans-CN', { numeric: true })
            : a.total - b.total;
        return sortOrder === 'asc' ? result : -result;
    }).slice(0, topLimit);
    const trimmedLabels = labelIndexes.map(item => item.label);
    const trimmedSeries = series.map(item => ({
        ...item,
        data: labelIndexes.map(labelItem => item.data[labelItem.index])
    }));
    return {
        type: 'pivot_chart',
        version: 1,
        chartType,
        title: String(input.title || `${xField} ${aggregation === 'count' ? '数量' : yField}`).slice(0, 120),
        xAxis: { field: xField, label: xField },
        yAxis: { field: yField || '__count__', label: aggregation === 'count' ? '数量' : yField, aggregation },
        groupBy: groupField ? { field: groupField, label: groupField } : null,
        labels: trimmedLabels,
        series: trimmedSeries,
        sort: { by: sortBy, order: sortOrder },
        source: {
            file: queryResult.file || null,
            sheet: queryResult.selectedSheet || '',
            rows: sourceRows.length
        }
    };
}

function normalizeInputRows(rows, maxRows = 1000) {
    if (!Array.isArray(rows)) {
        const err = new Error('rows must be an array of objects.');
        err.status = 400;
        throw err;
    }
    return rows.slice(0, Math.min(Math.max(Number(maxRows) || 1000, 1), 5000)).map(row => {
        if (!row || typeof row !== 'object' || Array.isArray(row)) return { value: row };
        return row;
    });
}

function escapeMarkdownCell(value) {
    return String(value ?? '')
        .replace(/\|/g, '\\|')
        .replace(/\r?\n/g, ' ')
        .trim();
}

function buildTableBlock(input = {}) {
    const limit = Math.min(Math.max(Number(input.limit) || 50, 1), 1000);
    const rows = normalizeInputRows(input.rows, limit).slice(0, limit);
    const inferredColumns = rows.reduce((cols, row) => {
        Object.keys(row || {}).forEach(key => {
            if (!cols.includes(key)) cols.push(key);
        });
        return cols;
    }, []);
    const columns = (Array.isArray(input.columns) && input.columns.length ? input.columns : inferredColumns)
        .map(String)
        .filter(Boolean)
        .slice(0, 40);
    const markdown = columns.length
        ? [
            `| ${columns.map(escapeMarkdownCell).join(' | ')} |`,
            `| ${columns.map(() => '---').join(' | ')} |`,
            ...rows.map(row => `| ${columns.map(col => escapeMarkdownCell(row[col])).join(' | ')} |`)
        ].join('\n')
        : '';
    return {
        type: 'pivot_table',
        title: String(input.title || '数据表').slice(0, 120),
        columns,
        rows,
        markdown,
        rowCount: rows.length
    };
}

async function executeVisualizationTool(_server, name, input = {}) {
    if (name === 'viz.build_chart') {
        const rows = normalizeInputRows(input.rows, input.limit || 1000);
        return buildChartSpec({ rows }, input);
    }
    if (name === 'viz.build_table') {
        return buildTableBlock(input);
    }
    throw new Error(`Unsupported visualization MCP tool: ${name}`);
}

function chartBlockMarkdown(chart) {
    return [
        '```pivot-chart',
        JSON.stringify(chart, null, 2),
        '```'
    ].join('\n');
}

function composeReportSection(section = {}, index = 0) {
    const title = String(section.title || `第 ${index + 1} 部分`).trim();
    const type = String(section.type || 'markdown').toLowerCase();
    const lines = [];
    if (title) lines.push(`## ${title}`);
    if (type === 'chart') {
        const chart = section.chart || section.chartSpec || section.content;
        if (chart?.type === 'pivot_chart') lines.push(chartBlockMarkdown(chart));
        else lines.push(String(section.markdown || section.text || ''));
    } else if (type === 'table') {
        const table = section.table || section.content;
        if (table?.markdown) lines.push(table.markdown);
        else if (Array.isArray(section.rows)) lines.push(buildTableBlock(section).markdown);
        else lines.push(String(section.markdown || section.text || ''));
    } else if (type === 'metrics') {
        const metrics = Array.isArray(section.metrics) ? section.metrics : [];
        lines.push(metrics.map(item => `- **${escapeMarkdownCell(item.label || item.name)}**：${escapeMarkdownCell(item.value)}`).join('\n'));
    } else {
        lines.push(String(section.markdown || section.text || section.content || ''));
    }
    return lines.filter(Boolean).join('\n\n');
}

function validateReportSections(sections) {
    if (!Array.isArray(sections) || sections.length === 0) {
        const err = new Error('sections must be a non-empty array.');
        err.status = 400;
        throw err;
    }
    const allowed = new Set(['summary', 'markdown', 'table', 'chart', 'metrics']);
    const issues = [];
    sections.forEach((section, index) => {
        const type = String(section?.type || 'markdown').toLowerCase();
        if (!allowed.has(type)) issues.push(`Section ${index + 1}: unsupported type ${type}`);
        if (type === 'chart' && !(section.chart || section.chartSpec || section.content)) issues.push(`Section ${index + 1}: chart section requires chart/chartSpec/content.`);
        if (type === 'table' && !(section.table || section.rows || section.markdown || section.text)) issues.push(`Section ${index + 1}: table section requires table/rows/markdown.`);
    });
    return { ok: issues.length === 0, issues };
}

async function executeReportComposerTool(_server, name, input = {}) {
    if (name === 'report.validate_template') {
        return validateReportSections(input.sections);
    }
    if (name === 'report.compose') {
        const title = String(input.title || '').trim();
        if (!title) {
            const err = new Error('Report title is required.');
            err.status = 400;
            throw err;
        }
        const validation = validateReportSections(input.sections);
        if (!validation.ok) {
            const err = new Error(`Invalid report template: ${validation.issues.join('; ')}`);
            err.status = 400;
            throw err;
        }
        const header = [`# ${title}`];
        if (input.subtitle) header.push(String(input.subtitle));
        const sectionMarkdown = input.sections.map(composeReportSection).filter(Boolean);
        const footer = input.footer ? [`---`, String(input.footer)] : [];
        const markdown = [...header, ...sectionMarkdown, ...footer].join('\n\n');
        return {
            type: 'pivot_report',
            title,
            sectionCount: input.sections.length,
            markdown
        };
    }
    throw new Error(`Unsupported report MCP tool: ${name}`);
}

async function executeReportTool(server, name, input = {}) {
    const { config } = getRequiredBuiltinConfig(server, 'reports');
    if (name === 'reports.list_files') {
        return listReportFiles(config, input.query, input.limit);
    }
    if (name === 'reports.read_file_summary') {
        const file = resolveReportFile(config, input.path);
        const sampleRows = Math.min(Math.max(Number(input.sampleRows) || 20, 1), Math.min(config.maxRows, 200));
        if (['csv', 'xls', 'xlsx'].includes(file.ext)) {
            const table = readWorkbookRows(file, input.sheet, sampleRows);
            return {
                file: { path: input.path, relativePath: file.relative, extension: file.ext, size: file.size, updatedAt: file.updatedAt },
                sheets: table.workbook.SheetNames,
                selectedSheet: table.selectedSheet,
                columns: table.headers,
                sampleRows: table.rows.slice(0, sampleRows)
            };
        }
        if (file.ext === 'json') {
            const value = JSON.parse(fs.readFileSync(file.target, 'utf8'));
            return {
                file: { path: input.path, relativePath: file.relative, extension: file.ext, size: file.size, updatedAt: file.updatedAt },
                type: Array.isArray(value) ? 'array' : typeof value,
                keys: value && typeof value === 'object' && !Array.isArray(value) ? Object.keys(value).slice(0, 100) : [],
                sample: Array.isArray(value) ? value.slice(0, sampleRows) : value
            };
        }
        const preview = readTextPreview(file, sampleRows);
        return {
            file: { path: input.path, relativePath: file.relative, extension: file.ext, size: file.size, updatedAt: file.updatedAt },
            ...preview
        };
    }
    if (name === 'reports.query_table') {
        const result = queryReportTable(config, input);
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

function validateImTarget(config, target, targetType) {
    const value = String(target || config.defaultTarget || '').trim();
    if (!value) {
        const err = new Error('IM target is required.');
        err.status = 400;
        throw err;
    }
    const lower = value.toLowerCase();
    if (!config.allowAtAll && ['*', 'all', '@all', 'everyone', '所有人', '全员'].includes(lower)) {
        const err = new Error('Broadcast/all-member notifications are disabled for this IM MCP service.');
        err.status = 403;
        throw err;
    }
    if (config.allowedTargets.length) {
        const allowed = new Set(config.allowedTargets.map(item => item.toLowerCase()));
        if (!allowed.has(lower) && !allowed.has(`${targetType}:${lower}`)) {
            const err = new Error('IM target is not in the allowed target list.');
            err.status = 403;
            throw err;
        }
    }
    return value;
}

async function sendIm(config, secret, payload) {
    const headers = {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'User-Agent': 'Pivot-IM-MCP/1.0'
    };
    if (secret && config.authHeader) headers[config.authHeader] = secret;
    const response = await axios({
        url: config.endpointUrl,
        method: config.method,
        headers,
        data: payload,
        timeout: IM_TIMEOUT_MS,
        proxy: false,
        validateStatus: status => status >= 200 && status < 300
    });
    return {
        ok: true,
        status: response.status,
        response: typeof response.data === 'object' ? response.data : String(response.data || '').slice(0, 2000)
    };
}

async function executeImTool(server, name, input = {}) {
    const { config, secret } = getRequiredBuiltinConfig(server, 'im');
    if (name === 'im.list_allowed_targets') {
        return {
            allowedTargets: config.allowedTargets,
            defaultTarget: config.defaultTarget,
            allowAtAll: config.allowAtAll,
            endpointHost: new URL(config.endpointUrl).host
        };
    }
    const targetType = name === 'im.send_user_message'
        ? 'user'
        : name === 'im.send_group_message'
            ? 'group'
            : String(input.targetType || 'group').toLowerCase() === 'user' ? 'user' : 'group';
    const target = validateImTarget(config, input.target, targetType);
    const rawMessage = name === 'im.send_markdown' ? input.markdown : input.message;
    const message = String(rawMessage || '').slice(0, config.maxMessageLength);
    if (!message.trim()) {
        const err = new Error('IM message content is required.');
        err.status = 400;
        throw err;
    }
    if (!['im.send_user_message', 'im.send_group_message', 'im.send_markdown'].includes(name)) {
        throw new Error(`Unsupported IM MCP tool: ${name}`);
    }
    return sendIm(config, secret, {
        source: 'pivot-mcp',
        target,
        targetType,
        title: String(input.title || '').slice(0, 120),
        message,
        format: name === 'im.send_markdown' ? 'markdown' : 'text',
        timestamp: new Date().toISOString()
    });
}

module.exports = {
    BUILTIN_MCP_PREFIXES,
    executeBuiltinMcpTool,
    getBuiltinConfigForServer,
    getBuiltinServiceTypeFromUrl,
    isInternalMcpUrl,
    listBuiltinMcpTools,
    normalizeBuiltinPayload
};
