const path = require('path');
const Database = require('better-sqlite3');
const { db, dataDir } = require('../db');
const { decryptSecret, isPrivateHost } = require('../security');

const DEFAULT_PORTS = {
    postgres: 5432,
    mysql: 3306,
    sqlserver: 1433,
    mongodb: 27017,
    sqlite: 0
};
const DATABASE_CONNECT_TIMEOUT_MS = Math.max(1000, Number.parseInt(process.env.MCP_DATABASE_CONNECT_TIMEOUT_MS || '10000', 10) || 10000);

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

    if (['ETIMEDOUT', 'ETIMEOUT', 'ESOCKETTIMEDOUT'].includes(rawCode) || /timed?\s*out|timeout/i.test(rawMessage)) {
        return {
            ...base,
            status: 504,
            code: 'DB_CONNECTION_TIMEOUT',
            message: `数据库连接超时：${diagnostics.host || '-'}:${diagnostics.port || '-'}`,
            hint: '请检查 Pivot 服务器到数据库主机的网络路由、防火墙、安全组和端口映射；可通过 MCP_DATABASE_CONNECT_TIMEOUT_MS 临时调大超时时间。'
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
    }
];

const MONGO_TOOL_DEFINITIONS = [
    {
        name: 'db.list_collections',
        description: '列出 MongoDB 数据库中的集合。',
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

function normalizeDatabaseConnection(row, { includeSecret = false } = {}) {
    if (!row) return null;
    const options = parseOptions(row.options);
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
        max_rows: Number(options.maxRows || 100),
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

function applySqlLimit(sql, limit, dialect) {
    if (/\blimit\s+\d+\b/i.test(sql) || /^\s*(show|describe|desc|explain)\b/i.test(sql)) return sql;
    if (dialect === 'sqlserver') {
        return sql.replace(/^\s*select\s+/i, `SELECT TOP (${limit}) `);
    }
    return `${sql}\nLIMIT ${limit}`;
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
        ssl: Boolean(connection.ssl || options.ssl)
    };
}

async function withPostgres(connection, handler) {
    const { Client } = optionalRequire('pg', 'Install it with npm install pg.');
    const client = new Client({
        host: connection.host,
        port: connection.port || DEFAULT_PORTS.postgres,
        database: connection.database_name,
        user: connection.username,
        password: connection.password,
        ssl: connection.ssl ? { rejectUnauthorized: false } : false,
        connectionTimeoutMillis: DATABASE_CONNECT_TIMEOUT_MS
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
    const client = await mysql.createConnection({
        host: connection.host,
        port: connection.port || DEFAULT_PORTS.mysql,
        database: connection.database_name,
        user: connection.username,
        password: connection.password,
        ssl: connection.ssl ? {} : undefined,
        connectTimeout: DATABASE_CONNECT_TIMEOUT_MS
    });
    try {
        return await handler(client);
    } finally {
        await client.end();
    }
}

async function withSqlServer(connection, handler) {
    const sql = optionalRequire('mssql', 'Install it with npm install mssql.');
    const pool = await sql.connect({
        server: connection.host,
        port: connection.port || DEFAULT_PORTS.sqlserver,
        database: connection.database_name,
        user: connection.username,
        password: connection.password,
        options: {
            encrypt: Boolean(connection.ssl),
            trustServerCertificate: true
        },
        connectionTimeout: DATABASE_CONNECT_TIMEOUT_MS,
        requestTimeout: DATABASE_CONNECT_TIMEOUT_MS
    });
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

    if (cfg.database_type === 'sqlite') {
        return withSqlite(cfg, client => {
            if (name === 'db.list_tables') {
                return client.prepare("SELECT name, type FROM sqlite_master WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%' ORDER BY type, name").all();
            }
            if (name === 'db.describe_table') {
                return client.prepare(`PRAGMA table_info(${quoteIdentifier(table)})`).all();
            }
            if (name === 'db.run_readonly_query') {
                const sql = applySqlLimit(assertReadonlySql(input.sql), limit, 'sqlite');
                return { rows: client.prepare(sql).all(), limit };
            }
            throw new Error(`Unsupported database MCP tool: ${name}`);
        });
    }

    if (cfg.database_type === 'postgres') {
        return withPostgres(cfg, async client => {
            if (name === 'db.list_tables') {
                const result = await client.query(`
                    SELECT table_schema, table_name, table_type
                    FROM information_schema.tables
                    WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
                      AND ($1::text = '' OR table_schema = $1)
                    ORDER BY table_schema, table_name
                `, [schema]);
                return result.rows;
            }
            if (name === 'db.describe_table') {
                const result = await client.query(`
                    SELECT column_name, data_type, is_nullable, column_default
                    FROM information_schema.columns
                    WHERE table_name = $1 AND ($2::text = '' OR table_schema = $2)
                    ORDER BY ordinal_position
                `, [table, schema]);
                return result.rows;
            }
            if (name === 'db.run_readonly_query') {
                const result = await client.query(applySqlLimit(assertReadonlySql(input.sql), limit, 'postgres'));
                return { rows: result.rows, limit };
            }
            throw new Error(`Unsupported database MCP tool: ${name}`);
        });
    }

    if (cfg.database_type === 'mysql') {
        return withMysql(cfg, async client => {
            if (name === 'db.list_tables') {
                const [rows] = await client.execute(`
                    SELECT table_schema, table_name, table_type
                    FROM information_schema.tables
                    WHERE table_schema = COALESCE(NULLIF(?, ''), DATABASE())
                    ORDER BY table_name
                `, [schema]);
                return rows;
            }
            if (name === 'db.describe_table') {
                const [rows] = await client.execute(`
                    SELECT column_name, data_type, is_nullable, column_default
                    FROM information_schema.columns
                    WHERE table_name = ? AND table_schema = COALESCE(NULLIF(?, ''), DATABASE())
                    ORDER BY ordinal_position
                `, [table, schema]);
                return rows;
            }
            if (name === 'db.run_readonly_query') {
                const [rows] = await client.query(applySqlLimit(assertReadonlySql(input.sql), limit, 'mysql'));
                return { rows, limit };
            }
            throw new Error(`Unsupported database MCP tool: ${name}`);
        });
    }

    if (cfg.database_type === 'sqlserver') {
        return withSqlServer(cfg, async pool => {
            if (name === 'db.list_tables') {
                const result = await pool.request()
                    .input('schema', schema)
                    .query(`
                        SELECT TABLE_SCHEMA AS table_schema, TABLE_NAME AS table_name, TABLE_TYPE AS table_type
                        FROM INFORMATION_SCHEMA.TABLES
                        WHERE (@schema = '' OR TABLE_SCHEMA = @schema)
                        ORDER BY TABLE_SCHEMA, TABLE_NAME
                    `);
                return result.recordset;
            }
            if (name === 'db.describe_table') {
                const result = await pool.request()
                    .input('table', table)
                    .input('schema', schema)
                    .query(`
                        SELECT COLUMN_NAME AS column_name, DATA_TYPE AS data_type, IS_NULLABLE AS is_nullable, COLUMN_DEFAULT AS column_default
                        FROM INFORMATION_SCHEMA.COLUMNS
                        WHERE TABLE_NAME = @table AND (@schema = '' OR TABLE_SCHEMA = @schema)
                        ORDER BY ORDINAL_POSITION
                    `);
                return result.recordset;
            }
            if (name === 'db.run_readonly_query') {
                const result = await pool.request().query(applySqlLimit(assertReadonlySql(input.sql), limit, 'sqlserver'));
                return { rows: result.recordset, limit };
            }
            throw new Error(`Unsupported database MCP tool: ${name}`);
        });
    }

    throw new Error(`Unsupported database type: ${cfg.database_type}`);
}

async function executeMongoTool(connection, name, input = {}) {
    const { MongoClient } = optionalRequire('mongodb', 'Install it with npm install mongodb.');
    const auth = connection.username
        ? `${encodeURIComponent(connection.username)}:${encodeURIComponent(connection.password || '')}@`
        : '';
    const uri = `mongodb://${auth}${connection.host}:${connection.port || DEFAULT_PORTS.mongodb}`;
    const client = new MongoClient(uri, { serverSelectionTimeoutMS: DATABASE_CONNECT_TIMEOUT_MS });
    await client.connect();
    try {
        const database = client.db(connection.database_name);
        if (name === 'db.list_collections') {
            return await database.listCollections({}, { nameOnly: true }).toArray();
        }
        if (name === 'db.sample_collection') {
            const limit = clampLimit(input.limit, 20, 100);
            return await database.collection(String(input.collection || '')).find({}).limit(limit).toArray();
        }
        if (name === 'db.aggregate') {
            const limit = clampLimit(input.limit, 100);
            const pipeline = Array.isArray(input.pipeline) ? input.pipeline : [];
            const blockedStage = pipeline.some(stage => {
                const keys = stage && typeof stage === 'object' ? Object.keys(stage) : [];
                return keys.some(key => ['$out', '$merge'].includes(key));
            });
            if (blockedStage) throw new Error('MongoDB aggregation cannot use write stages such as $out or $merge.');
            return await database.collection(String(input.collection || '')).aggregate([...pipeline, { $limit: limit }]).toArray();
        }
        throw new Error(`Unsupported database MCP tool: ${name}`);
    } finally {
        await client.close();
    }
}

async function testDatabaseConnection(connection) {
    if (connection.database_type === 'sqlite') {
        return withSqlite(connection, client => {
            client.prepare('SELECT 1 AS ok').get();
            return { database_type: connection.database_type };
        });
    }
    if (connection.database_type === 'postgres') {
        return withPostgres(connection, async client => {
            await client.query('SELECT 1 AS ok');
            return { database_type: connection.database_type };
        });
    }
    if (connection.database_type === 'mysql') {
        return withMysql(connection, async client => {
            await client.execute('SELECT 1 AS ok');
            return { database_type: connection.database_type };
        });
    }
    if (connection.database_type === 'sqlserver') {
        return withSqlServer(connection, async pool => {
            await pool.request().query('SELECT 1 AS ok');
            return { database_type: connection.database_type };
        });
    }
    if (connection.database_type === 'mongodb') {
        const { MongoClient } = optionalRequire('mongodb', 'Install it with npm install mongodb.');
        const auth = connection.username
            ? `${encodeURIComponent(connection.username)}:${encodeURIComponent(connection.password || '')}@`
            : '';
        const uri = `mongodb://${auth}${connection.host}:${connection.port || DEFAULT_PORTS.mongodb}`;
        const client = new MongoClient(uri, { serverSelectionTimeoutMS: DATABASE_CONNECT_TIMEOUT_MS });
        await client.connect();
        try {
            await client.db(connection.database_name).command({ ping: 1 });
            return { database_type: connection.database_type };
        } finally {
            await client.close();
        }
    }
    throw new Error(`Unsupported database type: ${connection.database_type}`);
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
    const ssl = payload.ssl === true || payload.ssl === 'true';

    if (type === 'sqlite') {
        if (!databaseName) throw createDatabaseMcpError('请填写 SQLite 文件路径。', 'DB_SQLITE_PATH_REQUIRED', 400);
        resolveSafeSqlitePath(databaseName);
    } else {
        if (!host || !databaseName) throw createDatabaseMcpError('请填写数据库主机和数据库名。', 'DB_HOST_OR_NAME_REQUIRED', 400);
        if (!username && type !== 'mongodb') throw createDatabaseMcpError('请填写数据库用户名。', 'DB_USERNAME_REQUIRED', 400);
        if (process.env.MCP_RESTRICT_PRIVATE_DATABASE_HOSTS_TO_ADMIN === 'true' && isPrivateHost(host) && user?.role !== 'admin') {
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
        options: { schema, ssl, maxRows }
    };
}

module.exports = {
    DEFAULT_PORTS,
    executeDatabaseMcpTool,
    getDatabaseConnectionForServer,
    listDatabaseMcpTools,
    normalizeDatabaseConnection,
    normalizeDatabaseType,
    normalizeDatabaseConnectionError,
    testDatabaseConnection,
    validateDatabaseConnectionPayload
};
