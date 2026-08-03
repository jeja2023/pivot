// 从 security-mcp.test.js 拆出；仍由父级入口统一加载。
const {
    Sqlite,
    assert,
    buildFallbackDataQueryInput,
    db,
    detectReportFileInventoryIntent,
    detectStrongDataQueryIntent,
    filterMcpToolsForChatIntent,
    filterMcpToolsForPlanner,
    fs,
    getBeijingTimestamp,
    http,
    listCachedMcpTools,
    maybeBuildMcpChatContext,
    os,
    path,
    refreshMcpTools,
    test
} = require('../security-helpers');
const { appendMcpContextForFinalAnswer } = require('../../server/services/chat-context-assembler');

test('聊天 MCP 意图过滤不会为普通数据查询暴露可视化工具', () => {
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

test('聊天 MCP 兜底会为表分布图构造 group_count 输入', () => {
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

test('聊天 MCP 上下文会为明确能力请求报告缺少匹配工具', async () => {
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
    assert.match(events[0].message, /没有匹配用户请求的工具库工具/);
    assert.match(context, /需要工具库工具/);
    assert.match(context, /没有匹配的工具库工具/);
    assert.doesNotMatch(context, /本轮不需要调用工具库工具/);
});

test('聊天 MCP 本机目录请求不会误用数据库工具', async () => {
    const { resetLocalBridgeForTests } = require('../../server/services/local-device-bridge');
    resetLocalBridgeForTests();
    const prompt = '查询本机法律目录下有哪些文件';
    const dbOnlyTools = [{
        fullName: 'mcp.0.db.run_readonly_query',
        name: 'db.run_readonly_query',
        serverName: 'DESKTOP-SNH56CH：本机 SQLite',
        description: '执行只读 SQL',
        input_schema: { type: 'object' }
    }];
    const filtered = filterMcpToolsForChatIntent(dbOnlyTools, prompt);
    assert.deepEqual(filtered, []);

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
        history: [{ role: 'user', content: prompt }],
        userPrompt: prompt,
        tools: dbOnlyTools,
        user: { id: 1, username: 'admin', role: 'admin', unit: '' },
        writeSse(payload) {
            events.push(JSON.parse(payload));
        },
        log: { warn() {} }
    });

    assert.deepEqual(events.filter(event => event.type === 'mcp').map(event => event.status), ['skipped']);
    assert.match(context, /本机报表目录|桌面端本机执行器/);
    assert.doesNotMatch(context, /db\.run_readonly_query.*无法调用的原因：规划器未选择工具/s);
});

test('聊天 MCP 本机目录请求会报告桌面端桥接诊断', async () => {
    const { resetLocalBridgeForTests } = require('../../server/services/local-device-bridge');
    resetLocalBridgeForTests();
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
        history: [{ role: 'user', content: '查询本机法律目录下有哪些文件' }],
        userPrompt: '查询本机法律目录下有哪些文件',
        tools: [],
        user: { id: 1, username: 'admin', role: 'admin', unit: '' },
        localMcpBridgeDebug: {
            page: 'chat',
            status: 'bridge_unavailable',
            hasDesktopBridge: false,
            hasStatusBridge: false,
            hasExecuteBridge: false,
            reason: '聊天页没有检测到桌面端桥 window.pivotDesktop；请确认当前页面在桌面客户端中打开，而不是普通浏览器。'
        },
        writeSse(payload) {
            events.push(JSON.parse(payload));
        },
        log: { warn() {} }
    });

    assert.match(events[0].message, /window\.pivotDesktop|普通浏览器/);
    assert.match(context, /window\.pivotDesktop|普通浏览器/);
});

