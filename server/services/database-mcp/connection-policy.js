const {
    decryptSecret,
    assertSafeOutboundHost,
    createSafeLookup,
    getSafeOutboundOptionsForUser
} = require('../../security');

function appDb() {
    return require('../../db').db;
}

// 数据库出站 SSRF 守卫：解析 DNS 后校验真实 IP，拦截 loopback / link-local / 云元数据等敏感目标，
// 默认仅管理员可连接内网（RFC1918）数据库（受 MCP_RESTRICT_PRIVATE_DATABASE_HOSTS_TO_ADMIN 控制）。
function databaseOutboundOptions(user) {
    const restrictPrivateHostsToAdmin = process.env.MCP_RESTRICT_PRIVATE_DATABASE_HOSTS_TO_ADMIN !== 'false';
    if (!restrictPrivateHostsToAdmin) {
        // 关闭内网限制后，仍需拦截 loopback / link-local / 云元数据等敏感目标。
        return { blockPrivate: false, allowExplicitLoopback: false };
    }
    return getSafeOutboundOptionsForUser(user, {
        allowPrivateEnv: 'ALLOW_PRIVATE_DATABASE_HOSTS',
        allowExplicitLoopbackForAdmin: false
    });
}

// 连接前再次解析并校验主机，缓解 TOCTOU / DNS rebinding。校验失败抛出 403 风格错误。
async function assertSafeDatabaseHost(host, user) {
    try {
        await assertSafeOutboundHost(host, databaseOutboundOptions(user));
    } catch (e) {
        const err = new Error('当前用户不允许连接内网、本机或云元数据数据库地址。');
        err.code = 'MCP_PRIVATE_HOST_RESTRICTED';
        err.status = 403;
        throw err;
    }
}

// 为关系型驱动构造安全 lookup 钩子，连接握手阶段对解析出的 IP 再次校验，阻断 DNS rebinding。
function databaseSafeLookup(user) {
    return createSafeLookup(databaseOutboundOptions(user));
}

// 连接执行阶段无法获取请求用户，按连接归属者（user_id）的管理员身份套用同一内网放行策略，
// 与配置入库时的校验语义保持一致；查不到归属者时按普通用户（不放行内网）处理。
function getConnectionOwner(connection = {}) {
    // 测试连接路径无 user_id，可直接附带已校验的请求用户（_owner）。
    if (connection._owner) return connection._owner;
    if (!connection.user_id) return null;
    try {
        return appDb().prepare('SELECT id, username, role, status FROM users WHERE id = ?').get(connection.user_id) || null;
    } catch (e) {
        return null;
    }
}

const DEFAULT_PORTS = {
    postgres: 5432,
    mysql: 3306,
    sqlserver: 1433,
    mongodb: 27017,
    sqlite: 0
};
const DATABASE_CONNECT_TIMEOUT_MS = Math.max(1000, Number.parseInt(process.env.MCP_DATABASE_CONNECT_TIMEOUT_MS || '10000', 10) || 10000);
const DATABASE_TEST_CONNECT_TIMEOUT_MS = Math.max(
    1000,
    Number.parseInt(
        process.env.MCP_DATABASE_TEST_TIMEOUT_MS || String(DATABASE_CONNECT_TIMEOUT_MS),
        10
    ) || DATABASE_CONNECT_TIMEOUT_MS
);

function createDatabaseMcpError(message, code, status = 400) {
    const err = new Error(message);
    err.code = code;
    err.status = status;
    return err;
}

function databaseConnectionDiagnostics(connection = {}) {
    return {
        database_type: connection.database_type || connection.databaseType || '',
        host: connection.host || '',
        port: connection.port || '',
        database_name: connection.database_name || connection.databaseName || '',
        ssl: Boolean(connection.ssl || connection.options?.ssl),
        source: 'Pivot 服务器运行环境'
    };
}

