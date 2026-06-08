// 从 security-chat.test.js 拆出；仍由父级入口统一加载。
const {
    appendStreamedChartsToAssistantContent,
    assert,
    buildChatCompletionsUrl,
    buildFtsQuery,
    buildModelHeaders,
    buildResponsesUrl,
    convertChatMessagesToResponsesInput,
    createChartSseCapture,
    createChatRenderSandbox,
    createFakeSseResponse,
    createSseEventParser,
    createStreamAccumulator,
    extractStreamPayload,
    fs,
    getRealtimeStats,
    normalizeModelBaseUrl,
    path,
    publishUserEvent,
    shouldUseResponsesApi,
    splitStreamTextForDisplay,
    subscribeUserEvents,
    test,
    vm
} = require('../security-helpers');

test('DOMPurify 不可用时安全 HTML 兜底会转义输入', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '..', '..', 'client', 'chat', 'safe-html.js'), 'utf8');
    const sandbox = { window: {} };
    vm.runInNewContext(source, sandbox);
    assert.equal(
        sandbox.window.PivotSafeHtml.sanitizeHtml('<img src=x onerror=alert(1)>'),
        '&lt;img src=x onerror=alert(1)&gt;'
    );
});

test('知识库和能力库下一步提示提供可点击动作', () => {
    const ragPanels = fs.readFileSync(path.resolve(__dirname, '..', '..', 'client', 'chat', 'rag-documents-panels.js'), 'utf8');
    const ragDocs = fs.readFileSync(path.resolve(__dirname, '..', '..', 'client', 'chat', 'rag-documents.js'), 'utf8');
    const ragCore = fs.readFileSync(path.resolve(__dirname, '..', '..', 'client', 'chat', 'rag.js'), 'utf8');
    const mcpCommon = fs.readFileSync(path.resolve(__dirname, '..', '..', 'client', 'chat', 'mcp-workbench-common.js'), 'utf8');
    const mcpWorkbench = fs.readFileSync(path.resolve(__dirname, '..', '..', 'client', 'chat', 'mcp-workbench-main.js'), 'utf8');
    const mcpForm = fs.readFileSync(path.resolve(__dirname, '..', '..', 'client', 'chat', 'mcp-workbench-form.js'), 'utf8');
    const mcpPartial = fs.readFileSync(path.resolve(__dirname, '..', '..', 'client', 'chat', 'partials', 'workspaces', 'mcp.html'), 'utf8');
    const knowledgePartial = fs.readFileSync(path.resolve(__dirname, '..', '..', 'client', 'chat', 'partials', 'workspaces', 'knowledge.html'), 'utf8');
    const chatShellPartial = fs.readFileSync(path.resolve(__dirname, '..', '..', 'client', 'chat', 'partials', 'workspaces', 'chat-shell.html'), 'utf8');
    const adminExtraModals = fs.readFileSync(path.resolve(__dirname, '..', '..', 'client', 'chat', 'partials', 'admin-extra-modals.html'), 'utf8');
    const ragDebugPartial = fs.readFileSync(path.resolve(__dirname, '..', '..', 'client', 'chat', 'partials', 'rag-debug-modal.html'), 'utf8');
    const appWorkspaces = fs.readFileSync(path.resolve(__dirname, '..', '..', 'client', 'chat', 'app-workspaces.js'), 'utf8');
    const knowledgeCss = fs.readFileSync(path.resolve(__dirname, '..', '..', 'client', 'chat', 'styles', 'workspaces', 'knowledge.css'), 'utf8');
    const inputCss = fs.readFileSync(path.resolve(__dirname, '..', '..', 'client', 'chat', 'styles', 'base', 'input.css'), 'utf8');
    const mcpCss = fs.readFileSync(path.resolve(__dirname, '..', '..', 'client', 'chat', 'styles', 'workspaces', 'mcp', 'mcp-forms.css'), 'utf8');
    const mcpGovernanceCss = fs.readFileSync(path.resolve(__dirname, '..', '..', 'client', 'chat', 'styles', 'workspaces', 'mcp', 'mcp-governance.css'), 'utf8');

    assert.match(ragPanels, /data-rag-next-step/);
    assert.match(ragPanels, /runRagNextStepAction/);
    assert.match(ragPanels, /pivot_chat_rag_enabled/);
    assert.match(ragDocs, /bindKnowledgeDropUpload/);
    assert.match(ragDocs, /event\.dataTransfer\?\.files/);
    assert.match(ragDocs, /updateRagDebugSamples/);
    assert.match(ragDocs, /getRagDocDisplayName/);
    assert.match(ragCore, /ragDebugSample/);
    assert.match(knowledgePartial, /knowledge-drop-zone/);
    assert.match(knowledgePartial, /试问一下/);
    assert.match(knowledgePartial, /高级设置/);
    assert.match(knowledgePartial, /系统会自动学习资料内容/);
    assert.match(ragDebugPartial, /data-rag-debug-sample/);
    assert.match(ragDebugPartial, /试问知识库/);
    assert.match(ragDebugPartial, /匹配要求/);
    assert.match(ragDebugPartial, /参考数/);
    assert.match(ragDebugPartial, /查找范围/);
    assert.match(adminExtraModals, /资料匹配要求/);
    assert.match(adminExtraModals, /资料理解模型/);
    assert.match(adminExtraModals, /资料理解服务地址/);
    assert.match(adminExtraModals, /单段资料长度/);
    assert.match(adminExtraModals, /相邻资料重复字数/);
    assert.match(ragPanels, /内容段/);
    assert.match(ragPanels, /localizeQualityTip/);
    assert.match(ragPanels, /试问一下/);
    assert.match(ragPanels, /打开聊天知识库/);
    assert.match(ragPanels, /rag-next-step-actions/);
    assert.match(ragPanels, /重新学习/);
    assert.match(ragPanels, /rag-debug-verdict/);
    assert.match(ragPanels, /用这个问题去聊天/);
    assert.match(ragDocs, /正在上传并学习资料/);
    assert.match(ragDocs, /正在查找相关资料/);
    assert.match(ragDocs, /还没有上传资料/);
    assert.match(ragCore, /data-rag-debug-chat/);
    assert.match(ragCore, /pivot_chat_rag_enabled/);
    assert.match(chatShellPartial, /chat-tool-status/);
    assert.match(appWorkspaces, /CHAT_TOOL_STATUS_COPY/);
    assert.match(appWorkspaces, /updateChatToolReadiness/);
    assert.match(appWorkspaces, /fetchChatToolReadiness/);
    assert.match(appWorkspaces, /\/rag\/summary/);
    assert.match(appWorkspaces, /\/mcp\/tools/);
    assert.match(appWorkspaces, /打开知识库/);
    assert.match(appWorkspaces, /打开能力库/);
    assert.match(mcpWorkbench, /data-mcp-next-step/);
    assert.match(mcpWorkbench, /runMcpNextStepAction/);
    assert.match(mcpWorkbench, /pivot_chat_mcp_enabled/);
    assert.match(mcpPartial, /mcp-edit-helper/);
    assert.match(mcpPartial, /可用动作/);
    assert.match(mcpPartial, /由技术同事提供/);
    assert.match(mcpCommon, /查找文件/);
    assert.match(mcpForm, /MCP_CONFIG_HELPERS/);
    assert.match(mcpForm, /MCP_DATABASE_TYPE_TIPS/);
    assert.match(mcpForm, /MCP_DATABASE_PLACEHOLDERS/);
    assert.match(mcpForm, /updateMcpDatabaseGuidance/);
    assert.match(mcpForm, /SQLite 只需要填写数据库文件路径/);
    assert.match(mcpForm, /普通用户通常先使用系统能力/);
    assert.match(mcpForm, /聊天工具接收地址/);
    assert.match(mcpForm, /applyMcpRecommendedDefaults/);
    assert.match(mcpWorkbench, /data-mcp-tool-prompt/);
    assert.match(mcpWorkbench, /pivot_chat_mcp_enabled/);
    assert.match(mcpWorkbench, /已带着示例问题回到聊天/);
    assert.match(mcpWorkbench, /mcpToolPrompt/);
    assert.match(mcpWorkbench, /刷新动作列表/);
    assert.match(mcpWorkbench, /已刷新 .* 个动作/);
    assert.match(mcpForm, /\.\.\.mcpBuiltinServices\.map\(item => item\.type\)/);
    assert.match(mcpForm, /reports-max-file-mb', '20'/);
    assert.match(mcpForm, /db-max-rows', '200'/);
    assert.match(knowledgeCss, /\.rag-next-step-action/);
    assert.match(knowledgeCss, /\.rag-next-step-actions/);
    assert.match(knowledgeCss, /\.knowledge-drop-zone/);
    assert.match(knowledgeCss, /\.rag-debug-sample/);
    assert.match(knowledgeCss, /\.rag-debug-verdict/);
    assert.match(inputCss, /\.chat-tool-status/);
    assert.match(inputCss, /\.chat-tool-status-item/);
    assert.match(mcpCss, /\.mcp-next-step-action/);
    assert.match(mcpCss, /\.mcp-config-helper/);
    assert.match(mcpGovernanceCss, /\.mcp-tool-example/);
});

test('聊天回答会保留知识库和能力库状态提示', () => {
    const engine = fs.readFileSync(path.resolve(__dirname, '..', '..', 'client', 'chat', 'engine.js'), 'utf8');
    const streaming = fs.readFileSync(path.resolve(__dirname, '..', '..', 'client', 'chat', 'engine-streaming.js'), 'utf8');
    const markdownCss = fs.readFileSync(path.resolve(__dirname, '..', '..', 'client', 'chat', 'styles', 'base', 'markdown.css'), 'utf8');

    assert.match(engine, /renderAssistantTraceEvent\?\.\(aiMsgEl, data\)/);
    assert.match(streaming, /function renderAssistantTraceEvent/);
    assert.match(streaming, /回答依据和能力状态/);
    assert.match(streaming, /可引用资料/);
    assert.match(streaming, /sources\.join/);
    assert.match(streaming, /知识库没有找到足够相关资料，本轮会按普通聊天继续/);
    assert.match(streaming, /getAssistantTraceMcpActionName/);
    assert.match(streaming, /正在使用能力库/);
    assert.match(streaming, /能力库动作已完成/);
    assert.match(streaming, /补充资料/);
    assert.match(streaming, /检查能力库/);
    assert.match(streaming, /openKnowledgeWorkbench/);
    assert.match(streaming, /openMcpWorkbench/);
    assert.match(markdownCss, /\.chat-answer-trace/);
    assert.match(markdownCss, /\.chat-answer-trace-item\.is-ready/);
    assert.match(markdownCss, /\.chat-answer-trace-item\.is-warning/);
    assert.match(markdownCss, /\.chat-answer-trace-action/);
});

test('聊天渲染器接受宽松的 ECharts 风格图表规格', () => {
    const sandbox = createChatRenderSandbox();
    const looseChartSpec = {
        type: 'bar',
        title: 'table_account 表中 group_id 分布统计',
        xAxis: {
            type: 'category',
            name: 'group_id'
        },
        yAxis: {
            type: 'value',
            name: '数量'
        },
        series: [
            {
                name: '账户数量',
                type: 'bar',
                data: []
            }
        ],
        tooltip: {
            trigger: 'axis'
        },
        dataQuery: {
            database: 'hcdb',
            table: 'table_account'
        }
    };
    const normalized = sandbox.normalizePivotChartSpec(JSON.stringify(looseChartSpec));
    assert.ok(normalized);
    assert.equal(normalized.chartType, 'bar');
    assert.equal(normalized.title, 'table_account 表中 group_id 分布统计');
    assert.equal(normalized.xAxis.label, 'group_id');
    assert.equal(normalized.yAxis.label, '数量');
    assert.equal(normalized.series.length, 1);
    assert.equal(normalized.series[0].name, '账户数量');
    assert.equal(normalized.series[0].data.length, 0);
    assert.equal(normalized.source.format, 'loose_chart');
    assert.equal(normalized.source.dataQuery.database, 'hcdb');
    assert.equal(normalized.source.dataQuery.table, 'table_account');

    const html = sandbox.renderMarkdown(`\`\`\`chart\n${JSON.stringify(looseChartSpec, null, 2)}\n\`\`\``);
    assert.match(html, /pivot-echart-block/);
});

test('聊天渲染器在流式输出期间延迟渲染 Pivot 图表块', () => {
    const sandbox = createChatRenderSandbox();
    const chart = {
        type: 'pivot_chart',
        chartType: 'bar',
        title: 'group_id count',
        labels: ['0', '3'],
        series: [{ name: 'count', data: [2, 1] }]
    };
    const markdown = [
        'chart below',
        '```pivot-echart',
        JSON.stringify(chart, null, 2),
        '```'
    ].join('\n');

    const streamingHtml = sandbox.renderAiMessage(markdown, true);
    assert.doesNotMatch(streamingHtml, /pivot-echart-block/);
    assert.doesNotMatch(streamingHtml, /data-pivot-echart/);

    const finalHtml = sandbox.renderAiMessage(markdown, false);
    assert.match(finalHtml, /pivot-echart-block/);
});

test('聊天路由会把流式图表规格写入持久化助手内容', () => {
    const chart = {
        type: 'pivot_chart',
        chartType: 'bar',
        title: 'group_id count',
        labels: ['0', '3'],
        series: [{ name: 'count', data: [2, 1] }]
    };

    const content = appendStreamedChartsToAssistantContent('analysis text', [chart, chart]);
    assert.match(content, /analysis text/);
    assert.match(content, /```pivot-echart/);
    assert.match(content, /"type": "pivot_chart"/);
    assert.equal((content.match(/```pivot-echart/g) || []).length, 1);

    const alreadyHasChart = [
        'analysis text',
        '```pivot-echart',
        '{}',
        '```'
    ].join('\n');
    assert.equal(appendStreamedChartsToAssistantContent(alreadyHasChart, [chart]), alreadyHasChart);
});