test('聊天 MCP 会将本机目录文件清单请求确定性路由到报表工具', async () => {
    assert.equal(detectReportFileInventoryIntent('查询本机法律目录下有哪些文件'), true);

    const suffix = Date.now().toString(36);
    const reportParent = fs.mkdtempSync(path.join(os.tmpdir(), `pivot-chat-local-reports-${suffix}-`));
    const legalDir = path.join(reportParent, '法律');
    fs.mkdirSync(legalDir, { recursive: true });
    fs.writeFileSync(path.join(legalDir, '法规.md'), '# 法规\n', 'utf8');
    fs.writeFileSync(path.join(legalDir, '合同.csv'), 'name,type\n合同,法律\n', 'utf8');

    const localRoot = fs.mkdtempSync(path.join(os.tmpdir(), `pivot-chat-local-auth-${suffix}-`));
    const authFile = path.join(localRoot, 'local-authorizations.json');
    fs.writeFileSync(authFile, JSON.stringify({
        version: 1,
        grants: {
            local_report_dir: {
                resourceKind: 'report_directory',
                path: legalDir,
                label: '法律',
                extensions: ['md', 'csv'],
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

    const plannerServer = http.createServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            choices: [{ message: { content: JSON.stringify({ action: 'none', reason: '不需要工具库' }) } }]
        }));
    });

    try {
        await new Promise(resolve => plannerServer.listen(0, '127.0.0.1', resolve));
        const events = [];
        const context = await maybeBuildMcpChatContext({
            modelCfg: {
                id: 1,
                name: 'Fake Planner',
                model_name: 'planner-test',
                url: `http://127.0.0.1:${plannerServer.address().port}/v1`,
                api_key: '',
                user_id: null
            },
            history: [{ role: 'user', content: '查询本机法律目录下有哪些文件' }],
            userPrompt: '查询本机法律目录下有哪些文件',
            tools: [{
                fullName: 'mcp.0.reports.list_files',
                name: 'reports.list_files',
                serverName: 'DESKTOP-SNH56CH：我的电脑',
                description: '列出配置目录下可访问的报表/数据文件。',
                input_schema: { type: 'object' },
                localDevice: {
                    online: true,
                    grants: {
                        local_report_dir: {
                            authorized: true,
                            label: '法律',
                            pathHint: '法律'
                        }
                    }
                }
            }],
            user: { id: 1, username: 'admin', role: 'admin', unit: '' },
            writeSse(payload) {
                events.push(JSON.parse(payload));
            },
            log: { warn() {} }
        });

        assert.match(context, /PIVOT_MCP_TOOL_RESULT_BEGIN/);
        assert.match(context, /PIVOT_MCP_TOOL_RESULT_END/);
        assert.match(context, /工具: mcp\.0\.reports\.list_files/);
        assert.match(context, /法规\.md/);
        assert.match(context, /"limit":80|"limit": 80/);
        assert.doesNotMatch(context, /"query":"法律"|"query": "法律"/);
        assert.deepEqual(events.filter(event => event.type === 'mcp').map(event => event.status), ['planning', 'running', 'done']);
        const running = events.find(event => event.type === 'mcp' && event.status === 'running');
        assert.equal(running.toolName, 'reports.list_files');
        assert.match(running.message, /查找报表文件/);
    } finally {
        await new Promise(resolve => plannerServer.close(resolve));
        if (previousDesktop === undefined) delete process.env.PIVOT_DESKTOP;
        else process.env.PIVOT_DESKTOP = previousDesktop;
        if (previousHelper === undefined) delete process.env.PIVOT_LOCAL_HELPER;
        else process.env.PIVOT_LOCAL_HELPER = previousHelper;
        if (previousAuthFile === undefined) delete process.env.PIVOT_LOCAL_AUTHORIZATIONS_FILE;
        else process.env.PIVOT_LOCAL_AUTHORIZATIONS_FILE = previousAuthFile;
        db.prepare("DELETE FROM mcp_call_logs WHERE server_id IS NULL AND tool_name = 'reports.list_files' AND source = 'chat_fallback'").run();
        fs.rmSync(reportParent, { recursive: true, force: true });
        fs.rmSync(localRoot, { recursive: true, force: true });
    }
});


