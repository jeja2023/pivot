const test = require('node:test');
const assert = require('node:assert/strict');

const {
    ensureDefaults,
    getAvailableVariableOptions,
    serialize
} = require('../client/chat/dag-core');
const {
    exportDagWorkflowSpec,
    importDagWorkflowSpec,
    lintDagGraph
} = require('../client/chat/dag-governance');
const { normalizeDagSpec, inspectDagTopology } = require('../server/services/agent-validators');
const { getDagNodeRouteState } = require('../server/services/agent-dag-utils');
const { executeWorkflowTemplate } = require('../server/services/agent-tools-workflow-nodes');
const { getBuiltInToolDefinitions } = require('../server/services/agent-tools');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('工作流变量目录包含声明输入、真实工具字段和聚合字段', () => {
    const nodes = [
        {
            id: 'order_input', tool: 'workflow.input', title: '订单编号', dependsOn: [],
            input: { name: 'orderNumber', label: '订单编号', type: 'number', required: true }
        },
        { id: 'request', tool: 'agent.http', title: '订单接口', dependsOn: ['order_input'], input: {} },
        {
            id: 'merged', tool: 'agent.merge', title: '汇总订单', dependsOn: ['request'],
            input: { fields: { order: '{{nodes.request.output.data}}' } }
        },
        { id: 'target', tool: 'workflow.template', title: '通知文案', dependsOn: ['merged'], input: {} }
    ];
    const options = getAvailableVariableOptions(nodes, 'target');
    const inputs = options.find(group => group.group === '工作流输入');
    assert.ok(inputs?.items.some(item => item.expression === '{{inputs.orderNumber}}'));
    const http = options.find(group => group.nodeId === 'request');
    assert.ok(http?.items.some(item => item.expression === '{{nodes.request.output.statusCode}}'));
    assert.ok(http?.items.some(item => item.expression === '{{nodes.request.output.data}}'));
    assert.equal(http?.items.some(item => item.expression === '{{nodes.request.output.status}}'), false);
    const merge = options.find(group => group.nodeId === 'merged');
    assert.ok(merge?.items.some(item => item.expression === '{{nodes.merged.output.merged.order}}'));
});

test('文本模板节点按缺失变量策略输出确定性结果', () => {
    assert.deepEqual(
        executeWorkflowTemplate({ template: '  日报：已完成  ', trim: true }),
        { text: '日报：已完成', charCount: 6, missingVariables: [] }
    );
    assert.deepEqual(
        executeWorkflowTemplate({ template: '日报：{{nodes.summary.output.text}}', missingVariable: 'keep' }),
        { text: '日报：{{nodes.summary.output.text}}', charCount: 32, missingVariables: ['nodes.summary.output.text'] }
    );
    assert.deepEqual(
        executeWorkflowTemplate({ template: '日报：{{nodes.summary.output.text}}', missingVariable: 'empty' }),
        { text: '日报：', charCount: 3, missingVariables: [] }
    );
    assert.throws(
        () => executeWorkflowTemplate({ template: '{{inputs.title}}', missingVariable: 'error' }),
        /未解析变量/
    );
    assert.deepEqual(
        executeWorkflowTemplate({ template: { title: '日报', count: 2 }, trim: false }),
        { text: '{\n  "title": "日报",\n  "count": 2\n}', charCount: 33, missingVariables: [] }
    );
});

