const path = require('path');
const Database = require('better-sqlite3');
const { db, dataDir } = require('../db');
const { decryptSecret, isPrivateHost } = require('../security');
const { isAdmin } = require('../permissions');

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
        source: 'Pivot server runtime'
    };
}

function normalizeDatabaseConnectionError(err, connection = {}) {
    const rawCode = String(err?.code || '').toUpperCase();
    const rawMessage = String(err?.message || err || '');
    const diagnostics = databaseConnectionDiagnostics(connection);
    const base = {
        status: Number(err?.status || err?.statusCode || 0) || 502,
        code: rawCode || 'DB_CONNECTION_FAILED',
        message: rawMessage || 'Database connection failed.',
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

const SQL_TOOL_DEFINITIONS = [
    {
        name: 'db.list_tables',
        description: '列出当前数据库中可查询的表和视图。',
        inputSchema: {
            type: 'object',
            properties: {
                schema: { type: 'string', description: '可选，数据库 schema 名称。' }
            }
        }
    },
    {
        name: 'db.count_tables',
        description: '统计当前数据库中可查询的数据表和视图数量，适合回答“有多少张表”等问题。',
        inputSchema: {
            type: 'object',
            properties: {
                schema: { type: 'string', description: '可选，数据库 schema 名称。' }
            }
        }
    },
    {
        name: 'db.describe_table',
        description: '查看表字段、类型和可空性，辅助模型生成安全 SQL。',
        inputSchema: {
            type: 'object',
            required: ['table'],
            properties: {
                table: { type: 'string', description: '表名。' },
                schema: { type: 'string', description: '可选，数据库 schema 名称。' }
            }
        }
    },
    {
        name: 'db.run_readonly_query',
        description: '执行只读 SQL 查询，仅允许 SELECT/WITH/SHOW/DESCRIBE/EXPLAIN，并限制返回行数。',
        inputSchema: {
            type: 'object',
            required: ['sql'],
            properties: {
                sql: { type: 'string', description: '只读 SQL。' },
                limit: { type: 'integer', minimum: 1, maximum: 1000, description: '最大返回行数，默认 100。' }
            }
        }
    },
    {
        name: 'db.group_count',
        description: '按指定表字段分组并统计数量，适合普通用户生成分布图，系统会自动生成安全只读 SQL。',
        inputSchema: {
            type: 'object',
            required: ['table', 'groupBy'],
            properties: {
                table: { type: 'string', description: '要统计的数据表。' },
                groupBy: { type: 'string', description: '用于分组统计的字段。' },
                schema: { type: 'string', description: '可选，数据库 schema 名称。' },
                groupAlias: { type: 'string', default: 'group_value', description: '分组字段输出别名。' },
                countAlias: { type: 'string', default: 'count', description: '数量字段别名。' },
                limit: { type: 'integer', minimum: 1, maximum: 1000, default: 100, description: '最多返回的分组数量。' },
                sortOrder: { type: 'string', enum: ['asc', 'desc'], default: 'desc', description: '按数量排序方向。' }
            }
        }
    }
];

const MONGO_TOOL_DEFINITIONS = [
    {
        name: 'db.list_collections',
        description: '列出 MongoDB 数据库中的集合。',
        inputSchema: { type: 'object', properties: {} }
    },
    {
        name: 'db.count_collections',
        description: '统计 MongoDB 数据库中的集合数量，适合回答“有多少个集合”等问题。',
        inputSchema: { type: 'object', properties: {} }
    },
    {
        name: 'db.sample_collection',
        description: '读取 MongoDB 集合的小样本，辅助理解字段结构。',
        inputSchema: {
            type: 'object',
            required: ['collection'],
            properties: {
                collection: { type: 'string' },
                limit: { type: 'integer', minimum: 1, maximum: 100, description: '最大返回文档数，默认 20。' }
            }
        }
    },
    {
        name: 'db.aggregate',
        description: '执行 MongoDB 聚合管道，建议仅用于只读统计分析。',
        inputSchema: {
            type: 'object',
            required: ['collection', 'pipeline'],
            properties: {
                collection: { type: 'string' },
                pipeline: { type: 'array', description: 'MongoDB aggregation pipeline。' },
                limit: { type: 'integer', minimum: 1, maximum: 1000, description: '最大返回文档数，默认 100。' }
            }
        }
    }
];

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

function getDatabaseConnectionForServer(serverId, { includeSecret = false } = {}) {
    const row = db.prepare(`
        SELECT * FROM mcp_database_connections
        WHERE mcp_server_id = ? AND status != 'deleted'
    `).get(serverId);
    return normalizeDatabaseConnection(row, { includeSecret });
}

function listDatabaseMcpTools(server) {
    const connection = getDatabaseConnectionForServer(server.id);
    if (!connection) throw new Error('Database MCP connection not found.');
    return connection.database_type === 'mongodb' ? MONGO_TOOL_DEFINITIONS : SQL_TOOL_DEFINITIONS;
}

function optionalRequire(packageName, installHint) {
    try {
        return require(packageName);
    } catch (e) {
        if (e.code === 'MODULE_NOT_FOUND') {
            throw new Error(`${packageName} driver is not installed. ${installHint}`);
        }
        throw e;
    }
}

function clampLimit(value, fallback = 100, max = 1000) {
    const limit = parseInt(value || fallback, 10);
    if (!Number.isFinite(limit)) return fallback;
    return Math.max(1, Math.min(limit, max));
}

function assertReadonlySql(sql) {
    const text = String(sql || '').trim();
    if (!text) throw new Error('SQL is required.');
    const withoutTrailingSemicolon = text.replace(/;\s*$/, '');
    if (withoutTrailingSemicolon.includes(';')) throw new Error('Only one SQL statement is allowed.');
    if (!/^(select|with|show|describe|desc|explain)\b/i.test(withoutTrailingSemicolon)) {
        throw new Error('Only readonly SQL is allowed.');
    }
    if (/\b(insert|update|delete|drop|alter|create|truncate|merge|grant|revoke|replace|vacuum|attach|detach|copy|call|execute)\b/i.test(withoutTrailingSemicolon)) {
        throw new Error('SQL contains a blocked write or administrative keyword.');
    }
    return withoutTrailingSemicolon;
}

function quoteIdentifier(identifier, quote = '"') {
    const value = String(identifier || '').trim();
    if (!value) throw new Error('Identifier is required.');
    return `${quote}${value.replace(new RegExp(quote, 'g'), quote + quote)}${quote}`;
}

function quoteSqlIdentifierPart(identifier, dialect) {
    const value = String(identifier || '').trim();
    if (!value) throw new Error('Identifier is required.');
    if (dialect === 'mysql') return `\`${value.replace(/`/g, '``')}\``;
    if (dialect === 'sqlserver') return `[${value.replace(/]/g, ']]')}]`;
    return quoteIdentifier(value, '"');
}

