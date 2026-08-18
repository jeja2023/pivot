// 从 security-chat.test.js 拆出；仍由父级入口统一加载。
const {
    appendStreamedChartsToAssistantContent,
    assert,
    buildAssistantSpeedStats,
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
    vm,
    estimateTokens
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

test('聊天图片附件预览不会暴露浏览器破损图标', () => {
    const renderMessages = fs.readFileSync(path.resolve(__dirname, '..', '..', 'client', 'chat', 'render-messages.js'), 'utf8');
    const attachmentsCss = fs.readFileSync(path.resolve(__dirname, '..', '..', 'client', 'chat', 'styles', 'base', 'attachments.css'), 'utf8');

    assert.match(renderMessages, /data-preview-image/);
    assert.match(renderMessages, /data-preview-fallback/);
    assert.match(renderMessages, /预览不可用，发送时上传/);
    assert.match(renderMessages, /addEventListener\('error', setError/);
    assert.match(renderMessages, /alt="" decoding="async"/);
    assert.match(attachmentsCss, /\.preview-image-frame\.is-ready \.preview-image/);
    assert.match(attachmentsCss, /\.preview-image-frame\.is-error \.preview-image-fallback/);
});

test('知识库和工具库工作台入口保持可点击', () => {
    const ragPanels = fs.readFileSync(path.resolve(__dirname, '..', '..', 'client', 'chat', 'rag-documents-panels.js'), 'utf8');
    const ragDocs = fs.readFileSync(path.resolve(__dirname, '..', '..', 'client', 'chat', 'rag-documents.js'), 'utf8');
    const ragCore = fs.readFileSync(path.resolve(__dirname, '..', '..', 'client', 'chat', 'rag.js'), 'utf8');
    const adminCore = fs.readFileSync(path.resolve(__dirname, '..', '..', 'client', 'chat', 'admin.js'), 'utf8');
    const appCore = fs.readFileSync(path.resolve(__dirname, '..', '..', 'client', 'chat', 'app', 'main.js'), 'utf8');
    const authCore = fs.readFileSync(path.resolve(__dirname, '..', '..', 'client', 'chat', 'auth.js'), 'utf8');
    const adminSettings = fs.readFileSync(path.resolve(__dirname, '..', '..', 'client', 'chat', 'admin-settings.js'), 'utf8');
    const toolPolicy = fs.readFileSync(path.resolve(__dirname, '..', '..', 'client', 'chat', 'tool-policy.js'), 'utf8');
    const mcpCommon = fs.readFileSync(path.resolve(__dirname, '..', '..', 'client', 'chat', 'mcp-workbench-common.js'), 'utf8');
    const mcpWorkbench = fs.readFileSync(path.resolve(__dirname, '..', '..', 'client', 'chat', 'mcp-workbench-main.js'), 'utf8');
    const mcpForm = fs.readFileSync(path.resolve(__dirname, '..', '..', 'client', 'chat', 'mcp-workbench-form.js'), 'utf8');
    const agentPartial = fs.readFileSync(path.resolve(__dirname, '..', '..', 'client', 'chat', 'partials', 'workspaces', 'agent.html'), 'utf8');
    const agentRunLoaders = fs.readFileSync(path.resolve(__dirname, '..', '..', 'client', 'chat', 'agent-run-loaders.js'), 'utf8');
    const settingsPartial = fs.readFileSync(path.resolve(__dirname, '..', '..', 'client', 'chat', 'partials', 'workspaces', 'settings.html'), 'utf8');
    const settingsShellStart = fs.readFileSync(path.resolve(__dirname, '..', '..', 'client', 'chat', 'partials', 'settings', 'shell-start.html'), 'utf8');
    const settingsToolPolicy = fs.readFileSync(path.resolve(__dirname, '..', '..', 'client', 'chat', 'partials', 'settings', 'tool-policy.html'), 'utf8');
    const scriptsPartial = fs.readFileSync(path.resolve(__dirname, '..', '..', 'client', 'chat', 'partials', 'scripts.html'), 'utf8');
    const mcpPartial = fs.readFileSync(path.resolve(__dirname, '..', '..', 'client', 'chat', 'partials', 'workspaces', 'mcp.html'), 'utf8');
    const knowledgePartial = fs.readFileSync(path.resolve(__dirname, '..', '..', 'client', 'chat', 'partials', 'workspaces', 'knowledge.html'), 'utf8');
    const chatShellPartial = fs.readFileSync(path.resolve(__dirname, '..', '..', 'client', 'chat', 'partials', 'workspaces', 'chat-shell.html'), 'utf8');
    const adminExtraModals = fs.readFileSync(path.resolve(__dirname, '..', '..', 'client', 'chat', 'partials', 'admin-extra-modals.html'), 'utf8');
    const ragDebugPartial = fs.readFileSync(path.resolve(__dirname, '..', '..', 'client', 'chat', 'partials', 'rag-debug-modal.html'), 'utf8');
    const appWorkspaces = fs.readFileSync(path.resolve(__dirname, '..', '..', 'client', 'chat', 'app-workspaces.js'), 'utf8');
    const chatCss = fs.readFileSync(path.resolve(__dirname, '..', '..', 'client', 'chat', 'chat.css'), 'utf8');
    const adminCss = fs.readFileSync(path.resolve(__dirname, '..', '..', 'client', 'chat', 'styles', 'admin.css'), 'utf8');
    const knowledgeCss = fs.readFileSync(path.resolve(__dirname, '..', '..', 'client', 'chat', 'styles', 'workspaces', 'knowledge.css'), 'utf8');
    const inputCss = fs.readFileSync(path.resolve(__dirname, '..', '..', 'client', 'chat', 'styles', 'base', 'input.css'), 'utf8');
    const mcpCss = fs.readFileSync(path.resolve(__dirname, '..', '..', 'client', 'chat', 'styles', 'workspaces', 'mcp', 'mcp-forms.css'), 'utf8');
    const mcpGovernanceCss = fs.readFileSync(path.resolve(__dirname, '..', '..', 'client', 'chat', 'styles', 'workspaces', 'mcp', 'mcp-governance.css'), 'utf8');

    assert.match(ragPanels, /pivot_chat_rag_enabled/);
    assert.match(ragDocs, /bindKnowledgeUploadZone/);
    assert.match(ragDocs, /openKnowledgeUploadModal/);
    assert.match(ragDocs, /event\.dataTransfer\?\.files/);
    assert.match(ragDocs, /updateRagDebugSamples/);
    assert.match(ragDocs, /getRagDocDisplayName/);
    assert.match(ragDocs, /ensureAdminSettingsScript/);
    assert.match(adminCore, /window\.ensureAdminSettingsScript/);
    assert.match(adminCore, /'tool-policy'/);
    assert.match(adminCore, /window\.loadToolPolicy/);
    assert.match(authCore, /window\.showApp = \(options = \{\}\)/);
    assert.match(authCore, /options\.restoreWorkspace !== false/);
    assert.match(authCore, /showApp\(\{ restoreWorkspace: false \}\)/);
    assert.match(appCore, /'tool-policy'/);
    assert.match(settingsPartial, /partials\/settings\/tool-policy\.html/);
    assert.match(settingsShellStart, /tab-tool-policy/);
    assert.match(settingsToolPolicy, /tool-policy-tool-body/);
    assert.match(scriptsPartial, /\/chat\/app-workspaces\.js/);
    assert.doesNotMatch(scriptsPartial, /\/chat\/tool-policy\.js/);
    assert.match(appWorkspaces, /WORKSPACE_SCRIPT_GROUPS/);
    assert.match(appWorkspaces, /\/chat\/tool-policy\.js/);
    assert.match(appWorkspaces, /ensureWorkspaceScripts/);
    assert.match(toolPolicy, /\/capabilities\/packages/);
    assert.match(toolPolicy, /data-tool-policy-package-enabled/);
    assert.match(toolPolicy, /data-tool-policy-save/);
    assert.match(toolPolicy, /toolPolicyCanEditPackage/);
    assert.match(toolPolicy, /toolPolicyIsGlobalPackage/);
    assert.ok(toolPolicy.includes('${editable ? `<button type="button" class="btn-secondary" data-tool-policy-edit='));
    assert.doesNotMatch(toolPolicy, /data-tool-policy-edit="[^"]+"\s+\$\{editable \? '' : 'disabled'\}/);
    assert.match(chatCss, /admin-tool-policy\.css/);
    assert.doesNotMatch(agentPartial, /agent-capability-list/);
    assert.doesNotMatch(agentRunLoaders, /loadCapabilityPackages/);
    assert.doesNotMatch(agentRunLoaders, /data-capability-key/);
    assert.match(adminCss, /admin-tool-policy\.css/);
    assert.match(adminSettings, /boundEmbeddingOpen/);
    assert.doesNotMatch(adminSettings, /cloneNode/);
    assert.match(ragCore, /ragDebugSample/);
    assert.match(ragDocs, /knowledge-upload-zone/);
    assert.match(knowledgePartial, /召回测试/);
    assert.match(knowledgePartial, /检索配置/);
    assert.match(ragDocs, /系统会自动索引文档内容/);
    assert.match(ragDebugPartial, /data-rag-debug-sample/);
    assert.match(ragDebugPartial, /知识库召回测试/);
    assert.match(ragDebugPartial, /阈值/);
    assert.match(ragDebugPartial, /命中/);
    assert.match(ragDebugPartial, /候选/);
    assert.match(adminExtraModals, /知识库 \(RAG\) 配置/);
    assert.match(adminExtraModals, /Embedding 模型/);
    assert.match(adminExtraModals, /Embedding Base URL/);
    assert.match(adminExtraModals, /分块最大长度/);
    assert.match(adminExtraModals, /重叠字符数/);
    assert.match(ragPanels, /分块/);
    assert.match(ragPanels, /rag-summary-items/);
    assert.match(knowledgePartial, /批量重建/);
    assert.match(ragDocs, /重新索引/);
    assert.match(ragPanels, /rag-debug-verdict/);
    assert.match(ragPanels, /用这个问题去聊天/);
    assert.match(ragDocs, /正在上传并向量化文档/);
    assert.match(ragDocs, /正在测试召回效果/);
    assert.match(ragDocs, /暂无知识库文档/);
    assert.match(ragCore, /data-rag-debug-chat/);
    assert.match(ragCore, /pivot_chat_rag_enabled/);
    assert.match(chatShellPartial, /chat-tool-status/);
    assert.match(appWorkspaces, /CHAT_TOOL_STATUS_COPY/);
    assert.match(appWorkspaces, /updateChatToolReadiness/);
    assert.match(appWorkspaces, /fetchChatToolReadiness/);
    assert.match(appWorkspaces, /\/rag\/summary/);
    assert.match(appWorkspaces, /\/mcp\/tools/);
    assert.match(appWorkspaces, /打开知识库/);
    assert.match(appWorkspaces, /打开工具库/);
    assert.match(appWorkspaces, /pivot_chat_mcp_enabled/);
    assert.match(chatShellPartial, /data-chat-tool-toggle="mcp"/);
    assert.doesNotMatch(mcpWorkbench, /mcp-next-step-card/);
    assert.doesNotMatch(mcpPartial, /mcp-onboarding-panel/);
    assert.match(mcpPartial, /mcp-edit-helper/);
    assert.match(mcpPartial, /可用工具/);
    assert.match(mcpPartial, /由技术同事提供/);
    assert.match(mcpCommon, /查找文件/);
    assert.match(mcpForm, /MCP_CONFIG_HELPERS/);
    assert.match(mcpForm, /MCP_DATABASE_TYPE_TIPS/);
    assert.match(mcpForm, /MCP_DATABASE_PLACEHOLDERS/);
    assert.match(mcpForm, /updateMcpDatabaseGuidance/);
    assert.match(mcpForm, /SQLite 只需要填写数据库文件路径/);
    assert.match(mcpForm, /普通用户通常先使用系统工具/);
    assert.match(mcpForm, /聊天工具接收地址/);
    assert.match(mcpForm, /applyMcpRecommendedDefaults/);
    assert.doesNotMatch(mcpWorkbench, /data-mcp-tool-prompt/);
    assert.doesNotMatch(mcpWorkbench, /带入聊天/);
    assert.match(mcpPartial, /刷新工具/);
    assert.match(mcpWorkbench, /refreshMcpTools/);
    assert.match(mcpWorkbench, /已刷新 .* 个工具/);
    assert.match(mcpForm, /\.\.\.mcpBuiltinServices\.map\(item => item\.type\)/);
    assert.match(mcpForm, /reports-max-file-mb', '20'/);
    assert.match(mcpForm, /db-max-rows', '200'/);
    assert.match(knowledgeCss, /\.knowledge-upload-zone/);
    assert.match(knowledgeCss, /\.rag-debug-sample/);
    assert.match(knowledgeCss, /\.rag-debug-verdict/);
    assert.match(inputCss, /\.chat-tool-status/);
    assert.match(inputCss, /\.chat-tool-status-item/);
    assert.doesNotMatch(mcpCss, /\.mcp-next-step-action/);
    assert.match(mcpCss, /\.mcp-config-helper/);
    assert.doesNotMatch(mcpGovernanceCss, /\.mcp-tool-governance-details/);
});

test('知识图谱卡片使用单一自定义浮层并补全实体悬停信息', () => {
    const sandbox = { window: {} };
    const escapeHtml = value => String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
    const escapeAttr = value => escapeHtml(value).replace(/"/g, '&quot;');

    vm.runInNewContext(
        fs.readFileSync(path.resolve(__dirname, '..', '..', 'client', 'chat', 'rag-graph-layout.js'), 'utf8'),
        sandbox
    );
    vm.runInNewContext(
        fs.readFileSync(path.resolve(__dirname, '..', '..', 'client', 'chat', 'rag-graph-render.js'), 'utf8'),
        sandbox
    );

    const graphRender = sandbox.window.Pivot.ragGraphRender;
    const entityHtml = graphRender.buildGraphEntitiesHtml([{
        id: 7,
        name: '代码文件中',
        type: 'concept',
        mention_count: 3,
        relation_count: 2,
        confidence: 0.78,
        description: '代码文件中使用中文注释和中文提示'
    }], {
        buildGraphNodeTooltip: graphRender.buildGraphNodeTooltip,
        escapeAttr,
        escapeHtml,
        graphTypeLabel: graphRender.graphTypeLabel,
        messages: {
            describeEntityMeta: (entity, getTypeLabel, escape) => `${escape(getTypeLabel(entity.type))} · 提及 ${entity.mention_count} · 关系 ${entity.relation_count}`,
            formatConfidence: entity => `可信度 ${Number(entity.confidence || 0).toFixed(2)}`
        }
    });
    assert.match(entityHtml, /class="rag-graph-entity/);
    assert.match(entityHtml, /data-graph-node-tooltip="/);
    assert.match(entityHtml, /描述：代码文件中使用中文注释和中文提示/);
    assert.doesNotMatch(entityHtml, /\stitle="/);

    const relationHtml = graphRender.buildGraphRelationsHtml([{
        id: 827,
        source_name: '代码文件中',
        relation_type: 'depends_on',
        target_name: '中文注释和中文提示',
        status: 'active',
        doc_name: '开发命令.txt',
        confidence: 0.78,
        description: '代码文件中使用中文注释和中文提示',
        chunk_text: '完整来源片段应该进入自定义浮层，不能只显示列表里的截断内容。'
    }], {
        buildGraphRelationTooltip: graphRender.buildGraphRelationTooltip,
        escapeAttr,
        escapeHtml,
        graphRelationLabel: graphRender.graphRelationLabel,
        messages: {
            deleteLabel: '删除',
            editLabel: '编辑',
            formatConfidence: row => `可信度 ${Number(row.confidence || 0).toFixed(2)}`,
            statusLabel: value => value
        }
    });
    assert.match(relationHtml, /data-graph-relation-tooltip="/);
    assert.match(relationHtml, /内容：完整来源片段应该进入自定义浮层/);
    assert.doesNotMatch(relationHtml, /\stitle="/);

    const graphUi = fs.readFileSync(path.resolve(__dirname, '..', '..', 'client', 'chat', 'rag-graph-ui.js'), 'utf8');
    const ragCore = fs.readFileSync(path.resolve(__dirname, '..', '..', 'client', 'chat', 'rag.js'), 'utf8');
    const graphCss = fs.readFileSync(path.resolve(__dirname, '..', '..', 'client', 'chat', 'styles', 'workspaces', 'rag-graph-map.css'), 'utf8');
    assert.match(graphUi, /scheduleGraphNodeTooltipHide/);
    assert.match(graphUi, /tooltip\.addEventListener\('mouseenter', cancelGraphNodeTooltipHide\)/);
    assert.match(ragCore, /scheduleGraphNodeTooltipHideUi\(300\)/);
    assert.match(ragCore, /#rag-graph-node-tooltip/);
    assert.match(graphCss, /pointer-events:\s*auto/);
    assert.match(graphCss, /overflow:\s*auto/);
});

test('聊天回答会保留知识库和工具库状态提示', () => {
    const engine = fs.readFileSync(path.resolve(__dirname, '..', '..', 'client', 'chat', 'engine.js'), 'utf8');
    const streaming = fs.readFileSync(path.resolve(__dirname, '..', '..', 'client', 'chat', 'engine-streaming.js'), 'utf8');
    const markdownCss = fs.readFileSync(path.resolve(__dirname, '..', '..', 'client', 'chat', 'styles', 'base', 'markdown.css'), 'utf8');

    assert.match(engine, /renderAssistantTraceEvent\?\.\(aiMsgEl, data\)/);
    assert.match(streaming, /function renderAssistantTraceEvent/);
    assert.match(streaming, /回答依据和能力状态/);
    assert.match(streaming, /可引用文档/);
    assert.match(streaming, /sources\.join/);
    assert.match(streaming, /知识库未命中足够相关内容，本轮会按普通聊天继续/);
    assert.match(streaming, /getAssistantTraceMcpActionName/);
    assert.match(streaming, /正在使用工具库/);
    assert.match(streaming, /工具库工具已完成/);
    assert.match(streaming, /补充资料/);
    assert.match(streaming, /检查工具库/);
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

test('chat send does not auto-enable MCP when toolbox is off', () => {
    const engine = fs.readFileSync(path.resolve(__dirname, '..', '..', 'client', 'chat', 'engine.js'), 'utf8');

    assert.doesNotMatch(engine, /shouldAutoEnableMcpForPrompt\s*\(/);
    assert.doesNotMatch(engine, /activateChatMcpToggle\s*\(/);
    assert.match(engine, /if \(mcpEnabled\) \{\s*mcpConfirmed = mcpConfirmed \|\| await ensureChatMcpConsent\(\);/s);
});

test('viewing a session record scrolls to bottom', () => {
    const render = fs.readFileSync(path.resolve(__dirname, '..', '..', 'client', 'chat', 'render.js'), 'utf8');
    const sessions = fs.readFileSync(path.resolve(__dirname, '..', '..', 'client', 'chat', 'engine-sessions.js'), 'utf8');
    const users = fs.readFileSync(path.resolve(__dirname, '..', '..', 'client', 'chat', 'users.js'), 'utf8');

    assert.match(render, /scrollMessagesToBottom = function\(options = \{\}\)/);
    assert.match(render, /scrollMessagesToBottomUntil = Math\.max/);
    assert.match(render, /new ResizeObserver/);
    assert.match(render, /requestAnimationFrame\(\(\) => requestAnimationFrame\(apply\)\)/);
    assert.match(sessions, /scrollMessagesToBottom\?\.\(\{ duration: 2400 \}\)/);
    assert.match(sessions, /setTimeout\(\(\) => window\.scrollMessagesToBottom\?\.\(\{ duration: 900 \}\), 320\)/);
    assert.match(users, /const displayData = sessionId \? data\.slice\(\)\.reverse\(\) : data;/);
    assert.match(users, /if \(sessionId\) scrollUserRecordsToBottom\(\);/);
});

test('usage statistics page has pagination controls and cache-bypassed monitor refresh', () => {
    const adminCore = fs.readFileSync(path.resolve(__dirname, '..', '..', 'client', 'chat', 'admin.js'), 'utf8');
    const stats = fs.readFileSync(path.resolve(__dirname, '..', '..', 'client', 'chat', 'stats.js'), 'utf8');
    const statsMonitor = fs.readFileSync(path.resolve(__dirname, '..', '..', 'client', 'chat', 'stats-monitor.js'), 'utf8');
    const adminSettings = fs.readFileSync(path.resolve(__dirname, '..', '..', 'client', 'chat', 'admin-settings.js'), 'utf8');
    const reportPartial = fs.readFileSync(path.resolve(__dirname, '..', '..', 'client', 'chat', 'partials', 'settings', 'report.html'), 'utf8');
    const adminStatsRoute = fs.readFileSync(path.resolve(__dirname, '..', '..', 'server', 'routes', 'admin-stats.js'), 'utf8');

    assert.match(adminCore, /stats: 1/);
    assert.match(adminCore, /if \(tab === 'stats' && window\.loadStats\) loadStats\(page\);/);
    assert.match(reportPartial, /id="pagination-stats" class="pagination"/);
    assert.match(stats, /window\.loadStats = async function\(page = pageState\.stats \|\| 1\)/);
    assert.match(stats, /stats\/usage\?\$\{params\.toString\(\)\}/);
    assert.match(stats, /renderPagination\('stats', total, requestedPage\)/);
    assert.match(stats, /window\.exportStats = \(\) => downloadFileByFetch\(`\$\{API_BASE\}\/stats\/usage\/export`, 'usage_stats\.csv'\)/);
    assert.match(adminStatsRoute, /router\.get\('\/usage'[\s\S]*LIMIT (?:\?|@limit) OFFSET (?:\?|@offset)/);
    assert.match(adminStatsRoute, /router\.get\('\/usage\/export'[\s\S]*filename=usage_stats\.csv/);
    assert.match(adminStatsRoute, /res\.json\(\{ data: stats, total, page, limit \}\)/);
    assert.match(adminStatsRoute, /const forceRefresh = req\.query\?\.refresh === '1'/);
    assert.match(statsMonitor, /window\.loadMonitorSummary = async function\(options = \{\}\)/);
    assert.match(statsMonitor, /\?refresh=1/);
    assert.match(statsMonitor, /window\.refreshMonitorSummary = function\(options = \{\}\)/);
    assert.match(adminSettings, /window\.refreshMonitorSummary\(\{ force: true \}\)/);
});

test('long-term memory table and modals use shared controls', () => {
    const adminCore = fs.readFileSync(path.resolve(__dirname, '..', '..', 'client', 'chat', 'admin.js'), 'utf8');
    const adminSettings = fs.readFileSync(path.resolve(__dirname, '..', '..', 'client', 'chat', 'admin-settings.js'), 'utf8');
    const memoryPartial = fs.readFileSync(path.resolve(__dirname, '..', '..', 'client', 'chat', 'partials', 'settings', 'memories.html'), 'utf8');
    const preAppModals = fs.readFileSync(path.resolve(__dirname, '..', '..', 'client', 'chat', 'partials', 'pre-app-modals.html'), 'utf8');
    const globalParamsPartial = fs.readFileSync(path.resolve(__dirname, '..', '..', 'client', 'chat', 'partials', 'settings', 'global-params.html'), 'utf8');
    const adminLayoutCss = fs.readFileSync(path.resolve(__dirname, '..', '..', 'client', 'chat', 'styles', 'admin', 'admin-layout.css'), 'utf8');

    assert.match(memoryPartial, /<table class="data-table compact-table memories-table">/);
    assert.match(memoryPartial, /id="pagination-memories" class="pagination"/);
    assert.match(memoryPartial, /class="modal model-modal memory-modal memory-edit-modal"/);
    assert.match(memoryPartial, /class="modal model-modal memory-modal memory-source-modal"/);
    assert.match(memoryPartial, /class="model-modal-header memory-modal-header"/);
    assert.match(memoryPartial, /id="memory-edit-form" class="model-form memory-edit-form"/);
    assert.match(memoryPartial, /class="model-form-row memory-edit-grid"/);
    assert.match(memoryPartial, /class="model-form memory-source-form"/);
    assert.match(memoryPartial, /class="model-modal-actions memory-modal-actions"/);
    assert.match(memoryPartial, /<div class="model-modal-header memory-modal-header">\s*<h3>来源<\/h3>\s*<button id="memory-source-close" type="button" class="btn-secondary settings-close-btn memory-source-close">关闭<\/button>\s*<\/div>/);
    assert.match(memoryPartial, /id="memory-source-close" type="button" class="btn-secondary settings-close-btn memory-source-close"/);
    assert.doesNotMatch(memoryPartial, /<div class="model-form memory-source-form">[\s\S]*?model-modal-actions memory-modal-actions/);
    assert.match(adminCore, /window\.loadMemories\(page\)/);
    assert.match(adminSettings, /function memoryQueryParams\(page = pageState\.memories \|\| 1\)/);
    assert.match(adminSettings, /function collectRuntimeSettingsPayload\(source = null\)/);
    assert.match(adminSettings, /sourceEl\?\.closest\?\.\('#tab-content-global-params'\)/);
    assert.doesNotMatch(adminSettings, /openRuntimeSettingsModal/);
    assert.doesNotMatch(adminSettings, /closeRuntimeSettingsModal/);
    assert.match(adminSettings, /const payload = collectRuntimeSettingsPayload\(source\);/);
    assert.doesNotMatch(adminSettings, /runtime-settings-save/);
    assert.doesNotMatch(preAppModals, /runtime-settings-modal/);
    assert.doesNotMatch(preAppModals, /data-runtime-key=/);
    assert.match(globalParamsPartial, /id="runtime-settings-page-save"/);
    assert.match(globalParamsPartial, /data-runtime-key="model_endpoint_default_concurrency"/);
    assert.doesNotMatch(adminSettings, /document\.querySelectorAll\('\[data-runtime-key\]'\)\)[\s\S]*visibleRuntimeInputs/);
    assert.match(adminSettings, /params\.set\('limit', String\(limit\)\)/);
    assert.match(adminSettings, /params\.set\('offset', String\(\(currentPage - 1\) \* limit\)\)/);
    assert.match(adminSettings, /renderPagination\('memories', total, requestedPage\)/);
    assert.match(adminSettings, /const MEMORY_STATUS_LABELS = \{\s*active: '活跃',\s*disabled: '禁用',\s*deleted: '已删除'\s*\}/s);
    assert.match(adminSettings, /formatMemoryStatusLabel\(memory\.status\)/);
    assert.doesNotMatch(adminSettings, /escapeHtml\(memory\.status \|\| 'active'\)/);
    assert.match(adminSettings, /const memory = getCurrentMemory\(memoryId\);/);
    assert.match(adminSettings, /catch \(e\) \{\s*if \(body\) PivotSafeHtml\.setHtml\(body, `<p class="muted">\$\{escapeHtml\(e\.message/s);
    assert.match(adminLayoutCss, /\.settings-workspace-view \.memory-content-cell \{\s*max-width: none;\s*white-space: nowrap;/s);
    assert.match(adminLayoutCss, /\.settings-workspace-view \.memory-edit-modal \{\s*width: min\(680px,/s);
    assert.match(adminLayoutCss, /\.settings-workspace-view \.memory-edit-content textarea\.form-input \{\s*height: 180px;/s);
    assert.match(adminLayoutCss, /\.settings-workspace-view \.memory-modal-header \{\s*display: flex;\s*align-items: center;\s*justify-content: space-between;/s);
    assert.match(adminLayoutCss, /\.settings-workspace-view \.memory-source-close \{\s*margin-left: auto;/s);
    assert.doesNotMatch(adminLayoutCss, /runtime-settings-modal/);
    assert.doesNotMatch(adminLayoutCss, /runtime-settings-grid/);
    assert.doesNotMatch(adminLayoutCss, /\.settings-workspace-view \.memory-edit-form,\s*\.settings-workspace-view \.memory-source-body \{/);
    assert.doesNotMatch(adminLayoutCss, /\.settings-workspace-view \.memory-action-cell \{\s*display: flex;/);
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
        onContent: (chunk, meta) => emitted.push({ chunk, meta })
    });
    accumulator.pushJson({ choices: [{ delta: { reasoning_content: 'reasoning' } }] });
    accumulator.pushJson({ choices: [{ delta: { content: 'answer' } }], usage: { completion_tokens: 2 } });
    accumulator.finish();

    assert.equal(accumulator.getContent(), '<thought>reasoning</thought>answer');
    assert.deepEqual(emitted, [
        { chunk: '<thought>reasoning', meta: { delta: 'reasoning', isThought: true, usage: null } },
        { chunk: '</thought>answer', meta: { delta: 'answer', isThought: false, usage: { completion_tokens: 2 } } }
    ]);
    assert.deepEqual(accumulator.getUsage(), { completion_tokens: 2 });
});

test('聊天回答速度按完整输出 token 与总耗时计算', () => {
    const stats = buildAssistantSpeedStats({
        assistantContent: '<thought>思考 1000 token</thought>最终答案',
        apiUsage: { completion_tokens: 140 },
        requestStartedAt: 1_000,
        endedAt: 71_000,
        firstVisibleAnswerAt: 61_000
    });

    assert.equal(stats.assistantTokens, 140);
    assert.equal(stats.answerTokens > 0, true);
    assert.equal(stats.costTime, 70);
    assert.equal(stats.tokensPerSec, 2);
});

test('聊天回答速度会用内容估算补足流式图表 token', () => {
    const stats = buildAssistantSpeedStats({
        assistantContent: '最终答案',
        streamedChartSpecs: [{ type: 'bar', data: [1, 2, 3], title: '示例图表' }],
        apiUsage: { completion_tokens: 1 },
        requestStartedAt: 1_000,
        endedAt: 11_000
    });

    assert.equal(stats.assistantTokens, estimateTokens(stats.assistantContent));
    assert.equal(stats.answerTokens > 0, true);
    assert.equal(stats.costTime, 10);
    assert.equal(stats.tokensPerSec, stats.assistantTokens / 10);
});

test('前端实时速度统计按总 token 和总耗时计算', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '..', '..', 'client', 'chat', 'engine-streaming.js'), 'utf8');

    assert.match(source, /const elapsed = Math\.max\(\(Date\.now\(\) - startTime\) \/ 1000, 0\.001\);/);
    assert.match(source, /safeTokenCount \/ elapsed/);
    assert.doesNotMatch(source, /answerElapsed/);
    assert.doesNotMatch(source, /firstStreamTime/);
});

test('前端流式速度统计会排除思考块 token', () => {
    const sandbox = createChatRenderSandbox();
    vm.runInNewContext(
        fs.readFileSync(path.resolve(__dirname, '..', '..', 'client', 'chat', 'engine-streaming.js'), 'utf8'),
        sandbox
    );

    const answerOnly = sandbox.estimateStreamingTokenCount('最终答案');
    const withThought = sandbox.estimateStreamingAnswerTokenCount('<thought>思考 1000 token</thought>最终答案');
    const openThought = sandbox.estimateStreamingAnswerTokenCount('<thought>仍在思考');

    assert.equal(withThought, answerOnly);
    assert.equal(openThought, 0);
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

test('任务模板通知中心会将运行结果统一显示为中文', () => {
    const agentUtils = fs.readFileSync(path.resolve(__dirname, '..', '..', 'client', 'chat', 'agent-run-utils.js'), 'utf8');
    const agentSchedules = fs.readFileSync(path.resolve(__dirname, '..', '..', 'client', 'chat', 'agent-schedules.js'), 'utf8');

    assert.match(agentUtils, /translateAgentNotificationText/);
    assert.match(agentUtils, /DAG\\s\+run\\s\+completed/);
    assert.match(agentUtils, /工作流运行完成/);
    assert.match(agentUtils, /工作流运行失败/);
    assert.match(agentUtils, /agentNotificationBody/);
    assert.match(agentSchedules, /agentNotificationTitle\(item\)/);
    assert.match(agentSchedules, /agentNotificationBody\(item\)/);
});
