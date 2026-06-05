// MCP 安全测试
const {
    Sqlite,
    assert,
    assertSafeMcpOutboundUrl,
    buildDatabaseTestConnectionConfig,
    buildFallbackDataQueryInput,
    buildGenericDatabaseTools,
    createMcpRouter,
    createPromptsRouter,
    db,
    detectStrongDataQueryIntent,
    filterMcpToolsForChatIntent,
    filterMcpToolsForPlanner,
    formatToolList,
    fs,
    getBeijingTimestamp,
    getRunDetailForUser,
    http,
    listCachedMcpTools,
    maybeBuildMcpChatContext,
    normalizeDatabaseConnectionError,
    os,
    path,
    refreshMcpTools,
    resolveDagNodeInput,
    runAgent,
    runExpressHandlers,
    test,
    validateDatabaseConnectionPayload
} = require('./security-helpers');

test('MCP outbound guard blocks loopback for non-admin users and allows admin loopback', async () => {
    await assert.rejects(
        assertSafeMcpOutboundUrl('http://127.0.0.1:3001/rpc', { role: 'user' }),
        /private or local MCP endpoints|sensitive local|metadata target/
    );
    await assert.doesNotReject(
        assertSafeMcpOutboundUrl('http://127.0.0.1:3001/rpc', { role: 'admin' })
    );
});

test('DAG templates read MCP structured rows through output.rows shorthand', () => {
    const rows = [{ group_id: 0, account_count: 2 }, { group_id: 1, account_count: 1 }];
    const context = {
        goal: '生成分组图表',
        inputs: {},
        nodeMap: new Map([['group_count', { id: 'group_count', title: '分组统计', tool: 'db.group_count' }]]),
        states: new Map([[
            'group_count',
            {
                status: 'completed',
                output: {
                    content: [{ type: 'text', text: JSON.stringify({ rows }) }],
                    structuredContent: { rows, limit: 50 }
                }
            }
        ]])
    };
    const resolved = resolveDagNodeInput({
        input: {
            rows: '{{nodes.group_count.output.rows}}',
            explicitRows: '{{nodes.group_count.output.structuredContent.rows}}'
        }
    }, context);
    assert.deepEqual(resolved.rows, rows);
    assert.deepEqual(resolved.explicitRows, rows);
});

test('non-root admin cannot create global prompts or shared MCP servers', async () => {
    const suffix = Date.now().toString(36);
    const userInfo = db.prepare(`
        INSERT INTO users (username, password_hash, nickname, unit, role, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, datetime('now', '+8 hours'))
    `).run(`resource_admin_${suffix}`, 'hash', 'Resource Admin', 'QA', 'admin', 'active');
    const adminUser = { id: Number(userInfo.lastInsertRowid), username: `resource_admin_${suffix}`, role: 'admin', unit: 'QA' };

    const promptRouter = createPromptsRouter({
        authMiddleware: (req, _res, next) => { req.user = adminUser; next(); },
        logAction: () => {}
    });
    const mcpRouter = createMcpRouter({
        authMiddleware: (req, _res, next) => { req.user = adminUser; next(); },
        adminMiddleware: (_req, _res, next) => next(),
        logAction: () => {}
    });
    const promptRoute = promptRouter.stack.find(layer => layer.route?.path === '/prompts' && layer.route?.methods?.post);
    const mcpRoute = mcpRouter.stack.find(layer => layer.route?.path === '/mcp/servers' && layer.route?.methods?.post);

    try {
        const promptReq = {
            body: { name: `Prompt ${suffix}`, content: 'test prompt', scope: 'global' },
            user: adminUser
        };
        const promptRes = { json(body) { this.body = body; return this; }, status(code) { this.statusCode = code; return this; } };
        await runExpressHandlers(promptRoute.route.stack.map(layer => layer.handle), promptReq, promptRes);
        const prompt = db.prepare('SELECT * FROM prompts WHERE id = ?').get(promptRes.body.id);
        assert.equal(prompt.scope, 'personal');
        assert.equal(prompt.user_id, adminUser.id);

        const mcpReq = {
            body: {
                name: `MCP ${suffix}`,
                base_url: 'https://mcp-resource.example/rpc',
                shared: true
            },
            user: adminUser
        };
        const mcpRes = { json(body) { this.body = body; return this; }, status(code) { this.statusCode = code; return this; } };
        await runExpressHandlers(mcpRoute.route.stack.map(layer => layer.handle), mcpReq, mcpRes);
        assert.equal(mcpRes.statusCode || 201, 201);
        const server = db.prepare('SELECT * FROM mcp_servers WHERE id = ?').get(mcpRes.body.server.id);
        assert.equal(server.user_id, adminUser.id);
    } finally {
        db.prepare('DELETE FROM prompts WHERE user_id = ?').run(adminUser.id);
        db.prepare('DELETE FROM mcp_servers WHERE user_id = ?').run(adminUser.id);
        db.prepare('DELETE FROM users WHERE id = ?').run(adminUser.id);
    }
});

test('database MCP preset exposes SQLite readonly tools and rejects writes', async () => {
    const suffix = Date.now().toString(36);
    const sqlitePath = path.join(process.env.DATA_DIR, `mcp-sqlite-${suffix}.db`);
    const source = new Sqlite(sqlitePath);
    source.exec(`
        CREATE TABLE widgets (id INTEGER PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL);
        INSERT INTO widgets (name, kind) VALUES ('alpha', 'red'), ('beta', 'blue'), ('gamma', 'red');
    `);
    source.close();

    const userInfo = db.prepare(`
        INSERT INTO users (username, password_hash, nickname, unit, role, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, datetime('now', '+8 hours'))
    `).run(`mcp_db_${suffix}`, 'hash', 'MCP DB Test', 'QA', 'admin', 'active');
    const adminUser = { id: Number(userInfo.lastInsertRowid), username: `mcp_db_${suffix}`, role: 'admin', unit: 'QA' };
    const router = createMcpRouter({
        authMiddleware: (req, _res, next) => { req.user = adminUser; next(); },
        adminMiddleware: (_req, _res, next) => next(),
        logAction: () => {}
    });
    const createRoute = router.stack.find(layer => layer.route?.path === '/mcp/database-connections' && layer.route?.methods?.post);
    const refreshRoute = router.stack.find(layer => layer.route?.path === '/mcp/servers/:id/refresh' && layer.route?.methods?.post);
    const callRoute = router.stack.find(layer => layer.route?.path === '/mcp/tools/call' && layer.route?.methods?.post);
    assert.ok(createRoute);
    assert.ok(refreshRoute);
    assert.ok(callRoute);

    let serverId = null;
    try {
        const createReq = {
            body: {
                name: `SQLite MCP ${suffix}`,
                database_type: 'sqlite',
                database_name: sqlitePath,
                max_rows: 5
            },
            user: adminUser
        };
        const createRes = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
        await runExpressHandlers(createRoute.route.stack.map(layer => layer.handle), createReq, createRes);
        assert.equal(createRes.statusCode, 201);
        serverId = createRes.body.server.id;
        assert.equal(createRes.body.server.server_type, 'database');
        assert.equal(createRes.body.server.database_connection.has_password, false);

        const refreshReq = { params: { id: String(serverId) }, user: adminUser };
        const refreshRes = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
        await runExpressHandlers(refreshRoute.route.stack.map(layer => layer.handle), refreshReq, refreshRes);
        assert.equal(refreshRes.statusCode, 200);
        assert.equal(refreshRes.body.tools.some(tool => tool.name === 'db.run_readonly_query'), true);
        assert.equal(refreshRes.body.tools.some(tool => tool.name === 'db.group_count'), true);
        assert.equal(refreshRes.body.tools.some(tool => tool.name === 'db.count_tables'), true);

        const queryReq = {
            body: {
                name: `mcp.${serverId}.db.run_readonly_query`,
                input: { sql: 'SELECT name FROM widgets ORDER BY id', limit: 2 }
            },
            user: adminUser
        };
        const queryRes = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
        await runExpressHandlers(callRoute.route.stack.map(layer => layer.handle), queryReq, queryRes);
        assert.equal(queryRes.statusCode, 200);
        assert.deepEqual(queryRes.body.result.structuredContent.rows.map(row => row.name), ['alpha', 'beta']);

        const groupReq = {
            body: {
                name: `mcp.${serverId}.db.group_count`,
                input: { table: 'widgets', groupBy: 'kind', groupAlias: 'kind', countAlias: 'total' }
            },
            user: adminUser
        };
        const groupRes = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
        await runExpressHandlers(callRoute.route.stack.map(layer => layer.handle), groupReq, groupRes);
        assert.equal(groupRes.statusCode, 200);
        assert.equal(groupRes.body.result.structuredContent.limit, 5);
        assert.match(groupRes.body.result.structuredContent.sql, /COUNT\(\*\) AS "total"/);
        assert.deepEqual(groupRes.body.result.structuredContent.rows, [
            { kind: 'red', total: 2 },
            { kind: 'blue', total: 1 }
        ]);

        const countTablesReq = {
            body: {
                name: `mcp.${serverId}.db.count_tables`,
                input: {}
            },
            user: adminUser
        };
        const countTablesRes = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
        await runExpressHandlers(callRoute.route.stack.map(layer => layer.handle), countTablesReq, countTablesRes);
        assert.equal(countTablesRes.statusCode, 200);
        assert.equal(countTablesRes.body.result.structuredContent.total, 1);
        assert.deepEqual(countTablesRes.body.result.structuredContent.rows, [
            { type: 'table', total: 1 }
        ]);

        const writeReq = {
            body: {
                name: `mcp.${serverId}.db.run_readonly_query`,
                input: { sql: 'DELETE FROM widgets' }
            },
            user: adminUser
        };
        const writeRes = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
        await assert.rejects(
            runExpressHandlers(callRoute.route.stack.map(layer => layer.handle), writeReq, writeRes),
            /Only readonly SQL|blocked write/
        );
    } finally {
        if (serverId) {
            db.prepare('DELETE FROM mcp_tool_cache WHERE server_id = ?').run(serverId);
            db.prepare('DELETE FROM mcp_database_connections WHERE mcp_server_id = ?').run(serverId);
            db.prepare('DELETE FROM mcp_servers WHERE id = ?').run(serverId);
        }
        db.prepare('DELETE FROM users WHERE id = ?').run(adminUser.id);
        fs.rmSync(sqlitePath, { force: true });
    }
});