function quoteSqlIdentifier(identifier, dialect) {
    return String(identifier || '')
        .split('.')
        .map(part => quoteSqlIdentifierPart(part, dialect))
        .join('.');
}

function buildQualifiedTableName({ schema = '', table = '', dialect = 'postgres' }) {
    const cleanTable = String(table || '').trim();
    const cleanSchema = String(schema || '').trim();
    if (!cleanTable) throw new Error('table is required.');
    if (!cleanSchema || dialect === 'sqlite') return quoteSqlIdentifier(cleanTable, dialect);
    return `${quoteSqlIdentifier(cleanSchema, dialect)}.${quoteSqlIdentifier(cleanTable, dialect)}`;
}

function normalizeSqlAlias(value, fallback) {
    const alias = String(value || fallback || '').trim();
    if (!alias) throw new Error('Alias is required.');
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(alias)) {
        const err = new Error('Alias must start with a letter or underscore and contain only letters, numbers, and underscores.');
        err.status = 400;
        throw err;
    }
    return alias;
}

function defaultSqlAlias(value, fallback) {
    const alias = String(value || '').trim().replace(/[^\w]/g, '_').replace(/^_+/, '').slice(0, 64);
    return /^[A-Za-z_]/.test(alias) ? alias : fallback;
}

function buildGroupCountSql(input = {}, dialect = 'postgres', fallbackSchema = '') {
    const table = String(input.table || '').trim();
    const groupBy = String(input.groupBy || input.group_by || '').trim();
    if (!table) throw new Error('table is required.');
    if (!groupBy) throw new Error('groupBy is required.');
    const limit = clampLimit(input.limit, 100);
    const schema = String(input.schema || fallbackSchema || '').trim();
    const countAlias = normalizeSqlAlias(input.countAlias || input.count_alias, 'count');
    const groupAlias = normalizeSqlAlias(input.groupAlias || input.group_alias, defaultSqlAlias(groupBy, 'group_value'));
    const order = String(input.sortOrder || input.sort_order || 'desc').toLowerCase() === 'asc' ? 'ASC' : 'DESC';
    const tableName = buildQualifiedTableName({ schema, table, dialect });
    const groupIdentifier = quoteSqlIdentifier(groupBy, dialect);
    const groupAliasIdentifier = quoteSqlIdentifier(groupAlias, dialect);
    const countAliasIdentifier = quoteSqlIdentifier(countAlias, dialect);
    const selectPrefix = dialect === 'sqlserver' ? `SELECT TOP (${limit})` : 'SELECT';
    const limitClause = dialect === 'sqlserver' ? '' : `\nLIMIT ${limit}`;
    const sql = [
        `${selectPrefix} ${groupIdentifier} AS ${groupAliasIdentifier}, COUNT(*) AS ${countAliasIdentifier}`,
        `FROM ${tableName}`,
        `GROUP BY ${groupIdentifier}`,
        `ORDER BY ${countAliasIdentifier} ${order}, ${groupAliasIdentifier} ASC${limitClause}`
    ].join('\n');
    return { sql, limit, groupAlias, countAlias, table, groupBy, schema };
}

function applySqlLimit(sql, limit, dialect) {
    if (/\blimit\s+\d+\b/i.test(sql) || /^\s*(show|describe|desc|explain)\b/i.test(sql)) return sql;
    if (dialect === 'sqlserver') {
        return sql.replace(/^\s*select\s+/i, `SELECT TOP (${limit}) `);
    }
    return `${sql}\nLIMIT ${limit}`;
}

function hasTableAllowlist(cfg = {}) {
    return Array.isArray(cfg.table_allowlist) && cfg.table_allowlist.length > 0;
}

