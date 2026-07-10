const fs = require('fs');
const path = require('path');
const os = require('os');
const {
    DEFAULT_MAX_FILE_MB,
    DEFAULT_MAX_ROWS,
    normalizeReportConfig
} = require('./builtin-mcp-common');
const {
    executeReportConfigTool,
    listReportTools
} = require('./builtin-mcp-reports');

const LOCAL_MCP_SERVER_ID = 0;
const LOCAL_MCP_SERVER_ID_TEXT = String(LOCAL_MCP_SERVER_ID);
const LOCAL_AUTH_TYPES = new Set(['local_database', 'local_report_dir']);
const LOCAL_REPORT_EXTENSIONS = ['csv', 'xlsx', 'xls', 'json', 'txt', 'md'];

function databaseMcp() {
    return require('./database-mcp');
}

function isLocalDeviceMcpServerId(value) {
    return String(value) === LOCAL_MCP_SERVER_ID_TEXT;
}

function localAuthorizationFilePath() {
    return String(process.env.PIVOT_LOCAL_AUTHORIZATIONS_FILE || '').trim();
}

function isLocalDeviceExecutorEnabled() {
    return (process.env.PIVOT_DESKTOP === 'true' || process.env.PIVOT_LOCAL_HELPER === 'true')
        && Boolean(localAuthorizationFilePath());
}

