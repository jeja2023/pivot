// 从 security-mcp.test.js 拆出；仍由父级入口统一加载。
const {
    Sqlite,
    assert,
    buildGenericDatabaseTools,
    createMcpRouter,
    db,
    formatToolList,
    fs,
    getBeijingTimestamp,
    getRunDetailForUser,
    http,
    os,
    path,
    refreshMcpTools,
    runAgent,
    runExpressHandlers,
    test
} = require('../security-helpers');
const {
    filterMcpToolsByCapability,
    setCapabilityToolGovernance,
    upsertCapabilityPackage
} = require('../../server/services/capability-market');

test('admin tool policy routes manage only global tool packages', async () => {
    const suffix = Date.now().toString(36);
    const userInfo = db.prepare(`
        INSERT INTO users (username, password_hash, nickname, unit, role, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, datetime('now', '+8 hours'))
    `).run(`tool_policy_${suffix}`, 'hash', 'Tool Policy Admin', 'QA', 'admin', 'active');
    const managerUser = { id: Number(userInfo.lastInsertRowid), username: `tool_policy_${suffix}`, role: 'admin', unit: 'QA' };
    const superUser = { id: 1, username: 'admin', role: 'admin', unit: 'HQ' };
    const now = getBeijingTimestamp();
    const globalServerInfo = db.prepare(`
        INSERT INTO mcp_servers (user_id, name, base_url, api_key, description, status, created_at, updated_at)
        VALUES (?, ?, ?, '', ?, 'active', ?, ?)
    `).run(null, `Global Policy MCP ${suffix}`, 'http://127.0.0.1:65530/mcp', 'global policy route test', now, now);
    const globalServerId = Number(globalServerInfo.lastInsertRowid);
    const privateServerInfo = db.prepare(`
        INSERT INTO mcp_servers (user_id, name, base_url, api_key, description, status, created_at, updated_at)
        VALUES (?, ?, ?, '', ?, 'active', ?, ?)
    `).run(managerUser.id, `Private Policy MCP ${suffix}`, 'http://127.0.0.1:65531/mcp', 'private policy route test', now, now);
    const privateServerId = Number(privateServerInfo.lastInsertRowid);
    db.prepare(`
        INSERT INTO mcp_tool_cache (server_id, name, description, input_schema, cached_at)
        VALUES (?, ?, ?, ?, ?)
    `).run(globalServerId, 'external.search', 'search external records', '{"type":"object"}', now);
    db.prepare(`
        INSERT INTO mcp_tool_cache (server_id, name, description, input_schema, cached_at)
        VALUES (?, ?, ?, ?, ?)
    `).run(privateServerId, 'private.search', 'search private records', '{"type":"object"}', now);
    const makeRes = () => ({
        statusCode: 200,
        status(code) { this.statusCode = code; return this; },
        json(body) { this.body = body; return this; }
    });
    const router = createMcpRouter({
        authMiddleware: (req, _res, next) => { req.user = req.user || managerUser; next(); },
        adminMiddleware: (_req, _res, next) => next(),
        logAction: () => {}
    });
    const packagesRoute = router.stack.find(layer => layer.route?.path === '/capabilities/packages' && layer.route?.methods?.get);
    const toolsRoute = router.stack.find(layer => layer.route?.path === '/capabilities/packages/:key/tools' && layer.route?.methods?.get);
    const saveRoute = router.stack.find(layer => layer.route?.path === '/capabilities/packages/:key/tools/:tool' && layer.route?.methods?.put);
    const globalPackageKey = `mcp_server:${globalServerId}`;
    const privatePackageKey = `mcp_server:${privateServerId}`;
    try {
        const packagesRes = makeRes();
        await runExpressHandlers(packagesRoute.route.stack.map(layer => layer.handle), { user: managerUser }, packagesRes);
        assert.equal(packagesRes.statusCode, 200);
        assert.equal(packagesRes.body.data.some(item => item.package_key === globalPackageKey), true);
        assert.equal(packagesRes.body.data.some(item => item.package_key === privatePackageKey), false);

        const privateRes = makeRes();
        await runExpressHandlers(toolsRoute.route.stack.map(layer => layer.handle), {
            params: { key: privatePackageKey },
            user: managerUser
        }, privateRes);
        assert.equal(privateRes.statusCode, 404);

        const listRes = makeRes();
        await runExpressHandlers(toolsRoute.route.stack.map(layer => layer.handle), {
            params: { key: globalPackageKey },
            user: managerUser
        }, listRes);
        assert.equal(listRes.statusCode, 200);
        assert.equal(listRes.body.item.package_key, globalPackageKey);
        assert.equal(listRes.body.tools.length, 1);
        assert.equal(listRes.body.tools[0].name, 'external.search');
        assert.equal(listRes.body.tools[0].governance.enabled, true);

        await assert.rejects(
            runExpressHandlers(saveRoute.route.stack.map(layer => layer.handle), {
                params: { key: globalPackageKey, tool: 'external.search' },
                body: { enabled: false },
                user: managerUser
            }, makeRes()),
            err => err?.status === 403
        );

        const saveRes = makeRes();
        await runExpressHandlers(saveRoute.route.stack.map(layer => layer.handle), {
            params: { key: globalPackageKey, tool: 'external.search' },
            body: {
                enabled: false,
                riskLevel: 'high',
                approvalRequired: true,
                usage: 'Only after admin approval'
            },
            user: superUser
        }, saveRes);
        assert.equal(saveRes.statusCode, 200);
        assert.equal(saveRes.body.item.governance.enabled, false);
        assert.equal(saveRes.body.item.governance.riskLevel, 'high');
        assert.equal(saveRes.body.item.governance.approvalRequired, true);

        const rereadRes = makeRes();
        await runExpressHandlers(toolsRoute.route.stack.map(layer => layer.handle), {
            params: { key: globalPackageKey },
            user: managerUser
        }, rereadRes);
        assert.equal(rereadRes.body.tools[0].governance.enabled, false);
        assert.equal(rereadRes.body.tools[0].governance.usage, 'Only after admin approval');
    } finally {
        db.prepare('DELETE FROM capability_packages WHERE package_key IN (?, ?)').run(globalPackageKey, privatePackageKey);
        db.prepare('DELETE FROM mcp_tool_cache WHERE server_id IN (?, ?)').run(globalServerId, privateServerId);
        db.prepare('DELETE FROM mcp_servers WHERE id IN (?, ?)').run(globalServerId, privateServerId);
        db.prepare('DELETE FROM users WHERE id = ?').run(managerUser.id);
    }
});

