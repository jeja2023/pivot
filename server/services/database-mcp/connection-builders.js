const path = require('path');
const {
    DATABASE_CONNECT_TIMEOUT_MS,
    DATABASE_TEST_CONNECT_TIMEOUT_MS,
    normalizePolicyList,
    normalizeFieldAllowlist,
    clampTimeoutMs
} = require('./connection-policy');

function defaultDataDir() {
    return require('../../db').dataDir;
}

function allowedSqliteRoots() {
    const fallbackDataDir = defaultDataDir();
    const roots = (process.env.MCP_SQLITE_ROOTS || fallbackDataDir)
        .split(',')
        .map(item => item.trim())
        .filter(Boolean)
        .map(item => path.resolve(item));
    return roots.length ? roots : [fallbackDataDir];
}

function resolveSafeSqlitePath(databaseName) {
    const target = path.resolve(String(databaseName || ''));
    const insideRoot = allowedSqliteRoots().some(root => target === root || target.startsWith(root + path.sep));
    if (!insideRoot) {
        throw new Error('SQLite file must be inside MCP_SQLITE_ROOTS or the application data directory.');
    }
    return target;
}

function buildRelationalConnectionConfig(connection) {
    // 归一化后的 connection 已包含全部治理字段（来自 normalizeDatabaseConnection），
    // 无需再次按 id 回查 options，直接复用调用方传入的值即可。
    const options = connection.options || {};
    return {
        ...connection,
        password: connection.password || '',
        schema: connection.schema || options.schema || '',
        ssl: Boolean(connection.ssl || options.ssl),
        ssl_allow_self_signed: Boolean(connection.ssl_allow_self_signed || options.allowSelfSigned || options.sslAllowSelfSigned),
        max_rows: Number(connection.max_rows || options.maxRows || 100),
        table_allowlist: connection.table_allowlist || normalizePolicyList(options.tableAllowlist || options.table_allowlist || options.allowedTables || options.allowed_tables),
        field_allowlist: connection.field_allowlist || normalizeFieldAllowlist(options.fieldAllowlist || options.field_allowlist || options.allowedFields || options.allowed_fields),
        sensitive_fields: connection.sensitive_fields || normalizePolicyList(options.sensitiveFields || options.sensitive_fields),
        row_policy_hint: connection.row_policy_hint || String(options.rowPolicyHint || options.row_policy_hint || '').slice(0, 500),
        query_timeout_ms: clampTimeoutMs(connection.query_timeout_ms || options.queryTimeoutMs || options.query_timeout_ms || 20000),
        sql_cost_estimate: connection.sql_cost_estimate !== undefined
            ? connection.sql_cost_estimate
            : (options.sqlCostEstimate !== false && options.sql_cost_estimate !== false)
    };
}

function getConnectionTimeoutMs(connection) {
    return Math.max(1000, Number.parseInt(connection?.connect_timeout_ms || DATABASE_CONNECT_TIMEOUT_MS, 10) || DATABASE_CONNECT_TIMEOUT_MS);
}

function getDatabaseTestTimeoutMs() {
    return DATABASE_TEST_CONNECT_TIMEOUT_MS;
}

function buildDatabaseTestConnectionConfig(connection = {}) {
    const options = connection.options || {};
    return {
        ...connection,
        ssl: connection.ssl !== undefined ? connection.ssl : options.ssl,
        ssl_allow_self_signed: connection.ssl_allow_self_signed !== undefined
            ? connection.ssl_allow_self_signed
            : Boolean(options.allowSelfSigned || options.sslAllowSelfSigned),
        schema: connection.schema || options.schema || '',
        connect_timeout_ms: getDatabaseTestTimeoutMs()
    };
}

module.exports = {
    allowedSqliteRoots,
    resolveSafeSqlitePath,
    buildRelationalConnectionConfig,
    getConnectionTimeoutMs,
    getDatabaseTestTimeoutMs,
    buildDatabaseTestConnectionConfig
};