test('聊天图表 SSE 捕获会存储图表事件且不向前转发', () => {
    const chart = {
        type: 'pivot_chart',
        chartType: 'bar',
        title: 'group_id count',
        labels: ['0', '3'],
        series: [{ name: 'count', data: [2, 1] }]
    };
    const forwarded = [];
    const { streamedChartSpecs, writeSse } = createChartSseCapture(payload => forwarded.push(payload));

    assert.equal(writeSse(JSON.stringify({ type: 'chart', data: chart })), false);
    assert.equal(writeSse(JSON.stringify({ type: 'chart', data: chart })), false);
    assert.deepEqual(forwarded, []);
    assert.equal(streamedChartSpecs.length, 1);
    assert.deepEqual(streamedChartSpecs[0], chart);

    const notice = JSON.stringify({ type: 'mcp', status: 'done' });
    assert.equal(writeSse(notice), true);
    assert.deepEqual(forwarded, [notice]);
});

test('buildFtsQuery 会把用户输入转义为短语项', () => {
    assert.equal(buildFtsQuery('hello world'), '"hello" AND "world"');
    assert.equal(buildFtsQuery('a"b NEAR c'), '"a""b" AND "NEAR" AND "c"');
    assert.equal(buildFtsQuery('   '), '');
});

test('createSseEventParser 可解析分块 SSE 载荷', () => {
    const payloads = [];
    const parser = createSseEventParser({
        onData: payload => payloads.push(payload)
    });
    parser.write(Buffer.from('data: {"choices":[{"delta":{"content":"he'));
    parser.write(Buffer.from('llo"}}]}\n\ndata: [DONE]\n\n'));
    parser.end();
    assert.equal(payloads.length, 1);
    const extracted = extractStreamPayload(JSON.parse(payloads[0]));
    assert.deepEqual(extracted, { delta: 'hello', isThought: false, usage: null });
});