function readJson(filePath) {
    try {
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (_err) {
        return {};
    }
}

function readLocalAuthorizationStore() {
    if (!isLocalDeviceExecutorEnabled()) return { version: 1, grants: {} };
    const filePath = localAuthorizationFilePath();
    const parsed = readJson(filePath);
    const grants = parsed && typeof parsed.grants === 'object' && parsed.grants ? parsed.grants : {};
    return { version: 1, grants };
}

function localAuthorizationError(message, status = 404) {
    const err = new Error(message);
    err.status = status;
    return err;
}

function getLocalGrant(type, { requireUsable = false } = {}) {
    if (!LOCAL_AUTH_TYPES.has(type)) {
        throw localAuthorizationError('不支持的本机授权类型。', 400);
    }
    if (!isLocalDeviceExecutorEnabled()) {
        if (requireUsable) throw localAuthorizationError('本机只读执行器未启用。', 404);
        return null;
    }
    const grant = readLocalAuthorizationStore().grants[type];
    const resourcePath = String(grant?.path || '').trim();
    if (!resourcePath) {
        if (requireUsable) throw localAuthorizationError('当前设备尚未授权该本机资源。', 404);
        return null;
    }
    const resolvedPath = path.resolve(resourcePath);
    if (!path.isAbsolute(resolvedPath)) {
        if (requireUsable) throw localAuthorizationError('本机授权路径无效。', 400);
        return null;
    }
    let stat;
    try {
        stat = fs.statSync(resolvedPath);
    } catch (_err) {
        if (requireUsable) throw localAuthorizationError('本机授权资源不存在或当前不可读。', 404);
        return null;
    }
    if (type === 'local_database' && !stat.isFile()) {
        if (requireUsable) throw localAuthorizationError('本机数据库授权必须指向 SQLite 文件。', 400);
        return null;
    }
    if (type === 'local_report_dir' && !stat.isDirectory()) {
        if (requireUsable) throw localAuthorizationError('本机报表目录授权必须指向目录。', 400);
        return null;
    }
    return {
        ...grant,
        path: resolvedPath,
        stat
    };
}

function getUsableLocalGrant(type) {
    try {
        return getLocalGrant(type);
    } catch (_err) {
        return null;
    }
}

function localGrantPathHint(resourcePath = '') {
    const base = path.basename(resourcePath || '');
    const parent = path.basename(path.dirname(resourcePath || ''));
    if (!base) return '';
    return parent ? path.join(parent, base) : base;
}

function sanitizeLocalGrantMeta(type, grant) {
    if (!grant || typeof grant !== 'object') return { type, authorized: false };
    return {
        type,
        authorized: true,
        resourceKind: String(grant.resourceKind || '').slice(0, 80),
        label: String(grant.label || localGrantPathHint(grant.path) || '').slice(0, 160),
        pathHint: localGrantPathHint(grant.path).slice(0, 180),
        provider: String(grant.provider || (process.env.PIVOT_DESKTOP === 'true' ? 'desktop' : 'local-helper')).slice(0, 40),
        deviceName: String(grant.deviceName || os.hostname()).slice(0, 120),
        grantedAt: String(grant.grantedAt || '').slice(0, 80),
        updatedAt: String(grant.updatedAt || grant.grantedAt || '').slice(0, 80)
    };
}

function localOwner(user) {
    if (!user?.id) {
        return {
            id: null,
            username: '',
            nickname: '当前设备',
            unit: '',
            role: '',
            displayName: '当前设备',
            scope: 'user'
        };
    }
    return {
        id: user.id,
        username: user.username || '',
        nickname: user.nickname || '',
        unit: user.unit || '',
        role: user.role || '',
        displayName: user.nickname || user.username || `用户 ${user.id}`,
        scope: 'user'
    };
}

function localToolRow(tool, { serverType, serverName, databaseType = '', user, localGrantType = '', localGrant = null }) {
    const name = String(tool.name || '').trim();
    return {
        serverId: LOCAL_MCP_SERVER_ID,
        serverName,
        serverType,
        databaseType,
        owner: localOwner(user),
        user_id: user?.id || null,
        name,
        fullName: `mcp.${LOCAL_MCP_SERVER_ID}.${name}`,
        description: tool.description || '',
        input_schema: tool.inputSchema || tool.input_schema || { type: 'object' },
        cached_at: new Date().toISOString(),
        localDevice: {
            online: true,
            deviceId: 'local',
            deviceName: os.hostname(),
            provider: process.env.PIVOT_DESKTOP === 'true' ? 'desktop' : 'local-helper',
            mode: process.env.PIVOT_DESKTOP === 'true' ? 'desktop' : 'local-helper',
            grants: {
                local_database: sanitizeLocalGrantMeta('local_database', localGrantType === 'local_database' ? localGrant : null),
                local_report_dir: sanitizeLocalGrantMeta('local_report_dir', localGrantType === 'local_report_dir' ? localGrant : null)
            }
        }
    };
}

function buildLocalDatabaseConnection(user) {
    const grant = getLocalGrant('local_database', { requireUsable: true });
    return {
        id: 'local_database',
        mcp_server_id: LOCAL_MCP_SERVER_ID,
        user_id: user?.id || null,
        database_type: 'sqlite',
        host: '',
        port: 0,
        database_name: grant.path,
        username: '',
        password: '',
        trusted_local_authorization: true,
        schema: '',
        ssl: false,
        max_rows: Math.min(Math.max(Number(grant.maxRows || DEFAULT_MAX_ROWS) || DEFAULT_MAX_ROWS, 1), 5000),
        table_allowlist: [],
        field_allowlist: {},
        sensitive_fields: [],
        row_policy_hint: '本机 SQLite 文件只读授权。',
        query_timeout_ms: 20000,
        sql_cost_estimate: true,
        options: {}
    };
}

function buildLocalReportConfig() {
    const grant = getLocalGrant('local_report_dir', { requireUsable: true });
    return normalizeReportConfig({
        roots: [grant.path],
        extensions: grant.extensions || LOCAL_REPORT_EXTENSIONS,
        maxFileMb: grant.maxFileMb || DEFAULT_MAX_FILE_MB,
        maxRows: grant.maxRows || DEFAULT_MAX_ROWS
    });
}

function getLocalDeviceMcpServerTypeForTool(toolName) {
    const name = String(toolName || '');
    if (name.startsWith('db.')) return 'database';
    if (name.startsWith('reports.')) return 'reports';
    return '';
}

function listLocalDeviceMcpTools(user = null) {
    if (!isLocalDeviceExecutorEnabled()) return [];
    const tools = [];
    const databaseGrant = getUsableLocalGrant('local_database');
    if (databaseGrant) {
        const connection = buildLocalDatabaseConnection(user);
        databaseMcp().listDatabaseConnectionMcpTools(connection).forEach(tool => {
            tools.push(localToolRow(tool, {
                serverType: 'database',
                serverName: '我的电脑：本机 SQLite',
                databaseType: 'sqlite',
                user,
                localGrantType: 'local_database',
                localGrant: databaseGrant
            }));
        });
    }
    const reportGrant = getUsableLocalGrant('local_report_dir');
    if (reportGrant) {
        listReportTools().forEach(tool => {
            tools.push(localToolRow(tool, {
                serverType: 'reports',
                serverName: '我的电脑：本机报表目录',
                user,
                localGrantType: 'local_report_dir',
                localGrant: reportGrant
            }));
        });
    }
    return tools;
}

async function executeLocalDeviceMcpTool(toolName, input = {}, user = null) {
    const serverType = getLocalDeviceMcpServerTypeForTool(toolName);
    if (serverType === 'database') {
        return databaseMcp().executeDatabaseConnectionTool(buildLocalDatabaseConnection(user), toolName, input);
    }
    if (serverType === 'reports') {
        return executeReportConfigTool(buildLocalReportConfig(), toolName, input);
    }
    throw localAuthorizationError(`Unsupported local device MCP tool: ${toolName}`, 400);
}

function localDeviceStatusSummary() {
    const store = readLocalAuthorizationStore();
    const grantCount = LOCAL_AUTH_TYPES.size
        ? Array.from(LOCAL_AUTH_TYPES).filter(type => Boolean(store.grants[type]?.path)).length
        : 0;
    return {
        available: isLocalDeviceExecutorEnabled(),
        provider: process.env.PIVOT_DESKTOP === 'true' ? 'desktop' : 'local-helper',
        deviceName: os.hostname(),
        grantCount
    };
}

module.exports = {
    LOCAL_MCP_SERVER_ID,
    executeLocalDeviceMcpTool,
    getLocalDeviceMcpServerTypeForTool,
    isLocalDeviceExecutorEnabled,
    isLocalDeviceMcpServerId,
    listLocalDeviceMcpTools,
    localDeviceStatusSummary
};