test('True/False 路由边兼容旧 dependsOn 并按条件输出激活', () => {
    const source = {
        schemaVersion: 'pivot.dag.v2',
        nodes: [
            { id: 'condition', tool: 'workflow.condition', dependsOn: [] },
            { id: 'yes', tool: 'workflow.template', dependsOn: [] },
            { id: 'no', tool: 'workflow.template', dependsOn: [] }
        ],
        edges: [
            { from: 'condition', to: 'yes', route: 'true' },
            { from: 'condition', to: 'no', route: 'false' }
        ]
    };
    const normalized = normalizeDagSpec(source);
    assert.deepEqual(normalized.nodes.find(node => node.id === 'yes').dependsOn, ['condition']);
    assert.deepEqual(normalized.nodes.find(node => node.id === 'no').dependsOn, ['condition']);
    assert.equal(inspectDagTopology(normalized).blockers.length, 0);

    const trueStates = new Map([['condition', { status: 'completed', output: { matched: true } }]]);
    assert.equal(getDagNodeRouteState(normalized.nodes.find(node => node.id === 'yes'), normalized, trueStates).active, true);
    assert.equal(getDagNodeRouteState(normalized.nodes.find(node => node.id === 'no'), normalized, trueStates).active, false);
    const falseStates = new Map([['condition', { status: 'completed', output: { matched: false } }]]);
    assert.equal(getDagNodeRouteState(normalized.nodes.find(node => node.id === 'yes'), normalized, falseStates).active, false);
    assert.equal(getDagNodeRouteState(normalized.nodes.find(node => node.id === 'no'), normalized, falseStates).active, true);
    const failedCondition = new Map([['condition', { status: 'continued_error', output: { error: '条件执行失败' } }]]);
    assert.equal(getDagNodeRouteState(normalized.nodes.find(node => node.id === 'no'), normalized, failedCondition).active, false);

    const legacy = normalizeDagSpec({ nodes: [{ id: 'start', tool: 'workflow.template', dependsOn: [] }, { id: 'end', tool: 'workflow.template', dependsOn: ['start'] }] });
    assert.equal(Object.hasOwn(legacy, 'edges'), false);
    assert.deepEqual(legacy.nodes.find(node => node.id === 'end').dependsOn, ['start']);
});

test('路由边会经过编辑期序列化、导入导出和静态治理', () => {
    const draft = ensureDefaults({
        schemaVersion: 'pivot.dag.v2',
        nodes: [
            { id: 'condition', tool: 'workflow.condition', dependsOn: [] },
            { id: 'yes', tool: 'workflow.template', dependsOn: ['condition'] }
        ],
        edges: [{ from: 'condition', to: 'yes', route: 'true' }]
    });
    const serialized = serialize(draft);
    assert.equal(serialized.schemaVersion, 'pivot.dag.v2');
    assert.deepEqual(serialized.edges, [{ from: 'condition', to: 'yes', route: 'true' }]);
    const exported = exportDagWorkflowSpec(serialized, { name: '路由测试' });
    assert.equal(exported.schemaVersion, 'pivot.dag.v2');
    assert.deepEqual(exported.spec.edges, [{ from: 'condition', to: 'yes', route: 'true' }]);
    const imported = importDagWorkflowSpec(JSON.stringify(exported));
    assert.equal(imported.ok, true);
    assert.deepEqual(imported.spec.edges, [{ from: 'condition', to: 'yes', route: 'true' }]);
    const invalid = lintDagGraph({
        nodes: draft.nodes,
        edges: [{ from: 'yes', to: 'condition', route: 'true' }]
    });
    assert.equal(invalid.valid, false);
    assert.ok(invalid.errors.some(item => item.type === 'invalid_route_source'));
});

test('文本模板作为受治理的内置工具公开输入与输出契约', () => {
    const tool = getBuiltInToolDefinitions({ id: 1 }).find(item => item.name === 'workflow.template');
    assert.ok(tool);
    assert.deepEqual(tool.input_schema.required, ['template']);
    assert.equal(tool.output_schema.properties.text.type, 'string');
});