test('流式载荷提取支持完整消息载荷并拆分大增量', () => {
    const extracted = extractStreamPayload({
        choices: [{ message: { content: 'complete answer' } }],
        usage: { completion_tokens: 3 }
    });
    assert.deepEqual(extracted, {
        delta: 'complete answer',
        isThought: false,
        usage: { completion_tokens: 3 }
    });

    const chunks = splitStreamTextForDisplay('a'.repeat(420), { targetLength: 80, maxLength: 120 });
    assert.ok(chunks.length > 1);
    assert.equal(chunks.join(''), 'a'.repeat(420));
});

test('实时 SSE 事件按订阅用户隔离', () => {
    const first = createFakeSseResponse();
    const second = createFakeSseResponse();
    const unsubscribeFirst = subscribeUserEvents({ id: 101 }, first, { heartbeatMs: 0 });
    const unsubscribeSecond = subscribeUserEvents({ id: 202 }, second, { heartbeatMs: 0 });

    const delivered = publishUserEvent(101, 'agent.run', { run: { id: 'run-test', status: 'queued' } });

    assert.equal(delivered, 1);
    assert.match(first.headers['content-type'], /text\/event-stream/);
    assert.match(first.chunks.join(''), /event: agent\.run/);
    assert.match(first.chunks.join(''), /run-test/);
    assert.doesNotMatch(second.chunks.join(''), /run-test/);
    assert.equal(getRealtimeStats().clients >= 2, true);

    unsubscribeFirst();
    unsubscribeSecond();
});