test('agent tool catalog collapses database MCP tools into generic actions', () => {
    const generic = buildGenericDatabaseTools([
        {
            serverId: 101,
            serverName: '生产库',
            serverType: 'database',
            databaseType: 'sqlite',
            name: 'db.run_readonly_query',
            fullName: 'mcp.101.db.run_readonly_query',
            description: '只读查询',
            input_schema: {
                type: 'object',
                required: ['sql'],
                properties: { sql: { type: 'string' }, limit: { type: 'integer' } }
            }
        },
        {
            serverId: 202,
            serverName: '测试库',
            serverType: 'database',
            databaseType: 'postgres',
            name: 'db.run_readonly_query',
            fullName: 'mcp.202.db.run_readonly_query',
            description: '只读查询',
            input_schema: {
                type: 'object',
                required: ['sql'],
                properties: { sql: { type: 'string' }, connectionId: { type: 'string' } }
            }
        },
        {
            serverId: 101,
            serverName: '生产库',
            serverType: 'database',
            databaseType: 'sqlite',
            name: 'db.describe_table',
            fullName: 'mcp.101.db.describe_table',
            description: '表结构',
            input_schema: {
                type: 'object',
                required: ['table'],
                properties: { table: { type: 'string' } }
            }
        },
        {
            serverId: 303,
            serverName: '第三方服务',
            serverType: 'external',
            name: 'db.run_readonly_query',
            fullName: 'mcp.303.db.run_readonly_query',
            description: '外部同名工具',
            input_schema: { type: 'object' }
        }
    ]);

    assert.deepEqual(generic.map(tool => tool.name), ['db.describe_table', 'db.run_readonly_query']);
    const queryTool = generic.find(tool => tool.name === 'db.run_readonly_query');
    assert.equal(queryTool.databaseTool, true);
    assert.equal(queryTool.requiresApproval, false);
    assert.deepEqual(queryTool.input_schema.required, ['sql', 'connectionId']);
    assert.deepEqual(queryTool.input_schema.properties.connectionId.enum, ['101', '202']);
    assert.deepEqual(queryTool.databaseConnections.map(connection => connection.fullName), [
        'mcp.101.db.run_readonly_query',
        'mcp.202.db.run_readonly_query'
    ]);
    assert.equal(queryTool.input_schema.properties.sql.type, 'string');
});

