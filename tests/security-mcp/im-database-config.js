// 从 security-mcp.test.js 拆出；仍由父级入口统一加载。
const {
    assert,
    buildDatabaseTestConnectionConfig,
    createMcpRouter,
    db,
    http,
    normalizeDatabaseConnectionError,
    runExpressHandlers,
    test,
    validateDatabaseConnectionPayload
} = require('../security-helpers');
const { assertSafeDatabaseHost } = require('../../server/services/database-mcp/connection-policy');

test('内置即时消息 MCP 校验目标白名单并发送局域网 webhook 载荷', async () => {
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
            /allowed target|允许的通知目标/
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

test('数据库 MCP 默认限制私有局域网主机，并支持显式关闭限制', () => {
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

test('数据库 MCP 仅允许管理员在受控只读诊断中探测显式 loopback 地址', async () => {
    const admin = { id: 1002, username: 'admin', role: 'admin' };
    const user = { id: 1001, username: 'operator', role: 'user' };

    await assert.rejects(
        assertSafeDatabaseHost('127.0.0.1', admin),
        err => err?.code === 'MCP_PRIVATE_HOST_RESTRICTED'
    );
    await assert.doesNotReject(
        assertSafeDatabaseHost('127.0.0.1', admin, { allowExplicitLoopbackForAdmin: true })
    );
    await assert.rejects(
        assertSafeDatabaseHost('127.0.0.1', user, { allowExplicitLoopbackForAdmin: true }),
        err => err?.code === 'MCP_PRIVATE_HOST_RESTRICTED'
    );
});

test('数据库 MCP 测试配置会展开驱动所需选项', () => {
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

test('数据库 MCP 连接错误返回可操作诊断信息', () => {
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
