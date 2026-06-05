// Agent 安全测试
const {
    aiSemaphore,
    assert,
    callModelText,
    cancelAgentRun,
    computeNextScheduleRun,
    createAgentRun,
    createAgentSchedule,
    createAgentTemplate,
    createAgentWorkbenchSandbox,
    createFakeSseResponse,
    db,
    executeBuiltInTool,
    formatToolList,
    fs,
    getBeijingTimestamp,
    getBuiltInToolDefinitions,
    getRunDetailForUser,
    getRunForUser,
    getRunProgress,
    getRunnableModelForUser,
    getUserRunnableModels,
    http,
    listAgentArtifacts,
    listAgentNotifications,
    listAgentSchedules,
    listAgentTemplates,
    listDeletedRunsForAdmin,
    listRuns,
    modelRouter,
    normalizeAgentGoal,
    normalizeApprovalPolicy,
    normalizeToolAllowlist,
    normalizeToolPolicy,
    parseJsonObject,
    path,
    publishUserEvent,
    rerunAgentRun,
    resumeAgentRun,
    runAgent,
    runAgentScheduleNow,
    saveAgentRunArtifact,
    shouldPauseForApproval,
    softDeleteAgentRun,
    streamingTools,
    subscribeUserEvents,
    test
} = require('./security-helpers');

function readAgentSourceBundle() {
    return [
        'agents.js',
        'agent-run-renderers.js',
        'agent-run-utils.js',
        'agent-run-tool-labels.js',
        'agent-run-step-renderers.js',
        'agent-run-visuals.js',
        'agent-run-loaders.js',
        'agent-run-detail.js',
        'agent-run-realtime.js',
        'agent-run-actions.js',
        'agent-runs-list.js',
        'agent-workflow-library.js',
        'agent-workflow-versions.js',
        'agent-workflow-editor.js',
        'agent-workflows.js',
        'agent-templates.js',
        'agent-schedules.js',
        'agent-artifacts.js'
    ].map(fileName => fs.readFileSync(path.join(__dirname, '..', 'client', 'chat', fileName), 'utf8')).join('\n');
}

function readDagEditorSourceBundle() {
    return [
        'dag-core.js',
        'dag-render.js',
        'dag-interaction.js',
        'dag-toolbar.js',
        'dag-toolbar-field-overrides.js',
        'dag-toolbar-fields.js',
        'dag-wizard-db.js',
        'dag-wizard-input.js',
        'dag-wizard-fields.js',
        'dag-wizard-stats.js',
        'dag-wizard.js',
        'dag-inspector.js',
        'agents-dag-editor.js'
    ].map(fileName => fs.readFileSync(path.join(__dirname, '..', 'client', 'chat', fileName), 'utf8')).join('\n');
}

function readAgentCssBundle() {
    return [
        'agent/agent-layout.css',
        'agent/agent-controls.css',
        'agent/agent-model-tools.css',
        'agent/agent-runs-list-table.css',
        'agent/agent-run-detail.css',
        'agent/agent-run-steps.css',
        'agent/agent-run-capabilities.css',
        'agent/agent-run-dag-artifacts.css',
        'agent/agent-dag-toolbar.css',
        'agent/agent-dag-workspace-shell.css',
        'agent/agent-workflow-modals.css',
        'agent/agent-dag-workbench.css',
        'agent/agent-dag-svg.css',
        'agent/agent-dag-drawer-inspector.css',
        'agent/agent-dag-input-overview.css',
        'agent/agent-dag-input-wizard.css',
        'agent/agent-dag-minimap.css',
        'agent-runtime.css'
    ].map(fileName => fs.readFileSync(path.join(__dirname, '..', 'client', 'chat', 'styles', 'workspaces', fileName), 'utf8')).join('\n');
}

test('agent run visual outputs wait until the run finishes', () => {
    const sandbox = createAgentWorkbenchSandbox();
    const chart = {
        type: 'pivot_chart',
        chartType: 'bar',
        title: 'group_id count',
        labels: ['0', '3'],
        series: [{ name: 'count', data: [2, 1] }]
    };

    const runningHtml = sandbox.renderAgentRunVisualOutputs([{ output: chart, title: '图表节点' }], [], '', 'running');
    assert.equal(runningHtml, '');

    const completedHtml = sandbox.renderAgentRunVisualOutputs([{ output: chart, title: '图表节点' }], [], '', 'completed');
    assert.match(completedHtml, /agent-visual-results/);
    assert.match(completedHtml, /pivot-echart-block/);
});

test('agent step details render structured tool output as readable summaries', () => {
    const sandbox = createAgentWorkbenchSandbox();
    const queryOutput = {
        content: [{ type: 'text', text: '{"rows":[{"group_id":0,"account_count":2}]}' }],
        structuredContent: {
            rows: [
                { group_id: 0, account_count: 2 },
                { group_id: 1, account_count: 1 }
            ],
            limit: 50
        }
    };
    const queryHtml = sandbox.agentStepMarkup({
        step_index: 1,
        status: 'completed',
        type: 'tool',
        tool_name: 'db.run_readonly_query',
        duration_ms: 46,
        output: queryOutput
    });
    assert.match(queryHtml, /agent-step-table/);
    assert.match(queryHtml, />查询结果</);
    assert.match(queryHtml, />group_id</);
    assert.match(queryHtml, />account_count</);
    assert.match(queryHtml, /agent-step-raw/);
    assert.doesNotMatch(queryHtml.slice(0, queryHtml.indexOf('agent-step-raw')), /&quot;structuredContent&quot;/);

    const chartHtml = sandbox.agentStepMarkup({
        step_index: 2,
        status: 'completed',
        type: 'tool',
        tool_name: 'viz.build_chart',
        duration_ms: 1,
        output: {
            type: 'pivot_chart',
            chartType: 'bar',
            title: 'table_account group_id 分布',
            xAxis: { field: 'group_id', label: 'group_id' },
            yAxis: { field: 'account_count', label: '数量' },
            labels: ['0', '1'],
            series: [{ name: 'account_count', data: [2, 1] }]
        }
    });
    assert.match(chartHtml, /agent-step-chart-summary/);
    assert.match(chartHtml, />图表已生成</);
    assert.match(chartHtml, />数据点</);
    assert.match(chartHtml, /agent-step-raw/);
    assert.doesNotMatch(chartHtml.slice(0, chartHtml.indexOf('agent-step-raw')), /&quot;type&quot;:&quot;pivot_chart&quot;/);
});