test('agent tool list exposes database connections as parameters and routes generic DAG tools', async () => {
    const axios = require('axios');
    const originalPost = axios.post;
    const suffix = Date.now().toString(36);
    const sqlitePathA = path.join(process.env.DATA_DIR, `agent-db-a-${suffix}.db`);
    const sqlitePathB = path.join(process.env.DATA_DIR, `agent-db-b-${suffix}.db`);
    const sourceA = new Sqlite(sqlitePathA);
    sourceA.exec(`
        CREATE TABLE widgets (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
        INSERT INTO widgets (name) VALUES ('prod-alpha'), ('prod-beta');
    `);
    sourceA.close();
    const sourceB = new Sqlite(sqlitePathB);
    sourceB.exec(`
        CREATE TABLE widgets (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
        INSERT INTO widgets (name) VALUES ('test-only');
    `);
    sourceB.close();

    const now = getBeijingTimestamp();
    const userInfo = db.prepare(`
        INSERT INTO users (username, password_hash, nickname, unit, role, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, datetime('now', '+8 hours'))
    `).run(`agent_db_${suffix}`, 'hash', 'Agent DB Test', 'QA', 'admin', 'active');
    const user = { id: Number(userInfo.lastInsertRowid), username: `agent_db_${suffix}`, role: 'admin', unit: 'QA' };
    const modelInfo = db.prepare(`
        INSERT INTO models (user_id, name, url, model_name, status, created_at)
        VALUES (?, ?, ?, ?, 'active', datetime('now', '+8 hours'))
    `).run(user.id, 'Agent DB Summary Model', 'http://127.0.0.1:65530/v1/chat/completions', `agent-db-summary-${suffix}`);
    const modelId = Number(modelInfo.lastInsertRowid);

    const serverIds = [];
    const insertDbServer = (name, sqlitePath) => {
        const serverInfo = db.prepare(`
            INSERT INTO mcp_servers (user_id, name, base_url, api_key, description, status, created_at, updated_at)
            VALUES (?, ?, 'pivot-db://pending', '', ?, 'active', ?, ?)
        `).run(user.id, name, `${name} test database`, now, now);
        const serverId = Number(serverInfo.lastInsertRowid);
        serverIds.push(serverId);
        db.prepare('UPDATE mcp_servers SET base_url = ? WHERE id = ?')
            .run(`pivot-db://connection/${serverId}`, serverId);
        db.prepare(`
            INSERT INTO mcp_database_connections (
                mcp_server_id, user_id, database_type, host, port, database_name, username, password, options, status, created_at, updated_at
            ) VALUES (?, ?, 'sqlite', '', 0, ?, '', '', ?, 'active', ?, ?)
        `).run(serverId, user.id, sqlitePath, JSON.stringify({ maxRows: 10 }), now, now);
        return serverId;
    };

    let runId = '';
    try {
        const prodServerId = insertDbServer(`生产库 ${suffix}`, sqlitePathA);
        const testServerId = insertDbServer(`测试库 ${suffix}`, sqlitePathB);
        for (const serverId of serverIds) {
            await refreshMcpTools(db.prepare('SELECT * FROM mcp_servers WHERE id = ?').get(serverId), user);
        }

        const allTools = formatToolList(user);
        const genericQueryTools = allTools.filter(tool => tool.name === 'db.run_readonly_query');
        assert.equal(genericQueryTools.length, 1);
        const queryTool = genericQueryTools[0];
        assert.equal(queryTool.databaseTool, true);
        assert.equal(allTools.some(tool => tool.name === `mcp.${prodServerId}.db.run_readonly_query`), false);
        assert.equal(allTools.some(tool => tool.name === `mcp.${testServerId}.db.run_readonly_query`), false);
        assert.deepEqual(queryTool.input_schema.properties.connectionId.enum.sort(), [String(prodServerId), String(testServerId)].sort());
        assert.deepEqual(
            queryTool.databaseConnections.map(connection => connection.fullName).sort(),
            [`mcp.${prodServerId}.db.run_readonly_query`, `mcp.${testServerId}.db.run_readonly_query`].sort()
        );
        assert.equal(allTools.some(tool => tool.name === 'db.describe_table'), true);
        assert.equal(allTools.some(tool => tool.name === 'db.group_count'), true);
        assert.equal(allTools.some(tool => tool.name === 'db.count_tables'), true);

        const scopedTools = formatToolList(user, {
            toolAllowlist: [`mcp.${prodServerId}.db.run_readonly_query`]
        });
        assert.deepEqual(scopedTools.map(tool => tool.name), ['db.run_readonly_query']);
        assert.deepEqual(scopedTools[0].input_schema.properties.connectionId.enum, [String(prodServerId)]);
        assert.deepEqual(scopedTools[0].databaseConnections.map(connection => connection.fullName), [`mcp.${prodServerId}.db.run_readonly_query`]);

        axios.post = async (_url, payload) => {
            assert.match(JSON.stringify(payload.messages || []), /prod-alpha/);
            return { data: { choices: [{ message: { content: 'DAG 查询完成' } }] } };
        };

        runId = `agent-db-dag-${suffix}`;
        db.prepare(`
            INSERT INTO agent_runs (
                id, user_id, model_id, title, goal, status, max_steps, run_mode, tool_policy,
                tool_allowlist, approval_policy, timeout_ms, tool_timeout_ms, retry_limit,
                context_config, metadata, model_router, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, 'queued', 3, 'dag', 'all', '', 'safe_mcp_auto', 600000, 120000, 0, ?, ?, 'fixed', ?, ?)
        `).run(
            runId,
            user.id,
            modelId,
            '数据库通用工具路由',
            '查询生产库 widgets',
            '{}',
            JSON.stringify({
                dagSpec: {
                    nodes: [{
                        id: 'query',
                        title: '只读查询',
                        tool: 'db.run_readonly_query',
                        input: {
                            connectionId: String(prodServerId),
                            sql: 'SELECT name FROM widgets ORDER BY id',
                            limit: 1
                        },
                        dependsOn: [],
                        condition: 'success',
                        retryLimit: 0,
                        timeoutMs: 0,
                        onError: 'stop'
                    }, {
                        id: 'summary',
                        title: '大模型汇总',
                        tool: 'agent.llm',
                        input: {
                            model: String(modelId),
                            prompt: '请基于查询结果输出摘要：\n{{nodes.query.output}}'
                        },
                        dependsOn: ['query'],
                        condition: 'success',
                        retryLimit: 0,
                        timeoutMs: 0,
                        onError: 'stop'
                    }]
                }
            }),
            now,
            now
        );

        await runAgent(runId, user);
        const detail = getRunDetailForUser(runId, user);
        assert.equal(detail.run.status, 'completed');
        assert.equal(detail.run.final_answer, 'DAG 查询完成');
        assert.equal(detail.dagNodes[0].tool_name, 'db.run_readonly_query');
        assert.equal(detail.dagNodes[0].input.connectionId, String(prodServerId));
        assert.equal(detail.dagNodes[0].status, 'completed');
        const dagOutputText = typeof detail.dagNodes[0].output === 'string'
            ? detail.dagNodes[0].output
            : JSON.stringify(detail.dagNodes[0].output);
        assert.match(dagOutputText, /prod-alpha/);
        assert.doesNotMatch(dagOutputText, /test-only/);
        const callLog = db.prepare(`
            SELECT server_id, tool_name, source, input_preview, output_preview
            FROM mcp_call_logs
            WHERE user_id = ? AND source = 'agent'
            ORDER BY id DESC
            LIMIT 1
        `).get(user.id);
        assert.equal(callLog.server_id, prodServerId);
        assert.equal(callLog.tool_name, 'db.run_readonly_query');
        assert.match(callLog.input_preview, /widgets/);
        assert.match(callLog.output_preview, /prod-alpha/);
        assert.doesNotMatch(callLog.output_preview, /test-only/);
    } finally {
        axios.post = originalPost;
        if (runId) {
            db.prepare('DELETE FROM agent_notifications WHERE run_id = ?').run(runId);
            db.prepare('DELETE FROM agent_dag_nodes WHERE run_id = ?').run(runId);
            db.prepare('DELETE FROM agent_steps WHERE run_id = ?').run(runId);
            db.prepare('DELETE FROM agent_runs WHERE id = ?').run(runId);
        }
        db.prepare('DELETE FROM model_usage_events WHERE user_id = ?').run(user.id);
        db.prepare('DELETE FROM models WHERE id = ?').run(modelId);
        db.prepare('DELETE FROM mcp_call_logs WHERE user_id = ?').run(user.id);
        serverIds.forEach(serverId => {
            db.prepare('DELETE FROM mcp_tool_cache WHERE server_id = ?').run(serverId);
            db.prepare('DELETE FROM mcp_database_connections WHERE mcp_server_id = ?').run(serverId);
            db.prepare('DELETE FROM mcp_servers WHERE id = ?').run(serverId);
        });
        db.prepare('DELETE FROM users WHERE id = ?').run(user.id);
        fs.rmSync(sqlitePathA, { force: true });
        fs.rmSync(sqlitePathB, { force: true });
    }
});