test('本机桥接执行错误会按路径错误归一化状态码', async () => {
    const {
        completeLocalBridgeTask,
        executeBridgeLocalDeviceMcpTool,
        registerLocalBridgeDevice,
        resetLocalBridgeForTests
    } = require('../../server/services/local-device-bridge');
    const user = { id: 1, username: 'admin', role: 'admin', unit: 'HQ' };
    const deviceId = `bridge-error-${Date.now()}`;
    resetLocalBridgeForTests();
    try {
        registerLocalBridgeDevice(user, {
            deviceId,
            deviceName: '测试电脑',
            provider: 'desktop',
            mode: 'remote',
            grants: {
                local_report_dir: {
                    authorized: true,
                    resourceKind: 'report_directory',
                    label: '法律',
                    pathHint: '法律'
                }
            }
        });
        const pending = executeBridgeLocalDeviceMcpTool('reports.list_files', { limit: 80 }, user);
        const task = await require('../../server/services/local-device-bridge').pollLocalBridgeTask(user, deviceId, 1000);
        assert.equal(task.status, 'claimed');
        assert.equal(task.task.toolName, 'reports.list_files');
        completeLocalBridgeTask(user, task.task.id, {
            deviceId,
            success: false,
            error: {
                message: '本机报表目录中存在无法按目录读取的路径，或当前授权目标不是有效目录；请重新授权一个真实文件夹后再试。',
                code: 'ENOTDIR'
            }
        });
        await assert.rejects(pending, err => {
            assert.equal(err.status, 400);
            assert.equal(err.code, 'ENOTDIR');
            assert.match(err.message, /有效目录|目录读取/);
            return true;
        });
    } finally {
        resetLocalBridgeForTests();
    }
});