test('agent DAG node details render LLM output as readable content', () => {
    const sandbox = createAgentWorkbenchSandbox();
    const html = sandbox.agentDagNodeMarkup({
        node_key: 'summary',
        title: '总结',
        tool_name: 'agent.llm',
        status: 'completed',
        depends_on: ['query'],
        condition: 'success',
        attempt_count: 1,
        duration_ms: 123,
        input: { prompt: '总结上游结果' },
        output: {
            content: '这是大模型节点正文',
            text: '这是大模型节点正文',
            responseFormat: 'markdown',
            model: { name: 'Agent Test Model' }
        }
    });

    assert.match(html, /agent-dag-node-readable-output/);
    assert.match(html, /这是大模型节点正文/);
    assert.match(html, /<summary>节点输出<\/summary>/);
    assert.match(html, /responseFormat/);
});

test('agent preview run display strips redundant report heading', () => {
    const sandbox = createAgentWorkbenchSandbox();
    assert.equal(
        sandbox.agentPreviewDisplayTitle('预览运行：table_account group_id 分布'),
        'table_account group_id 分布'
    );
    assert.equal(
        sandbox.stripAgentWorkflowReportHeading('# 工作流分析报告：table_account 表 group_id 分布\n\n## 1. 任务目标\n内容'),
        '## 1. 任务目标\n内容'
    );
});

test('agent DAG inspector uses modal entry points for parameter editing', () => {
    const source = readDagEditorSourceBundle();
    assert.match(source, /data-pivot-dag-open-wizard="1">配置参数/);
    assert.match(source, /data-pivot-dag-open-json="1">编辑 JSON/);
    assert.match(source, /data-pivot-dag-node-id-display/);
    assert.match(source, /readonly aria-readonly="true"/);
    assert.doesNotMatch(source, /data-pivot-dag-field="id"/);
    assert.match(source, /function friendlyFieldLabel/);
    assert.match(source, /数据库 Schema \/ 命名空间/);
    assert.match(source, /pivot-dag-tool-meta-badges/);
    assert.match(source, /pivot-dag-tool-meta-body/);
    assert.match(source, /const upstreamNodes = getDependencyCandidateNodes\(node\)/);
    assert.match(source, />上游节点</);
    assert.match(source, />上游成功后执行</);
    assert.match(source, /这是起始节点，没有可选上游节点/);
    assert.match(source, /只能从左侧上游节点连接到右侧下游节点/);
    assert.doesNotMatch(source, />依赖节点</);
    assert.ok(
        source.indexOf('<div class="pivot-dag-inspector-depends">') < source.indexOf('<div class="pivot-dag-input-overview">'),
        '上游节点选择区应显示在参数输入上方'
    );
    assert.match(source, /pivot-dag-json-input-editor/);
    assert.doesNotMatch(source, /pivot-dag-input-advanced/);
    assert.doesNotMatch(source, /data-pivot-dag-insert-token/);
});