test('built-in reports MCP lists and queries configured files only', async () => {
    const suffix = Date.now().toString(36);
    const reportDir = fs.mkdtempSync(path.join(os.tmpdir(), `pivot-reports-${suffix}-`));
    const csvPath = path.join(reportDir, 'sales.csv');
    fs.writeFileSync(csvPath, 'dept,amount\nops,10\nrnd,25\nops,30\n', 'utf8');
    const userInfo = db.prepare(`
        INSERT INTO users (username, password_hash, nickname, unit, role, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, datetime('now', '+8 hours'))
    `).run(`mcp_reports_${suffix}`, 'hash', 'MCP Reports Test', 'QA', 'admin', 'active');
    const adminUser = { id: Number(userInfo.lastInsertRowid), username: `mcp_reports_${suffix}`, role: 'admin', unit: 'QA' };
    const router = createMcpRouter({
        authMiddleware: (req, _res, next) => { req.user = adminUser; next(); },
        adminMiddleware: (_req, _res, next) => next(),
        logAction: () => {}
    });
    const createRoute = router.stack.find(layer => layer.route?.path === '/mcp/builtin-services' && layer.route?.methods?.post);
    const refreshRoute = router.stack.find(layer => layer.route?.path === '/mcp/servers/:id/refresh' && layer.route?.methods?.post);
    const callRoute = router.stack.find(layer => layer.route?.path === '/mcp/tools/call' && layer.route?.methods?.post);
    let serverId = null;
    try {
        const createRes = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
        await runExpressHandlers(createRoute.route.stack.map(layer => layer.handle), {
            body: {
                name: `Reports MCP ${suffix}`,
                service_type: 'reports',
                roots: reportDir,
                extensions: 'csv',
                maxRows: 20
            },
            user: adminUser
        }, createRes);
        assert.equal(createRes.statusCode, 201);
        serverId = createRes.body.server.id;
        assert.equal(createRes.body.server.server_type, 'reports');

        const refreshRes = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
        await runExpressHandlers(refreshRoute.route.stack.map(layer => layer.handle), { params: { id: String(serverId) }, user: adminUser }, refreshRes);
        assert.equal(refreshRes.body.tools.some(tool => tool.name === 'reports.query_table'), true);

        const listRes = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
        await runExpressHandlers(callRoute.route.stack.map(layer => layer.handle), {
            body: { name: `mcp.${serverId}.reports.list_files`, input: { query: 'sales' } },
            user: adminUser
        }, listRes);
        assert.equal(listRes.body.result.structuredContent.files[0].path, '0:sales.csv');

        const queryRes = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
        await runExpressHandlers(callRoute.route.stack.map(layer => layer.handle), {
            body: {
                name: `mcp.${serverId}.reports.query_table`,
                input: { path: '0:sales.csv', filters: { dept: 'ops' }, columns: ['amount'], limit: 5 }
            },
            user: adminUser
        }, queryRes);
        assert.deepEqual(queryRes.body.result.structuredContent.rows.map(row => row.amount), ['10', '30']);
    } finally {
        if (serverId) {
            db.prepare('DELETE FROM mcp_tool_cache WHERE server_id = ?').run(serverId);
            db.prepare('DELETE FROM mcp_builtin_configs WHERE mcp_server_id = ?').run(serverId);
            db.prepare('DELETE FROM mcp_servers WHERE id = ?').run(serverId);
        }
        db.prepare('DELETE FROM users WHERE id = ?').run(adminUser.id);
        fs.rmSync(reportDir, { recursive: true, force: true });
    }
});