test('结构化数组字段优先使用上游引用选择器，手写 JSON 仅保留为高级入口', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'client', 'chat', 'dag-wizard-fields.js'), 'utf8');
    assert.match(source, /isStructuredReferenceField/);
    assert.match(source, /请选择上游结构化结果/);
    assert.match(source, /高级：自定义变量或 JSON/);
    assert.match(source, /data-pivot-dag-structured-reference/);
    assert.match(source, /output\.rows/);

    const sandbox = {
        normalizeSchemaType: schema => schema.type || 'string',
        friendlySchemaTypeLabel: schema => schema.type || '文本',
        friendlyFieldLabel: name => name,
        friendlyFieldDescription: () => '',
        friendlyFieldPlaceholder: () => '',
        friendlyEnumOptionLabel: (_name, value) => value,
        isDatabaseConnectionField: () => false,
        toolValue: tool => tool?.name || '',
        toolShortName: tool => String(tool?.name || '').replace(/^mcp\.\d+\./, ''),
        normalizeFieldKey: value => String(value || '').toLowerCase(),
        isTextualSchemaField: () => true,
        formatWizardFieldValue: (_schema, value) => value === undefined || value === null ? '' : String(value),
        fieldUsageHint: () => '',
        buildWizardFieldSuggestions: () => [{ label: '数据查询 · 数据行', token: '{{nodes.query.output.rows}}' }],
        buildSchemaReferenceTokens: () => [],
        buildWizardDataFieldOptions: () => [{ value: '部门', label: '数据查询 · 部门' }],
        workflowModelOptions: () => [],
        defaultWorkflowModelId: () => '',
        dagEscapeAttr: value => String(value || ''),
        dagEscapeHtml: value => String(value || ''),
        window: { Pivot: { moduleApi: () => ({}) } }
    };
    vm.createContext(sandbox);
    vm.runInContext(`${source}\nthis.renderWizardField = renderWizardField;`, sandbox);
    const markup = sandbox.renderWizardField(
        'rows',
        { type: 'array', items: { type: 'object' } },
        '{{nodes.query.output.rows}}',
        true,
        [{ id: 'query', title: '数据查询', tool: 'db.run_readonly_query' }]
    );
    assert.match(markup, /<select[^>]*data-pivot-dag-structured-reference/);
    assert.match(markup, /数据查询 · 数据行/);
    assert.doesNotMatch(markup, />任务目标</);
    assert.doesNotMatch(markup, /pivot-dag-wizard-textarea/);

    const reviewMarkup = sandbox.renderWizardField(
        'records',
        { description: '待校对记录' },
        '{{nodes.query.output.rows}}',
        true,
        [{ id: 'query', title: '数据查询', tool: 'db.run_readonly_query' }],
        { name: 'agent.content_review' }
    );
    assert.match(reviewMarkup, /data-pivot-dag-structured-reference/);
    assert.doesNotMatch(reviewMarkup, /pivot-dag-wizard-textarea/);

    const promptMarkup = sandbox.renderWizardField(
        'prompt',
        { type: 'string' },
        '请根据结果总结',
        true,
        [{ id: 'query', title: '数据查询', tool: 'db.run_readonly_query' }],
        { name: 'agent.llm' }
    );
    assert.match(promptMarkup, /data-pivot-dag-wizard-reference-picker="prompt"/);
    assert.match(promptMarkup, /运行上下文 · 任务目标/);
    assert.match(promptMarkup, /数据查询 · 完整结果/);
    assert.match(promptMarkup, /手动填写/);

    const mappingMarkup = sandbox.renderWizardField(
        'fields',
        { type: 'object', description: '字段映射' },
        {},
        false,
        [{ id: 'query', title: '数据查询', tool: 'db.run_readonly_query' }],
        { name: 'agent.merge' }
    );
    assert.match(mappingMarkup, /data-pivot-dag-keyvalue-map/);
    assert.match(mappingMarkup, /data-pivot-dag-keyvalue-key/);
    assert.match(mappingMarkup, /data-pivot-dag-keyvalue-value/);
    assert.doesNotMatch(mappingMarkup, /pivot-dag-wizard-textarea/);

    const groupByMarkup = sandbox.renderWizardField(
        'groupBy',
        { type: ['array', 'string'], items: { type: 'string' } },
        ['部门', '状态'],
        true,
        [],
        { name: 'data.group_summary' }
    );
    assert.match(groupByMarkup, /data-pivot-dag-group-fields/);
    assert.match(groupByMarkup, /部门/);
    assert.match(groupByMarkup, /状态/);
    assert.match(groupByMarkup, /添加字段/);

    const aggregateMetricsMarkup = sandbox.renderWizardField(
        'metrics',
        { type: 'array', items: { type: 'object' } },
        [{ field: '金额', aggregation: 'sum', alias: '总金额' }],
        false,
        [{ id: 'query', title: '数据查询', tool: 'db.run_readonly_query' }],
        { name: 'data.aggregate' }
    );
    assert.match(aggregateMetricsMarkup, /data-pivot-dag-aggregation-metrics/);
    assert.match(aggregateMetricsMarkup, /总金额/);
    assert.match(aggregateMetricsMarkup, /统计方式/);
    assert.match(aggregateMetricsMarkup, /添加统计指标/);
    assert.doesNotMatch(aggregateMetricsMarkup, /pivot-dag-wizard-textarea/);

    const prefixedGroupByMarkup = sandbox.renderWizardField(
        'groupBy',
        { type: ['array', 'string'], items: { type: 'string' } },
        [],
        true,
        [],
        { name: 'mcp.7.data.group_summary' }
    );
    assert.match(prefixedGroupByMarkup, /data-pivot-dag-group-fields/);
    assert.match(prefixedGroupByMarkup, /添加字段/);
    assert.doesNotMatch(prefixedGroupByMarkup, /data-pivot-dag-wizard-reference-picker="groupBy"/);
    assert.doesNotMatch(prefixedGroupByMarkup, /高级：自定义变量或 JSON/);

    const persistedToolGroupByMarkup = sandbox.renderWizardField(
        'groupBy',
        { type: 'string' },
        [],
        true,
        [],
        { name: 'unrelated.tool', fullName: 'mcp.legacy.unrelated.tool', title: '数据分组汇总' },
        [],
        'mcp.42.data.group_summary'
    );
    assert.match(persistedToolGroupByMarkup, /data-pivot-dag-group-fields/);
    assert.match(persistedToolGroupByMarkup, /添加字段/);
    assert.doesNotMatch(persistedToolGroupByMarkup, /取值方式/);

    const titleMatchedGroupByMarkup = sandbox.renderWizardField(
        'groupBy',
        { type: 'string' },
        [],
        true,
        [],
        { name: 'unrelated.tool', title: '分组汇总' },
        [],
        'mcp.cached.unknown',
        '分组汇总'
    );
    assert.match(titleMatchedGroupByMarkup, /data-pivot-dag-group-fields/);
    assert.match(titleMatchedGroupByMarkup, /data-pivot-dag-group-field-add/);
    assert.doesNotMatch(titleMatchedGroupByMarkup, /value="\[\]"/);

    const tableTitleGroupByMarkup = sandbox.renderWizardField(
        'groupBy',
        { type: 'string' },
        [],
        true,
        [],
        { name: 'unrelated.tool', title: '表格分组汇总' },
        [],
        'mcp.cached.unknown',
        '表格分组汇总'
    );
    assert.match(tableTitleGroupByMarkup, /data-pivot-dag-group-fields/);
    assert.match(tableTitleGroupByMarkup, /data-pivot-dag-group-field-add/);

    const aggregationMarkup = sandbox.renderWizardField(
        'aggregation',
        { type: 'string', enum: ['count', 'sum', 'avg'] },
        'count',
        false,
        [],
        { name: 'mcp.7.data.group_summary' }
    );
    assert.doesNotMatch(aggregationMarkup, /任务目标/);
    assert.doesNotMatch(aggregationMarkup, /全部运行输入/);
    assert.doesNotMatch(aggregationMarkup, /推荐引用/);

    const limitMarkup = sandbox.renderWizardField(
        'limit',
        { type: 'number' },
        100,
        false,
        [],
        { name: 'mcp.7.data.group_summary' }
    );
    assert.doesNotMatch(limitMarkup, /取值方式/);
    assert.doesNotMatch(limitMarkup, /推荐引用/);

    const inputDefaultMarkup = sandbox.renderWizardField(
        'defaultValue',
        {},
        '默认订单',
        false,
        [{ id: 'query', title: '数据查询', tool: 'db.run_readonly_query' }],
        { name: 'workflow.input' }
    );
    assert.doesNotMatch(inputDefaultMarkup, /取值方式/);
    assert.doesNotMatch(inputDefaultMarkup, /运行上下文/);

    const typedInputDefaultMarkup = sandbox.renderWizardField(
        'defaultValue',
        {},
        { department: '财务部' },
        false,
        [],
        { name: 'workflow.input' }
    );
    assert.match(typedInputDefaultMarkup, /data-pivot-dag-workflow-input-default/);
    assert.match(typedInputDefaultMarkup, /data-pivot-dag-input-default-editor="boolean"/);
    assert.match(typedInputDefaultMarkup, /data-pivot-dag-input-default-editor="json"/);

    const handoffAgentMarkup = sandbox.renderWizardField(
        'fromAgent',
        { type: 'string' },
        'Researcher',
        true,
        [{ id: 'query', title: '数据查询', tool: 'db.run_readonly_query' }],
        { name: 'agent.handoff' }
    );
    assert.doesNotMatch(handoffAgentMarkup, /取值方式/);

    const notifyBodyMarkup = sandbox.renderWizardField(
        'body',
        { type: 'string' },
        '处理完成：{{nodes.query.output.count}}',
        true,
        [{ id: 'query', title: '数据查询', tool: 'db.run_readonly_query' }],
        { name: 'workflow.notify' }
    );
    assert.match(notifyBodyMarkup, /取值方式/);

    const notifyBindingMarkup = sandbox.renderWizardField(
        'bindingId',
        { type: 'string' },
        '',
        true,
        [],
        { name: 'workflow.notify' }
    );
    assert.match(notifyBindingMarkup, /data-pivot-dag-channel-binding-picker/);
    assert.match(notifyBindingMarkup, /刷新可用渠道/);
    assert.doesNotMatch(notifyBindingMarkup, /取值方式/);

    const credentialMarkup = sandbox.renderWizardField(
        'credentialSecret',
        { type: 'string' },
        '',
        false,
        [],
        { name: 'agent.http' }
    );
    assert.match(credentialMarkup, /data-pivot-dag-credential-picker/);
    assert.match(credentialMarkup, /刷新凭据/);
    assert.doesNotMatch(credentialMarkup, /取值方式/);

    const chartGroupMarkup = sandbox.renderWizardField(
        'groupBy',
        { type: 'string' },
        '',
        false,
        [{ id: 'rows', title: '数据行', tool: 'data.filter_rows' }],
        { name: 'viz.build_chart' }
    );
    assert.match(chartGroupMarkup, /data-pivot-dag-data-field-picker/);
    assert.match(chartGroupMarkup, /请选择上游数据字段/);

    const fieldHelpers = fs.readFileSync(path.join(__dirname, '..', 'client', 'chat', 'dag-toolbar-fields.js'), 'utf8');
    assert.match(fieldHelpers, /'workflow\.notify': \['platform'\]/);
    assert.match(fieldHelpers, /'workflow\.output': \['name', 'value', 'presentation'/);
    assert.doesNotMatch(fieldHelpers, /'workflow\.output': \['format', 'presentation'\]/);

    const reportMarkup = sandbox.renderWizardField(
        'path',
        { type: 'string' },
        '2026-09/日报.xlsx',
        true,
        [],
        { name: 'reports.query_table' }
    );
    assert.match(reportMarkup, /data-pivot-dag-report-path-picker/);
    assert.match(reportMarkup, /读取可访问文件/);
    assert.match(reportMarkup, /data-pivot-dag-report-path-custom/);

    const reportSheetMarkup = sandbox.renderWizardField(
        'sheet',
        { type: 'string' },
        '明细',
        false,
        [],
        { name: 'reports.query_table' }
    );
    assert.match(reportSheetMarkup, /data-pivot-dag-report-sheet-picker/);
    assert.match(reportSheetMarkup, /读取工作表和字段/);
    assert.match(reportSheetMarkup, /pivot-dag-report-sheet-manual is-visible/);

    const compareSheetMarkup = sandbox.renderWizardField(
        'sheet',
        { type: 'string' },
        '',
        false,
        [],
        { name: 'reports.compare_files' }
    );
    assert.match(compareSheetMarkup, /读取共同工作表/);

    const reportColumnsMarkup = sandbox.renderWizardField(
        'columns',
        { type: 'array', items: { type: 'string' } },
        ['部门'],
        false,
        [],
        { name: 'reports.query_table' }
    );
    assert.match(reportColumnsMarkup, /data-pivot-dag-report-columns="1"/);
    assert.match(reportColumnsMarkup, /data-pivot-dag-report-columns-list/);

    const reportFiltersMarkup = sandbox.renderWizardField(
        'filters',
        { type: 'object' },
        {},
        false,
        [],
        { name: 'reports.query_table' }
    );
    assert.match(reportFiltersMarkup, /data-pivot-dag-report-filter-fields-list/);
    assert.match(reportFiltersMarkup, /data-pivot-dag-report-filter-fields-hint/);

    const reportAssist = fs.readFileSync(path.join(__dirname, '..', 'client', 'chat', 'dag-wizard-report-assist.js'), 'utf8');
    assert.match(reportAssist, /请先选择一份具体的授权报表文件/);
    assert.match(reportAssist, /reports\.read_file_summary/);
    assert.match(reportAssist, /report-filter-fields-list/);
    assert.match(reportAssist, /共同工作表/);

    const specialFields = fs.readFileSync(path.join(__dirname, '..', 'client', 'chat', 'dag-wizard-special-fields.js'), 'utf8');
    assert.match(specialFields, /bindConditionCompareField/);
    assert.match(specialFields, /bindBrowserTargetVisibility/);
    assert.match(specialFields, /bindCredentialPicker/);
    assert.match(specialFields, /bindOutputPresentationFields/);
    assert.match(specialFields, /bindWorkflowInputDefault/);

    const artifactMarkup = sandbox.renderWizardField(
        'artifactId',
        { type: 'integer' },
        42,
        true,
        [],
        { name: 'artifact.render' }
    );
    assert.match(artifactMarkup, /data-pivot-dag-artifact-picker/);
    assert.match(artifactMarkup, /读取可用产物/);
    assert.match(artifactMarkup, /data-pivot-dag-artifact-custom/);

    const approvalLevelsMarkup = sandbox.renderWizardField(
        'approvalLevels',
        { type: 'array', items: { type: 'object' } },
        [{ title: '直属负责人', mode: 'any', approverUserIds: [1001], approverUnits: ['财务部'] }],
        false,
        [{ id: 'policy', title: '审批策略', tool: 'agent.llm' }],
        { name: 'workflow.approval' }
    );
    assert.match(approvalLevelsMarkup, /data-pivot-dag-approval-levels/);
    assert.match(approvalLevelsMarkup, /第 1 级审批/);
    assert.match(approvalLevelsMarkup, /data-pivot-dag-approval-level-user-ids/);
    assert.doesNotMatch(approvalLevelsMarkup, /pivot-dag-wizard-textarea/);

    const handoffFindingsMarkup = sandbox.renderWizardField(
        'findings',
        { type: 'array', items: { type: 'string' } },
        ['已完成核验'],
        false,
        [],
        { name: 'agent.handoff' }
    );
    assert.match(handoffFindingsMarkup, /data-pivot-dag-tag-list/);
    assert.match(handoffFindingsMarkup, /添加条目/);
    assert.doesNotMatch(handoffFindingsMarkup, /pivot-dag-wizard-textarea/);

    const browserTargetMarkup = sandbox.renderWizardField(
        'target',
        { type: 'object' },
        { role: 'button', name: '提交', exact: true },
        false,
        [{ id: 'page', title: '页面解析', tool: 'agent.browser' }],
        { name: 'agent.browser' }
    );
    assert.match(browserTargetMarkup, /data-pivot-dag-browser-target/);
    assert.match(browserTargetMarkup, /无障碍角色和名称/);
    assert.match(browserTargetMarkup, /data-pivot-dag-browser-target-role-input/);
    assert.doesNotMatch(browserTargetMarkup, /pivot-dag-wizard-textarea/);
});