function hasFieldAllowlist(cfg = {}) {
    return cfg.field_allowlist && typeof cfg.field_allowlist === 'object' && Object.keys(cfg.field_allowlist).length > 0;
}

function isTableAllowed(cfg = {}, table = '') {
    if (!hasTableAllowlist(cfg)) return true;
    const target = normalizePolicyIdentifier(table);
    const targetBase = baseIdentifier(table);
    return cfg.table_allowlist.some(item => item === target || baseIdentifier(item) === targetBase);
}

function assertTableAllowed(cfg = {}, table = '') {
    if (!String(table || '').trim()) return;
    if (!isTableAllowed(cfg, table)) {
        const err = new Error(`数据表 ${table} 不在允许访问的表白名单内。`);
        err.status = 403;
        throw err;
    }
}

function allowedFieldsForTable(cfg = {}, table = '') {
    if (!hasFieldAllowlist(cfg)) return [];
    const fields = cfg.field_allowlist || {};
    const key = normalizePolicyIdentifier(table);
    const base = baseIdentifier(table);
    return Array.from(new Set([
        ...(fields['*'] || []),
        ...(fields[key] || []),
        ...(fields[base] || [])
    ].map(normalizePolicyIdentifier).filter(Boolean)));
}

function assertFieldAllowed(cfg = {}, table = '', field = '') {
    if (!hasFieldAllowlist(cfg)) return;
    const allowed = allowedFieldsForTable(cfg, table);
    const target = normalizePolicyIdentifier(field);
    if (!allowed.includes(target) && !allowed.includes(baseIdentifier(field))) {
        const err = new Error(`字段 ${field} 不在 ${table || '当前表'} 的字段白名单内。`);
        err.status = 403;
        throw err;
    }
}

function getTableNameFromRow(row = {}) {
    return row.table_name || row.name || row.TABLE_NAME || row.table || '';
}

function getColumnNameFromRow(row = {}) {
    return row.column_name || row.name || row.COLUMN_NAME || '';
}

function filterTableRows(rows = [], cfg = {}) {
    const list = Array.isArray(rows) ? rows : [];
    if (!hasTableAllowlist(cfg)) return list;
    return list.filter(row => isTableAllowed(cfg, getTableNameFromRow(row)));
}

function summarizeTableRows(rows = []) {
    const grouped = new Map();
    rows.forEach(row => {
        const type = String(row.table_type || row.type || row.TABLE_TYPE || 'table');
        grouped.set(type, (grouped.get(type) || 0) + 1);
    });
    const resultRows = Array.from(grouped.entries()).map(([type, total]) => ({ type, total }));
    return { total: rows.length, rows: resultRows };
}

function filterDescribeRows(rows = [], cfg = {}, table = '') {
    const list = Array.isArray(rows) ? rows : [];
    if (!hasFieldAllowlist(cfg)) return list;
    const allowed = allowedFieldsForTable(cfg, table);
    return list.filter(row => {
        const column = normalizePolicyIdentifier(getColumnNameFromRow(row));
        return allowed.includes(column) || allowed.includes(baseIdentifier(column));
    });
}

function isSensitiveField(cfg = {}, key = '') {
    const fields = Array.isArray(cfg.sensitive_fields) ? cfg.sensitive_fields : [];
    if (!fields.length) return false;
    const target = normalizePolicyIdentifier(key);
    const targetBase = baseIdentifier(key);
    return fields.some(field => field === target || baseIdentifier(field) === targetBase);
}

function maskSensitiveRows(rows, cfg = {}) {
    if (!Array.isArray(rows) || !(cfg.sensitive_fields || []).length) return rows;
    return rows.map(row => {
        if (!row || typeof row !== 'object' || Array.isArray(row)) return row;
        const masked = {};
        Object.entries(row).forEach(([key, value]) => {
            masked[key] = isSensitiveField(cfg, key) ? '[已脱敏]' : value;
        });
        return masked;
    });
}

function splitTopLevelCsv(text = '') {
    const parts = [];
    let current = '';
    let depth = 0;
    let quote = '';
    String(text || '').split('').forEach(ch => {
        if (quote) {
            current += ch;
            if (ch === quote) quote = '';
            return;
        }
        if (['"', "'", '`'].includes(ch)) {
            quote = ch;
            current += ch;
            return;
        }
        if (ch === '(') depth += 1;
        if (ch === ')') depth = Math.max(0, depth - 1);
        if (ch === ',' && depth === 0) {
            parts.push(current.trim());
            current = '';
            return;
        }
        current += ch;
    });
    if (current.trim()) parts.push(current.trim());
    return parts;
}

