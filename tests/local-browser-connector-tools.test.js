const assert = require('node:assert/strict');
const test = require('node:test');
const {
    browserNetworkPolicy,
    localBrowserToolDefinitions,
    normalizeLocalBrowserGrant,
    normalizeLocalBrowserTask
} = require('../server/services/local-browser-connector-tools');
const { localConnectorInputSchema, mergeLocalMcpTools } = require('../server/services/mcp-client');
const { buildDeterministicBrowserFallback, detectBrowserVisitIntent, filterMcpToolsForChatIntent } = require('../server/services/chat-mcp-context');
const { buildToolExecutionPlan } = require('../server/services/agent-tool-execution-plan');

const grant = {
    browsers: [
        { id: 'edge-local', label: 'Microsoft Edge', engine: 'chromium' },
        { id: 'firefox-local', label: 'Firefox', engine: 'firefox' }
    ],
    allowedOrigins: ['https://oa.example.internal', 'http://10.2.3.4:8080']
};

test('本机浏览器工具只接受已授权浏览器和精确 Origin', async () => {
    const normalized = normalizeLocalBrowserGrant(grant);
    assert.equal(normalized.browsers.length, 2);
    assert.deepEqual(browserNetworkPolicy(normalized).allowed_origins, grant.allowedOrigins);
    assert.ok(browserNetworkPolicy({ ...normalized, allowedOrigins: ['http://10.2.3.4:3000'] }).allowed_ports.includes(3000));
    const task = await normalizeLocalBrowserTask('browser.click', {
        browserId: 'firefox-local',
        url: 'http://10.2.3.4:8080/portal',
        target: { role: 'button', name: '提交' }
    }, normalized);
    assert.equal(task.browser.engine, 'firefox');
    await assert.rejects(
        () => normalizeLocalBrowserTask('browser.inspect', { browserId: 'edge-local', url: 'https://example.com' }, normalized),
        error => error.code === 'LOCAL_BROWSER_ORIGIN_FORBIDDEN'
    );
    await assert.rejects(
        () => normalizeLocalBrowserTask('browser.open', { browserId: 'edge-local', url: 'test' }, normalized),
        error => error.code === 'LOCAL_BROWSER_URL_INVALID' && error.status === 400 && /完整的 HTTP\/HTTPS URL/.test(error.message)
    );
    await assert.rejects(
        () => normalizeLocalBrowserTask('browser.click', { browserId: 'edge-local', url: 'https://oa.example.internal' }, normalized),
        error => error.code === 'LOCAL_BROWSER_TARGET_REQUIRED'
    );
});

test('本机浏览器工具契约不允许任意脚本执行或日常 Profile 参数', () => {
    const definitions = localBrowserToolDefinitions();
    assert.deepEqual(definitions.map(item => item.name), ['browser.open', 'browser.inspect', 'browser.click', 'browser.screenshot']);
    definitions.forEach(tool => {
        assert.equal(Object.prototype.hasOwnProperty.call(tool.inputSchema.properties, 'script'), false);
        assert.equal(Object.prototype.hasOwnProperty.call(tool.inputSchema.properties, 'profilePath'), false);
        assert.equal(Object.prototype.hasOwnProperty.call(tool.inputSchema.properties, 'browserId'), true);
        assert.equal(tool.inputSchema.required.includes('browserId'), false);
        assert.equal(tool.inputSchema.required.includes('url'), true);
        if (tool.name === 'browser.click') assert.equal(tool.inputSchema.required.includes('target'), true);
    });
});

test('唯一授权浏览器可省略 browserId，多个设备的会话 Schema 明确列出可选项', async () => {
    const oneBrowser = { browsers: [grant.browsers[0]], allowedOrigins: [grant.allowedOrigins[0]] };
    const task = await normalizeLocalBrowserTask('browser.inspect', { url: 'https://oa.example.internal/portal' }, oneBrowser);
    assert.equal(task.browserId, 'edge-local');
    const schema = localConnectorInputSchema(localBrowserToolDefinitions()[0], null, {
        devices: [{ deviceId: 'device-a', deviceName: 'A', grants: { local_browser: oneBrowser } }]
    });
    assert.deepEqual(schema.properties.deviceId.enum, ['device-a']);
    assert.equal(schema.properties.deviceId.default, 'device-a');
    assert.deepEqual(schema.properties.browserId.enum, ['edge-local']);
    assert.deepEqual(schema.localBrowserDevices, [{
        deviceId: 'device-a',
        deviceName: 'A',
        browsers: [{ id: 'edge-local', label: 'Microsoft Edge', engine: 'chromium' }],
        allowedOrigins: ['https://oa.example.internal']
    }]);
});

test('持久化本机浏览器工具不会被旧式本机数据库或目录工具遮蔽', () => {
    const merged = mergeLocalMcpTools(
        [{ name: 'db.list_tables', serverType: 'database' }, { name: 'reports.list_files', serverType: 'reports' }],
        [{ name: 'db.list_tables', serverType: 'database' }, { name: 'browser.open', serverType: 'browser', localBrowserConnector: true }]
    );
    assert.deepEqual(merged.map(tool => tool.name), ['db.list_tables', 'reports.list_files', 'browser.open']);
});

test('普通会话只在用户明确要求访问 URL 时向模型暴露本机浏览器工具', () => {
    const browser = { fullName: 'mcp.0.browser.open', name: 'browser.open', serverType: 'browser', localBrowserConnector: true };
    const report = { fullName: 'mcp.0.reports.list_files', name: 'reports.list_files', serverType: 'reports' };
    assert.equal(detectBrowserVisitIntent('打开 https://oa.example.internal 并查看待办'), true);
    assert.equal(detectBrowserVisitIntent('帮我分析今天的待办'), false);
    assert.deepEqual(filterMcpToolsForChatIntent([browser, report], '打开 https://oa.example.internal'), [browser, report]);
    assert.deepEqual(filterMcpToolsForChatIntent([browser, report], '帮我分析今天的待办'), [report]);
    assert.deepEqual(buildDeterministicBrowserFallback('打开 https://oa.example.internal', [browser]), { tool: browser, input: { url: 'https://oa.example.internal' }, reason: '用户明确要求在已授权本机浏览器访问其提供的网址' });
});

test('普通会话对明确本机浏览器访问不再卡在服务端审批，但 Agent 仍可保持审批', async () => {
    const tool = {
        name: 'mcp.0.browser.inspect', source: 'mcp', risk: 'high', network: false, localBrowserConnector: true,
        input_schema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] }
    };
    const base = { run: { tool_policy: 'all', approval_policy: 'safe_mcp_auto', network_policy: { enabled: true } }, tool, input: { url: 'https://oa.example.internal' }, user: { id: 1 } };
    const blocked = await buildToolExecutionPlan({ ...base, context: { autonomous: false, allowApproval: false } });
    const allowed = await buildToolExecutionPlan({ ...base, context: { autonomous: false, allowApproval: true } });
    assert.equal(blocked.policy.decision, 'require_approval');
    assert.equal(allowed.policy.decision, 'allow');
    assert.equal(allowed.network.preflight, 'not_applicable');
});