test('visualization and report MCP compose independently from data-source MCPs', async () => {
    const suffix = Date.now().toString(36);
    const userInfo = db.prepare(`
        INSERT INTO users (username, password_hash, nickname, unit, role, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, datetime('now', '+8 hours'))
    `).run(`mcp_workflow_${suffix}`, 'hash', 'MCP Workflow Test', 'QA', 'admin', 'active');
    const adminUser = { id: Number(userInfo.lastInsertRowid), username: `mcp_workflow_${suffix}`, role: 'admin', unit: 'QA' };
    const router = createMcpRouter({
        authMiddleware: (req, _res, next) => { req.user = adminUser; next(); },
        adminMiddleware: (_req, _res, next) => next(),
        logAction: () => {}
    });
    const createRoute = router.stack.find(layer => layer.route?.path === '/mcp/builtin-services' && layer.route?.methods?.post);
    const refreshRoute = router.stack.find(layer => layer.route?.path === '/mcp/servers/:id/refresh' && layer.route?.methods?.post);
    const callRoute = router.stack.find(layer => layer.route?.path === '/mcp/tools/call' && layer.route?.methods?.post);
    const serverIds = [];
    try {
        async function createBuiltin(serviceType, name) {
            const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
            await runExpressHandlers(createRoute.route.stack.map(layer => layer.handle), {
                body: { name, service_type: serviceType },
                user: adminUser
            }, res);
            assert.equal(res.statusCode, 201);
            serverIds.push(res.body.server.id);
            return res.body.server.id;
        }

        const vizServerId = await createBuiltin('visualization', `Viz MCP ${suffix}`);
        const reportServerId = await createBuiltin('report', `Report MCP ${suffix}`);

        for (const id of serverIds) {
            const refreshRes = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
            await runExpressHandlers(refreshRoute.route.stack.map(layer => layer.handle), { params: { id: String(id) }, user: adminUser }, refreshRes);
            assert.equal(refreshRes.statusCode, 200);
        }

        const chartRes = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
        await runExpressHandlers(callRoute.route.stack.map(layer => layer.handle), {
            body: {
                name: `mcp.${vizServerId}.viz.build_chart`,
                input: {
                    rows: [
                        { dept: 'ops', amount: 10 },
                        { dept: 'rnd', amount: 25 },
                        { dept: 'ops', amount: 30 }
                    ],
                    chartType: 'bar',
                    xAxis: 'dept',
                    yAxis: 'amount',
                    aggregation: 'sum',
                    title: '部门销售'
                }
            },
            user: adminUser
        }, chartRes);
        const chart = chartRes.body.result.structuredContent;
        assert.equal(chart.type, 'pivot_chart');
        assert.equal(chart.chartType, 'bar');
        assert.deepEqual(chart.labels, ['ops', 'rnd']);
        assert.deepEqual(chart.series[0].data, [40, 25]);

        const areaRes = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
        await runExpressHandlers(callRoute.route.stack.map(layer => layer.handle), {
            body: {
                name: `mcp.${vizServerId}.viz.build_chart`,
                input: {
                    rows: [
                        { month: '2026-02', channel: 'direct', growth: '12%' },
                        { month: '2026-01', channel: 'direct', growth: '(5%)' },
                        { month: '2026-01', channel: 'partner', growth: '￥8' }
                    ],
                    chartType: 'area',
                    xAxis: 'month',
                    yAxis: 'growth',
                    groupBy: 'channel',
                    aggregation: 'sum',
                    sortBy: 'label',
                    sortOrder: 'asc',
                    title: '增长趋势'
                }
            },
            user: adminUser
        }, areaRes);
        const area = areaRes.body.result.structuredContent;
        assert.equal(area.chartType, 'area');
        assert.deepEqual(area.labels, ['2026-01', '2026-02']);
        assert.deepEqual(area.series.find(item => item.name === 'direct').data, [-0.05, 0.12]);
        assert.deepEqual(area.series.find(item => item.name === 'partner').data, [8, 0]);
        assert.deepEqual(area.sort, { by: 'label', order: 'asc' });

        const tableRes = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
        await runExpressHandlers(callRoute.route.stack.map(layer => layer.handle), {
            body: {
                name: `mcp.${vizServerId}.viz.build_table`,
                input: { rows: [{ dept: 'ops', amount: 40 }, { dept: 'rnd', amount: 25 }], columns: ['dept', 'amount'], title: '部门明细' }
            },
            user: adminUser
        }, tableRes);
        const table = tableRes.body.result.structuredContent;
        assert.equal(table.type, 'pivot_table');
        assert.match(table.markdown, /\| dept \| amount \|/);

        const reportRes = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
        await runExpressHandlers(callRoute.route.stack.map(layer => layer.handle), {
            body: {
                name: `mcp.${reportServerId}.report.compose`,
                input: {
                    title: '经营分析报告',
                    sections: [
                        { type: 'summary', title: '一、摘要', text: '整体平稳。' },
                        { type: 'table', title: '二、明细表', table },
                        { type: 'chart', title: '三、趋势图', chart }
                    ]
                }
            },
            user: adminUser
        }, reportRes);
        const report = reportRes.body.result.structuredContent;
        assert.equal(report.type, 'pivot_report');
        assert.match(report.markdown, /# 经营分析报告/);
        assert.match(report.markdown, /```pivot-echart/);
        assert.match(report.markdown, /\| ops \| 40 \|/);
    } finally {
        for (const id of serverIds) {
            db.prepare('DELETE FROM mcp_tool_cache WHERE server_id = ?').run(id);
            db.prepare('DELETE FROM mcp_builtin_configs WHERE mcp_server_id = ?').run(id);
            db.prepare('DELETE FROM mcp_servers WHERE id = ?').run(id);
        }
        db.prepare('DELETE FROM users WHERE id = ?').run(adminUser.id);
    }
});

test('system MCP services can be enabled without user-supplied names', async () => {
    const suffix = Date.now().toString(36);
    const userInfo = db.prepare(`
        INSERT INTO users (username, password_hash, nickname, unit, role, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, datetime('now', '+8 hours'))
    `).run(`mcp_system_${suffix}`, 'hash', 'MCP System Test', 'QA', 'user', 'active');
    const user = { id: Number(userInfo.lastInsertRowid), username: `mcp_system_${suffix}`, role: 'user', unit: 'QA' };
    const router = createMcpRouter({
        authMiddleware: (req, _res, next) => { req.user = user; next(); },
        adminMiddleware: (_req, _res, next) => next(),
        logAction: () => {}
    });
    const ensureRoute = router.stack.find(layer => layer.route?.path === '/mcp/system-services/:type/ensure' && layer.route?.methods?.post);
    const statusRoute = router.stack.find(layer => layer.route?.path === '/mcp/servers/:id/status' && layer.route?.methods?.patch);
    const toolsRoute = router.stack.find(layer => layer.route?.path === '/mcp/tools' && layer.route?.methods?.get);
    const serverIds = [];
    try {
        const firstRes = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
        await runExpressHandlers(ensureRoute.route.stack.map(layer => layer.handle), {
            params: { type: 'visualization' },
            body: {},
            user
        }, firstRes);
        assert.equal(firstRes.statusCode, 201);
        assert.equal(firstRes.body.server.server_type, 'visualization');
        assert.equal(firstRes.body.server.name, '图表生成');
        assert.equal(firstRes.body.tools.some(tool => tool.name === 'viz.build_chart'), true);
        serverIds.push(firstRes.body.server.id);

        const secondRes = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
        await runExpressHandlers(ensureRoute.route.stack.map(layer => layer.handle), {
            params: { type: 'visualization' },
            body: {},
            user
        }, secondRes);
        assert.equal(secondRes.statusCode, 200);
        assert.equal(secondRes.body.server.id, firstRes.body.server.id);

        const count = db.prepare(`
            SELECT COUNT(*) AS total
            FROM mcp_servers s
            JOIN mcp_builtin_configs c ON c.mcp_server_id = s.id
            WHERE s.user_id = ? AND s.status != 'deleted' AND c.service_type = 'visualization'
        `).get(user.id).total;
        assert.equal(count, 1);

        const pauseRes = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
        await runExpressHandlers(statusRoute.route.stack.map(layer => layer.handle), {
            params: { id: String(firstRes.body.server.id) },
            body: { status: 'paused' },
            user
        }, pauseRes);
        assert.equal(pauseRes.body.server.status, 'paused');
        const pausedToolsRes = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
        await runExpressHandlers(toolsRoute.route.stack.map(layer => layer.handle), { user }, pausedToolsRes);
        assert.equal(pausedToolsRes.body.tools.some(tool => tool.serverId === firstRes.body.server.id), false);

        const activeRes = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
        await runExpressHandlers(statusRoute.route.stack.map(layer => layer.handle), {
            params: { id: String(firstRes.body.server.id) },
            body: { status: 'active' },
            user
        }, activeRes);
        assert.equal(activeRes.body.server.status, 'active');
    } finally {
        serverIds.forEach(id => {
            db.prepare('DELETE FROM mcp_tool_cache WHERE server_id = ?').run(id);
            db.prepare('DELETE FROM mcp_builtin_configs WHERE mcp_server_id = ?').run(id);
            db.prepare('DELETE FROM mcp_servers WHERE id = ?').run(id);
        });
        db.prepare('DELETE FROM users WHERE id = ?').run(user.id);
    }
});

test('system utility MCP services expose document data and format tools', async () => {
    const suffix = Date.now().toString(36);
    const userInfo = db.prepare(`
        INSERT INTO users (username, password_hash, nickname, unit, role, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, datetime('now', '+8 hours'))
    `).run(`mcp_util_${suffix}`, 'hash', 'MCP Utility Test', 'QA', 'user', 'active');
    const user = { id: Number(userInfo.lastInsertRowid), username: `mcp_util_${suffix}`, role: 'user', unit: 'QA' };
    const router = createMcpRouter({
        authMiddleware: (req, _res, next) => { req.user = user; next(); },
        adminMiddleware: (_req, _res, next) => next(),
        logAction: () => {}
    });
    const ensureRoute = router.stack.find(layer => layer.route?.path === '/mcp/system-services/:type/ensure' && layer.route?.methods?.post);
    const callRoute = router.stack.find(layer => layer.route?.path === '/mcp/tools/call' && layer.route?.methods?.post);
    const serverIds = {};
    try {
        for (const item of [
            { type: 'documents', tool: 'doc.extract_outline' },
            { type: 'data', tool: 'data.group_summary' },
            { type: 'format', tool: 'format.extract_json' }
        ]) {
            const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
            await runExpressHandlers(ensureRoute.route.stack.map(layer => layer.handle), {
                params: { type: item.type },
                body: {},
                user
            }, res);
            assert.equal(res.statusCode, 201);
            assert.equal(res.body.server.server_type, item.type);
            assert.equal(res.body.tools.some(tool => tool.name === item.tool), true);
            serverIds[item.type] = res.body.server.id;
        }

        const outlineRes = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
        await runExpressHandlers(callRoute.route.stack.map(layer => layer.handle), {
            body: { name: `mcp.${serverIds.documents}.doc.extract_outline`, input: { text: '# Sales\n\n1. Summary\nBody' } },
            user
        }, outlineRes);
        assert.equal(outlineRes.body.result.structuredContent.headings[0].title, 'Sales');

        const groupRes = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
        await runExpressHandlers(callRoute.route.stack.map(layer => layer.handle), {
            body: {
                name: `mcp.${serverIds.data}.data.group_summary`,
                input: {
                    rows: [{ dept: 'ops', amount: 10 }, { dept: 'ops', amount: 15 }, { dept: 'rnd', amount: 5 }],
                    groupBy: 'dept',
                    valueField: 'amount',
                    aggregation: 'sum'
                }
            },
            user
        }, groupRes);
        assert.equal(groupRes.body.result.structuredContent.rows.find(row => row.dept === 'ops').value, 25);

        const jsonRes = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
        await runExpressHandlers(callRoute.route.stack.map(layer => layer.handle), {
            body: { name: `mcp.${serverIds.format}.format.extract_json`, input: { text: 'payload: {"ok":true,"n":1}' } },
            user
        }, jsonRes);
        assert.equal(jsonRes.body.result.structuredContent.value.ok, true);
    } finally {
        Object.values(serverIds).forEach(id => {
            db.prepare('DELETE FROM mcp_tool_cache WHERE server_id = ?').run(id);
            db.prepare('DELETE FROM mcp_builtin_configs WHERE mcp_server_id = ?').run(id);
            db.prepare('DELETE FROM mcp_servers WHERE id = ?').run(id);
        });
        db.prepare('DELETE FROM users WHERE id = ?').run(user.id);
    }
});

test('system IM MCP uses default service identity with user configuration', async () => {
    const suffix = Date.now().toString(36);
    const received = [];
    const webhook = http.createServer((req, res) => {
        let raw = '';
        req.on('data', chunk => { raw += chunk; });
        req.on('end', () => {
            received.push({ headers: req.headers, body: JSON.parse(raw || '{}') });
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true }));
        });
    });
    await new Promise(resolve => webhook.listen(0, '127.0.0.1', resolve));
    const endpointUrl = `http://127.0.0.1:${webhook.address().port}/message`;
    const userInfo = db.prepare(`
        INSERT INTO users (username, password_hash, nickname, unit, role, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, datetime('now', '+8 hours'))
    `).run(`mcp_system_im_${suffix}`, 'hash', 'MCP System IM Test', 'QA', 'admin', 'active');
    const user = { id: Number(userInfo.lastInsertRowid), username: `mcp_system_im_${suffix}`, role: 'admin', unit: 'QA' };
    const router = createMcpRouter({
        authMiddleware: (req, _res, next) => { req.user = user; next(); },
        adminMiddleware: (_req, _res, next) => next(),
        logAction: () => {}
    });
    const createRoute = router.stack.find(layer => layer.route?.path === '/mcp/builtin-services' && layer.route?.methods?.post);
    const refreshRoute = router.stack.find(layer => layer.route?.path === '/mcp/servers/:id/refresh' && layer.route?.methods?.post);
    const callRoute = router.stack.find(layer => layer.route?.path === '/mcp/tools/call' && layer.route?.methods?.post);
    let serverId = null;
    try {
        const createRes = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
        await runExpressHandlers(createRoute.route.stack.map(layer => layer.handle), {
            body: {
                name: 'IM 通知',
                service_type: 'im',
                endpointUrl,
                authHeader: 'X-Token',
                secret: 'system-secret',
                allowedTargets: 'user:alice',
                defaultTarget: 'user:alice'
            },
            user
        }, createRes);
        assert.equal(createRes.statusCode, 201);
        assert.equal(createRes.body.server.server_type, 'im');
        assert.equal(createRes.body.server.name, 'IM 通知');
        serverId = createRes.body.server.id;

        const refreshRes = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
        await runExpressHandlers(refreshRoute.route.stack.map(layer => layer.handle), { params: { id: String(serverId) }, user }, refreshRes);
        assert.equal(refreshRes.body.tools.some(tool => tool.name === 'im.send_user_message'), true);

        const callRes = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
        await runExpressHandlers(callRoute.route.stack.map(layer => layer.handle), {
            body: { name: `mcp.${serverId}.im.send_user_message`, input: { target: 'alice', message: 'hello' } },
            user
        }, callRes);
        assert.equal(callRes.statusCode || 200, 200);
        assert.equal(received[0].headers['x-token'], 'system-secret');
        assert.equal(received[0].body.target, 'alice');
    } finally {
        if (serverId) {
            db.prepare('DELETE FROM mcp_tool_cache WHERE server_id = ?').run(serverId);
            db.prepare('DELETE FROM mcp_builtin_configs WHERE mcp_server_id = ?').run(serverId);
            db.prepare('DELETE FROM mcp_servers WHERE id = ?').run(serverId);
        }
        db.prepare('DELETE FROM users WHERE id = ?').run(user.id);
        await new Promise(resolve => webhook.close(resolve));
    }
});

test('chat MCP intent filter does not expose visualization tools for plain data queries', () => {
    const tools = [
        { fullName: 'mcp.db.db.run_readonly_query', name: 'db.run_readonly_query' },
        { fullName: 'mcp.viz.viz.build_chart', name: 'viz.build_chart' },
        { fullName: 'mcp.report.report.compose', name: 'report.compose' }
    ];
    const queryOnly = filterMcpToolsForChatIntent(tools, '查询 hcd_b 表中各部门的数据');
    assert.deepEqual(queryOnly.map(tool => tool.name), ['db.run_readonly_query']);

    const withChart = filterMcpToolsForChatIntent(tools, '查询 hcd_b 表中各部门的数据并生成柱状图');
    assert.deepEqual(withChart.map(tool => tool.name), ['db.run_readonly_query', 'viz.build_chart']);

    const withReport = filterMcpToolsForChatIntent(tools, '查询 hcd_b 表并生成月报');
    assert.deepEqual(withReport.map(tool => tool.name), ['db.run_readonly_query', 'viz.build_chart', 'report.compose']);

    const plannerChartTools = filterMcpToolsForPlanner(withChart, '查询 hcd_b 表中各部门的数据并生成柱状图');
    assert.deepEqual(plannerChartTools.map(tool => tool.name), ['db.run_readonly_query']);
});

test('chat MCP fallback builds group_count input for table distribution charts', () => {
    const prompt = '查询 hcdb 数据库中的数据表 table_account 中 group_id 的名称及对应的数量，并生成柱状图图表';
    assert.equal(detectStrongDataQueryIntent(prompt), true);

    const groupCountInput = buildFallbackDataQueryInput(prompt, { name: 'db.group_count' });
    assert.equal(groupCountInput.table, 'table_account');
    assert.equal(groupCountInput.groupBy, 'group_id');
    assert.equal(groupCountInput.groupAlias, 'group_id');
    assert.equal(groupCountInput.countAlias, 'count');
    assert.equal(groupCountInput.limit, 80);

    const queryInput = buildFallbackDataQueryInput(prompt, { name: 'db.run_readonly_query' });
    assert.equal(queryInput.sql, 'SELECT group_id, COUNT(*) AS count FROM table_account GROUP BY group_id ORDER BY count DESC');
    assert.equal(queryInput.limit, 80);

    const tableCountInput = buildFallbackDataQueryInput('查询hcdb数据库中数据表的数量。', { name: 'db.count_tables' });
    assert.deepEqual(tableCountInput, {});

    assert.equal(detectStrongDataQueryIntent('查询 MongoDB 数据库中集合的数量。'), true);
    const collectionCountInput = buildFallbackDataQueryInput('查询 MongoDB 数据库中集合的数量。', { name: 'db.count_collections' });
    assert.deepEqual(collectionCountInput, {});
});

test('chat MCP context reports missing matching tool for explicit capability requests', async () => {
    const events = [];
    const context = await maybeBuildMcpChatContext({
        modelCfg: {
            id: 1,
            name: 'Unused Planner',
            model_name: 'planner-test',
            url: 'http://127.0.0.1:9/v1',
            api_key: '',
            user_id: null
        },
        history: [{ role: 'user', content: '查询hcdb数据库中数据表的数量。' }],
        userPrompt: '查询hcdb数据库中数据表的数量。',
        tools: [{
            fullName: 'mcp.viz.viz.build_chart',
            name: 'viz.build_chart',
            serverName: '图表能力',
            description: '生成图表',
            input_schema: { type: 'object' }
        }],
        user: { id: 1, username: 'admin', role: 'admin', unit: '' },
        writeSse(payload) {
            events.push(JSON.parse(payload));
        },
        log: { warn() {} }
    });

    assert.deepEqual(events.filter(event => event.type === 'mcp').map(event => event.status), ['skipped']);
    assert.match(events[0].message, /没有匹配用户请求的能力库工具/);
    assert.match(context, /需要能力库工具/);
    assert.match(context, /没有匹配的能力库工具/);
    assert.doesNotMatch(context, /本轮不需要调用能力库工具/);
});

test('chat MCP context invokes selected MCP tool and injects result for user dialogue', async () => {
    const suffix = Date.now().toString(36);
    const sqlitePath = path.join(process.env.DATA_DIR, `chat-mcp-${suffix}.db`);
    const source = new Sqlite(sqlitePath);
    source.exec(`
        CREATE TABLE widgets (id INTEGER PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL);
        INSERT INTO widgets (name, kind) VALUES ('alpha', 'red'), ('beta', 'blue'), ('gamma', 'red');
    `);
    source.close();

    const userInfo = db.prepare(`
        INSERT INTO users (username, password_hash, nickname, unit, role, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, datetime('now', '+8 hours'))
    `).run(`chat_mcp_${suffix}`, 'hash', 'Chat MCP Test', 'QA', 'admin', 'active');
    const adminUser = { id: Number(userInfo.lastInsertRowid), username: `chat_mcp_${suffix}`, role: 'admin', unit: 'QA' };
    const now = getBeijingTimestamp();
    const serverInfo = db.prepare(`
        INSERT INTO mcp_servers (user_id, name, base_url, api_key, description, status, created_at, updated_at)
        VALUES (?, ?, ?, '', ?, 'active', ?, ?)
    `).run(adminUser.id, `Chat SQLite MCP ${suffix}`, 'pivot-db://pending', 'chat MCP test database', now, now);
    const serverId = Number(serverInfo.lastInsertRowid);
    db.prepare('UPDATE mcp_servers SET base_url = ? WHERE id = ?')
        .run(`pivot-db://connection/${serverId}`, serverId);
    db.prepare(`
        INSERT INTO mcp_database_connections (
            mcp_server_id, user_id, database_type, host, port, database_name, username, password, options, status, created_at, updated_at
        ) VALUES (?, ?, 'sqlite', '', 0, ?, '', '', ?, 'active', ?, ?)
    `).run(serverId, adminUser.id, sqlitePath, JSON.stringify({ maxRows: 10 }), now, now);

    const toolName = `mcp.${serverId}.db.run_readonly_query`;
    const listTablesToolName = `mcp.${serverId}.db.list_tables`;
    const countTablesToolName = `mcp.${serverId}.db.count_tables`;
    const plannerRequests = [];
    const plannerServer = http.createServer((req, res) => {
        let raw = '';
        req.on('data', chunk => { raw += chunk; });
        req.on('end', () => {
            plannerRequests.push(JSON.parse(raw || '{}'));
            const requestText = raw.toLowerCase();
            let plannerContent;
            if (requestText.includes('短名')) {
                plannerContent = {
                    action: 'tool',
                    tool: 'db.count_tables',
                    input: {},
                    reason: '用户要求查询数据库表数量'
                };
            } else if (requestText.includes('数据表的数量')) {
                plannerContent = {
                    action: 'none',
                    reason: '不需要能力库'
                };
            } else {
                plannerContent = {
                    action: 'tool',
                    tool: toolName,
                    input: {
                        sql: 'SELECT name, kind FROM widgets ORDER BY id',
                        limit: 2
                    },
                    reason: '用户要求查询数据库表'
                };
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                choices: [{
                    message: {
                        content: JSON.stringify(plannerContent)
                    }
                }]
            }));
        });
    });

    try {
        await new Promise(resolve => plannerServer.listen(0, '127.0.0.1', resolve));
        await refreshMcpTools(db.prepare('SELECT * FROM mcp_servers WHERE id = ?').get(serverId), adminUser);
        const tools = listCachedMcpTools(null, adminUser).filter(tool => tool.serverId === serverId);
        assert.equal(tools.some(tool => tool.fullName === toolName), true);
        assert.equal(tools.some(tool => tool.fullName === listTablesToolName), true);
        assert.equal(tools.some(tool => tool.fullName === countTablesToolName), true);

        const sseEvents = [];
        const context = await maybeBuildMcpChatContext({
            modelCfg: {
                id: 1,
                name: 'Fake Planner',
                model_name: 'planner-test',
                url: `http://127.0.0.1:${plannerServer.address().port}/v1`,
                api_key: '',
                user_id: null
            },
            history: [{ role: 'user', content: '查询 widgets 表前两条数据' }],
            userPrompt: '查询 widgets 表前两条数据',
            tools,
            user: adminUser,
            writeSse(payload) {
                sseEvents.push(JSON.parse(payload));
            },
            log: { warn() {} }
        });

        assert.equal(plannerRequests.length, 1);
        assert.match(JSON.stringify(plannerRequests[0]), /db\.run_readonly_query/);
        assert.match(context, new RegExp(`工具: ${toolName.replace(/\./g, '\\.')}`));
        assert.match(context, /alpha/);
        assert.match(context, /beta/);
        assert.doesNotMatch(context, /gamma/);
        assert.deepEqual(sseEvents.filter(event => event.type === 'mcp').map(event => event.status), ['planning', 'running', 'done']);

        const callLog = db.prepare(`
            SELECT source, status, tool_name, input_preview, output_preview
            FROM mcp_call_logs
            WHERE server_id = ?
            ORDER BY id DESC
            LIMIT 1
        `).get(serverId);
        assert.equal(callLog.source, 'chat');
        assert.equal(callLog.status, 'success');
        assert.equal(callLog.tool_name, 'db.run_readonly_query');
        assert.match(callLog.input_preview, /widgets/);
        assert.match(callLog.output_preview, /alpha/);

        const tableCountEvents = [];
        const tableCountContext = await maybeBuildMcpChatContext({
            modelCfg: {
                id: 1,
                name: 'Fake Planner',
                model_name: 'planner-test',
                url: `http://127.0.0.1:${plannerServer.address().port}/v1`,
                api_key: '',
                user_id: null
            },
            history: [{ role: 'user', content: '查询hcdb数据库中数据表的数量。' }],
            userPrompt: '查询hcdb数据库中数据表的数量。',
            tools,
            user: adminUser,
            writeSse(payload) {
                tableCountEvents.push(JSON.parse(payload));
            },
            log: { warn() {} }
        });

        assert.match(tableCountContext, new RegExp(`工具: ${countTablesToolName.replace(/\./g, '\\.')}`));
        assert.match(tableCountContext, /"total": 1/);
        assert.deepEqual(tableCountEvents.filter(event => event.type === 'mcp').map(event => event.status), ['planning', 'running', 'done']);
        const fallbackLog = db.prepare(`
            SELECT source, status, tool_name, input_preview, output_preview
            FROM mcp_call_logs
            WHERE server_id = ?
            ORDER BY id DESC
            LIMIT 1
        `).get(serverId);
        assert.equal(fallbackLog.source, 'chat_fallback');
        assert.equal(fallbackLog.status, 'success');
        assert.equal(fallbackLog.tool_name, 'db.count_tables');
        assert.match(fallbackLog.output_preview, /"total":1/);

        const shortNameEvents = [];
        const shortNameContext = await maybeBuildMcpChatContext({
            modelCfg: {
                id: 1,
                name: 'Fake Planner',
                model_name: 'planner-test',
                url: `http://127.0.0.1:${plannerServer.address().port}/v1`,
                api_key: '',
                user_id: null
            },
            history: [{ role: 'user', content: '短名方式查询hcdb数据库中数据表的数量。' }],
            userPrompt: '短名方式查询hcdb数据库中数据表的数量。',
            tools,
            user: adminUser,
            writeSse(payload) {
                shortNameEvents.push(JSON.parse(payload));
            },
            log: { warn() {} }
        });

        assert.match(shortNameContext, new RegExp(`工具: ${countTablesToolName.replace(/\./g, '\\.')}`));
        assert.match(shortNameContext, /"total": 1/);
        assert.deepEqual(shortNameEvents.filter(event => event.type === 'mcp').map(event => event.status), ['planning', 'running', 'done']);
        const shortNameLog = db.prepare(`
            SELECT source, status, tool_name, output_preview
            FROM mcp_call_logs
            WHERE server_id = ?
            ORDER BY id DESC
            LIMIT 1
        `).get(serverId);
        assert.equal(shortNameLog.source, 'chat');
        assert.equal(shortNameLog.status, 'success');
        assert.equal(shortNameLog.tool_name, 'db.count_tables');
        assert.match(shortNameLog.output_preview, /"total":1/);
    } finally {
        await new Promise(resolve => plannerServer.close(resolve));
        db.prepare('DELETE FROM mcp_call_logs WHERE server_id = ?').run(serverId);
        db.prepare('DELETE FROM mcp_tool_cache WHERE server_id = ?').run(serverId);
        db.prepare('DELETE FROM mcp_database_connections WHERE mcp_server_id = ?').run(serverId);
        db.prepare('DELETE FROM mcp_servers WHERE id = ?').run(serverId);
        db.prepare('DELETE FROM users WHERE id = ?').run(adminUser.id);
        fs.rmSync(sqlitePath, { force: true });
    }
});

test('built-in IM MCP enforces target whitelist and sends LAN webhook payloads', async () => {
    const suffix = Date.now().toString(36);
    const received = [];
    const server = http.createServer((req, res) => {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
            received.push({ headers: req.headers, body: JSON.parse(body || '{}') });
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ ok: true, id: 'msg-1' }));
        });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const userInfo = db.prepare(`
        INSERT INTO users (username, password_hash, nickname, unit, role, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, datetime('now', '+8 hours'))
    `).run(`mcp_im_${suffix}`, 'hash', 'MCP IM Test', 'QA', 'admin', 'active');
    const adminUser = { id: Number(userInfo.lastInsertRowid), username: `mcp_im_${suffix}`, role: 'admin', unit: 'QA' };
    const router = createMcpRouter({
        authMiddleware: (req, _res, next) => { req.user = adminUser; next(); },
        adminMiddleware: (_req, _res, next) => next(),
        logAction: () => {}
    });
    const createRoute = router.stack.find(layer => layer.route?.path === '/mcp/builtin-services' && layer.route?.methods?.post);
    const refreshRoute = router.stack.find(layer => layer.route?.path === '/mcp/servers/:id/refresh' && layer.route?.methods?.post);
    const callRoute = router.stack.find(layer => layer.route?.path === '/mcp/tools/call' && layer.route?.methods?.post);
    let serverId = null;
    try {
        const createRes = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
        await runExpressHandlers(createRoute.route.stack.map(layer => layer.handle), {
            body: {
                name: `IM MCP ${suffix}`,
                service_type: 'im',
                endpointUrl: `http://127.0.0.1:${port}/message`,
                authHeader: 'x-pivot-token',
                secret: 'secret-token',
                allowedTargets: 'user:alice\ngroup:ops',
                maxMessageLength: 200
            },
            user: adminUser
        }, createRes);
        assert.equal(createRes.statusCode, 201);
        serverId = createRes.body.server.id;
        assert.equal(createRes.body.server.server_type, 'im');
        assert.equal(createRes.body.server.builtin_config.has_secret, true);

        const refreshRes = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
        await runExpressHandlers(refreshRoute.route.stack.map(layer => layer.handle), { params: { id: String(serverId) }, user: adminUser }, refreshRes);
        assert.equal(refreshRes.body.tools.some(tool => tool.name === 'im.send_user_message'), true);

        const sendRes = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
        await runExpressHandlers(callRoute.route.stack.map(layer => layer.handle), {
            body: { name: `mcp.${serverId}.im.send_user_message`, input: { target: 'alice', title: 'Hi', message: 'hello' } },
            user: adminUser
        }, sendRes);
        assert.equal(sendRes.body.result.structuredContent.ok, true);
        assert.equal(received[0].headers['x-pivot-token'], 'secret-token');
        assert.equal(received[0].body.target, 'alice');
        assert.equal(received[0].body.targetType, 'user');

        await assert.rejects(
            runExpressHandlers(callRoute.route.stack.map(layer => layer.handle), {
                body: { name: `mcp.${serverId}.im.send_user_message`, input: { target: 'mallory', message: 'nope' } },
                user: adminUser
            }, { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } }),
            /allowed target/
        );
    } finally {
        await new Promise(resolve => server.close(resolve));
        if (serverId) {
            db.prepare('DELETE FROM mcp_tool_cache WHERE server_id = ?').run(serverId);
            db.prepare('DELETE FROM mcp_builtin_configs WHERE mcp_server_id = ?').run(serverId);
            db.prepare('DELETE FROM mcp_servers WHERE id = ?').run(serverId);
        }
        db.prepare('DELETE FROM users WHERE id = ?').run(adminUser.id);
    }
});