function extractSqlTables(sql = '') {
    const tables = [];
    const text = String(sql || '').replace(/["'`]/g, '');
    const pattern = /\b(?:from|join|describe|desc)\s+([A-Za-z_][\w$]*(?:\.[A-Za-z_][\w$]*)?)/ig;
    let match;
    while ((match = pattern.exec(text))) {
        const value = normalizePolicyIdentifier(match[1]);
        if (value && !tables.includes(value)) tables.push(value);
    }
    return tables;
}

function extractSelectFields(sql = '') {
    const text = String(sql || '').trim();
    const match = text.match(/^\s*select\s+(.+?)\s+from\s+/is);
    if (!match) return [];
    return splitTopLevelCsv(match[1]).map(item => {
        const withoutAlias = item
            .replace(/\s+as\s+[A-Za-z_][\w$]*$/i, '')
            .replace(/\s+[A-Za-z_][\w$]*$/i, '')
            .trim();
        if (withoutAlias === '*') return '*';
        const identifierMatch = withoutAlias.match(/^[A-Za-z_][\w$]*(?:\.[A-Za-z_][\w$]*)?$/);
        return identifierMatch ? baseIdentifier(identifierMatch[0]) : '';
    }).filter(Boolean);
}

function assertSqlGovernance(sql = '', cfg = {}) {
    const tables = extractSqlTables(sql);
    if (hasTableAllowlist(cfg) && /^\s*select\b/i.test(sql) && tables.length === 0) {
        const err = new Error('表白名单已启用，复杂 SQL 需要改写为能明确识别 FROM/JOIN 表名的查询。');
        err.status = 403;
        throw err;
    }
    tables.forEach(table => assertTableAllowed(cfg, table));
    if (hasFieldAllowlist(cfg)) {
        const fields = extractSelectFields(sql);
        if (fields.includes('*')) {
            const err = new Error('字段白名单已启用，请使用明确字段名，不能 SELECT *。');
            err.status = 403;
            throw err;
        }
        if (/^\s*select\b/i.test(sql) && fields.length === 0) {
            const err = new Error('字段白名单已启用，复杂 SQL 需要改写为明确列名的 SELECT。');
            err.status = 403;
            throw err;
        }
        fields.forEach(field => {
            if (!/^\d+$/.test(field)) {
                const allowed = tables.length
                    ? tables.some(table => {
                        try {
                            assertFieldAllowed(cfg, table, field);
                            return true;
                        } catch (e) {
                            return false;
                        }
                    })
                    : allowedFieldsForTable(cfg, '*').includes(normalizePolicyIdentifier(field));
                if (!allowed) {
                    const err = new Error(`字段 ${field} 不在字段白名单内。`);
                    err.status = 403;
                    throw err;
                }
            }
        });
    }
    return { tables };
}

function buildDatabaseCost(cfg = {}, details = {}) {
    const governance = {
        tableAllowlistActive: hasTableAllowlist(cfg),
        fieldAllowlistActive: hasFieldAllowlist(cfg),
        sensitiveMaskingActive: Array.isArray(cfg.sensitive_fields) && cfg.sensitive_fields.length > 0,
        rowPolicyHint: cfg.row_policy_hint || '',
        queryTimeoutMs: cfg.query_timeout_ms || 20000
    };
    if (cfg.sql_cost_estimate === false) return { governance };
    return {
        governance,
        cost: {
            operation: details.operation || 'query',
            databaseType: cfg.database_type,
            tables: details.tables || [],
            fields: details.fields || [],
            limit: details.limit || cfg.max_rows || 100,
            boundedByLimit: true,
            estimate: '轻量估算：实际扫描成本取决于数据库执行计划、索引和过滤条件。'
        }
    };
}

function allowedSqliteRoots() {
    const roots = (process.env.MCP_SQLITE_ROOTS || dataDir)
        .split(',')
        .map(item => item.trim())
        .filter(Boolean)
        .map(item => path.resolve(item));
    return roots.length ? roots : [dataDir];
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
    const options = parseOptions(db.prepare('SELECT options FROM mcp_database_connections WHERE id = ?').get(connection.id)?.options);
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

function createTimeoutError(connection, timeoutMs, phase = 'database connection test') {
    const err = new Error(`${phase} timed out after ${timeoutMs}ms`);
    err.code = 'DB_CONNECTION_TEST_TIMEOUT';
    err.status = 504;
    err.connection = databaseConnectionDiagnostics(connection);
    return err;
}

function withOperationTimeout(promise, timeoutMs, connection, phase) {
    let timer;
    // 增加外层超时缓冲时间，让驱动底层自身的超时逻辑先触发，从而返回更具体的错误原因而不是通用超时
    const outerTimeoutMs = timeoutMs + 5000;
    const timeoutPromise = new Promise((_, reject) => {
        timer = setTimeout(() => reject(createTimeoutError(connection, timeoutMs, phase)), outerTimeoutMs);
    });
    return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timer));
}

async function withPostgres(connection, handler) {
    const { Client } = optionalRequire('pg', 'Install it with npm install pg.');
    const timeoutMs = getConnectionTimeoutMs(connection);
    const client = new Client({
        host: connection.host,
        port: connection.port || DEFAULT_PORTS.postgres,
        database: connection.database_name,
        user: connection.username,
        password: connection.password,
        // 默认校验证书防止 MITM；仅当用户显式信任自签名时才放行
        ssl: connection.ssl ? { rejectUnauthorized: !connection.ssl_allow_self_signed } : false,
        connectionTimeoutMillis: timeoutMs
    });
    await client.connect();
    try {
        return await handler(client);
    } finally {
        await client.end();
    }
}

async function withMysql(connection, handler) {
    const mysql = optionalRequire('mysql2/promise', 'Install it with npm install mysql2.');
    const timeoutMs = getConnectionTimeoutMs(connection);
    const client = await mysql.createConnection({
        host: connection.host,
        port: connection.port || DEFAULT_PORTS.mysql,
        database: connection.database_name,
        user: connection.username,
        password: connection.password,
        // 默认校验证书防 MITM；仅当用户显式信任自签名时才放行
        ssl: connection.ssl ? { rejectUnauthorized: !connection.ssl_allow_self_signed } : undefined,
        connectTimeout: timeoutMs
    });
    try {
        return await handler(client);
    } finally {
        await client.end();
    }
}

async function withSqlServer(connection, handler) {
    const sql = optionalRequire('mssql', 'Install it with npm install mssql.');
    const timeoutMs = getConnectionTimeoutMs(connection);
    const pool = new sql.ConnectionPool({
        server: connection.host,
        port: connection.port || DEFAULT_PORTS.sqlserver,
        database: connection.database_name,
        user: connection.username,
        password: connection.password,
        options: {
            encrypt: Boolean(connection.ssl),
            // 默认校验证书防止 MITM；仅当用户显式信任自签名时才放行
            trustServerCertificate: Boolean(connection.ssl_allow_self_signed)
        },
        connectionTimeout: timeoutMs,
        requestTimeout: timeoutMs
    });
    await pool.connect();
    try {
        return await handler(pool);
    } finally {
        await pool.close();
    }
}

function withSqlite(connection, handler) {
    const sqlitePath = resolveSafeSqlitePath(connection.database_name);
    const client = new Database(sqlitePath, { readonly: true, fileMustExist: true });
    try {
        return handler(client);
    } finally {
        client.close();
    }
}

async function executeSqlTool(connection, name, input = {}) {
    const cfg = buildRelationalConnectionConfig(connection);
    const schema = String(input.schema || cfg.schema || '').trim();
    const table = String(input.table || '').trim();
    const limit = clampLimit(input.limit, cfg.max_rows || 100);
    const decorate = (result, details = {}) => ({
        ...result,
        ...buildDatabaseCost(cfg, { limit, ...details })
    });

    if (cfg.database_type === 'sqlite') {
        return withSqlite(cfg, client => {
            if (name === 'db.list_tables') {
                return filterTableRows(client.prepare("SELECT name, type FROM sqlite_master WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%' ORDER BY type, name").all(), cfg);
            }
            if (name === 'db.count_tables') {
                const rows = filterTableRows(client.prepare("SELECT name, type FROM sqlite_master WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%' ORDER BY type, name").all(), cfg);
                return summarizeTableRows(rows);
            }
            if (name === 'db.describe_table') {
                assertTableAllowed(cfg, table);
                return filterDescribeRows(client.prepare(`PRAGMA table_info(${quoteIdentifier(table)})`).all(), cfg, table);
            }
            if (name === 'db.run_readonly_query') {
                const readonly = assertReadonlySql(input.sql);
                const governance = assertSqlGovernance(readonly, cfg);
                const sql = applySqlLimit(readonly, limit, 'sqlite');
                return decorate({ rows: maskSensitiveRows(client.prepare(sql).all(), cfg), limit }, {
                    operation: 'readonly_sql',
                    tables: governance.tables
                });
            }
            if (name === 'db.group_count') {
                assertTableAllowed(cfg, table);
                assertFieldAllowed(cfg, table, input.groupBy || input.group_by);
                const query = buildGroupCountSql({ ...input, limit }, 'sqlite', schema);
                return decorate({ ...query, rows: maskSensitiveRows(client.prepare(query.sql).all(), cfg) }, {
                    operation: 'group_count',
                    tables: [table],
                    fields: [input.groupBy || input.group_by]
                });
            }
            throw new Error(`Unsupported database MCP tool: ${name}`);
        });
    }

    if (cfg.database_type === 'postgres') {
        return withOperationTimeout(withPostgres(cfg, async client => {
            if (name === 'db.list_tables') {
                const result = await client.query(`
                    SELECT table_schema, table_name, table_type
                    FROM information_schema.tables
                    WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
                      AND ($1::text = '' OR table_schema = $1)
                    ORDER BY table_schema, table_name
                `, [schema]);
                return filterTableRows(result.rows, cfg);
            }
            if (name === 'db.count_tables') {
                const result = await client.query(`
                    SELECT table_schema, table_name, table_type
                    FROM information_schema.tables
                    WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
                      AND ($1::text = '' OR table_schema = $1)
                    ORDER BY table_schema, table_name
                `, [schema]);
                return summarizeTableRows(filterTableRows(result.rows, cfg));
            }
            if (name === 'db.describe_table') {
                assertTableAllowed(cfg, table);
                const result = await client.query(`
                    SELECT column_name, data_type, is_nullable, column_default
                    FROM information_schema.columns
                    WHERE table_name = $1 AND ($2::text = '' OR table_schema = $2)
                    ORDER BY ordinal_position
                `, [table, schema]);
                return filterDescribeRows(result.rows, cfg, table);
            }
            if (name === 'db.run_readonly_query') {
                const readonly = assertReadonlySql(input.sql);
                const governance = assertSqlGovernance(readonly, cfg);
                const result = await client.query(applySqlLimit(readonly, limit, 'postgres'));
                return decorate({ rows: maskSensitiveRows(result.rows, cfg), limit }, {
                    operation: 'readonly_sql',
                    tables: governance.tables
                });
            }
            if (name === 'db.group_count') {
                assertTableAllowed(cfg, table);
                assertFieldAllowed(cfg, table, input.groupBy || input.group_by);
                const query = buildGroupCountSql({ ...input, limit }, 'postgres', schema);
                const result = await client.query(query.sql);
                return decorate({ ...query, rows: maskSensitiveRows(result.rows, cfg) }, {
                    operation: 'group_count',
                    tables: [table],
                    fields: [input.groupBy || input.group_by]
                });
            }
            throw new Error(`Unsupported database MCP tool: ${name}`);
        }), cfg.query_timeout_ms, cfg, 'PostgreSQL database query');
    }

    if (cfg.database_type === 'mysql') {
        return withOperationTimeout(withMysql(cfg, async client => {
            if (name === 'db.list_tables') {
                const [rows] = await client.execute(`
                    SELECT table_schema, table_name, table_type
                    FROM information_schema.tables
                    WHERE table_schema = COALESCE(NULLIF(?, ''), DATABASE())
                    ORDER BY table_name
                `, [schema]);
                return filterTableRows(rows, cfg);
            }
            if (name === 'db.count_tables') {
                const [rows] = await client.execute(`
                    SELECT table_schema, table_name, table_type
                    FROM information_schema.tables
                    WHERE table_schema = COALESCE(NULLIF(?, ''), DATABASE())
                    ORDER BY table_schema, table_name
                `, [schema]);
                return summarizeTableRows(filterTableRows(rows, cfg));
            }
            if (name === 'db.describe_table') {
                assertTableAllowed(cfg, table);
                const [rows] = await client.execute(`
                    SELECT column_name, data_type, is_nullable, column_default
                    FROM information_schema.columns
                    WHERE table_name = ? AND table_schema = COALESCE(NULLIF(?, ''), DATABASE())
                    ORDER BY ordinal_position
                `, [table, schema]);
                return filterDescribeRows(rows, cfg, table);
            }
            if (name === 'db.run_readonly_query') {
                const readonly = assertReadonlySql(input.sql);
                const governance = assertSqlGovernance(readonly, cfg);
                const [rows] = await client.query(applySqlLimit(readonly, limit, 'mysql'));
                return decorate({ rows: maskSensitiveRows(rows, cfg), limit }, {
                    operation: 'readonly_sql',
                    tables: governance.tables
                });
            }
            if (name === 'db.group_count') {
                assertTableAllowed(cfg, table);
                assertFieldAllowed(cfg, table, input.groupBy || input.group_by);
                const query = buildGroupCountSql({ ...input, limit }, 'mysql', schema);
                const [rows] = await client.query(query.sql);
                return decorate({ ...query, rows: maskSensitiveRows(rows, cfg) }, {
                    operation: 'group_count',
                    tables: [table],
                    fields: [input.groupBy || input.group_by]
                });
            }
            throw new Error(`Unsupported database MCP tool: ${name}`);
        }), cfg.query_timeout_ms, cfg, 'MySQL database query');
    }

    if (cfg.database_type === 'sqlserver') {
        return withOperationTimeout(withSqlServer(cfg, async pool => {
            if (name === 'db.list_tables') {
                const result = await pool.request()
                    .input('schema', schema)
                    .query(`
                        SELECT TABLE_SCHEMA AS table_schema, TABLE_NAME AS table_name, TABLE_TYPE AS table_type
                        FROM INFORMATION_SCHEMA.TABLES
                        WHERE (@schema = '' OR TABLE_SCHEMA = @schema)
                        ORDER BY TABLE_SCHEMA, TABLE_NAME
                    `);
                return filterTableRows(result.recordset, cfg);
            }
            if (name === 'db.count_tables') {
                const result = await pool.request()
                    .input('schema', schema)
                    .query(`
                        SELECT TABLE_SCHEMA AS table_schema, TABLE_NAME AS table_name, TABLE_TYPE AS table_type
                        FROM INFORMATION_SCHEMA.TABLES
                        WHERE (@schema = '' OR TABLE_SCHEMA = @schema)
                        ORDER BY TABLE_SCHEMA, TABLE_NAME
                    `);
                return summarizeTableRows(filterTableRows(result.recordset, cfg));
            }
            if (name === 'db.describe_table') {
                assertTableAllowed(cfg, table);
                const result = await pool.request()
                    .input('table', table)
                    .input('schema', schema)
                    .query(`
                        SELECT COLUMN_NAME AS column_name, DATA_TYPE AS data_type, IS_NULLABLE AS is_nullable, COLUMN_DEFAULT AS column_default
                        FROM INFORMATION_SCHEMA.COLUMNS
                        WHERE TABLE_NAME = @table AND (@schema = '' OR TABLE_SCHEMA = @schema)
                        ORDER BY ORDINAL_POSITION
                    `);
                return filterDescribeRows(result.recordset, cfg, table);
            }
            if (name === 'db.run_readonly_query') {
                const readonly = assertReadonlySql(input.sql);
                const governance = assertSqlGovernance(readonly, cfg);
                const result = await pool.request().query(applySqlLimit(readonly, limit, 'sqlserver'));
                return decorate({ rows: maskSensitiveRows(result.recordset, cfg), limit }, {
                    operation: 'readonly_sql',
                    tables: governance.tables
                });
            }
            if (name === 'db.group_count') {
                assertTableAllowed(cfg, table);
                assertFieldAllowed(cfg, table, input.groupBy || input.group_by);
                const query = buildGroupCountSql({ ...input, limit }, 'sqlserver', schema);
                const result = await pool.request().query(query.sql);
                return decorate({ ...query, rows: maskSensitiveRows(result.recordset, cfg) }, {
                    operation: 'group_count',
                    tables: [table],
                    fields: [input.groupBy || input.group_by]
                });
            }
            throw new Error(`Unsupported database MCP tool: ${name}`);
        }), cfg.query_timeout_ms, cfg, 'SQL Server database query');
    }

    throw new Error(`Unsupported database type: ${cfg.database_type}`);
}

async function executeMongoTool(connection, name, input = {}) {
    const { MongoClient } = optionalRequire('mongodb', 'Install it with npm install mongodb.');
    const cfg = connection;
    const auth = connection.username
        ? `${encodeURIComponent(connection.username)}:${encodeURIComponent(connection.password || '')}@`
        : '';
    const uri = `mongodb://${auth}${connection.host}:${connection.port || DEFAULT_PORTS.mongodb}`;
    const timeoutMs = getConnectionTimeoutMs(connection);
    const client = new MongoClient(uri, {
        // 默认校验证书防 MITM；仅当用户显式信任自签名时才放行
        tls: Boolean(connection.ssl),
        ...(connection.ssl && connection.ssl_allow_self_signed ? { tlsAllowInvalidCertificates: true } : {}),
        serverSelectionTimeoutMS: timeoutMs,
        connectTimeoutMS: timeoutMs,
        socketTimeoutMS: timeoutMs
    });
    return withOperationTimeout((async () => {
        await client.connect();
        try {
        const database = client.db(connection.database_name);
        if (name === 'db.list_collections') {
            return filterTableRows(await database.listCollections({}, { nameOnly: true }).toArray(), cfg);
        }
        if (name === 'db.count_collections') {
            const collections = filterTableRows(await database.listCollections({}, { nameOnly: true }).toArray(), cfg);
            return { total: collections.length, rows: collections };
        }
        if (name === 'db.sample_collection') {
            assertTableAllowed(cfg, input.collection);
            const limit = clampLimit(input.limit, 20, 100);
            const rows = await database.collection(String(input.collection || '')).find({}).limit(limit).toArray();
            return {
                rows: maskSensitiveRows(rows, cfg),
                limit,
                ...buildDatabaseCost(cfg, {
                    operation: 'sample_collection',
                    tables: [String(input.collection || '')],
                    limit
                })
            };
        }
        if (name === 'db.aggregate') {
            assertTableAllowed(cfg, input.collection);
            const limit = clampLimit(input.limit, 100);
            const pipeline = Array.isArray(input.pipeline) ? input.pipeline : [];
            const blockedStage = pipeline.some(stage => {
                const keys = stage && typeof stage === 'object' ? Object.keys(stage) : [];
                return keys.some(key => ['$out', '$merge'].includes(key));
            });
            if (blockedStage) throw new Error('MongoDB aggregation cannot use write stages such as $out or $merge.');
            const rows = await database.collection(String(input.collection || '')).aggregate([...pipeline, { $limit: limit }]).toArray();
            return {
                rows: maskSensitiveRows(rows, cfg),
                limit,
                ...buildDatabaseCost(cfg, {
                    operation: 'aggregate',
                    tables: [String(input.collection || '')],
                    limit
                })
            };
        }
        throw new Error(`Unsupported database MCP tool: ${name}`);
        } finally {
            await client.close();
        }
    })(), cfg.query_timeout_ms || timeoutMs, cfg, 'MongoDB database query');
}

async function testDatabaseConnection(connection) {
    const timeoutMs = getDatabaseTestTimeoutMs();
    const testConnection = buildDatabaseTestConnectionConfig(connection);
    if (testConnection.database_type === 'sqlite') {
        return withSqlite(testConnection, client => {
            client.prepare('SELECT 1 AS ok').get();
            return { database_type: testConnection.database_type };
        });
    }
    if (testConnection.database_type === 'postgres') {
        return withOperationTimeout(withPostgres(testConnection, async client => {
            await client.query('SELECT 1 AS ok');
            return { database_type: testConnection.database_type };
        }), timeoutMs, testConnection, 'PostgreSQL connection test');
    }
    if (testConnection.database_type === 'mysql') {
        return withOperationTimeout(withMysql(testConnection, async client => {
            await client.query({ sql: 'SELECT 1 AS ok', timeout: timeoutMs });
            return { database_type: testConnection.database_type };
        }), timeoutMs, testConnection, 'MySQL connection test');
    }
    if (testConnection.database_type === 'sqlserver') {
        return withOperationTimeout(withSqlServer(testConnection, async pool => {
            await pool.request().query('SELECT 1 AS ok');
            return { database_type: testConnection.database_type };
        }), timeoutMs, testConnection, 'SQL Server connection test');
    }
    if (testConnection.database_type === 'mongodb') {
        const { MongoClient } = optionalRequire('mongodb', 'Install it with npm install mongodb.');
        const auth = testConnection.username
            ? `${encodeURIComponent(testConnection.username)}:${encodeURIComponent(testConnection.password || '')}@`
            : '';
        const uri = `mongodb://${auth}${testConnection.host}:${testConnection.port || DEFAULT_PORTS.mongodb}`;
        const client = new MongoClient(uri, {
            // 默认校验证书防 MITM；仅当用户显式信任自签名时才放行
            tls: Boolean(testConnection.ssl),
            ...(testConnection.ssl && testConnection.ssl_allow_self_signed ? { tlsAllowInvalidCertificates: true } : {}),
            serverSelectionTimeoutMS: timeoutMs,
            connectTimeoutMS: timeoutMs,
            socketTimeoutMS: timeoutMs
        });
        return withOperationTimeout((async () => {
            await client.connect();
            try {
                await client.db(testConnection.database_name).command({ ping: 1 });
                return { database_type: testConnection.database_type };
            } finally {
                await client.close();
            }
        })(), timeoutMs, testConnection, 'MongoDB connection test');
    }
    throw new Error(`Unsupported database type: ${testConnection.database_type}`);
}

async function executeDatabaseMcpTool(server, name, input = {}) {
    const connection = getDatabaseConnectionForServer(server.id, { includeSecret: true });
    if (!connection) throw new Error('Database MCP connection not found.');
    if (connection.database_type === 'mongodb') {
        return executeMongoTool(connection, name, input);
    }
    return executeSqlTool(connection, name, input);
}

function validateDatabaseConnectionPayload(payload, user) {
    const type = normalizeDatabaseType(payload.database_type || payload.databaseType);
    if (!type) throw createDatabaseMcpError('请选择数据库类型。', 'DB_TYPE_REQUIRED', 400);
    const host = String(payload.host || '').trim();
    const databaseName = String(payload.database_name || payload.databaseName || '').trim();
    const username = String(payload.username || '').trim();
    const port = parseInt(payload.port || DEFAULT_PORTS[type] || 0, 10) || DEFAULT_PORTS[type] || 0;
    const schema = String(payload.schema || '').trim();
    const maxRows = clampLimit(payload.max_rows || payload.maxRows, 100);
    const tableAllowlist = normalizePolicyList(payload.table_allowlist || payload.tableAllowlist || payload.allowed_tables || payload.allowedTables);
    const fieldAllowlist = normalizeFieldAllowlist(payload.field_allowlist || payload.fieldAllowlist || payload.allowed_fields || payload.allowedFields);
    const sensitiveFields = normalizePolicyList(payload.sensitive_fields || payload.sensitiveFields);
    const rowPolicyHint = String(payload.row_policy_hint || payload.rowPolicyHint || '').trim().slice(0, 500);
    const queryTimeoutMs = clampTimeoutMs(payload.query_timeout_ms || payload.queryTimeoutMs || 20000);
    const sqlCostEstimate = payload.sql_cost_estimate === false || payload.sql_cost_estimate === 'false'
        || payload.sqlCostEstimate === false || payload.sqlCostEstimate === 'false'
        ? false
        : true;
    const ssl = payload.ssl === true || payload.ssl === 'true';
    // 显式「信任自签名证书」开关，默认关闭（即校验证书防 MITM）
    const allowSelfSigned = payload.allow_self_signed === true || payload.allow_self_signed === 'true'
        || payload.allowSelfSigned === true || payload.allowSelfSigned === 'true';

    if (type === 'sqlite') {
        if (!databaseName) throw createDatabaseMcpError('请填写 SQLite 文件路径。', 'DB_SQLITE_PATH_REQUIRED', 400);
        resolveSafeSqlitePath(databaseName);
    } else {
        if (!host || !databaseName) throw createDatabaseMcpError('请填写数据库主机和数据库名。', 'DB_HOST_OR_NAME_REQUIRED', 400);
        if (!username && type !== 'mongodb') throw createDatabaseMcpError('请填写数据库用户名。', 'DB_USERNAME_REQUIRED', 400);
        const restrictPrivateHostsToAdmin = process.env.MCP_RESTRICT_PRIVATE_DATABASE_HOSTS_TO_ADMIN !== 'false';
        if (restrictPrivateHostsToAdmin && isPrivateHost(host) && !isAdmin(user)) {
            throw createDatabaseMcpError('普通用户不能配置内网或本机数据库地址。', 'MCP_PRIVATE_HOST_RESTRICTED', 403);
        }
    }

    return {
        database_type: type,
        host,
        port,
        database_name: databaseName,
        username,
        password: String(payload.password || ''),
        options: {
            schema,
            ssl,
            maxRows,
            allowSelfSigned,
            tableAllowlist,
            fieldAllowlist,
            sensitiveFields,
            rowPolicyHint,
            queryTimeoutMs,
            sqlCostEstimate
        }
    };
}

module.exports = {
    DEFAULT_PORTS,
    executeDatabaseMcpTool,
    buildDatabaseTestConnectionConfig,
    getDatabaseConnectionForServer,
    listDatabaseMcpTools,
    normalizeDatabaseConnection,
    normalizeDatabaseType,
    normalizeDatabaseConnectionError,
    testDatabaseConnection,
    validateDatabaseConnectionPayload
};
