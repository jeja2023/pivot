// 从 security-mcp.test.js 拆出；仍由父级入口统一加载。
const {
    Sqlite,
    assert,
    assertSafeMcpOutboundUrl,
    createMcpRouter,
    createPromptsRouter,
    db,
    fs,
    path,
    resolveDagNodeInput,
    runExpressHandlers,
    test
} = require('../security-helpers');

test('MCP 出站防护阻止普通用户访问回环地址，并允许管理员访问回环地址', async () => {
    await assert.rejects(
        assertSafeMcpOutboundUrl('http://127.0.0.1:3001/rpc', { role: 'user' }),
        /private or local MCP endpoints|sensitive local|metadata target/
    );
    await assert.doesNotReject(
        assertSafeMcpOutboundUrl('http://127.0.0.1:3001/rpc', { role: 'admin' })
    );
});

test('DAG 模板可通过 output.rows 简写读取 MCP 结构化行', () => {
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

test('非 root 管理员不能创建全局提示词或共享 MCP 服务', async () => {
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
    const promptListRoute = promptRouter.stack.find(layer => layer.route?.path === '/prompts' && layer.route?.methods?.get);
    const mcpRoute = mcpRouter.stack.find(layer => layer.route?.path === '/mcp/servers' && layer.route?.methods?.post);

    try {
        const promptReq = {
            body: {
                name: `Prompt ${suffix}`,
                content: 'test prompt',
                category: '治理',
                description: '规范库字段测试',
                type: 'method',
                targetSurfaces: ['agent', 'workflow'],
                scope: 'global'
            },
            user: adminUser
        };
        const promptRes = { json(body) { this.body = body; return this; }, status(code) { this.statusCode = code; return this; } };
        await runExpressHandlers(promptRoute.route.stack.map(layer => layer.handle), promptReq, promptRes);
        const prompt = db.prepare('SELECT * FROM prompts WHERE id = ?').get(promptRes.body.id);
        assert.equal(prompt.scope, 'personal');
        assert.equal(prompt.user_id, adminUser.id);
        assert.equal(prompt.type, 'method');
        assert.equal(prompt.target_surfaces, 'agent,workflow');
        assert.equal(prompt.description, '规范库字段测试');

        const promptListReq = {
            query: { surface: 'workflow', type: 'method', q: '规范库字段' },
            user: adminUser
        };
        const promptListRes = { json(body) { this.body = body; return this; }, status(code) { this.statusCode = code; return this; } };
        await runExpressHandlers(promptListRoute.route.stack.map(layer => layer.handle), promptListReq, promptListRes);
        const listedPrompt = promptListRes.body.find(item => item.id === promptRes.body.id);
        assert.ok(listedPrompt, 'created role policy asset should be returned by type/surface filter');
        assert.deepEqual(listedPrompt.targetSurfaces, ['agent', 'workflow']);
        assert.equal(listedPrompt.type, 'method');

        const mcpReq = {
            body: {
                name: `MCP ${suffix}`,
                base_url: 'https://192.0.2.10/rpc',
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

test('数据库 MCP 预设暴露 SQLite 只读工具并拒绝写入', async () => {
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

test('数据库 MCP 治理会限制表字段并脱敏敏感字段', async () => {
    const suffix = Date.now().toString(36);
    const sqlitePath = path.join(process.env.DATA_DIR, `mcp-governed-${suffix}.db`);
    const source = new Sqlite(sqlitePath);
    source.exec(`
        CREATE TABLE widgets (id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL, kind TEXT NOT NULL);
        CREATE TABLE secrets (id INTEGER PRIMARY KEY, token TEXT NOT NULL);
        INSERT INTO widgets (name, email, kind) VALUES ('alpha', 'alpha@example.test', 'red'), ('beta', 'beta@example.test', 'blue');
        INSERT INTO secrets (token) VALUES ('top-secret');
    `);
    source.close();

    const userInfo = db.prepare(`
        INSERT INTO users (username, password_hash, nickname, unit, role, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, datetime('now', '+8 hours'))
    `).run(`mcp_governed_${suffix}`, 'hash', 'MCP Governed DB Test', 'QA', 'admin', 'active');
    const adminUser = { id: Number(userInfo.lastInsertRowid), username: `mcp_governed_${suffix}`, role: 'admin', unit: 'QA' };
    const router = createMcpRouter({
        authMiddleware: (req, _res, next) => { req.user = adminUser; next(); },
        adminMiddleware: (_req, _res, next) => next(),
        logAction: () => {}
    });
    const createRoute = router.stack.find(layer => layer.route?.path === '/mcp/database-connections' && layer.route?.methods?.post);
    const refreshRoute = router.stack.find(layer => layer.route?.path === '/mcp/servers/:id/refresh' && layer.route?.methods?.post);
    const callRoute = router.stack.find(layer => layer.route?.path === '/mcp/tools/call' && layer.route?.methods?.post);
    let serverId = null;
    try {
        const createReq = {
            body: {
                name: `Governed SQLite ${suffix}`,
                database_type: 'sqlite',
                database_name: sqlitePath,
                max_rows: 5,
                table_allowlist: 'widgets',
                field_allowlist: 'widgets: id,name,email,kind',
                sensitive_fields: 'email',
                row_policy_hint: '仅演示脱敏字段',
                query_timeout_ms: 5000
            },
            user: adminUser
        };
        const createRes = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
        await runExpressHandlers(createRoute.route.stack.map(layer => layer.handle), createReq, createRes);
        assert.equal(createRes.statusCode, 201);
        serverId = createRes.body.server.id;

        const refreshReq = { params: { id: String(serverId) }, user: adminUser };
        const refreshRes = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
        await runExpressHandlers(refreshRoute.route.stack.map(layer => layer.handle), refreshReq, refreshRes);
        assert.equal(refreshRes.statusCode, 200);

        const listReq = { body: { name: `mcp.${serverId}.db.list_tables`, input: {} }, user: adminUser };
        const listRes = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
        await runExpressHandlers(callRoute.route.stack.map(layer => layer.handle), listReq, listRes);
        assert.deepEqual(listRes.body.result.structuredContent.map(row => row.name), ['widgets']);

        const queryReq = {
            body: {
                name: `mcp.${serverId}.db.run_readonly_query`,
                input: { sql: 'SELECT name, email FROM widgets ORDER BY id', limit: 2 }
            },
            user: adminUser
        };
        const queryRes = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
        await runExpressHandlers(callRoute.route.stack.map(layer => layer.handle), queryReq, queryRes);
        assert.deepEqual(queryRes.body.result.structuredContent.rows, [
            { name: 'alpha', email: '[已脱敏]' },
            { name: 'beta', email: '[已脱敏]' }
        ]);
        assert.equal(queryRes.body.result.structuredContent.cost.operation, 'readonly_sql');
        assert.equal(queryRes.body.result.structuredContent.governance.rowPolicyHint, '仅演示脱敏字段');

        const blockedReq = {
            body: {
                name: `mcp.${serverId}.db.run_readonly_query`,
                input: { sql: 'SELECT token FROM secrets' }
            },
            user: adminUser
        };
        const blockedRes = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
        await assert.rejects(
            runExpressHandlers(callRoute.route.stack.map(layer => layer.handle), blockedReq, blockedRes),
            /不在允许访问的表白名单/
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
test('MCP outbound policy normalizes IPv4-mapped IPv6 literals', async () => {
    for (const host of ['127.0.0.1', '10.0.0.1', '169.254.169.254']) {
        await assert.rejects(
            assertSafeMcpOutboundUrl(`http://[::ffff:${host}]:3001/rpc`, { role: 'user' }),
            /private or local MCP endpoints|sensitive local|metadata target/
        );
    }
});