test('database MCP restricts private LAN hosts by default and allows explicit opt-out', () => {
    const previous = process.env.MCP_RESTRICT_PRIVATE_DATABASE_HOSTS_TO_ADMIN;
    const user = { id: 1001, username: 'lan_user', role: 'user' };
    const admin = { id: 1002, username: 'admin', role: 'admin' };
    try {
        delete process.env.MCP_RESTRICT_PRIVATE_DATABASE_HOSTS_TO_ADMIN;
        assert.throws(() => validateDatabaseConnectionPayload({
            database_type: 'mysql',
            host: '192.168.1.88',
            port: 3306,
            database_name: 'biz',
            username: 'reader',
            password: 'secret'
        }, user), err => err?.code === 'MCP_PRIVATE_HOST_RESTRICTED');


        const adminConnection = validateDatabaseConnectionPayload({
            database_type: 'mysql',
            host: '192.168.1.88',
            port: 3306,
            database_name: 'biz',
            username: 'reader',
            password: 'secret'
        }, admin);
        assert.equal(adminConnection.host, '192.168.1.88');

        process.env.MCP_RESTRICT_PRIVATE_DATABASE_HOSTS_TO_ADMIN = 'false';
        const userConnection = validateDatabaseConnectionPayload({
            database_type: 'mysql',
            host: '192.168.1.88',
            port: 3306,
            database_name: 'biz',
            username: 'reader',
            password: 'secret'
        }, user);
        assert.equal(userConnection.host, '192.168.1.88');
    } finally {
        if (previous === undefined) delete process.env.MCP_RESTRICT_PRIVATE_DATABASE_HOSTS_TO_ADMIN;
        else process.env.MCP_RESTRICT_PRIVATE_DATABASE_HOSTS_TO_ADMIN = previous;
    }
});