test('createStreamAccumulator 包装推理增量并捕获用量', () => {
    const emitted = [];
    const accumulator = createStreamAccumulator({
        includeThoughtTags: true,
        onContent: chunk => emitted.push(chunk)
    });
    accumulator.pushJson({ choices: [{ delta: { reasoning_content: 'reasoning' } }] });
    accumulator.pushJson({ choices: [{ delta: { content: 'answer' } }], usage: { completion_tokens: 2 } });
    accumulator.finish();

    assert.equal(accumulator.getContent(), '<thought>reasoning</thought>answer');
    assert.deepEqual(emitted, ['<thought>reasoning', '</thought>answer']);
    assert.deepEqual(accumulator.getUsage(), { completion_tokens: 2 });
});

test('createStreamAccumulator 可收集不含思考标签的转发流文本', () => {
    const accumulator = createStreamAccumulator();
    accumulator.pushPayload(JSON.stringify({ choices: [{ delta: { reasoning_content: 'hidden' } }] }));
    accumulator.pushPayload(JSON.stringify({ choices: [{ delta: { content: ' shown' } }] }));
    accumulator.pushPayload('{bad json');
    accumulator.finish();
    assert.equal(accumulator.getContent(), 'hidden shown');
});

test('模型适配器规范化兼容端点 URL 且不改变本地聊天行为', () => {
    assert.equal(
        normalizeModelBaseUrl('https://api.example.com', { appendV1ForLocal: false }),
        'https://api.example.com/v1'
    );
    assert.equal(
        normalizeModelBaseUrl('http://localhost:8000', { appendV1ForLocal: false }),
        'http://localhost:8000'
    );
    assert.equal(
        buildChatCompletionsUrl('https://api.example.com/v1/chat/completions'),
        'https://api.example.com/v1/chat/completions'
    );
    assert.equal(
        buildChatCompletionsUrl('http://127.0.0.1:8000', { appendV1ForLocal: true }),
        'http://127.0.0.1:8000/v1/chat/completions'
    );
    assert.equal(
        buildResponsesUrl('https://api.example.com'),
        'https://api.example.com/v1/responses'
    );
    assert.equal(shouldUseResponsesApi('gpt-5.1'), true);
    assert.equal(shouldUseResponsesApi('qwen2.5'), false);
});

test('模型适配器将聊天消息转换为 Responses API 输入', () => {
    const converted = convertChatMessagesToResponsesInput([
        { role: 'system', content: 'security policy' },
        {
            role: 'user',
            content: [
                { type: 'text', text: 'look at image' },
                { type: 'image_url', image_url: { url: 'data:image/png;base64,abc' } }
            ]
        }
    ]);
    assert.equal(converted[0].role, 'user');
    assert.match(converted[0].content, /security policy/);
    assert.deepEqual(converted[1].content[1], {
        type: 'input_image',
        image_url: 'data:image/png;base64,abc'
    });

    const headers = buildModelHeaders({ api_key: 'secret' }, { acceptJson: true });
    assert.equal(headers.Authorization, 'Bearer secret');
    assert.equal(headers['x-api-key'], 'secret');
    assert.equal(headers.Accept, 'application/json');
});
