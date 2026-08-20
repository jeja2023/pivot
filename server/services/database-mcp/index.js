const Database = require('better-sqlite3');
const path = require('path');
const { isPrivateHost } = require('../../security');
const { isAdmin } = require('../../permissions');

const {
    DEFAULT_PORTS,
    assertSafeDatabaseHost,
    databaseSafeLookup,
    getConnectionOwnerAsync,
    createDatabaseMcpError,
    databaseConnectionDiagnostics,
    normalizeDatabaseConnectionError,
    normalizeDatabaseType,
    normalizePolicyList,
    normalizeFieldAllowlist,
    clampTimeoutMs,
    normalizeDatabaseConnection
} = require('./connection-policy');
const { SQL_TOOL_DEFINITIONS, MONGO_TOOL_DEFINITIONS } = require('./tool-definitions');
const {
    clampLimit,
    assertReadonlySql,
    buildGroupCountSql,
    applySqlLimit,
    quoteIdentifier,
    assertTableAllowed,
    assertFieldAllowed,
    filterTableRows,
    summarizeTableRows,
    filterDescribeRows,
    maskSensitiveRows,
    assertSqlGovernance,
    buildDatabaseCost
} = require('./sql-governance');
const {
    resolveSafeSqlitePath,
    buildRelationalConnectionConfig,
    getConnectionTimeoutMs,
    getDatabaseTestTimeoutMs,
    buildDatabaseTestConnectionConfig
} = require('./connection-builders');


async function getDatabaseConnectionForServerAsync(serverId, { includeSecret = false } = {}) {
    const { queryOne } = require('../../db/client');
    const row = await queryOne(`
        SELECT * FROM mcp_database_connections
        WHERE mcp_server_id = ? AND status != 'deleted'
    `, [serverId]);
    return normalizeDatabaseConnection(row, { includeSecret });
}

async function listDatabaseMcpTools(server) {
    const connection = server?.database_connection || await getDatabaseConnectionForServerAsync(server.id);
    if (!connection) throw new Error('未找到指定的数据库 MCP 连接配置。');
    return listDatabaseConnectionMcpTools(connection);
}

function listDatabaseConnectionMcpTools(connection) {
    return connection.database_type === 'mongodb' ? MONGO_TOOL_DEFINITIONS : SQL_TOOL_DEFINITIONS;
}

function optionalRequire(packageName, installHint) {
    try {
        return require(packageName);
    } catch (e) {
        if (e.code === 'MODULE_NOT_FOUND') {
            throw new Error(`${packageName} 驱动程序未安装。${installHint}`);
        }
        throw e;
    }
}

function createTimeoutError(connection, timeoutMs, phase = 'database connection test') {
    const err = new Error(`${phase}执行超时（${timeoutMs}毫秒）`);
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
    const owner = await getConnectionOwnerAsync(connection);
    // 连接前再次解析校验，缓解配置入库后 DNS 被改写（rebinding）的 SSRF。
    await assertSafeDatabaseHost(connection.host, owner);
    const client = new Client({
        host: connection.host,
        port: connection.port || DEFAULT_PORTS.postgres,
        database: connection.database_name,
        user: connection.username,
        password: connection.password,
        // 默认校验证书防止 MITM；仅当用户显式信任自签名时才放行
        ssl: connection.ssl ? { rejectUnauthorized: !connection.ssl_allow_self_signed } : false,
        connectionTimeoutMillis: timeoutMs,
        // 握手阶段对解析出的 IP 再次校验，关闭 DNS rebinding。
        lookup: databaseSafeLookup(owner)
    });
    let connected = false;
    try {
        await client.connect();
        connected = true;
        return await handler(client);
    } finally {
        // 即使超时先于 connect 完成（race 失败），也确保底层连接被关闭，避免句柄泄漏。
        try {
            await client.end();
        } catch (e) {
            if (connected) throw e;
        }
    }
}

