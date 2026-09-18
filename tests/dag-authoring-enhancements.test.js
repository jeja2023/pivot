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
    assert.match(css, /\.pivot-dag-contract-editor \.pivot-dag-schema-field \.form-input\s*\{[\s\S]*?min-height:\s*34px;/);
});