function normalizeDatabaseConnectionError(err, connection = {}) {
    const rawCode = String(err?.code || '').toUpperCase();
    const rawMessage = String(err?.message || err || '');
    const diagnostics = databaseConnectionDiagnostics(connection);
    const base = {
        status: Number(err?.status || err?.statusCode || 0) || 502,
        code: rawCode || 'DB_CONNECTION_FAILED',
        message: rawMessage || '数据库连接失败。',
        detail: rawMessage || '',
        hint: '',
        diagnostics
    };

    if (err?.status === 403 || rawCode === 'MCP_PRIVATE_HOST_RESTRICTED') {
        return {
            ...base,
            status: 403,
            code: 'MCP_PRIVATE_HOST_RESTRICTED',
            message: '当前用户不允许配置内网或本机数据库地址。',
            hint: '如需允许普通用户连接个人局域网数据库，请确认服务端环境变量 MCP_RESTRICT_PRIVATE_DATABASE_HOSTS_TO_ADMIN=false，并重启服务。'
        };
    }

    if (['ECONNREFUSED'].includes(rawCode) || /ECONNREFUSED|connection refused/i.test(rawMessage)) {
        return {
            ...base,
            status: 502,
            code: 'DB_CONNECTION_REFUSED',
            message: `数据库主机拒绝连接：${diagnostics.host || '-'}:${diagnostics.port || '-'}`,
            hint: '请确认数据库监听的是内网地址/0.0.0.0，端口已对 Pivot 服务器或容器开放；Docker 部署时，127.0.0.1 指向容器自身，不是宿主机或你的电脑。'
        };
    }

    if (rawCode === 'DB_CONNECTION_TEST_TIMEOUT') {
        return {
            ...base,
            status: 504,
            code: 'DB_CONNECTION_TEST_TIMEOUT',
            message: `数据库测试连接超时：${diagnostics.host || '-'}:${diagnostics.port || '-'}`,
            hint: `测试连接已按 MCP_DATABASE_TEST_TIMEOUT_MS 结束。局域网环境连接慢或超时的常见原因：1. 目标数据库（如 MySQL）启用了 DNS 反向解析导致握手变慢，可在其配置文件中添加 skip-name-resolve 解决；2. 防火墙、安全组未开放此端口。可在环境变量中调大 MCP_DATABASE_TEST_TIMEOUT_MS 解决。`
        };
    }

    if (['ETIMEDOUT', 'ETIMEOUT', 'ESOCKETTIMEDOUT'].includes(rawCode) || /timed?\s*out|timeout/i.test(rawMessage)) {
        return {
            ...base,
            status: 504,
            code: 'DB_CONNECTION_TIMEOUT',
            message: `数据库连接超时：${diagnostics.host || '-'}:${diagnostics.port || '-'}`,
            hint: '局域网连接超时，请检查 Pivot 服务器到数据库主机的物理路由、防火墙或安全组规则；如果是 MySQL 数据库，请排查其是否在进行反向 DNS 解析，建议配置 skip-name-resolve；同时可以调大环境变量 MCP_DATABASE_CONNECT_TIMEOUT_MS。'
        };
    }

    if (['ENOTFOUND', 'EAI_AGAIN'].includes(rawCode) || /getaddrinfo|ENOTFOUND|EAI_AGAIN/i.test(rawMessage)) {
        return {
            ...base,
            status: 502,
            code: 'DB_HOST_NOT_FOUND',
            message: `数据库主机无法解析：${diagnostics.host || '-'}`,
            hint: '请改用数据库服务器的内网 IP，或确认生产环境容器/服务器能解析该主机名。'
        };
    }

    if (
        ['ER_ACCESS_DENIED_ERROR', 'ELOGIN', 'LOGIN_FAILED'].includes(rawCode) ||
        ['28P01', '28000'].includes(String(err?.code || '')) ||
        /access denied|login failed|password authentication failed|authentication failed|auth failed/i.test(rawMessage)
    ) {
        return {
            ...base,
            status: 403,
            code: 'DB_AUTH_FAILED',
            message: '数据库账号认证失败或该账号不允许从 Pivot 服务器地址登录。',
            hint: '用户名和密码即使正确，也需要数据库授权允许来自 Pivot 服务器/容器出口 IP 的连接。例如 MySQL 需要 user@PivotIP 或 user@% 授权，PostgreSQL 需要 pg_hba.conf 放行。'
        };
    }

    if (/self[- ]signed|certificate|tls|ssl|handshake/i.test(rawMessage)) {
        return {
            ...base,
            status: 502,
            code: 'DB_TLS_FAILED',
            message: '数据库 TLS/SSL 握手失败。',
            hint: '请确认是否需要勾选 SSL/TLS；如果数据库没有启用 TLS，请关闭该选项。如果启用了自签证书，需要允许信任服务器证书。'
        };
    }

    return {
        ...base,
        status: base.status >= 400 && base.status <= 599 ? base.status : 502,
        code: base.code,
        message: rawMessage || '数据库连接失败。',
        hint: '请确认这是从 Pivot 服务器所在机器或容器发起连接，而不是从浏览器所在电脑发起连接。'
    };
}

function normalizeDatabaseType(value) {
    const type = String(value || '').trim().toLowerCase();
    const map = {
        postgresql: 'postgres',
        postgres: 'postgres',
        pg: 'postgres',
        mysql: 'mysql',
        mariadb: 'mysql',
        sqlserver: 'sqlserver',
        mssql: 'sqlserver',
        sqlite: 'sqlite',
        sqlite3: 'sqlite',
        mongodb: 'mongodb',
        mongo: 'mongodb'
    };
    return map[type] || '';
}

function parseOptions(value) {
    if (!value) return {};
    try {
        return JSON.parse(value) || {};
    } catch (e) {
        return {};
    }
}

