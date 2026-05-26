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
    documents: 'pivot-documents://',
    data: 'pivot-data://',
    format: 'pivot-format://',
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
    if (['visualization', 'report', 'documents', 'data', 'format'].includes(type)) {
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
    const err = new Error('不支持的系统能力类型。');
    err.status = 400;
    throw err;
}

function normalizeServiceType(value) {
    const type = String(value || '').trim().toLowerCase();
    if (['reports', 'files', 'data_files'].includes(type)) return 'reports';
    if (['visualization', 'visualisation', 'viz', 'chart', 'charts', 'echarts'].includes(type)) return 'visualization';
    if (['report', 'reporting', 'composer', 'report_composer'].includes(type)) return 'report';
    if (['documents', 'document', 'doc', 'docs', 'parser', 'document_parser'].includes(type)) return 'documents';
    if (['data', 'processing', 'processor', 'data_processing', 'data_processor'].includes(type)) return 'data';
    if (['format', 'formats', 'conversion', 'converter', 'format_converter'].includes(type)) return 'format';
    if (['im', 'message', 'messages', 'notification', 'notifications'].includes(type)) return 'im';
    return '';
}

function getBuiltinServiceTypeFromUrl(baseUrl = '') {
    const url = String(baseUrl || '');
    if (url.startsWith(BUILTIN_MCP_PREFIXES.reports)) return 'reports';
    if (url.startsWith(BUILTIN_MCP_PREFIXES.visualization)) return 'visualization';
    if (url.startsWith(BUILTIN_MCP_PREFIXES.report)) return 'report';
    if (url.startsWith(BUILTIN_MCP_PREFIXES.documents)) return 'documents';
    if (url.startsWith(BUILTIN_MCP_PREFIXES.data)) return 'data';
    if (url.startsWith(BUILTIN_MCP_PREFIXES.format)) return 'format';
    if (url.startsWith(BUILTIN_MCP_PREFIXES.im)) return 'im';
    return '';
}

function isInternalMcpUrl(baseUrl = '') {
    const url = String(baseUrl || '');
    return url.startsWith('pivot-db://') ||
        url.startsWith(BUILTIN_MCP_PREFIXES.reports) ||
        url.startsWith(BUILTIN_MCP_PREFIXES.visualization) ||
        url.startsWith(BUILTIN_MCP_PREFIXES.report) ||
        url.startsWith(BUILTIN_MCP_PREFIXES.documents) ||
        url.startsWith(BUILTIN_MCP_PREFIXES.data) ||
        url.startsWith(BUILTIN_MCP_PREFIXES.format) ||
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
    if (type === 'documents') return listDocumentTools();
    if (type === 'data') return listDataProcessingTools();
    if (type === 'format') return listFormatConversionTools();
    if (type === 'im') return listImTools();
    throw new Error('Unsupported built-in MCP server.');
}

async function executeBuiltinMcpTool(server, name, input = {}) {
    const type = getBuiltinServiceTypeFromUrl(server.base_url);
    if (type === 'reports') return executeReportTool(server, name, input);
    if (type === 'visualization') return executeVisualizationTool(server, name, input);
    if (type === 'report') return executeReportComposerTool(server, name, input);
    if (type === 'documents') return executeDocumentTool(server, name, input);
    if (type === 'data') return executeDataProcessingTool(server, name, input);
    if (type === 'format') return executeFormatConversionTool(server, name, input);
    if (type === 'im') return executeImTool(server, name, input);
    throw new Error('Unsupported built-in MCP server.');
}

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