async function withMysql(connection, handler) {
    const mysql = optionalRequire('mysql2/promise', 'Install it with npm install mysql2.');
    const timeoutMs = getConnectionTimeoutMs(connection);
    const owner = await getConnectionOwnerAsync(connection);
    // mysql2 不支持自定义 dns lookup 钩子，连接前再次解析校验以缓解 DNS rebinding。
    await assertSafeDatabaseHost(connection.host, owner);
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
        // 确保连接句柄在超时胜出时也被释放。
        try {
            await client.end();
        } catch (e) {
            // 忽略关闭阶段的异常，避免掩盖原始（如超时）错误。
        }
    }
}

async function withSqlServer(connection, handler) {
    const sql = optionalRequire('mssql', 'Install it with npm install mssql.');
    const timeoutMs = getConnectionTimeoutMs(connection);
    const owner = await getConnectionOwnerAsync(connection);
    // mssql/tedious 不便注入 dns lookup 钩子，连接前再次解析校验以缓解 DNS rebinding。
    await assertSafeDatabaseHost(connection.host, owner);
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
    let connected = false;
    try {
        await pool.connect();
        connected = true;
        return await handler(pool);
    } finally {
        // 即使超时先于 connect 完成（race 失败），也确保连接池被关闭，避免句柄泄漏。
        try {
            await pool.close();
        } catch (e) {
            if (connected) throw e;
        }
    }
}

async function withSqlite(connection, handler) {
    const sqlitePath = connection.trusted_local_authorization === true
        ? path.resolve(String(connection.database_name || ''))
        : resolveSafeSqlitePath(connection.database_name);
    const client = new Database(sqlitePath, { readonly: true, fileMustExist: true });
    try {
        // better-sqlite3 为同步驱动，但统一 await 句柄以便共享分发器（runRelationalTool）
        // 在异步处理完成后再关闭连接，避免在结果落地前提前 close。
        return await handler(client);
    } finally {
        client.close();
    }
}

// 关系型方言适配器：把四种数据库（sqlite/postgres/mysql/sqlserver）的差异收敛为
//  - withConnection：连接包装器（含 SSRF 复核、超时、句柄清理）
//  - timeoutPhase：用于 withOperationTimeout 的阶段名；sqlite 为本地同步驱动，无需外层超时
//  - dialect：传给 applySqlLimit / buildGroupCountSql 的方言串
//  - runQuery(client, sql, params)：执行 SQL 并归一化为「行数组」
//  - listTablesSql(schema) / describeTableSql(table, schema)：元数据查询的 { sql, params }
// 这样 5 个工具（list_tables/count_tables/describe_table/run_readonly_query/group_count）
// 的治理（allowlist/只读校验/SQL 治理）与脱敏逻辑只需在 runRelationalTool 里写一份。
const RELATIONAL_DIALECTS = {
    sqlite: {
        dialect: 'sqlite',
        timeoutPhase: null,
        withConnection: withSqlite,
        runQuery: (client, sql, params = []) => client.prepare(sql).all(...params),
        listTablesSql: () => ({
            sql: "SELECT name, type FROM sqlite_master WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%' ORDER BY type, name",
            params: []
        }),
        describeTableSql: (table) => ({
            sql: `PRAGMA table_info(${quoteIdentifier(table)})`,
            params: []
        })
    },
    postgres: {
        dialect: 'postgres',
        timeoutPhase: 'PostgreSQL database query',
        withConnection: withPostgres,
        runQuery: async (client, sql, params = []) => (await client.query(sql, params)).rows,
        listTablesSql: (schema) => ({
            sql: `
                SELECT table_schema, table_name, table_type
                FROM information_schema.tables
                WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
                  AND ($1::text = '' OR table_schema = $1)
                ORDER BY table_schema, table_name
            `,
            params: [schema]
        }),
        describeTableSql: (table, schema) => ({
            sql: `
                SELECT column_name, data_type, is_nullable, column_default
                FROM information_schema.columns
                WHERE table_name = $1 AND ($2::text = '' OR table_schema = $2)
                ORDER BY ordinal_position
            `,
            params: [table, schema]
        })
    },
    mysql: {
        dialect: 'mysql',
        timeoutPhase: 'MySQL database query',
        withConnection: withMysql,
        runQuery: async (client, sql, params = []) => {
            const [rows] = await client.query(sql, params);
            return rows;
        },
        listTablesSql: (schema) => ({
            sql: `
                SELECT table_schema, table_name, table_type
                FROM information_schema.tables
                WHERE table_schema = COALESCE(NULLIF(?, ''), DATABASE())
                ORDER BY table_schema, table_name
            `,
            params: [schema]
        }),
        describeTableSql: (table, schema) => ({
            sql: `
                SELECT column_name, data_type, is_nullable, column_default
                FROM information_schema.columns
                WHERE table_name = ? AND table_schema = COALESCE(NULLIF(?, ''), DATABASE())
                ORDER BY ordinal_position
            `,
            params: [table, schema]
        })
    },
    sqlserver: {
        dialect: 'sqlserver',
        timeoutPhase: 'SQL Server database query',
        withConnection: withSqlServer,
        // sqlserver 使用具名参数 @name，params 形如 [{ name, value }]。
        runQuery: async (pool, sql, params = []) => {
            const request = pool.request();
            for (const { name: paramName, value } of params) request.input(paramName, value);
            return (await request.query(sql)).recordset;
        },
        listTablesSql: (schema) => ({
            sql: `
                SELECT TABLE_SCHEMA AS table_schema, TABLE_NAME AS table_name, TABLE_TYPE AS table_type
                FROM INFORMATION_SCHEMA.TABLES
                WHERE (@schema = '' OR TABLE_SCHEMA = @schema)
                ORDER BY TABLE_SCHEMA, TABLE_NAME
            `,
            params: [{ name: 'schema', value: schema }]
        }),
        describeTableSql: (table, schema) => ({
            sql: `
                SELECT COLUMN_NAME AS column_name, DATA_TYPE AS data_type, IS_NULLABLE AS is_nullable, COLUMN_DEFAULT AS column_default
                FROM INFORMATION_SCHEMA.COLUMNS
                WHERE TABLE_NAME = @table AND (@schema = '' OR TABLE_SCHEMA = @schema)
                ORDER BY ORDINAL_POSITION
            `,
            params: [{ name: 'table', value: table }, { name: 'schema', value: schema }]
        })
    }
};