test('数据契约编辑器使用统一表单控件，并将编辑入口放在契约标题操作区', () => {
    const inspector = fs.readFileSync(path.join(__dirname, '..', 'client', 'chat', 'dag-inspector.js'), 'utf8');
    const css = fs.readFileSync(path.join(__dirname, '..', 'client', 'chat', 'styles', 'workspaces', 'agent', 'agent-dag-drawer-inspector.css'), 'utf8');

    assert.match(inspector, /class="form-input" data-pivot-schema-root-type/);
    assert.match(inspector, /class="form-input" data-pivot-schema-item-type/);
    assert.match(inspector, /pivot-dag-contract-edit-action/);
    assert.match(inspector, /pivot-dag-contract-pane pivot-dag-contract-output-pane/);
    assert.match(css, /\.pivot-dag-contract-edit-action\s*\{[\s\S]*?position:\s*absolute;/);
    assert.match(css, /\.pivot-dag-contract-editor-body\s*\{[\s\S]*?grid-template-columns:\s*minmax\(260px, 0\.78fr\) minmax\(440px, 1\.22fr\);/);
    assert.match(css, /\.pivot-dag-contract-editor \.pivot-dag-input-head\s*\{[\s\S]*?margin-inline:\s*18px;/);
    assert.match(css, /\.pivot-dag-contract-editor \.pivot-dag-input-head\s*\{[\s\S]*?text-align:\s*left;/);
    assert.match(css, /\.pivot-dag-contract-editor\s*\{[\s\S]*?text-align:\s*left;/);
    assert.match(css, /\.pivot-dag-contract-editor \.pivot-dag-schema-field \.form-input\s*\{[\s\S]*?min-height:\s*34px;/);
});

test('编辑期可运行性检查能定位节点缺失必填参数和重复运行参数声明', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'client', 'chat', 'dag-readiness.js'), 'utf8');
    const sandbox = {
        window: { Pivot: { exposeModule: (_name, value) => { sandbox.api = value; } } }
    };
    vm.createContext(sandbox);
    vm.runInContext(source, sandbox);
    const report = sandbox.api.inspectDagReadiness([
        { id: 'group', title: '分组', tool: 'mcp.8.data.group_summary', input: { rows: '{{nodes.query.output.rows}}', groupBy: [] } },
        { id: 'notify', title: '通知', tool: 'workflow.notify', input: { body: '{{goal}}' } },
        { id: 'input_a', title: '参数 A', tool: 'workflow.input', input: { name: 'orderNo' } },
        { id: 'input_b', title: '参数 B', tool: 'workflow.input', input: { name: 'orderNo' } },
        { id: 'output_a', title: '交付 A', tool: 'workflow.output', input: { value: '{{goal}}' } },
        { id: 'output_b', title: '交付 B', tool: 'workflow.output', input: { value: '{{goal}}' } }
    ], [
        { fullName: 'mcp.8.data.group_summary', inputSchema: { required: ['rows', 'groupBy'] } },
        { name: 'workflow.notify', input_schema: { required: ['bindingId', 'body'] } },
        { name: 'workflow.input', input_schema: { required: ['name'] } },
        { name: 'workflow.output', input_schema: { required: ['name', 'value'], properties: { name: { default: 'result' } } } }
    ]);
    assert.equal(report.valid, false);
    assert.ok(report.issues.some(issue => issue.nodeId === 'group' && issue.field === 'groupBy'));
    assert.ok(report.issues.some(issue => issue.nodeId === 'notify' && issue.field === 'bindingId'));
    assert.ok(report.issues.some(issue => issue.nodeId === 'input_b' && issue.type === 'duplicate_workflow_input'));
    assert.ok(report.issues.some(issue => issue.nodeId === 'output_b' && issue.type === 'duplicate_workflow_output'));

    const exclusive = sandbox.api.inspectDagReadiness([
        { id: 'condition', title: '判断', tool: 'workflow.condition', input: { operator: 'not_empty' } },
        { id: 'yes', title: '成功交付', tool: 'workflow.output', input: { value: '{{goal}}' } },
        { id: 'no', title: '失败交付', tool: 'workflow.output', input: { value: '{{goal}}' } }
    ], [
        { name: 'workflow.condition', input_schema: { properties: { operator: { default: 'not_empty' } } } },
        { name: 'workflow.output', input_schema: { required: ['name', 'value'], properties: { name: { default: 'result' } } } }
    ], [
        { from: 'condition', to: 'yes', route: 'true' },
        { from: 'condition', to: 'no', route: 'false' }
    ]);
    assert.ok(!exclusive.issues.some(issue => issue.type === 'duplicate_workflow_output'));
});

test('编辑期可运行性检查覆盖常见节点的语义配置和 schema 边界', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'client', 'chat', 'dag-readiness.js'), 'utf8');
    const sandbox = {
        window: { Pivot: { exposeModule: (_name, value) => { sandbox.api = value; } } }
    };
    vm.createContext(sandbox);
    vm.runInContext(source, sandbox);
    const report = sandbox.api.inspectDagReadiness([
        { id: 'summary', title: '汇总', tool: 'data.group_summary', input: { rows: '{{nodes.query.output.rows}}', groupBy: [''], aggregation: 'sum' } },
        { id: 'aggregate', title: '整体汇总', tool: 'data.aggregate', input: { rows: '{{nodes.query.output.rows}}', metrics: [{ aggregation: 'sum', alias: '总金额' }] } },
        { id: 'route', title: '判断', tool: 'workflow.condition', input: { operator: 'equals', value: '' } },
        { id: 'browser', title: '点击', tool: 'agent.browser', input: { url: 'https://example.com', action: 'click' } },
        { id: 'input', title: '输入', tool: 'workflow.input', input: { name: '9-invalid' } },
        { id: 'search', title: '检索', tool: 'rag.search', input: { query: '合同', topK: 12 } },
        { id: 'dynamic', title: '动态数量', tool: 'rag.search', input: { query: '合同', topK: '{{inputs.topK}}' } }
    ], [
        { name: 'data.group_summary', input_schema: { required: ['rows', 'groupBy'], properties: { rows: { type: 'array' }, groupBy: { type: 'array', minItems: 1 }, aggregation: { type: 'string', enum: ['count', 'sum'] }, valueField: { type: 'string' } } } },
        { name: 'data.aggregate', input_schema: { required: ['rows'], properties: { rows: { type: 'array' }, metrics: { type: 'array' } } } },
        { name: 'workflow.condition', input_schema: { properties: { operator: { type: 'string', enum: ['equals', 'not_empty'] }, value: {}, compareTo: {} } } },
        { name: 'agent.browser', input_schema: { required: ['url'], properties: { url: { type: 'string' }, action: { type: 'string', enum: ['inspect', 'click'] }, target: { type: 'object' } } } },
        { name: 'workflow.input', input_schema: { required: ['name'], properties: { name: { type: 'string' } } } },
        { name: 'rag.search', input_schema: { required: ['query'], properties: { query: { type: 'string' }, topK: { type: 'integer', minimum: 1, maximum: 10 } } } }
    ]);
    assert.equal(report.valid, false);
    assert.ok(report.issues.some(issue => issue.nodeId === 'summary' && issue.type === 'missing_group_fields'));
    assert.ok(report.issues.some(issue => issue.nodeId === 'summary' && issue.type === 'missing_aggregation_field'));
    assert.ok(report.issues.some(issue => issue.nodeId === 'aggregate' && issue.type === 'missing_metric_field'));
    assert.ok(report.issues.some(issue => issue.nodeId === 'route' && issue.type === 'missing_condition_value'));
    assert.ok(report.issues.some(issue => issue.nodeId === 'route' && issue.type === 'missing_condition_compare_to'));
    assert.ok(report.issues.some(issue => issue.nodeId === 'browser' && issue.type === 'missing_browser_target'));
    assert.ok(report.issues.some(issue => issue.nodeId === 'input' && issue.type === 'invalid_workflow_input_name'));
    assert.ok(report.issues.some(issue => issue.nodeId === 'search' && issue.type === 'number_too_large'));
    assert.ok(!report.issues.some(issue => issue.nodeId === 'dynamic' && issue.field === 'topK'));
});