test('database MCP test config flattens options used by drivers', () => {
    const previousTimeout = process.env.MCP_DATABASE_TEST_TIMEOUT_MS;
    const connection = validateDatabaseConnectionPayload({
        database_type: 'mysql',
        host: '192.168.1.88',
        port: 3306,
        database_name: 'biz',
        username: 'reader',
        password: 'secret',
        schema: 'reporting',
        ssl: true
    }, { id: 1002, username: 'lan_ssl_admin', role: 'admin' });
    const testConfig = buildDatabaseTestConnectionConfig(connection);
    assert.equal(testConfig.ssl, true);
    assert.equal(testConfig.schema, 'reporting');
    assert.equal(testConfig.connect_timeout_ms >= 1000, true);
    if (previousTimeout === undefined) delete process.env.MCP_DATABASE_TEST_TIMEOUT_MS;
    else process.env.MCP_DATABASE_TEST_TIMEOUT_MS = previousTimeout;
});

test('database MCP connection errors return actionable diagnostics', () => {
    const refused = normalizeDatabaseConnectionError(
        Object.assign(new Error('connect ECONNREFUSED 192.168.1.88:3306'), { code: 'ECONNREFUSED' }),
        { database_type: 'mysql', host: '192.168.1.88', port: 3306, database_name: 'biz' }
    );
    assert.equal(refused.status, 502);
    assert.equal(refused.code, 'DB_CONNECTION_REFUSED');
    assert.match(refused.hint, /Pivot|Docker|端口/);
    assert.equal(refused.diagnostics.host, '192.168.1.88');

    const auth = normalizeDatabaseConnectionError(
        Object.assign(new Error("Access denied for user 'reader'@'192.168.1.20'"), { code: 'ER_ACCESS_DENIED_ERROR' }),
        { database_type: 'mysql', host: '192.168.1.88', port: 3306, database_name: 'biz' }
    );
    assert.equal(auth.status, 403);
    assert.equal(auth.code, 'DB_AUTH_FAILED');
    assert.match(auth.hint, /Pivot|授权|pg_hba|user@/);

    const testTimeout = normalizeDatabaseConnectionError(
        Object.assign(new Error('database TCP probe timed out after 5000ms'), { code: 'DB_CONNECTION_TEST_TIMEOUT', status: 504 }),
        { database_type: 'mysql', host: '192.168.1.88', port: 3306, database_name: 'biz' }
    );
    assert.equal(testTimeout.status, 504);
    assert.equal(testTimeout.code, 'DB_CONNECTION_TEST_TIMEOUT');
    assert.match(testTimeout.hint, /MCP_DATABASE_TEST_TIMEOUT_MS|skip-name-resolve|反向 DNS/);
});