test('chat MCP result context is appended as final answer turn for reasoning models', () => {
    const messages = appendMcpContextForFinalAnswer([
        { role: 'system', content: 'system prompt' },
        { role: 'user', content: 'count files in my local report directory' }
    ], [
        'PIVOT_MCP_TOOL_RESULT_BEGIN',
        '工具: mcp.0.reports.list_files',
        '结果:',
        'total: 2',
        'PIVOT_MCP_TOOL_RESULT_END'
    ].join('\n'));

    assert.deepEqual(messages.map(message => message.role), ['system', 'user', 'assistant', 'user']);
    assert.match(messages[2].content, /PIVOT_MCP_CONTEXT_BEGIN/);
    assert.match(messages[2].content, /mcp\.0\.reports\.list_files/);
    assert.match(messages[3].content, /PIVOT_MCP_TOOL_RESULT_BEGIN/);
    assert.match(messages[3].content, /不得声称无法访问本机文件系统/);
});
test('聊天 MCP 本机目录确定性工具失败时不会继续等待规划模型', async () => {
    const { resetLocalBridgeForTests } = require('../../server/services/local-device-bridge');
    resetLocalBridgeForTests();
    const previousDesktop = process.env.PIVOT_DESKTOP;
    const previousHelper = process.env.PIVOT_LOCAL_HELPER;
    const previousAuthFile = process.env.PIVOT_LOCAL_AUTHORIZATIONS_FILE;
    delete process.env.PIVOT_DESKTOP;
    delete process.env.PIVOT_LOCAL_HELPER;
    delete process.env.PIVOT_LOCAL_AUTHORIZATIONS_FILE;

    try {
        const events = [];
        const context = await maybeBuildMcpChatContext({
            modelCfg: {
                id: 1,
                name: 'Planner Must Not Be Called',
                model_name: 'planner-test',
                url: 'http://127.0.0.1:9/v1',
                api_key: '',
                user_id: null
            },
            history: [{ role: 'user', content: '查询本机法律目录下有哪些文件' }],
            userPrompt: '查询本机法律目录下有哪些文件',
            tools: [{
                fullName: 'mcp.0.reports.list_files',
                name: 'reports.list_files',
                serverName: 'DESKTOP-SNH56CH：我的电脑',
                description: '列出配置目录下可访问的报表/数据文件。',
                input_schema: { type: 'object' }
            }],
            user: { id: 1, username: 'admin', role: 'admin', unit: '' },
            writeSse(payload) {
                events.push(JSON.parse(payload));
            },
            log: { warn() {} }
        });

        assert.deepEqual(events.filter(event => event.type === 'mcp').map(event => event.status), ['planning', 'running', 'error']);
        assert.match(context, /工具执行阶段|工具调用暂时不可用|HTTP 404/);
        assert.doesNotMatch(context, /工具规划暂时不可用/);
    } finally {
        if (previousDesktop === undefined) delete process.env.PIVOT_DESKTOP;
        else process.env.PIVOT_DESKTOP = previousDesktop;
        if (previousHelper === undefined) delete process.env.PIVOT_LOCAL_HELPER;
        else process.env.PIVOT_LOCAL_HELPER = previousHelper;
        if (previousAuthFile === undefined) delete process.env.PIVOT_LOCAL_AUTHORIZATIONS_FILE;
        else process.env.PIVOT_LOCAL_AUTHORIZATIONS_FILE = previousAuthFile;
        resetLocalBridgeForTests();
    }
});
test('聊天 MCP 规划模型限流时不会误报为工具执行失败', async () => {
    const plannerServer = http.createServer((_req, res) => {
        res.writeHead(429, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            error: {
                message: 'Upstream rate limit exceeded, please retry later',
                type: 'rate_limit_error'
            }
        }));
    });

    try {
        await new Promise(resolve => plannerServer.listen(0, '127.0.0.1', resolve));
        const events = [];
        const warnings = [];
        const context = await maybeBuildMcpChatContext({
            modelCfg: {
                id: 1,
                name: 'Rate Limited Planner',
                model_name: 'planner-test',
                url: `http://127.0.0.1:${plannerServer.address().port}/v1`,
                api_key: '',
                user_id: null
            },
            history: [{ role: 'user', content: '查询 widgets 表前两条数据' }],
            userPrompt: '查询 widgets 表前两条数据',
            tools: [{
                fullName: 'mcp.1.db.run_readonly_query',
                name: 'db.run_readonly_query',
                serverName: '测试数据库',
                description: '执行只读 SQL',
                input_schema: { type: 'object' }
            }],
            user: { id: 1, username: 'admin', role: 'admin', unit: '' },
            writeSse(payload) {
                events.push(JSON.parse(payload));
            },
            log: {
                warn(payload) {
                    warnings.push(payload);
                }
            }
        });

        assert.deepEqual(events.filter(event => event.type === 'mcp').map(event => event.status), ['planning', 'error']);
        assert.match(events.at(-1).message, /工具规划模型暂时被限流/);
        assert.doesNotMatch(events.at(-1).message, /Request failed with status code 429/);
        assert.match(context, /没有实际调用工具/);
        assert.equal(warnings.at(-1).statusCode, 429);
        assert.equal(warnings.at(-1).stage, 'planning');
    } finally {
        await new Promise(resolve => plannerServer.close(resolve));
    }
});

test('聊天 MCP 上下文会调用选中的 MCP 工具并注入结果供用户对话使用', async () => {
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
                    reason: '不需要工具库'
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
        const runningEvent = sseEvents.find(event => event.type === 'mcp' && event.status === 'running');
        const doneEvent = sseEvents.find(event => event.type === 'mcp' && event.status === 'done');
        assert.equal(runningEvent.actionName, '执行只读 SQL');
        assert.equal(runningEvent.toolName, 'db.run_readonly_query');
        assert.match(runningEvent.message, /执行只读 SQL/);
        assert.equal(doneEvent.actionName, '执行只读 SQL');

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
        const tableCountRunning = tableCountEvents.find(event => event.type === 'mcp' && event.status === 'running');
        assert.equal(tableCountRunning.actionName, '统计数据表数量');
        assert.equal(tableCountRunning.toolName, 'db.count_tables');
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