function splitPolicyList(value) {
    if (Array.isArray(value)) return value.map(item => String(item || '').trim()).filter(Boolean);
    return String(value || '')
        .split(/[\n,;]+/)
        .map(item => item.trim())
        .filter(Boolean);
}

function normalizePolicyIdentifier(value) {
    return String(value || '')
        .trim()
        .split('.')
        .map(part => part.trim().replace(/^["'`\[]+|["'`\]]+$/g, ''))
        .filter(Boolean)
        .join('.')
        .toLowerCase();
}

function baseIdentifier(value) {
    const normalized = normalizePolicyIdentifier(value);
    const parts = normalized.split('.').filter(Boolean);
    return parts[parts.length - 1] || normalized;
}

function normalizePolicyList(value) {
    return Array.from(new Set(splitPolicyList(value).map(normalizePolicyIdentifier).filter(Boolean)));
}

function normalizeFieldAllowlist(value) {
    const result = {};
    const addField = (table, field) => {
        const key = normalizePolicyIdentifier(table || '*') || '*';
        const name = normalizePolicyIdentifier(field);
        if (!name) return;
        if (!result[key]) result[key] = [];
        if (!result[key].includes(name)) result[key].push(name);
    };
    if (value && typeof value === 'object' && !Array.isArray(value)) {
        Object.entries(value).forEach(([table, fields]) => {
            splitPolicyList(fields).forEach(field => addField(table, field));
        });
        return result;
    }
    const raw = String(value || '').trim();
    if (raw.startsWith('{')) {
        try {
            return normalizeFieldAllowlist(JSON.parse(raw));
        } catch (e) {
            // Fall through to line parsing.
        }
    }
    splitPolicyList(raw).forEach(item => {
        if (item.includes(':')) {
            const [table, fields] = item.split(/:(.+)/);
            splitPolicyList(fields).forEach(field => addField(table, field));
            return;
        }
        const parts = normalizePolicyIdentifier(item).split('.').filter(Boolean);
        if (parts.length >= 2) addField(parts.slice(0, -1).join('.'), parts[parts.length - 1]);
        else addField('*', parts[0] || item);
    });
    return result;
}

function clampTimeoutMs(value, fallback = 20000) {
    const parsed = Number.parseInt(value || fallback, 10);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.max(1000, Math.min(parsed, 120000));
}

function normalizeDatabaseConnection(row, { includeSecret = false } = {}) {
    if (!row) return null;
    const options = parseOptions(row.options);
    const tableAllowlist = normalizePolicyList(options.tableAllowlist || options.table_allowlist || options.allowedTables || options.allowed_tables);
    const fieldAllowlist = normalizeFieldAllowlist(options.fieldAllowlist || options.field_allowlist || options.allowedFields || options.allowed_fields);
    const sensitiveFields = normalizePolicyList(options.sensitiveFields || options.sensitive_fields);
    return {
        id: row.id,
        mcp_server_id: row.mcp_server_id,
        user_id: row.user_id,
        database_type: row.database_type,
        host: row.host || '',
        port: row.port || DEFAULT_PORTS[row.database_type] || 0,
        database_name: row.database_name || '',
        username: row.username || '',
        schema: options.schema || '',
        ssl: Boolean(options.ssl),
        // 默认校验服务端证书，仅当用户显式开启「信任自签名」时才放行无效证书
        ssl_allow_self_signed: Boolean(options.allowSelfSigned || options.sslAllowSelfSigned),
        max_rows: Number(options.maxRows || 100),
        table_allowlist: tableAllowlist,
        field_allowlist: fieldAllowlist,
        sensitive_fields: sensitiveFields,
        row_policy_hint: String(options.rowPolicyHint || options.row_policy_hint || '').slice(0, 500),
        query_timeout_ms: clampTimeoutMs(options.queryTimeoutMs || options.query_timeout_ms || 20000),
        sql_cost_estimate: options.sqlCostEstimate !== false && options.sql_cost_estimate !== false,
        status: row.status || 'active',
        has_password: Boolean(row.password),
        created_at: row.created_at,
        updated_at: row.updated_at,
        ...(includeSecret ? { password: decryptSecret(row.password || '') } : {})
    };
}

module.exports = {
    DEFAULT_PORTS,
    DATABASE_CONNECT_TIMEOUT_MS,
    DATABASE_TEST_CONNECT_TIMEOUT_MS,
    databaseOutboundOptions,
    assertSafeDatabaseHost,
    databaseSafeLookup,
    getConnectionOwner,
    createDatabaseMcpError,
    databaseConnectionDiagnostics,
    normalizeDatabaseConnectionError,
    normalizeDatabaseType,
    parseOptions,
    splitPolicyList,
    normalizePolicyIdentifier,
    baseIdentifier,
    normalizePolicyList,
    normalizeFieldAllowlist,
    clampTimeoutMs,
    normalizeDatabaseConnection
};