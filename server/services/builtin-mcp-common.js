/* 内置 MCP 能力 - 公共层 Built-in MCP Shared Helpers
 *
 * 收纳被多个内置能力领域（报表/可视化/报告/文档/数据/格式/IM）复用的通用工具：
 *   - 服务类型识别与 URL 前缀
 *   - 配置归一化与读取
 *   - 通用数据处理（行规整、表格块、数值解析等）
 *
 * 本文件由 builtin-mcp.js 拆分而来，逻辑保持不变，仅做结构归并以便维护。
 */
const path = require('path');
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
    const err = new Error('不支持的系统工具类型。');
    err.status = 400;
    throw err;
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

function toFiniteNumber(value) {
    if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
    const text = String(value ?? '').trim();
    if (!text) return 0;
    const percentLike = /%$/.test(text) || /%\)$/.test(text);
    let normalized = text
        .replace(/,/g, '')
        .replace(/[¥￥$€£]/g, '')
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

function textInput(input = {}) {
    return String(input.text || input.content || '').slice(0, 200000);
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

module.exports = {
    BUILTIN_MCP_PREFIXES,
    SUPPORTED_REPORT_EXTENSIONS,
    DEFAULT_REPORT_EXTENSIONS,
    DEFAULT_MAX_FILE_MB,
    DEFAULT_MAX_ROWS,
    DEFAULT_MAX_MESSAGE_LENGTH,
    IM_TIMEOUT_MS,
    parseJson,
    splitList,
    normalizeServiceType,
    normalizeReportConfig,
    normalizeImConfig,
    normalizeBuiltinPayload,
    getBuiltinServiceTypeFromUrl,
    isInternalMcpUrl,
    getBuiltinConfigRow,
    getBuiltinConfigForServer,
    getRequiredBuiltinConfig,
    isPathInside,
    getExtension,
    toFiniteNumber,
    aggregateValues,
    normalizeInputRows,
    escapeMarkdownCell,
    buildTableBlock,
    textInput,
    inferValueKind
};