// 5 个关系型工具的统一分发：治理 + 取行 + 脱敏 + 成本装饰只写一份，方言差异全部走 adapter。
async function runRelationalTool(adapter, client, name, ctx) {
    const { cfg, schema, table, limit, input, decorate } = ctx;

    if (name === 'db.list_tables') {
        const { sql, params } = adapter.listTablesSql(schema);
        return filterTableRows(await adapter.runQuery(client, sql, params), cfg);
    }
    if (name === 'db.count_tables') {
        const { sql, params } = adapter.listTablesSql(schema);
        return summarizeTableRows(filterTableRows(await adapter.runQuery(client, sql, params), cfg));
    }
    if (name === 'db.describe_table') {
        assertTableAllowed(cfg, table);
        const { sql, params } = adapter.describeTableSql(table, schema);
        return filterDescribeRows(await adapter.runQuery(client, sql, params), cfg, table);
    }
    if (name === 'db.run_readonly_query') {
        const readonly = assertReadonlySql(input.sql);
        const governance = assertSqlGovernance(readonly, cfg);
        // 多取一行用于准确标记导入/分析结果是否触达上限，返回给调用方时仍严格限制为 limit 行。
        const sql = applySqlLimit(readonly, limit + 1, adapter.dialect);
        const rawRows = maskSensitiveRows(await adapter.runQuery(client, sql), cfg);
        const truncated = rawRows.length > limit;
        return decorate({ rows: truncated ? rawRows.slice(0, limit) : rawRows, limit, truncated }, {
            operation: 'readonly_sql',
            tables: governance.tables
        });
    }
    if (name === 'db.group_count') {
        assertTableAllowed(cfg, table);
        assertFieldAllowed(cfg, table, input.groupBy || input.group_by);
        const query = buildGroupCountSql({ ...input, limit }, adapter.dialect, schema);
        return decorate({ ...query, rows: maskSensitiveRows(await adapter.runQuery(client, query.sql), cfg) }, {
            operation: 'group_count',
            tables: [table],
            fields: [input.groupBy || input.group_by]
        });
    }
    throw new Error(`不支持的数据库 MCP 工具操作: ${name}`);
}