test('Agent 工具目录将数据库 MCP 工具归并为通用操作', () => {
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

test('工具包工具级治理会过滤已停用 MCP 工具', () => {
    const suffix = Date.now().toString(36);
    const userInfo = db.prepare(`
        INSERT INTO users (username, password_hash, nickname, unit, role, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, datetime('now', '+8 hours'))
    `).run(`mcp_tool_gov_${suffix}`, 'hash', 'MCP Tool Governance', 'QA', 'admin', 'active');
    const user = { id: Number(userInfo.lastInsertRowid), username: `mcp_tool_gov_${suffix}`, role: 'admin', unit: 'QA' };
    const serverId = 900000 + Math.floor(Math.random() * 10000);
    try {
        upsertCapabilityPackage({
            type: 'database_connection',
            sourceRef: String(serverId),
            name: `Governed DB ${suffix}`,
            scope: 'user',
            userId: user.id,
            config: { serverId, serverType: 'database', databaseType: 'sqlite' }
        });
        const packageKey = `database_connection:${serverId}`;
        const updated = setCapabilityToolGovernance(packageKey, user, 'db.run_readonly_query', {
            enabled: false,
            riskLevel: 'high',
            approvalRequired: true,
            usage: '仅审批后查询'
        });
        assert.equal(updated.governance.enabled, false);
        const filtered = filterMcpToolsByCapability([
            { serverId, serverType: 'database', name: 'db.list_tables', fullName: `mcp.${serverId}.db.list_tables` },
            { serverId, serverType: 'database', name: 'db.run_readonly_query', fullName: `mcp.${serverId}.db.run_readonly_query` }
        ], user);
        assert.deepEqual(filtered.map(tool => tool.name), ['db.list_tables']);
    } finally {
        db.prepare('DELETE FROM capability_packages WHERE package_key = ?').run(`database_connection:${serverId}`);
        db.prepare('DELETE FROM users WHERE id = ?').run(user.id);
    }
});

test('Agent 工具列表将数据库连接作为参数暴露，并路由通用 DAG 工具', async () => {
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

test('内置报表 MCP 只列出并查询已配置文件', async () => {
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

test('可视化和报表 MCP 可独立组合数据源 MCP', async () => {
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

test('系统 MCP 服务无需用户填写名称即可启用', async () => {
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

test('超级管理员查看其他用户工具时返回所属用户信息', async () => {
    const suffix = Date.now().toString(36);
    const ownerInfo = db.prepare(`
        INSERT INTO users (username, password_hash, nickname, unit, role, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, datetime('now', '+8 hours'))
    `).run(`mcp_owner_${suffix}`, 'hash', '工具负责人', '数据部', 'user', 'active');
    const ownerUser = { id: Number(ownerInfo.lastInsertRowid), username: `mcp_owner_${suffix}`, role: 'user', unit: '数据部' };
    const superUser = { id: 1, username: 'admin', role: 'admin', unit: 'HQ' };
    const now = getBeijingTimestamp();
    const serverInfo = db.prepare(`
        INSERT INTO mcp_servers (user_id, name, base_url, api_key, description, status, created_at, updated_at)
        VALUES (?, ?, ?, '', ?, 'active', ?, ?)
    `).run(ownerUser.id, `Owner MCP ${suffix}`, 'http://127.0.0.1:65532/mcp', 'owner metadata test', now, now);
    const serverId = Number(serverInfo.lastInsertRowid);
    db.prepare(`
        INSERT INTO mcp_tool_cache (server_id, name, description, input_schema, cached_at)
        VALUES (?, ?, ?, ?, ?)
    `).run(serverId, 'owner.lookup', 'look up owner scoped data', '{"type":"object"}', now);
    const router = createMcpRouter({
        authMiddleware: (req, _res, next) => { req.user = req.user || superUser; next(); },
        adminMiddleware: (_req, _res, next) => next(),
        logAction: () => {}
    });
    const serversRoute = router.stack.find(layer => layer.route?.path === '/mcp/servers' && layer.route?.methods?.get);
    const toolsRoute = router.stack.find(layer => layer.route?.path === '/mcp/tools' && layer.route?.methods?.get);
    const makeRes = () => ({
        statusCode: 200,
        status(code) { this.statusCode = code; return this; },
        json(body) { this.body = body; return this; }
    });
    try {
        const serversRes = makeRes();
        await runExpressHandlers(serversRoute.route.stack.map(layer => layer.handle), { user: superUser }, serversRes);
        const listedServer = serversRes.body.data.find(item => item.id === serverId);
        assert.equal(listedServer.owner.displayName, '工具负责人');
        assert.equal(listedServer.owner.username, ownerUser.username);
        assert.equal(listedServer.owner.unit, '数据部');

        const toolsRes = makeRes();
        await runExpressHandlers(toolsRoute.route.stack.map(layer => layer.handle), { user: superUser }, toolsRes);
        const listedTool = toolsRes.body.tools.find(item => item.fullName === `mcp.${serverId}.owner.lookup`);
        assert.equal(listedTool.owner.displayName, '工具负责人');
        assert.equal(listedTool.owner.username, ownerUser.username);

        const agentTool = formatToolList(superUser).find(item => item.name === `mcp.${serverId}.owner.lookup`);
        assert.equal(agentTool.owner.displayName, '工具负责人');
        assert.equal(agentTool.owner.unit, '数据部');
    } finally {
        db.prepare('DELETE FROM capability_packages WHERE package_key = ?').run(`mcp_server:${serverId}`);
        db.prepare('DELETE FROM mcp_tool_cache WHERE server_id = ?').run(serverId);
        db.prepare('DELETE FROM mcp_servers WHERE id = ?').run(serverId);
        db.prepare('DELETE FROM users WHERE id = ?').run(ownerUser.id);
    }
});

test('系统工具 MCP 服务暴露文档、数据和格式化工具', async () => {
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

test('系统即时消息 MCP 使用默认服务身份和用户配置', async () => {
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

test('desktop local read-only executor exposes authorized SQLite and report directory only', async () => {
    const suffix = Date.now().toString(36);
    const localRoot = fs.mkdtempSync(path.join(os.tmpdir(), `pivot-local-executor-${suffix}-`));
    const reportDir = path.join(localRoot, 'reports');
    fs.mkdirSync(reportDir, { recursive: true });
    fs.writeFileSync(path.join(reportDir, 'sales.csv'), 'dept,amount\nops,10\nrnd,25\nops,30\n', 'utf8');

    const sqlitePath = path.join(localRoot, 'local.db');
    const sqlite = new Sqlite(sqlitePath);
    sqlite.exec(`
        CREATE TABLE widgets (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
        INSERT INTO widgets (name) VALUES ('local-alpha'), ('local-beta');
    `);
    sqlite.close();

    const authFile = path.join(localRoot, 'local-authorizations.json');
    fs.writeFileSync(authFile, JSON.stringify({
        version: 1,
        grants: {
            local_database: {
                resourceKind: 'sqlite_file',
                path: sqlitePath,
                label: 'Local SQLite'
            },
            local_report_dir: {
                resourceKind: 'report_directory',
                path: reportDir,
                label: 'Local Reports',
                extensions: ['csv'],
                maxRows: 20
            }
        }
    }), 'utf8');

    const previousDesktop = process.env.PIVOT_DESKTOP;
    const previousHelper = process.env.PIVOT_LOCAL_HELPER;
    const previousAuthFile = process.env.PIVOT_LOCAL_AUTHORIZATIONS_FILE;
    process.env.PIVOT_DESKTOP = 'true';
    delete process.env.PIVOT_LOCAL_HELPER;
    process.env.PIVOT_LOCAL_AUTHORIZATIONS_FILE = authFile;

    const userInfo = db.prepare(`
        INSERT INTO users (username, password_hash, nickname, unit, role, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, datetime('now', '+8 hours'))
    `).run(`local_executor_${suffix}`, 'hash', 'Local Executor Test', 'QA', 'admin', 'active');
    const adminUser = { id: Number(userInfo.lastInsertRowid), username: `local_executor_${suffix}`, role: 'admin', unit: 'QA' };
    const router = createMcpRouter({
        authMiddleware: (req, _res, next) => { req.user = adminUser; next(); },
        adminMiddleware: (_req, _res, next) => next(),
        logAction: () => {}
    });
    const makeRes = () => ({
        statusCode: 200,
        status(code) { this.statusCode = code; return this; },
        json(body) { this.body = body; return this; }
    });
    const toolsRoute = router.stack.find(layer => layer.route?.path === '/mcp/tools' && layer.route?.methods?.get);
    const callRoute = router.stack.find(layer => layer.route?.path === '/mcp/tools/call' && layer.route?.methods?.post);

    try {
        const toolsRes = makeRes();
        await runExpressHandlers(toolsRoute.route.stack.map(layer => layer.handle), { user: adminUser }, toolsRes);
        assert.equal(toolsRes.statusCode, 200);
        const fullNames = toolsRes.body.tools.map(tool => tool.fullName);
        assert.equal(fullNames.includes('mcp.0.reports.list_files'), true);
        assert.equal(fullNames.includes('mcp.0.db.run_readonly_query'), true);
        assert.equal(toolsRes.body.tools.find(tool => tool.fullName === 'mcp.0.db.run_readonly_query').serverId, 0);

        const agentTools = formatToolList(adminUser);
        const genericQuery = agentTools.find(tool => tool.name === 'db.run_readonly_query');
        assert.equal(genericQuery?.databaseConnections.some(connection => connection.serverId === '0'), true);
        assert.equal(genericQuery?.input_schema.properties.connectionId.enum.includes('0'), true);

        const listRes = makeRes();
        await runExpressHandlers(callRoute.route.stack.map(layer => layer.handle), {
            body: { name: 'mcp.0.reports.list_files', input: { query: 'sales' } },
            user: adminUser
        }, listRes);
        assert.equal(listRes.statusCode, 200);
        const listedFile = listRes.body.result.structuredContent.files[0];
        assert.equal(listedFile.path, '0:sales.csv');
        assert.equal(listedFile.relativePath, 'sales.csv');
        const listedText = JSON.stringify(listedFile).replace(/\\\\/g, '\\');
        assert.equal(listedText.includes(sqlitePath), false);
        assert.equal(listedText.includes(reportDir), false);

        const queryTableRes = makeRes();
        await runExpressHandlers(callRoute.route.stack.map(layer => layer.handle), {
            body: {
                name: 'mcp.0.reports.query_table',
                input: { path: listedFile.path, filters: { dept: 'ops' }, columns: ['amount'], limit: 5 }
            },
            user: adminUser
        }, queryTableRes);
        assert.deepEqual(queryTableRes.body.result.structuredContent.rows.map(row => row.amount), ['10', '30']);
        assert.equal(queryTableRes.body.result.structuredContent.file.relativePath, 'sales.csv');

        await assert.rejects(
            runExpressHandlers(callRoute.route.stack.map(layer => layer.handle), {
                body: { name: 'mcp.0.reports.read_file_summary', input: { path: '0:../local.db' } },
                user: adminUser
            }, makeRes()),
            err => err?.status === 404
        );

        const dbRes = makeRes();
        await runExpressHandlers(callRoute.route.stack.map(layer => layer.handle), {
            body: {
                name: 'mcp.0.db.run_readonly_query',
                input: { sql: 'SELECT name FROM widgets ORDER BY id', limit: 1 }
            },
            user: adminUser
        }, dbRes);
        assert.equal(dbRes.statusCode, 200);
        assert.deepEqual(dbRes.body.result.structuredContent.rows.map(row => row.name), ['local-alpha']);

        await assert.rejects(
            runExpressHandlers(callRoute.route.stack.map(layer => layer.handle), {
                body: {
                    name: 'mcp.0.db.run_readonly_query',
                    input: { sql: "INSERT INTO widgets (name) VALUES ('blocked')" }
                },
                user: adminUser
            }, makeRes()),
            /Only readonly SQL is allowed/
        );

        const callLog = db.prepare(`
            SELECT server_id, tool_name, source, input_preview, output_preview
            FROM mcp_call_logs
            WHERE user_id = ?
            ORDER BY id DESC
            LIMIT 1
        `).get(adminUser.id);
        assert.equal(callLog.server_id, null);
        assert.equal(callLog.tool_name, 'db.run_readonly_query');
        assert.match(callLog.input_preview, /INSERT INTO widgets/);
    } finally {
        if (previousDesktop === undefined) delete process.env.PIVOT_DESKTOP;
        else process.env.PIVOT_DESKTOP = previousDesktop;
        if (previousHelper === undefined) delete process.env.PIVOT_LOCAL_HELPER;
        else process.env.PIVOT_LOCAL_HELPER = previousHelper;
        if (previousAuthFile === undefined) delete process.env.PIVOT_LOCAL_AUTHORIZATIONS_FILE;
        else process.env.PIVOT_LOCAL_AUTHORIZATIONS_FILE = previousAuthFile;
        db.prepare('DELETE FROM mcp_call_logs WHERE user_id = ?').run(adminUser.id);
        db.prepare('DELETE FROM users WHERE id = ?').run(adminUser.id);
        fs.rmSync(localRoot, { recursive: true, force: true });
    }
});
test('remote desktop bridge exposes authorized local MCP tools', async () => {
    const suffix = Date.now().toString(36);
    const userInfo = db.prepare(`
        INSERT INTO users (username, password_hash, nickname, unit, role, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, datetime('now', '+8 hours'))
    `).run(`remote_local_bridge_${suffix}`, 'hash', 'Remote Local Bridge', 'QA', 'admin', 'active');
    const user = { id: Number(userInfo.lastInsertRowid), username: `remote_local_bridge_${suffix}`, role: 'admin', unit: 'QA' };
    const { resetLocalBridgeForTests } = require('../../server/services/local-device-bridge');
    const router = createMcpRouter({
        authMiddleware: (req, _res, next) => { req.user = req.user || user; next(); },
        adminMiddleware: (_req, _res, next) => next(),
        logAction: () => {}
    });
    const makeRes = () => ({
        statusCode: 200,
        status(code) { this.statusCode = code; return this; },
        json(body) { this.body = body; return this; }
    });
    const heartbeatRoute = router.stack.find(layer => layer.route?.path === '/mcp/local-device/heartbeat' && layer.route?.methods?.post);
    const nextRoute = router.stack.find(layer => layer.route?.path === '/mcp/local-device/tasks/next' && layer.route?.methods?.get);
    const completeRoute = router.stack.find(layer => layer.route?.path === '/mcp/local-device/tasks/:id/result' && layer.route?.methods?.post);
    const toolsRoute = router.stack.find(layer => layer.route?.path === '/mcp/tools' && layer.route?.methods?.get);
    const serverToolsRoute = router.stack.find(layer => layer.route?.path === '/mcp/servers/:id/tools' && layer.route?.methods?.get);
    const callRoute = router.stack.find(layer => layer.route?.path === '/mcp/tools/call' && layer.route?.methods?.post);
    const deviceId = `desktop-${suffix}`;
    try {
        const heartbeatRes = makeRes();
        await runExpressHandlers(heartbeatRoute.route.stack.map(layer => layer.handle), {
            user,
            body: {
                deviceId,
                deviceName: 'QA Desktop',
                provider: 'desktop',
                mode: 'remote',
                grants: {
                    local_database: { type: 'local_database', authorized: true, label: 'Local DB', pathHint: 'local.db' },
                    local_report_dir: { type: 'local_report_dir', authorized: true, label: 'Reports', pathHint: 'Reports' }
                }
            }
        }, heartbeatRes);
        assert.equal(heartbeatRes.statusCode, 200);
        assert.equal(heartbeatRes.body.tools.some(tool => tool.fullName === 'mcp.0.reports.list_files'), true);
        assert.equal(heartbeatRes.body.tools.some(tool => tool.fullName === 'mcp.0.db.run_readonly_query'), true);

        const toolsRes = makeRes();
        await runExpressHandlers(toolsRoute.route.stack.map(layer => layer.handle), { user }, toolsRes);
        assert.equal(toolsRes.body.tools.some(tool => tool.fullName === 'mcp.0.reports.list_files'), true);

        const localServerToolsRes = makeRes();
        await runExpressHandlers(serverToolsRoute.route.stack.map(layer => layer.handle), {
            user,
            params: { id: '0' }
        }, localServerToolsRes);
        assert.equal(localServerToolsRes.statusCode, 200);
        assert.equal(localServerToolsRes.body.tools.some(tool => tool.fullName === 'mcp.0.reports.list_files'), true);
        assert.equal(localServerToolsRes.body.tools.some(tool => tool.fullName === 'mcp.0.db.run_readonly_query'), true);

        const agentTools = formatToolList(user);
        const genericQuery = agentTools.find(tool => tool.name === 'db.run_readonly_query');
        assert.equal(genericQuery?.databaseConnections.some(connection => connection.serverId === '0'), true);

        const callRes = makeRes();
        const callPromise = runExpressHandlers(callRoute.route.stack.map(layer => layer.handle), {
            user,
            body: { name: 'mcp.0.reports.list_files', input: { query: 'sales' } }
        }, callRes);
        await new Promise(resolve => setImmediate(resolve));

        const nextRes = makeRes();
        await runExpressHandlers(nextRoute.route.stack.map(layer => layer.handle), {
            user,
            query: { deviceId, waitMs: '1000' }
        }, nextRes);
        assert.equal(nextRes.statusCode, 200);
        assert.equal(nextRes.body.task.toolName, 'reports.list_files');
        assert.deepEqual(nextRes.body.task.input, { query: 'sales' });

        const completeRes = makeRes();
        await runExpressHandlers(completeRoute.route.stack.map(layer => layer.handle), {
            user,
            params: { id: nextRes.body.task.id },
            body: {
                deviceId,
                success: true,
                result: {
                    files: [{ path: '0:sales.csv', relativePath: 'sales.csv' }],
                    count: 1
                }
            }
        }, completeRes);
        assert.equal(completeRes.statusCode, 200);

        await callPromise;
        assert.equal(callRes.statusCode, 200);
        assert.equal(callRes.body.result.structuredContent.files[0].path, '0:sales.csv');

        const callLog = db.prepare(`
            SELECT server_id, tool_name, source, output_preview
            FROM mcp_call_logs
            WHERE user_id = ?
            ORDER BY id DESC
            LIMIT 1
        `).get(user.id);
        assert.equal(callLog.server_id, null);
        assert.equal(callLog.tool_name, 'reports.list_files');
        assert.match(callLog.output_preview, /sales\.csv/);
    } finally {
        resetLocalBridgeForTests();
        db.prepare('DELETE FROM mcp_call_logs WHERE user_id = ?').run(user.id);
        db.prepare('DELETE FROM users WHERE id = ?').run(user.id);
    }
});