test('受控通知绑定在检查器中使用可用渠道下拉框', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'client', 'chat', 'dag-inspector-special-fields.js'), 'utf8');
    const sandbox = {};
    vm.createContext(sandbox);
    vm.runInContext(`${source}\nthis.renderField = renderDagInspectorChannelBindingField;`, sandbox);
    const markup = sandbox.renderField({
        value: 'channel_1',
        bindings: [
            { id: 'channel_1', status: 'active', channelKey: '日报群', config: { platform: 'wecom' } },
            { id: 'channel_2', status: 'paused', channelKey: '停用群', config: { platform: 'feishu' } }
        ],
        escapeAttr: value => String(value),
        escapeHtml: value => String(value)
    });
    assert.match(markup, /<select class="form-input"/);
    assert.match(markup, /企业微信 · 日报群/);
    assert.doesNotMatch(markup, /停用群/);
    assert.match(markup, /平台由所选绑定自动确定/);
});

test('检查器就地显示节点配置问题，并让条件判断使用中文且按需显示比较值', () => {
    const inspector = fs.readFileSync(path.join(__dirname, '..', 'client', 'chat', 'dag-inspector.js'), 'utf8');
    const css = fs.readFileSync(path.join(__dirname, '..', 'client', 'chat', 'styles', 'workspaces', 'agent', 'agent-dag-drawer-inspector.css'), 'utf8');

    assert.match(inspector, /getReadinessIssues/);
    assert.match(inspector, /pivot-dag-config-issues/);
    assert.match(inspector, /\['equals', '等于'\]/);
    assert.match(inspector, /key === 'compareTo' && !comparisonNeeded/);
    assert.match(inspector, /replace\(\/\^mcp\\\./);
    assert.match(css, /\.pivot-dag-config-issues\s*\{/);
});

test('条件比较值和工作流输出的按需字段在切换模式后无需重新打开向导', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'client', 'chat', 'dag-wizard-input.js'), 'utf8');

    assert.match(source, /shortName === 'workflow\.output' && \['table_title', 'table_columns', 'file_ref'\]\.includes\(key\)\) return true/);
    assert.match(source, /shortName === 'workflow\.condition' && key === 'compare_to'\) return true/);
});