async function executeSqlTool(connection, name, input = {}) {
    const cfg = buildRelationalConnectionConfig(connection);
    const adapter = RELATIONAL_DIALECTS[cfg.database_type];
    if (!adapter) throw new Error(`不支持的数据库类型: ${cfg.database_type}`);

    const schema = String(input.schema || cfg.schema || '').trim();
    const table = String(input.table || '').trim();
    const limit = clampLimit(input.limit, cfg.max_rows || 100);
    const decorate = (result, details = {}) => ({
        ...result,
        ...buildDatabaseCost(cfg, { limit, ...details })
    });
    const ctx = { cfg, schema, table, limit, input, decorate };

    const run = adapter.withConnection(cfg, client => runRelationalTool(adapter, client, name, ctx));
    return adapter.timeoutPhase
        ? withOperationTimeout(run, cfg.query_timeout_ms, cfg, adapter.timeoutPhase)
        : run;
}

async function executeMongoTool(connection, name, input = {}) {
    const { MongoClient } = optionalRequire('mongodb', 'Install it with npm install mongodb.');
    const cfg = connection;
    // 连接前再次解析校验，拦截内网/loopback/云元数据 SSRF 与 DNS rebinding。
    await assertSafeDatabaseHost(connection.host, await getConnectionOwnerAsync(connection));
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
            if (blockedStage) throw new Error('MongoDB 聚合操作禁止使用 $out 或 $merge 等写入阶段。');
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
        throw new Error(`不支持的数据库 MCP 工具操作: ${name}`);
        } finally {
            await client.close();
        }
    })(), cfg.query_timeout_ms || timeoutMs, cfg, 'MongoDB database query');
}

async function testDatabaseConnection(connection) {
    const timeoutMs = getDatabaseTestTimeoutMs();
    const testConnection = buildDatabaseTestConnectionConfig(connection);
    if (testConnection.database_type === 'sqlite') {
        // better-sqlite3 为同步驱动，仍包一层超时以与其他方言保持一致并防止极端阻塞。
        return withOperationTimeout(Promise.resolve().then(() => withSqlite(testConnection, client => {
            client.prepare('SELECT 1 AS ok').get();
            return { database_type: testConnection.database_type };
        })), timeoutMs, testConnection, 'SQLite connection test');
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
        // 连接前再次解析校验，拦截内网/loopback/云元数据 SSRF 与 DNS rebinding。
        await assertSafeDatabaseHost(testConnection.host, await getConnectionOwnerAsync(testConnection));
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
    throw new Error(`不支持的数据库类型: ${testConnection.database_type}`);
}

async function executeDatabaseMcpTool(server, name, input = {}) {
    const connection = server?.database_connection || await getDatabaseConnectionForServerAsync(server.id, { includeSecret: true });
    if (!connection) throw new Error('未找到指定的数据库 MCP 连接配置。');
    return executeDatabaseConnectionTool(connection, name, input);
}

async function executeDatabaseConnectionTool(connection, name, input = {}) {
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
        // 字面量主机名的快速拦截（无需 DNS、同步）：普通用户禁配内网/本机地址。
        // 真正的 DNS 解析后 IP 校验（防把内网/loopback/云元数据藏在域名背后的 SSRF，并防 TOCTOU/DNS-rebinding）
        // 在连接时由各驱动助手统一执行（assertSafeDatabaseHost / databaseSafeLookup），此处保持同步契约。
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
        // 携带已校验的请求用户，供测试连接（testDatabaseConnection）阶段沿用同一内网放行策略；
        // 该字段不会被持久化（入库仅取明确字段），仅在内存对象中传递。
        _owner: user || null,
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
    executeDatabaseConnectionTool,
    buildDatabaseTestConnectionConfig,
    getDatabaseConnectionForServerAsync,
    listDatabaseConnectionMcpTools,
    listDatabaseMcpTools,
    normalizeDatabaseConnection,
    normalizeDatabaseType,
    normalizeDatabaseConnectionError,
    testDatabaseConnection,
    validateDatabaseConnectionPayload
};