test('agent task panel context notes uses full-width textarea', () => {
    const partial = fs.readFileSync(path.join(__dirname, '..', 'client', 'chat', 'partials', 'workspaces', 'agent.html'), 'utf8');
    const css = readAgentCssBundle();
    assert.match(partial, /<label class="agent-context-notes-field">/);
    assert.match(partial, /<textarea id="agent-context-notes" class="form-input" rows="2"/);
    assert.doesNotMatch(partial, /<input id="agent-context-notes"/);
    assert.match(css, /\.agent-context-controls \.agent-context-notes-field\s*\{[\s\S]*grid-column: 1 \/ -1/);
    assert.match(css, /\.agent-context-controls textarea\.form-input\s*\{[\s\S]*min-height: 58px/);
});

test('agent stats chart wizard explains optional database schema field', () => {
    const source = readDagEditorSourceBundle();
    assert.match(source, /Schema \/ 命名空间（可选）/);
    assert.match(source, /SQLite\/MySQL 通常留空/);
    assert.match(source, /不确定就留空，系统会使用当前连接的默认数据库范围/);
    assert.match(source, /正在读取默认范围的数据表/);
});

test('agent DAG parameter modals use large fixed-height workbench layout', () => {
    const css = readAgentCssBundle();
    assert.match(css, /\.pivot-dag-input-wizard\s*\{[\s\S]*width: min\(1320px, calc\(100vw - 24px\)\)/);
    assert.match(css, /\.pivot-dag-input-wizard\s*\{[\s\S]*height: min\(92vh, 900px\)/);
    assert.match(css, /\.pivot-dag-wizard-form\s*\{[\s\S]*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/);
    assert.match(css, /\.pivot-dag-wizard-actions\s*\{[\s\S]*flex: 0 0 auto/);
    assert.match(css, /\.pivot-dag-wizard-field\.is-wide/);
    assert.match(css, /\.pivot-dag-node-id-field input\[readonly\]/);
});

test('agent DAG tool meta card uses compact full-width summary styling', () => {
    const css = readAgentCssBundle();
    assert.match(css, /\.pivot-dag-tool-meta\s*\{[\s\S]*box-shadow: inset 3px 0 0/);
    assert.match(css, /\.pivot-dag-tool-meta-body\s*\{[\s\S]*grid-template-columns: minmax\(0, 1fr\) max-content/);
    assert.match(css, /\.pivot-dag-tool-meta p\s*\{[\s\S]*-webkit-line-clamp: 2/);
    assert.match(css, /\.pivot-dag-tool-meta-badges\s*\{[\s\S]*max-width: 55%/);
});

test('agent DAG parameter editor localizes common tool input fields', () => {
    const source = readDagEditorSourceBundle();
    assert.match(source, /query: '检索问题 \/ 查询条件'/);
    assert.match(source, /sql: 'SQL 语句'/);
    assert.match(source, /topK: '返回片段数'/);
    assert.match(source, /candidateLimit: '候选数量上限'/);
    assert.match(source, /columns: '字段列表'/);
    assert.match(source, /prompt: '提示词'/);
    assert.match(source, /model: '模型'/);
    assert.match(source, /temperature: '随机性'/);
    assert.match(source, /maxTokens: '最大输出长度'/);
    assert.match(source, /filters: '筛选条件'/);
    assert.match(source, /rows: '数据行'/);
    assert.match(source, /function friendlyFieldPlaceholder/);
    assert.match(source, /friendlyFieldLabel\(name, item, tool\)/);
    assert.match(source, /friendlyFieldDescription\(name, item, tool\)/);
    assert.match(source, /friendlyEnumOptionLabel\(name, option\)/);
    assert.match(source, /data-pivot-dag-db-connection-select="1"/);
    assert.match(source, /const syncAssistConnection = \(\) =>/);
    assert.match(source, /databaseConnectionId/);
    assert.match(source, /读取表\/字段会跟随这个选择/);
    assert.match(source, /请先填写：\$\{missingLabels\.join\('、'\)\}/);
});

test('agent workflow workbench exposes preview and published-version run controls', () => {
    const dagPartial = fs.readFileSync(path.join(__dirname, '..', 'client', 'chat', 'partials', 'workspaces', 'agent-dag.html'), 'utf8');
    const agentPartial = fs.readFileSync(path.join(__dirname, '..', 'client', 'chat', 'partials', 'workspaces', 'agent.html'), 'utf8');
    const source = readAgentSourceBundle();
    const editor = readDagEditorSourceBundle();
    const css = readAgentCssBundle();

    assert.doesNotMatch(dagPartial, /id="agent-dag-preview-run-btn"/);
    assert.doesNotMatch(dagPartial, /id="agent-dag-run-published-btn"/);
    assert.doesNotMatch(dagPartial, /id="agent-dag-publish-run-btn"/);
    assert.doesNotMatch(dagPartial, /id="agent-dag-console-preview-run-btn"/);
    assert.doesNotMatch(dagPartial, /id="agent-dag-console-run-published-btn"/);
    assert.doesNotMatch(dagPartial, /id="agent-dag-console-publish-run-btn"/);
    assert.match(editor, /makeToolbarDropdown\('节点'/);
    assert.match(editor, /makeToolbarDropdown\('发布'/);
    assert.match(editor, /makeToolbarDropdown\('运行'/);
    assert.match(editor, /const DEFAULT_VIEW_SCALE = 0\.72/);
    assert.match(editor, /const NODE_WIDTH = 188/);
    assert.match(editor, /const NODE_HEIGHT = 62/);
    assert.match(editor, /const MIN_CONTENT_WIDTH = 960/);
    assert.match(editor, /scale: DEFAULT_VIEW_SCALE/);
    assert.match(editor, /viewState\.scale = DEFAULT_VIEW_SCALE/);
    assert.match(editor, /const closeToolbarDropdowns = \(event\) =>/);
    assert.match(editor, /document\.addEventListener\('pointerdown', closeToolbarDropdowns\)/);
    assert.match(editor, /document\.removeEventListener\('pointerdown', closeToolbarDropdowns\)/);
    assert.match(editor, /makeButton\('预览运行'/);
    assert.match(editor, /makeButton\('运行发布版'/);
    assert.doesNotMatch(editor, /makeButton\('发布并运行'/);
    assert.match(dagPartial, /id="agent-workflow-current-label"/);
    assert.match(dagPartial, />已保存工作流</);
    assert.match(dagPartial, /id="agent-workflow-lifecycle"/);
    assert.doesNotMatch(dagPartial, /id="agent-workflow-run-console"/);
    assert.doesNotMatch(dagPartial, /id="agent-workflow-run-console-status"/);
    assert.doesNotMatch(dagPartial, /id="agent-workflow-name"/);
    assert.doesNotMatch(dagPartial, /id="agent-workflow-version-label"/);
    assert.doesNotMatch(dagPartial, /id="agent-workflow-run-source"/);
    assert.doesNotMatch(dagPartial, /id="agent-workflow-model-select"/);
    assert.doesNotMatch(dagPartial, /id="agent-workflow-max-steps"/);
    assert.doesNotMatch(dagPartial, /id="agent-workflow-allow-mcp"/);
    assert.doesNotMatch(agentPartial, /id="agent-run-workflow-field"/);
    assert.doesNotMatch(agentPartial, /id="agent-run-workflow-version"/);
    assert.doesNotMatch(agentPartial, /id="agent-workflow-model-select"/);
    assert.doesNotMatch(agentPartial, /<option value="dag">工作流<\/option>/);
    assert.match(source, /function buildAgentWorkflowWorkbenchRunPayload/);
    assert.match(source, /function getAgentWorkflowRunSettings/);
    assert.match(source, /const llmNode = nodes\.find\(node => String\(node\?\.tool/);
    assert.match(source, /modelId: runSettings\.modelId/);
    assert.match(source, /maxSteps: runSettings\.maxSteps/);
    assert.match(source, /async function ensureAgentWorkflowNameForSave/);
    assert.match(source, /await window\.showInputPrompt\?\.\(\{/);
    assert.match(source, /const workflowName = await ensureAgentWorkflowNameForSave\(\)/);
    assert.doesNotMatch(source, /window\.prompt\?\(/);
    assert.match(source, /payload\.workflowVersion = 'draft'/);
    assert.match(source, /workflowRunSource: 'preview'/);
    assert.match(source, /payload\.workflowVersion = sourceMode === 'published' \? 'published' : 'current'/);
    assert.match(source, /workflowRunSource: sourceMode === 'published' \? 'published' : 'current'/);
    assert.match(source, /await window\.openAgentRun\(data\.run\.id, \{ workflowPreview: true \}\)/);
    assert.match(source, /function ensureAgentRunDetailModalVisible/);
    assert.match(source, /function startAgentWorkflowPreviewPolling/);
    assert.match(source, /window\.cancelAgentWorkflowPreviewRun/);
    assert.match(source, /function agentDagNodeReadableOutputMarkup/);
    assert.match(source, /window\.publishAndRunAgentWorkflow = publishAndRunAgentWorkflow/);
    assert.match(source, /data-agent-run-title-full/);
    assert.match(source, /function bindAgentRunTitleTooltip/);
    assert.match(source, /const NODE_W = 112, NODE_H = 34/);
    assert.match(source, /const MIN_VIEW_W = 880, MIN_VIEW_H = 150/);
    assert.doesNotMatch(source, /agent-run-workflow/);
    assert.doesNotMatch(source, /agent-run-dag-inputs/);
    assert.doesNotMatch(source, /agent-workflow-model-select/);
    assert.doesNotMatch(source, /agent-workflow-version-label/);
    assert.doesNotMatch(source, /agent-workflow-run-source/);
    assert.doesNotMatch(source, /getSelectedAgentWorkflowRunVersion/);
    assert.match(css, /\.agent-workflow-lifecycle\s*\{/);
    assert.match(css, /\.agent-workflow-lifecycle-chip\s*\{/);
    assert.match(css, /\.agent-dag-library-select:focus-within\s*\{/);
    assert.match(css, /\.agent-dag-library-actions\s*\{[\s\S]*?border: 0;[\s\S]*?background: transparent;/);
    assert.doesNotMatch(css, /\.agent-workflow-run-console\s*\{/);
    assert.match(css, /\.pivot-dag-toolbar-dropdown\s*\{/);
    assert.match(css, /\.pivot-dag-toolbar-summary::marker\s*\{/);
    assert.match(css, /\.pivot-dag-toolbar-summary::after\s*\{\s*display: none;/);
    assert.match(css, /\.pivot-dag-toolbar-menu \.pivot-dag-toolbar-btn\.btn-primary/);
    assert.match(css, /\.agent-run-title-tooltip\s*\{/);
    assert.match(css, /\.agent-dag-node-readable-output\s*\{/);
    assert.doesNotMatch(css, /padding: 0 28px 0 12px/);
    assert.doesNotMatch(css, /\.agent-workflow-run-settings\s*\{/);
    assert.doesNotMatch(css, /\.agent-workflow-run-source/);
    assert.doesNotMatch(css, /\.agent-run-workflow-field/);
    assert.doesNotMatch(css, /\.agent-workflow-run-status/);
});

test('agent DAG editor and runtime expose first-class LLM workflow node', () => {
    const ui = fs.readFileSync(path.join(__dirname, '..', 'client', 'chat', 'ui.js'), 'utf8');
    const agents = readAgentSourceBundle();
    const editor = readDagEditorSourceBundle();
    const tools = fs.readFileSync(path.join(__dirname, '..', 'server', 'services', 'agent-tools.js'), 'utf8');
    const runtime = fs.readFileSync(path.join(__dirname, '..', 'server', 'services', 'agent-runtime.js'), 'utf8');
    const model = fs.readFileSync(path.join(__dirname, '..', 'server', 'services', 'agent-model.js'), 'utf8');

    assert.match(ui, /function isSelectableModelForCurrentUser/);
    assert.match(ui, /const models = data\.filter\(isSelectableModelForCurrentUser\)/);
    assert.doesNotMatch(ui, /owner_role === 'admin'/);
    assert.match(agents, /window\.isSelectableModelForCurrentUser/);

    assert.match(editor, /'agent\.llm': \['大模型节点'/);
    assert.match(editor, /key: 'llm', label: '大模型'/);
    assert.match(editor, /function defaultLlmInput/);
    assert.match(editor, /function defaultWorkflowModelId/);
    assert.match(editor, /function workflowModelOptions/);
    assert.match(editor, /window\.isSelectableModelForCurrentUser/);
    assert.match(editor, /isLlmModelField && workflowModelOptions\(\)\.length/);
    assert.match(editor, /createDefaultLlmNode/);
    assert.match(editor, /工作流必须包含 1 个大模型节点/);
    assert.match(editor, /工作流必须保留 1 个大模型节点/);
    assert.match(editor, /需要填写节点模型/);
    assert.match(editor, /makeButton\('大模型'/);
    assert.match(editor, /patterns: \['agent\.llm'\]/);
    assert.match(editor, /prompt: selectedNode/);
    assert.match(tools, /name: 'agent\.llm'/);
    assert.match(tools, /maxSteps: \{ type: 'integer'/);
    assert.match(tools, /\['prompt', 'model'\]/);
    assert.match(tools, /async function executeAgentLlmNode/);
    assert.match(tools, /recordAgentModelUsage\(user, modelCfg, messages, content, 'agent_llm_node'/);
    assert.match(runtime, /function inferDagLlmRuntimeSettings/);
    assert.match(runtime, /if \(!effectiveModelId && llmRuntimeSettings\.modelId\)/);
    assert.match(runtime, /executeToolByName\(node\.tool, resolvedInput, user, toolList, \{ run, modelCfg \}\)/);
    assert.match(model, /const temperature = typeof options\.temperature === 'number'/);
    assert.match(model, /max_tokens: maxTokens/);
});

test('agent JSON parser extracts strict object from model text', () => {
    assert.deepEqual(parseJsonObject('{"action":"final","answer":"ok"}'), { action: 'final', answer: 'ok' });
    assert.deepEqual(parseJsonObject('```json\n{"tool":"models.list","input":{}}\n```'), { tool: 'models.list', input: {} });
    assert.equal(parseJsonObject('no json here'), null);
});

test('built-in agent tools expose user-safe tool definitions and execute model list', async () => {
    const user = { id: 1, role: 'user', unit: '' };
    const tools = getBuiltInToolDefinitions(user);
    assert.equal(tools.some(tool => tool.name === 'rag.search'), true);
    assert.equal(tools.some(tool => tool.name === 'system.health'), false);
    assert.equal(formatToolList(user).some(tool => tool.name === 'system.health'), false);
    const limitedAdminTools = formatToolList({ id: 1, username: 'ops-admin', role: 'admin', unit: '' });
    assert.equal(limitedAdminTools.some(tool => tool.name === 'system.health'), false);
    const spoofedAdminNameTools = formatToolList({ id: 1, username: 'admin', role: 'user', unit: '' });
    assert.equal(spoofedAdminNameTools.some(tool => tool.name === 'system.health'), false);
    const superAdminTools = formatToolList({ id: 1, username: 'admin', role: 'admin', unit: '' });
    const systemHealth = superAdminTools.find(tool => tool.name === 'system.health');
    assert.equal(systemHealth.admin, true);
    assert.equal(systemHealth.title, '系统健康');
    assert.equal(normalizeToolPolicy('builtin_only'), 'builtin_only');
    assert.equal(normalizeToolPolicy('unknown'), 'all');
    assert.equal(normalizeApprovalPolicy('approve_all_mcp'), 'approve_all_mcp');
    assert.equal(normalizeApprovalPolicy('bad'), 'safe_mcp_auto');
    assert.deepEqual(normalizeToolAllowlist('["rag.search","rag.search","models.list"]'), ['rag.search', 'models.list']);
    assert.equal(shouldPauseForApproval(
        { approval_policy: 'safe_mcp_auto', metadata: '{}' },
        { name: 'mcp.high', source: 'mcp', risk: 'high', requiresApproval: true }
    ), true);
    assert.equal(shouldPauseForApproval(
        { approval_policy: 'safe_mcp_auto', metadata: '{}' },
        { name: 'mcp.db', source: 'mcp', risk: 'low', requiresApproval: false }
    ), false);
    assert.equal(shouldPauseForApproval(
        { approval_policy: 'approve_all_mcp', metadata: '{}' },
        { name: 'mcp.db', source: 'mcp', risk: 'low', requiresApproval: false }
    ), true);
    assert.equal(shouldPauseForApproval(
        { approval_policy: 'approve_all_mcp', metadata: '{"approvedTools":["mcp.db"]}' },
        { name: 'mcp.db', source: 'mcp', risk: 'low', requiresApproval: false }
    ), false);
    await assert.rejects(
        () => executeBuiltInTool('system.health', {}, { id: 1, username: 'admin', role: 'user', unit: '' }),
        /admin/
    );
    const result = await executeBuiltInTool('models.list', {}, user);
    assert.equal(Array.isArray(result), true);
});

test('agent model calls wait for global model queue instead of failing immediately', async () => {
    const axios = require('axios');
    const originalPost = axios.post;
    await aiSemaphore.acquire();
    let releasedGlobal = false;
    let called = false;
    axios.post = async () => {
        called = true;
        return { data: { choices: [{ message: { content: 'queued ok' } }] } };
    };
    try {
        const pending = callModelText({
            id: 901001,
            name: 'Queued Agent Model',
            url: 'http://127.0.0.1:65530/v1/chat/completions',
            model_name: 'queued-agent-model'
        }, [{ role: 'user', content: 'hello' }]);
        await new Promise(resolve => setTimeout(resolve, 20));
        assert.equal(called, false);
        aiSemaphore.release();
        releasedGlobal = true;
        const result = await pending;
        assert.equal(result, 'queued ok');
        assert.equal(called, true);
    } finally {
        axios.post = originalPost;
        if (!releasedGlobal) aiSemaphore.release();
    }
});

test('agent runs can be cancelled and rerun from an existing run', () => {
    const suffix = Date.now();
    const userInfo = db.prepare(`
        INSERT INTO users (username, password_hash, nickname, unit, role, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, datetime('now', '+8 hours'))
    `).run(`agent_user_${suffix}`, 'hash', 'Agent User', 'QA', 'user', 'active');
    const user = { id: Number(userInfo.lastInsertRowid), username: `agent_user_${suffix}`, role: 'user', unit: 'QA' };
    const modelInfo = db.prepare(`
        INSERT INTO models (user_id, name, url, model_name, status, created_at)
        VALUES (?, ?, ?, ?, 'active', datetime('now', '+8 hours'))
    `).run(user.id, 'Agent Test Model', 'http://127.0.0.1:65530/v1/chat/completions', 'agent-test-model');

    const run = createAgentRun({
        user,
        goal: '整理项目风险',
        modelId: Number(modelInfo.lastInsertRowid),
        maxSteps: 3,
        runMode: 'audit',
        toolPolicy: 'builtin_only',
        approvalPolicy: 'approve_all_mcp',
        retryLimit: 2,
        maxTokenBudget: 100000,
        toolAllowlist: ['rag.search', 'models.list']
    });
    assert.equal(run.run_mode, 'audit');
    assert.equal(run.tool_policy, 'builtin_only');
    assert.equal(run.approval_policy, 'approve_all_mcp');
    assert.equal(run.retry_limit, 2);
    assert.equal(run.max_token_budget, 100000);
    assert.throws(() => rerunAgentRun(run.id, user), /仍在执行/);

    const repairedTitleRun = createAgentRun({
        user,
        goal: '请使用数据库 MCP 查询 hcd_b 表并输出部门统计',
        title: '????????',
        modelId: Number(modelInfo.lastInsertRowid),
        maxSteps: 3,
        toolPolicy: 'builtin_only'
    });
    assert.equal(repairedTitleRun.title, '请使用数据库 MCP 查询 hcd_b 表并输出部门统计'.slice(0, 40));
    db.prepare('UPDATE agent_runs SET title = ? WHERE id = ?').run('????????', repairedTitleRun.id);
    const realtime = createFakeSseResponse();
    const unsubscribeRealtime = subscribeUserEvents(user, realtime, { heartbeatMs: 0 });
    cancelAgentRun(repairedTitleRun.id, user);
    const realtimePayload = realtime.chunks.join('');
    assert.doesNotMatch(realtimePayload, /\?{3,}/);
    assert.match(realtimePayload, /请使用数据库 MCP 查询 hcd_b 表并输出部门统计/);
    unsubscribeRealtime();

    const cancelled = cancelAgentRun(run.id, user);
    assert.equal(cancelled.status, 'cancelled');
    assert.equal(Boolean(cancelled.cancelled_at), true);
    const detail = getRunDetailForUser(run.id, user);
    assert.equal(detail.progress.errorCount, 0);
    assert.equal(detail.progress.stepCount >= 1, true);
    const listedRun = listRuns(user, { limit: 30 }).data.find(item => item.id === run.id);
    assert.equal(listedRun.step_count, detail.steps.length);
    assert.equal(listedRun.tool_count, detail.steps.filter(step => step.type === 'tool').length);
    assert.equal(listedRun.error_count, detail.steps.filter(step => step.status === 'error').length);

    const previewRun = createAgentRun({
        user,
        goal: '预览当前工作流执行结果',
        modelId: Number(modelInfo.lastInsertRowid),
        maxSteps: 3,
        toolPolicy: 'builtin_only',
        metadata: { workflowRunSource: 'preview', workflowVersionMode: 'draft' }
    });
    cancelAgentRun(previewRun.id, user);
    assert.equal(listRuns(user, { limit: 30 }).data.some(item => item.id === previewRun.id), false);
    assert.equal(listRuns(user, { limit: 30, includePreview: true }).data.some(item => item.id === previewRun.id), true);
    assert.equal(listAgentNotifications(user, 50).some(item => item.run_id === previewRun.id), false);

    const rerun = rerunAgentRun(run.id, user);
    assert.equal(rerun.goal, run.goal);
    assert.equal(rerun.model_id, run.model_id);
    assert.equal(rerun.max_steps, run.max_steps);
    assert.equal(rerun.parent_run_id, run.id);
    assert.equal(rerun.run_mode, run.run_mode);
    assert.equal(rerun.tool_policy, run.tool_policy);
    assert.equal(rerun.approval_policy, run.approval_policy);

    cancelAgentRun(rerun.id, user);
    assert.equal(getRunForUser(rerun.id, user).status, 'cancelled');
    assert.equal(getRunProgress({ status: 'completed', max_steps: 3 }, []).percent, 100);

    const deleted = softDeleteAgentRun(run.id, user, '用户清理任务列表');
    assert.equal(Boolean(deleted.deleted_at), true);
    assert.equal(deleted.deleted_by_user, user.id);
    assert.equal(getRunForUser(run.id, user), undefined);
    assert.equal(getRunDetailForUser(run.id, user), null);
    assert.equal(listRuns(user, { limit: 30 }).data.some(item => item.id === run.id), false);
    assert.throws(() => listDeletedRunsForAdmin(user, 20), /admin 权限层级/);
    const adminAudit = listDeletedRunsForAdmin({ id: 1, username: 'admin', role: 'admin', unit: '' }, 20);
    assert.equal(adminAudit.some(item => item.id === run.id && item.deleted_by_user === user.id), true);

    assert.throws(() => normalizeAgentGoal('短'), /更明确/);
});

test('agent model visibility excludes other users private models', () => {
    const suffix = Date.now();
    const ownerInfo = db.prepare(`
        INSERT INTO users (username, password_hash, nickname, unit, role, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, datetime('now', '+8 hours'))
    `).run(`agent_owner_${suffix}`, 'hash', 'Owner', 'QA', 'user', 'active');
    const otherInfo = db.prepare(`
        INSERT INTO users (username, password_hash, nickname, unit, role, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, datetime('now', '+8 hours'))
    `).run(`agent_other_${suffix}`, 'hash', 'Other', 'QA', 'user', 'active');
    const owner = { id: Number(ownerInfo.lastInsertRowid), username: `agent_owner_${suffix}`, role: 'user', unit: 'QA' };
    const other = { id: Number(otherInfo.lastInsertRowid), username: `agent_other_${suffix}`, role: 'user', unit: 'QA' };
    const superAdmin = { id: 1, username: 'admin', role: 'admin', unit: '' };
    const privateModel = db.prepare(`
        INSERT INTO models (user_id, name, url, model_name, status, created_at)
        VALUES (?, ?, ?, ?, 'active', datetime('now', '+8 hours'))
    `).run(owner.id, 'Owner Private Agent Model', 'http://127.0.0.1:65530/v1/chat/completions', `owner-private-${suffix}`);
    const globalModel = db.prepare(`
        INSERT INTO models (user_id, name, url, model_name, allowed_units, status, created_at)
        VALUES (NULL, ?, ?, ?, ?, 'active', datetime('now', '+8 hours'))
    `).run('QA Global Agent Model', 'http://127.0.0.1:65530/v1/chat/completions', `qa-global-${suffix}`, 'QA');

    const privateId = Number(privateModel.lastInsertRowid);
    const globalId = Number(globalModel.lastInsertRowid);
    assert.equal(getRunnableModelForUser(privateId, owner)?.id, privateId);
    assert.equal(getRunnableModelForUser(privateId, other), null);
    assert.equal(getRunnableModelForUser(privateId, superAdmin), null);
    assert.equal(getRunnableModelForUser(globalId, other)?.id, globalId);
    assert.equal(getUserRunnableModels(owner).some(model => model.id === privateId), true);
    assert.equal(getUserRunnableModels(other).some(model => model.id === privateId), false);
    assert.equal(getUserRunnableModels(superAdmin).some(model => model.id === privateId), false);
    assert.throws(() => createAgentRun({
        user: superAdmin,
        goal: '检查其他用户私有模型是否可用于自动化',
        modelId: privateId,
        maxSteps: 3
    }), /accessible model/);
});

test('enterprise agent templates schedules artifacts and resume are user scoped', () => {
    const suffix = Date.now();
    const userInfo = db.prepare(`
        INSERT INTO users (username, password_hash, nickname, unit, role, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, datetime('now', '+8 hours'))
    `).run(`agent_enterprise_${suffix}`, 'hash', 'Agent Enterprise', 'QA', 'user', 'active');
    const user = { id: Number(userInfo.lastInsertRowid), username: `agent_enterprise_${suffix}`, role: 'user', unit: 'QA' };
    const modelInfo = db.prepare(`
        INSERT INTO models (user_id, name, url, model_name, status, created_at)
        VALUES (?, ?, ?, ?, 'active', datetime('now', '+8 hours'))
    `).run(user.id, 'Enterprise Agent Model', 'http://127.0.0.1:65530/v1/chat/completions', `agent-enterprise-${suffix}`);
    const modelId = Number(modelInfo.lastInsertRowid);

    const template = createAgentTemplate(user, {
        name: '风险审查',
        goalTemplate: '检查项目风险并给出建议',
        runMode: 'audit',
        toolPolicy: 'builtin_only',
        toolAllowlist: ['rag.search'],
        contextConfig: { mode: 'knowledge', notes: '仅检查当前用户资料' },
        maxSteps: 4
    });
    assert.equal(template.run_mode, 'audit');
    assert.equal(listAgentTemplates(user).some(item => item.id === template.id), true);

    const nextDaily = computeNextScheduleRun('daily', '09:00', 1, '2026-05-16 10:00:00');
    assert.equal(nextDaily.startsWith('2026-05-17 09:00'), true);
    const schedule = createAgentSchedule(user, {
        name: '每日风险巡检',
        goal: '每天检查项目风险',
        modelId,
        templateId: template.id,
        frequency: 'daily',
        timeOfDay: '09:00',
        runMode: 'audit',
        toolPolicy: 'builtin_only',
        contextConfig: { mode: 'knowledge' }
    });
    assert.equal(Boolean(schedule.next_run_at), true);
    assert.equal(listAgentSchedules(user).some(item => item.id === schedule.id), true);

    const run = runAgentScheduleNow(schedule.id, user);
    assert.equal(run.schedule_id, schedule.id);
    assert.equal(run.template_id, template.id);
    assert.equal(JSON.parse(run.context_config).mode, 'knowledge');
    cancelAgentRun(run.id, user);
    const saved = saveAgentRunArtifact(run.id, user, { content: '风险结果摘要', title: '风险摘要' });
    assert.equal(saved.title, '风险摘要');
    assert.equal(listAgentArtifacts(user).some(item => item.id === saved.id), true);
    assert.equal(listAgentNotifications(user, 20).some(item => item.run_id === run.id), true);

    const resumed = resumeAgentRun(run.id, user);
    assert.equal(resumed.parent_run_id, run.id);
    assert.equal(resumed.resume_from_step >= 1, true);
    cancelAgentRun(resumed.id, user);

    const dagRun = createAgentRun({
        user,
        goal: '使用 DAG 检查可用模型',
        modelId,
        maxSteps: 3,
        runMode: 'dag',
        toolPolicy: 'builtin_only',
        dagSpec: { nodes: [{ id: 'models', title: '列出模型', tool: 'models.list', input: {} }] }
    });
    cancelAgentRun(dagRun.id, user);
    const dagResumed = resumeAgentRun(dagRun.id, user);
    const dagMetadata = JSON.parse(dagResumed.metadata || '{}');
    assert.equal(dagMetadata.dagSpec.nodes[0].tool, 'models.list');
    cancelAgentRun(dagResumed.id, user);
});

test('DAG final answer falls back to successful node output when summary is empty', async () => {
    const axios = require('axios');
    const originalPost = axios.post;
    const suffix = Date.now().toString(36);
    const now = getBeijingTimestamp();
    const userInfo = db.prepare(`
        INSERT INTO users (username, password_hash, nickname, unit, role, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, datetime('now', '+8 hours'))
    `).run(`agent_dag_fallback_${suffix}`, 'hash', 'DAG Fallback User', 'QA', 'user', 'active');
    const user = { id: Number(userInfo.lastInsertRowid), username: `agent_dag_fallback_${suffix}`, role: 'user', unit: 'QA' };
    const modelInfo = db.prepare(`
        INSERT INTO models (user_id, name, url, model_name, status, created_at)
        VALUES (?, ?, ?, ?, 'active', datetime('now', '+8 hours'))
    `).run(user.id, 'DAG Fallback Model', 'https://example.com/v1/chat/completions', `agent-dag-fallback-${suffix}`);
    const modelId = Number(modelInfo.lastInsertRowid);
    const runId = `agent-dag-fallback-${suffix}`;
    let callCount = 0;
    axios.post = async () => {
        callCount += 1;
        return {
            data: {
                choices: [{
                    message: {
                        content: callCount === 1 ? '这是大模型节点输出' : ''
                    }
                }]
            }
        };
    };

    try {
        db.prepare(`
            INSERT INTO agent_runs (
                id, user_id, model_id, title, goal, status, max_steps, run_mode, tool_policy,
                tool_allowlist, approval_policy, timeout_ms, tool_timeout_ms, retry_limit,
                context_config, metadata, model_router, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, 'queued', 3, 'dag', 'builtin_only', '', 'safe_mcp_auto', 600000, 120000, 0, ?, ?, 'fixed', ?, ?)
        `).run(
            runId,
            user.id,
            modelId,
            'DAG 摘要兜底',
            '运行大模型节点并输出最终结果',
            '{}',
            JSON.stringify({
                dagSpec: {
                    nodes: [{
                        id: 'summary',
                        title: '大模型总结',
                        tool: 'agent.llm',
                        input: {
                            model: String(modelId),
                            prompt: '请总结测试数据',
                            responseFormat: 'markdown'
                        },
                        dependsOn: [],
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
        assert.equal(detail.run.final_answer, '这是大模型节点输出');
        assert.equal(detail.dagNodes[0].tool_name, 'agent.llm');
        assert.equal(callCount, 2);
    } finally {
        axios.post = originalPost;
        db.prepare('DELETE FROM agent_notifications WHERE run_id = ?').run(runId);
        db.prepare('DELETE FROM agent_dag_nodes WHERE run_id = ?').run(runId);
        db.prepare('DELETE FROM agent_steps WHERE run_id = ?').run(runId);
        db.prepare('DELETE FROM agent_runs WHERE id = ?').run(runId);
        db.prepare('DELETE FROM model_usage_events WHERE user_id = ?').run(user.id);
        db.prepare('DELETE FROM models WHERE id = ?').run(modelId);
        db.prepare('DELETE FROM users WHERE id = ?').run(user.id);
    }
});

test('normalizeStrategy 接受合法值并将未知值回退到 fixed', () => {
    assert.equal(modelRouter.normalizeStrategy('auto-vision'), 'auto-vision');
    assert.equal(modelRouter.normalizeStrategy('auto-cost'), 'auto-cost');
    assert.equal(modelRouter.normalizeStrategy('auto-load'), 'auto-load');
    assert.equal(modelRouter.normalizeStrategy('auto-context'), 'auto-context');
    assert.equal(modelRouter.normalizeStrategy('fixed'), 'fixed');
    assert.equal(modelRouter.normalizeStrategy('unknown'), 'fixed');
    assert.equal(modelRouter.normalizeStrategy(''), 'fixed');
    assert.equal(modelRouter.normalizeStrategy(null), 'fixed');
});

test('listStrategies 返回完整 6 项策略（含 auto-escalate）', () => {
    const list = modelRouter.listStrategies();
    const codes = list.map(item => item.code).sort();
    assert.deepEqual(codes, ['auto-context', 'auto-cost', 'auto-escalate', 'auto-load', 'auto-vision', 'fixed']);
    assert.ok(list.every(item => item.label && item.description));
});

test('normalizeStrategy 接受 auto-escalate', () => {
    assert.equal(modelRouter.normalizeStrategy('auto-escalate'), 'auto-escalate');
});

test('assessConfidence 在低置信场景下返回 confident=false 与具体 reason', () => {
    assert.equal(modelRouter.assessConfidence({ output: '' }).confident, false);
    assert.equal(modelRouter.assessConfidence({ output: '太短' }).confident, false);
    const lowConf = modelRouter.assessConfidence({ output: '抱歉，我无法判断这个问题的答案，需要更多信息。' });
    assert.equal(lowConf.confident, false);
    assert.equal(lowConf.reason, 'low_confidence_phrase');
    const lengthFail = modelRouter.assessConfidence({ output: 'I dont know what this is about and not sure how to help here.' });
    assert.equal(lengthFail.confident, false);
    assert.equal(lengthFail.reason, 'low_confidence_phrase');
    const finishFail = modelRouter.assessConfidence({ output: '这是一段足够长的、表述明确的回答，应当被视为有效输出，长度过关。', finishReason: 'length' });
    assert.equal(finishFail.confident, false);
    assert.match(finishFail.reason, /finish_reason/);
});

test('assessConfidence 在正常输出下返回 confident=true', () => {
    const ok = modelRouter.assessConfidence({
        output: '根据现有资料的分析，建议采用方案 A，因为它在成本和稳定性之间取得了平衡。',
        finishReason: 'stop'
    });
    assert.equal(ok.confident, true);
    assert.equal(ok.reason, 'pass');
});

test('createToolCallAccumulator 累加单个工具的 arguments 字符串增量', () => {
    const acc = streamingTools.createToolCallAccumulator();
    acc.ingest({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'search', arguments: '{"q":"' } }] } }] });
    acc.ingest({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'hello world' } }] } }] });
    acc.ingest({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"}' } }] } }] });
    acc.ingest({ choices: [{ finish_reason: 'tool_calls' }], usage: { prompt_tokens: 12, completion_tokens: 8 } });
    const result = acc.finalize();
    assert.equal(result.hasToolCalls, true);
    assert.equal(result.toolCalls.length, 1);
    assert.equal(result.toolCalls[0].id, 'call_1');
    assert.equal(result.toolCalls[0].name, 'search');
    assert.deepEqual(result.toolCalls[0].arguments, { q: 'hello world' });
    assert.equal(result.toolCalls[0].parseError, '');
    assert.equal(result.finishReason, 'tool_calls');
    assert.deepEqual(result.usage, { prompt_tokens: 12, completion_tokens: 8 });
});

test('legacy function_call delta 与 tool_calls 协议向后兼容', () => {
    const acc = streamingTools.createToolCallAccumulator();
    acc.ingest({ choices: [{ delta: { function_call: { name: 'legacy_tool', arguments: '{"x":1}' } } }] });
    acc.ingest({ choices: [{ finish_reason: 'function_call' }] });
    const result = acc.finalize();
    assert.equal(result.toolCalls.length, 1);
    assert.equal(result.toolCalls[0].name, 'legacy_tool');
    assert.deepEqual(result.toolCalls[0].arguments, { x: 1 });
});

test('buildOpenAiToolsPayload 把工具列表转成 OpenAI tools 数组', () => {
    const payload = streamingTools.buildOpenAiToolsPayload([
        { name: 'rag.search', description: '搜索知识库', input_schema: { type: 'object', properties: { q: { type: 'string' } } } },
        { name: '' } // 无名工具应该被过滤
    ]);
    assert.equal(payload.length, 1);
    assert.equal(payload[0].type, 'function');
    assert.equal(payload[0].function.name, 'rag.search');
    assert.deepEqual(payload[0].function.parameters, { type: 'object', properties: { q: { type: 'string' } } });
});

test('buildAssistantToolMessage 与 buildToolResultMessage 输出标准消息结构', () => {
    const result = {
        hasToolCalls: true,
        content: '',
        toolCalls: [{ id: 'c1', name: 'rag.search', argumentsRaw: '{"q":"X"}' }]
    };
    const assistantMsg = streamingTools.buildAssistantToolMessage(result);
    assert.equal(assistantMsg.role, 'assistant');
    assert.equal(assistantMsg.tool_calls[0].id, 'c1');
    assert.equal(assistantMsg.tool_calls[0].function.name, 'rag.search');

    const toolMsg = streamingTools.buildToolResultMessage('c1', { ok: true });
    assert.equal(toolMsg.role, 'tool');
    assert.equal(toolMsg.tool_call_id, 'c1');
    assert.equal(toolMsg.content, '{"ok":true}');

    // 无 tool calls 时回退到普通 assistant content 消息
    const plain = streamingTools.buildAssistantToolMessage({ hasToolCalls: false, content: '直接回答' });
    assert.deepEqual(plain, { role: 'assistant', content: '直接回答' });
});

test('agent.streaming SSE 事件按用户隔离并携带累加快照字段', () => {
    const observer = createFakeSseResponse();
    const other = createFakeSseResponse();
    subscribeUserEvents({ id: 7001 }, observer, { heartbeatMs: 0 });
    subscribeUserEvents({ id: 7002 }, other, { heartbeatMs: 0 });

    const delivered = publishUserEvent(7001, 'agent.streaming', {
        runId: 'run_streaming_test',
        step: 2,
        content: '正在思考',
        partialToolCalls: [{ id: 'c1', name: 'rag.search', argumentsRaw: '{"q":"x"}' }],
        finishReason: 'tool_calls'
    });
    assert.equal(delivered, 1);
    const text = observer.chunks.join('');
    assert.match(text, /event: agent\.streaming/);
    assert.match(text, /run_streaming_test/);
    assert.match(text, /rag\.search/);
    assert.match(text, /tool_calls/);
    // 不应泄漏到其他用户
    assert.doesNotMatch(other.chunks.join(''), /run_streaming_test/);
});