function listVisualizationTools() {
    return [
        {
            name: 'viz.build_chart',
            description: '基于传入的表格行生成可直接渲染的图表配置，不直接读取数据库或文件。',
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
            description: '基于传入的表格行生成 Markdown 表格块，不直接读取数据库或文件。',
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
            description: '将摘要、表格、图表、指标和 Markdown 片段组合为固定格式报告。',
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
            description: '在执行多步骤编排前验证报告模板。',
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

function listDocumentTools() {
    return [
        {
            name: 'doc.extract_outline',
            description: 'Extract a lightweight outline from plain text or Markdown content.',
            inputSchema: {
                type: 'object',
                properties: {
                    text: { type: 'string' },
                    maxHeadings: { type: 'number', minimum: 1, maximum: 200 }
                },
                required: ['text']
            }
        },
        {
            name: 'doc.extract_key_values',
            description: 'Extract key/value style lines from document text.',
            inputSchema: {
                type: 'object',
                properties: {
                    text: { type: 'string' },
                    maxItems: { type: 'number', minimum: 1, maximum: 500 }
                },
                required: ['text']
            }
        },
        {
            name: 'doc.chunk_text',
            description: 'Split long text into paragraph-aware chunks for downstream analysis.',
            inputSchema: {
                type: 'object',
                properties: {
                    text: { type: 'string' },
                    maxChars: { type: 'number', minimum: 200, maximum: 8000 }
                },
                required: ['text']
            }
        }
    ];
}

function listDataProcessingTools() {
    return [
        {
            name: 'data.profile_rows',
            description: 'Profile tabular rows, including field names, types, fill rates, and sample values.',
            inputSchema: {
                type: 'object',
                properties: {
                    rows: { type: 'array', items: { type: 'object' } },
                    limit: { type: 'number', minimum: 1, maximum: 5000 }
                },
                required: ['rows']
            }
        },
        {
            name: 'data.filter_rows',
            description: 'Filter rows using exact or contains matching.',
            inputSchema: {
                type: 'object',
                properties: {
                    rows: { type: 'array', items: { type: 'object' } },
                    filters: { type: 'object' },
                    matchMode: { type: 'string', enum: ['contains', 'exact'] },
                    limit: { type: 'number', minimum: 1, maximum: 5000 }
                },
                required: ['rows']
            }
        },
        {
            name: 'data.group_summary',
            description: 'Group rows and calculate count, sum, average, min, or max.',
            inputSchema: {
                type: 'object',
                properties: {
                    rows: { type: 'array', items: { type: 'object' } },
                    groupBy: { type: 'string' },
                    valueField: { type: 'string' },
                    aggregation: { type: 'string', enum: ['count', 'sum', 'avg', 'min', 'max'] },
                    limit: { type: 'number', minimum: 1, maximum: 5000 }
                },
                required: ['rows', 'groupBy']
            }
        },
        {
            name: 'data.normalize_fields',
            description: 'Rename fields and trim string values in tabular rows.',
            inputSchema: {
                type: 'object',
                properties: {
                    rows: { type: 'array', items: { type: 'object' } },
                    renameMap: { type: 'object' },
                    trimStrings: { type: 'boolean' },
                    limit: { type: 'number', minimum: 1, maximum: 5000 }
                },
                required: ['rows']
            }
        }
    ];
}

function listFormatConversionTools() {
    return [
        {
            name: 'format.to_markdown_table',
            description: 'Convert rows into a Markdown table block.',
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
        },
        {
            name: 'format.to_json',
            description: 'Serialize a value as compact or pretty JSON.',
            inputSchema: {
                type: 'object',
                properties: {
                    value: {},
                    pretty: { type: 'boolean' }
                },
                required: ['value']
            }
        },
        {
            name: 'format.extract_json',
            description: 'Extract and parse the first JSON object or array from text.',
            inputSchema: {
                type: 'object',
                properties: {
                    text: { type: 'string' }
                },
                required: ['text']
            }
        },
        {
            name: 'format.normalize_text',
            description: 'Normalize whitespace and optionally convert text case.',
            inputSchema: {
                type: 'object',
                properties: {
                    text: { type: 'string' },
                    mode: { type: 'string', enum: ['plain', 'lower', 'upper'] }
                },
                required: ['text']
            }
        }
    ];
}

function listImTools() {
    return [
        {
            name: 'im.list_allowed_targets',
            description: '列出当前允许通知的 LAN IM 目标。',
            inputSchema: { type: 'object', properties: {} }
        },
        {
            name: 'im.send_user_message',
            description: '向一个允许的 LAN IM 用户发送纯文本消息。',
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
            description: '向一个允许的 LAN IM 群组发送纯文本消息。',
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
            description: '向一个允许的 LAN IM 目标发送 Markdown 消息。',
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
            const err = new Error(`当前报表文件能力不允许读取 .${ext} 文件。`);
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
    const text = String(value ?? '').trim();
    if (!text) return 0;
    const percentLike = /%$/.test(text) || /%\)$/.test(text);
    let normalized = text
        .replace(/,/g, '')
        .replace(/[\u00a5\uffe5\u0024\u20ac\u00a3]/g, '')
        .replace(/\s+/g, '');
    if (/^\((.*)\)$/.test(normalized)) {
        normalized = '-' + RegExp.$1;
    }
    normalized = normalized.replace(/%/g, '');
    const parsed = Number(normalized);
    if (Number.isFinite(parsed)) return parsed * (percentLike ? 0.01 : 1);
    const fallback = normalized.match(/-?\d+(?:\.\d+)?/);
    if (fallback) return Number(fallback[0]) * (percentLike ? 0.01 : 1);
    return 0;
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

function buildChartDefaultTitle({ xField, yField, aggregation, chartType, groupField }) {
    const xLabel = String(xField || 'data').trim();
    const yLabel = String(yField || 'value').trim();
    if (chartType === 'line' || chartType === 'area') {
        return xLabel + (groupField ? '分组' : '') + '趋势';
    }
    if (chartType === 'pie') {
        return xLabel + (groupField ? '分组' : '') + '占比';
    }
    if (aggregation === 'count') {
        return xLabel + (groupField ? '分组' : '') + '统计';
    }
    return xLabel + (groupField ? '分组' : '') + (yLabel ? ' ' + yLabel : '') + '统计';
}

function normalizeSeriesName({ groupField, group, aggregation, yField }) {
    if (groupField) return group;
    return aggregation === 'count' ? '数量' : (yField || '数值');
}

function buildEchartsOption({ chartType, title, labels, series, xAxis, yAxis }) {
    const normalizedType = chartType === 'area' ? 'line' : chartType;
    const commonSeries = series.map(item => ({
        name: item.name,
        type: normalizedType === 'pie' ? 'pie' : normalizedType,
        data: normalizedType === 'pie'
            ? labels.map((label, index) => ({ name: label, value: item.data[index] || 0 }))
            : item.data,
        smooth: normalizedType === 'line',
        areaStyle: chartType === 'area' ? {} : undefined,
        emphasis: { focus: 'series' }
    }));
    if (normalizedType === 'pie') {
        return {
            title: { text: title, left: 18, top: 16, textStyle: { fontSize: 15, fontWeight: 700, color: '#334155' } },
            tooltip: { trigger: 'item' },
            legend: { top: 50, left: 'center', type: 'scroll' },
            series: commonSeries.map(item => ({
                ...item,
                radius: ['35%', '68%'],
                center: ['50%', '58%']
            }))
        };
    }
    return {
        title: { text: title, left: 18, top: 16, textStyle: { fontSize: 15, fontWeight: 700, color: '#334155' } },
        color: ['#10a37f', '#2563eb', '#f59e0b', '#ef4444', '#7c3aed', '#0891b2'],
        tooltip: { trigger: 'axis', confine: true },
        legend: { top: 50, right: 18, type: 'scroll' },
        grid: { left: 68, right: 32, top: 96, bottom: 64, containLabel: true },
        xAxis: {
            type: 'category',
            name: xAxis?.label || '分类',
            nameLocation: 'middle',
            nameGap: 38,
            nameTextStyle: { color: '#64748b', fontWeight: 600 },
            axisLabel: { hideOverlap: true, margin: 12 },
            data: labels
        },
        yAxis: {
            type: 'value',
            name: yAxis?.label || '数值',
            nameLocation: 'middle',
            nameRotate: 90,
            nameGap: 56,
            nameTextStyle: { color: '#64748b', fontWeight: 600 },
            axisLabel: { margin: 10 },
            splitLine: { lineStyle: { color: '#e2e8f0' } }
        },
        series: commonSeries
    };
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
        name: normalizeSeriesName({ groupField, group, aggregation, yField }),
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
    const title = String(input.title || buildChartDefaultTitle({ xField, yField, aggregation, chartType, groupField })).slice(0, 120);
    const xAxis = { field: xField, label: String(input.xAxisLabel || input.x_axis_label || xField || '分类').trim() };
    const yAxis = { field: yField || '__count__', label: String(input.yAxisLabel || input.y_axis_label || (aggregation === 'count' ? '数量' : yField || '数值')).trim(), aggregation };
    const chart = {
        type: 'pivot_chart',
        version: 1,
        renderer: 'echarts',
        chartType,
        title,
        xAxis,
        yAxis,
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
    chart.echartsOption = buildEchartsOption({
        chartType,
        title,
        labels: trimmedLabels,
        series: trimmedSeries,
        xAxis,
        yAxis
    });
    return chart;
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
        '```pivot-echart',
        JSON.stringify(chart, null, 2),
        '```'
    ].join('\n');
}

function composeReportSection(section = {}, index = 0) {
    const title = String(section.title || `第${index + 1}部分`).trim();
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

function textInput(input = {}) {
    return String(input.text || input.content || '').slice(0, 200000);
}

function executeDocumentTool(_server, name, input = {}) {
    const text = textInput(input);
    if (!text.trim()) {
        const err = new Error('Document text is required.');
        err.status = 400;
        throw err;
    }
    if (name === 'doc.extract_outline') {
        const maxHeadings = Math.min(Math.max(Number(input.maxHeadings) || 50, 1), 200);
        const headings = [];
        text.split(/\r?\n/).forEach((line, index) => {
            const trimmed = line.trim();
            const markdown = trimmed.match(/^(#{1,6})\s+(.+)$/);
            const numbered = trimmed.match(/^(\d+(?:\.\d+)*[.)、])\s*(.{2,160})$/);
            if (markdown) {
                headings.push({ level: markdown[1].length, title: markdown[2].trim(), line: index + 1 });
            } else if (numbered) {
                headings.push({ level: Math.min(numbered[1].split('.').length, 6), title: numbered[2].trim(), line: index + 1 });
            }
        });
        return {
            type: 'document_outline',
            headings: headings.slice(0, maxHeadings),
            headingCount: headings.length,
            lineCount: text.split(/\r?\n/).length,
            charCount: text.length
        };
    }
    if (name === 'doc.extract_key_values') {
        const maxItems = Math.min(Math.max(Number(input.maxItems) || 100, 1), 500);
        const items = [];
        text.split(/\r?\n/).forEach((line, index) => {
            const match = line.trim().match(/^([^:：]{1,80})[:：]\s*(.{0,1000})$/);
            if (!match) return;
            items.push({ key: match[1].trim(), value: match[2].trim(), line: index + 1 });
        });
        return {
            type: 'document_key_values',
            items: items.slice(0, maxItems),
            itemCount: items.length
        };
    }
    if (name === 'doc.chunk_text') {
        const maxChars = Math.min(Math.max(Number(input.maxChars) || 1200, 200), 8000);
        const chunks = [];
        let current = '';
        for (const paragraph of text.split(/\n\s*\n/).map(item => item.trim()).filter(Boolean)) {
            if (current && current.length + paragraph.length + 2 > maxChars) {
                chunks.push(current);
                current = '';
            }
            if (paragraph.length > maxChars) {
                for (let i = 0; i < paragraph.length; i += maxChars) chunks.push(paragraph.slice(i, i + maxChars));
            } else {
                current = current ? `${current}\n\n${paragraph}` : paragraph;
            }
        }
        if (current) chunks.push(current);
        return {
            type: 'document_chunks',
            maxChars,
            chunks: chunks.map((chunk, index) => ({ index, text: chunk, charCount: chunk.length })),
            chunkCount: chunks.length
        };
    }
    throw new Error(`Unsupported document MCP tool: ${name}`);
}

function inferValueKind(value) {
    if (value === null || value === undefined || value === '') return 'empty';
    if (typeof value === 'number') return Number.isFinite(value) ? 'number' : 'text';
    if (typeof value === 'boolean') return 'boolean';
    if (value instanceof Date) return 'date';
    const raw = String(value).trim();
    if (!raw) return 'empty';
    if (/^-?\d+(\.\d+)?%?$/.test(raw) || /^\(\d+(\.\d+)?%?\)$/.test(raw)) return 'number';
    if (/^\d{4}[-/]\d{1,2}[-/]\d{1,2}/.test(raw)) return 'date';
    return 'text';
}

function executeDataProcessingTool(_server, name, input = {}) {
    if (name === 'data.profile_rows') {
        const rows = normalizeInputRows(input.rows, input.limit || 1000);
        const fields = rows.reduce((cols, row) => {
            Object.keys(row || {}).forEach(key => {
                if (!cols.includes(key)) cols.push(key);
            });
            return cols;
        }, []);
        const profile = fields.map(field => {
            const values = rows.map(row => row[field]).filter(value => value !== undefined && value !== null && String(value).trim() !== '');
            const typeCounts = values.reduce((acc, value) => {
                const kind = inferValueKind(value);
                acc[kind] = (acc[kind] || 0) + 1;
                return acc;
            }, {});
            const topType = Object.entries(typeCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || 'empty';
            return {
                field,
                type: topType,
                filled: values.length,
                fillRate: rows.length ? values.length / rows.length : 0,
                samples: Array.from(new Set(values.map(value => String(value)).filter(Boolean))).slice(0, 5)
            };
        });
        return { type: 'data_profile', rowCount: rows.length, fields: profile };
    }
    if (name === 'data.filter_rows') {
        const rows = normalizeInputRows(input.rows, input.limit || 1000);
        const filters = input.filters && typeof input.filters === 'object' ? input.filters : {};
        const exact = String(input.matchMode || input.match_mode || 'contains').toLowerCase() === 'exact';
        const filtered = rows.filter(row => Object.entries(filters).every(([key, expected]) => {
            const actual = String(row[key] ?? '').toLowerCase();
            const needle = String(expected ?? '').toLowerCase();
            return exact ? actual === needle : actual.includes(needle);
        }));
        return { type: 'data_filter', rowCount: filtered.length, rows: filtered };
    }
    if (name === 'data.group_summary') {
        const rows = normalizeInputRows(input.rows, input.limit || 1000);
        const groupBy = String(input.groupBy || input.group_by || '').trim();
        if (!groupBy) {
            const err = new Error('groupBy is required.');
            err.status = 400;
            throw err;
        }
        const valueField = String(input.valueField || input.value_field || '').trim();
        const aggregation = String(input.aggregation || (valueField ? 'sum' : 'count')).toLowerCase();
        const grouped = new Map();
        rows.forEach(row => {
            const key = String(row[groupBy] ?? '');
            const bucket = grouped.get(key) || [];
            bucket.push(row);
            grouped.set(key, bucket);
        });
        const items = Array.from(grouped.entries()).map(([key, groupRows]) => {
            const values = valueField ? groupRows.map(row => toFiniteNumber(row[valueField])).filter(Number.isFinite) : [];
            let value = groupRows.length;
            if (aggregation === 'sum') value = values.reduce((sum, item) => sum + item, 0);
            if (aggregation === 'avg') value = values.length ? values.reduce((sum, item) => sum + item, 0) / values.length : 0;
            if (aggregation === 'min') value = values.length ? Math.min(...values) : 0;
            if (aggregation === 'max') value = values.length ? Math.max(...values) : 0;
            return { [groupBy]: key, value, count: groupRows.length };
        });
        return { type: 'data_group_summary', groupBy, valueField, aggregation, rows: items };
    }
    if (name === 'data.normalize_fields') {
        const rows = normalizeInputRows(input.rows, input.limit || 1000);
        const renameMap = input.renameMap && typeof input.renameMap === 'object' ? input.renameMap : {};
        const trimStrings = input.trimStrings !== false;
        const normalized = rows.map(row => Object.entries(row || {}).reduce((acc, [key, value]) => {
            const nextKey = String(renameMap[key] || key);
            acc[nextKey] = trimStrings && typeof value === 'string' ? value.trim() : value;
            return acc;
        }, {}));
        return { type: 'data_normalized_rows', rowCount: normalized.length, rows: normalized };
    }
    throw new Error(`Unsupported data MCP tool: ${name}`);
}

function findJsonCandidate(text) {
    const raw = String(text || '');
    const starts = [];
    ['{', '['].forEach(char => {
        const index = raw.indexOf(char);
        if (index >= 0) starts.push(index);
    });
    starts.sort((a, b) => a - b);
    for (const start of starts) {
        const open = raw[start];
        const close = open === '{' ? '}' : ']';
        let depth = 0;
        let inString = false;
        let escaped = false;
        for (let index = start; index < raw.length; index += 1) {
            const char = raw[index];
            if (inString) {
                escaped = char === '\\' && !escaped;
                if (char === '"' && !escaped) inString = false;
                if (char !== '\\') escaped = false;
                continue;
            }
            if (char === '"') {
                inString = true;
                continue;
            }
            if (char === open) depth += 1;
            if (char === close) depth -= 1;
            if (depth === 0) {
                const candidate = raw.slice(start, index + 1);
                try {
                    return { value: JSON.parse(candidate), json: candidate };
                } catch (e) {
                    break;
                }
            }
        }
    }
    return null;
}

function executeFormatConversionTool(_server, name, input = {}) {
    if (name === 'format.to_markdown_table') {
        const table = buildTableBlock(input);
        return { type: 'format_markdown_table', markdown: table.markdown, columns: table.columns, rowCount: table.rowCount };
    }
    if (name === 'format.to_json') {
        return {
            type: 'format_json',
            json: JSON.stringify(input.value, null, input.pretty === false ? 0 : 2)
        };
    }
    if (name === 'format.extract_json') {
        const result = findJsonCandidate(input.text);
        if (!result) {
            const err = new Error('No JSON object or array was found in the text.');
            err.status = 400;
            throw err;
        }
        return { type: 'format_extracted_json', value: result.value, json: result.json };
    }
    if (name === 'format.normalize_text') {
        const mode = String(input.mode || 'plain').toLowerCase();
        let text = textInput(input).replace(/\r\n/g, '\n').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
        if (mode === 'lower') text = text.toLowerCase();
        if (mode === 'upper') text = text.toUpperCase();
        return { type: 'format_normalized_text', text, charCount: text.length };
    }
    throw new Error(`Unsupported format MCP tool: ${name}`);
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
        const err = new Error('当前 IM 通知能力未启用广播/全员通知。');
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
    buildChartSpec,
    buildTableBlock,
    executeBuiltinMcpTool,
    getBuiltinConfigForServer,
    getBuiltinServiceTypeFromUrl,
    isInternalMcpUrl,
    listBuiltinMcpTools,
    normalizeBuiltinPayload
};
