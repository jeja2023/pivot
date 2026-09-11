const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const { normalizeDagSpec } = require('../server/services/agent-validators');
const { applySqlLimit } = require('../server/services/database-mcp/sql-governance');

function loadDagCore() {
    const source = fs.readFileSync(path.join(__dirname, '..', 'client', 'chat', 'dag-core.js'), 'utf8');
    const sandbox = {
        window: { Pivot: { legacy: { PivotSafeHtml: null, _cachedAgentModels: [] } } },
        document: { getElementById: () => null },
        currentUser: null,
        Event: class Event {}
    };
    vm.createContext(sandbox);
    vm.runInContext(source, sandbox, { filename: 'dag-core.js' });
    return sandbox;
}

function loadQueryBuilder() {
    const source = fs.readFileSync(path.join(__dirname, '..', 'client', 'chat', 'dag-query-builder.js'), 'utf8');
    const sandbox = {};
    vm.createContext(sandbox);
    vm.runInContext(source, sandbox, { filename: 'dag-query-builder.js' });
    return vm.runInContext('({ buildVisualSqlQuery, normalizeVisualSqlQueryBuilder, queryBuilderTemporalKind, queryBuilderTemporalInputValue, queryBuilderTemporalSqlValue })', sandbox);
}

test('visual SQL builder generates bounded dialect-safe readonly queries', () => {
    const { buildVisualSqlQuery } = loadQueryBuilder();
    const result = buildVisualSqlQuery({
        table: 'customers',
        columns: ['id', 'name', 'status'],
        filters: [{ field: 'status', operator: 'eq', value: "active' OR 1=1" }],
        sortBy: 'name',
        sortOrder: 'asc',
        limit: 40
    }, 'sqlite');
    assert.equal(result.issues.length, 0);
    assert.match(result.sql, /^SELECT "id", "name", "status"/);
    assert.match(result.sql, /WHERE "status" = 'active'' OR 1=1'/);
    assert.match(result.sql, /ORDER BY "name" ASC/);
    assert.match(result.sql, /LIMIT 40$/);

    const invalid = buildVisualSqlQuery({ table: 'customers', columns: ['profile..name'] }, 'sqlite');
    assert.equal(invalid.sql, '');
    assert.match(invalid.issues.join(' '), /字段/);

    const invalidSort = buildVisualSqlQuery({ table: 'customers', columns: ['id'], sortBy: '__metric__' }, 'sqlite');
    assert.equal(invalidSort.sql, '');
    assert.match(invalidSort.issues.join(' '), /普通查询不能按统计值/);
});

test('visual SQL builder supports grouped aggregation and SQL Server limits', () => {
    const { buildVisualSqlQuery } = loadQueryBuilder();
    const result = buildVisualSqlQuery({
        schema: 'dbo',
        table: 'orders',
        aggregation: 'count',
        groupBy: 'status',
        sortBy: '__metric__',
        sortOrder: 'desc',
        limit: 20
    }, 'sqlserver');
    assert.equal(result.issues.length, 0);
    assert.match(result.sql, /^SELECT TOP \(20\) \[status\] AS \[group_value\], COUNT\(\*\) AS \[metric_value\]/);
    assert.match(result.sql, /FROM \[dbo\]\.\[orders\]/);
    assert.match(result.sql, /GROUP BY \[status\]/);
    assert.match(result.sql, /ORDER BY \[metric_value\] DESC$/);
    assert.equal(applySqlLimit(result.sql, 20, 'sqlserver'), result.sql);
    assert.equal(
        applySqlLimit('SELECT id FROM customers', 20, 'sqlserver'),
        'SELECT TOP (20) id FROM customers'
    );
});

test('visual SQL builder supports OR filters and temporal field controls', () => {
    const {
        buildVisualSqlQuery,
        normalizeVisualSqlQueryBuilder,
        queryBuilderTemporalKind,
        queryBuilderTemporalInputValue,
        queryBuilderTemporalSqlValue
    } = loadQueryBuilder();
    const normalized = normalizeVisualSqlQueryBuilder({ queryBuilder: {
        filter_relation: 'OR',
        filters: [{ field: 'created_at', field_type: 'timestamp without time zone', operator: 'gte', value: '2026-08-04 13:44:28' }]
    } });
    assert.equal(normalized.filterRelation, 'or');
    assert.equal(normalized.filters[0].fieldType, 'timestamp without time zone');
    assert.equal(queryBuilderTemporalKind('timestamp without time zone'), 'datetime');
    assert.equal(queryBuilderTemporalKind('DATE'), 'date');
    assert.equal(queryBuilderTemporalKind('time(6)'), 'time');
    assert.equal(queryBuilderTemporalInputValue('2026-08-04 13:44:28', 'datetime'), '2026-08-04T13:44:28');
    assert.equal(queryBuilderTemporalSqlValue('2026-08-04T13:44', 'timestamp'), '2026-08-04 13:44:00');

    const result = buildVisualSqlQuery({
        table: 'orders',
        columns: ['id', 'created_at'],
        filterRelation: 'or',
        filters: [
            { field: 'created_at', fieldType: 'datetime', operator: 'gte', value: '2026-08-01T00:00:00' },
            { field: 'created_at', fieldType: 'datetime', operator: 'lt', value: '2026-09-01T00:00:00' }
        ]
    }, 'mysql');
    assert.equal(result.issues.length, 0);
    assert.match(result.sql, /WHERE `created_at` >= '2026-08-01 00:00:00'\n  OR `created_at` < '2026-09-01 00:00:00'/);
    assert.equal(result.config.filterRelation, 'or');
});

test('visual SQL builder supports relative filters against the current day', () => {
    const { buildVisualSqlQuery } = loadQueryBuilder();
    const sqlite = buildVisualSqlQuery({
        table: 'orders',
        columns: ['id', 'created_at'],
        filters: [{ field: 'created_at', fieldType: 'datetime', operator: 'afterToday' }]
    }, 'sqlite');
    assert.equal(sqlite.issues.length, 0);
    assert.match(sqlite.sql, /WHERE date\("created_at"\) > date\('now', '\+8 hours'\)/);

    const postgres = buildVisualSqlQuery({
        table: 'orders',
        columns: ['id', 'created_at'],
        filters: [{ field: 'created_at', fieldType: 'timestamp with time zone', operator: 'beforeToday' }]
    }, 'postgres');
    assert.equal(postgres.issues.length, 0);
    assert.match(postgres.sql, /WHERE CAST\("created_at" AS date\) < CURRENT_DATE/);

    const mysql = buildVisualSqlQuery({
        table: 'orders',
        columns: ['id', 'created_at'],
        filters: [{ field: 'created_at', fieldType: 'datetime', operator: 'today' }]
    }, 'mysql');
    assert.equal(mysql.issues.length, 0);
    assert.match(mysql.sql, /WHERE DATE\(`created_at`\) = CURRENT_DATE/);

    const sqlserver = buildVisualSqlQuery({
        table: 'orders',
        columns: ['id', 'created_at'],
        filters: [{ field: 'created_at', fieldType: 'datetime2', operator: 'afterToday' }]
    }, 'sqlserver');
    assert.equal(sqlserver.issues.length, 0);
    assert.match(sqlserver.sql, /WHERE CAST\(\[created_at\] AS date\) > CAST\(GETDATE\(\) AS date\)/);

    const unsupported = buildVisualSqlQuery({
        table: 'orders',
        columns: ['id', 'created_at'],
        filters: [{ field: 'created_at', fieldType: 'time', operator: 'afterToday' }]
    }, 'sqlite');
    assert.equal(unsupported.sql, '');
    assert.match(unsupported.issues.join(' '), /只有日期或日期时间字段支持/);
});

test('normalizeDagSpec preserves layout and ignores legacy primary LLM metadata', () => {
    const normalized = normalizeDagSpec({
        primaryLlmNodeId: 'llm_final',
        layout: {
            source: { x: 36.25, y: 44 },
            llm_first: { x: 310, y: 20 },
            llm_final: { x: 580, y: 120 }
        },
        nodes: [
            { id: 'source', tool: 'rag.search' },
            { id: 'llm_first', tool: 'agent.llm', input: { model: 'model-a', prompt: '{{goal}}' } },
            { id: 'llm_final', tool: 'agent.llm', input: { model: 'model-b', maxSteps: 31, prompt: '{{goal}}' } }
        ]
    });

    assert.deepEqual(normalized.layout, {
        source: { x: 36.25, y: 44 },
        llm_first: { x: 310, y: 20 },
        llm_final: { x: 580, y: 120 }
    });
    assert.equal(Object.hasOwn(normalized, 'primaryLlmNodeId'), false);
    assert.deepEqual(normalized.nodes.map(node => node.id), ['source', 'llm_first', 'llm_final']);
});

test('normalizeDagSpec preserves negative coordinates for the infinite workflow canvas', () => {
    const normalized = normalizeDagSpec({
        layout: {
            source: { x: -320.5, y: -96.25 },
            next: { x: 180, y: 64 }
        },
        nodes: [
            { id: 'source', tool: 'workflow.input' },
            { id: 'next', tool: 'agent.llm', input: { model: 'model-a', prompt: '{{goal}}' } }
        ]
    });

    assert.deepEqual(normalized.layout, {
        source: { x: -320.5, y: -96.25 },
        next: { x: 180, y: 64 }
    });
});

test('DAG core migrates legacy coordinates and keeps layout separate from nodes', () => {
    const core = loadDagCore();
    const internal = core.ensureDefaults({
        primaryLlmNodeId: 'llm',
        nodes: [
            { id: 'source', tool: 'rag.search', input: {}, dependsOn: [], _x: 41, _y: 53 },
            {
                id: 'llm',
                tool: 'agent.llm',
                input: { model: 'model-a', prompt: '{{nodes.source.output}}' },
                dependsOn: ['source'],
                _x: 333,
                _y: 127
            }
        ]
    });
    const serialized = JSON.parse(JSON.stringify(core.serialize(internal)));

    assert.deepEqual(serialized.layout, {
        source: { x: 41, y: 53 },
        llm: { x: 333, y: 127 }
    });
    assert.equal(Object.hasOwn(serialized, 'primaryLlmNodeId'), false);
    assert.equal(Object.hasOwn(serialized.nodes[0], '_x'), false);
    assert.equal(Object.hasOwn(serialized.nodes[0], '_y'), false);
});

test('DAG core retains negative node positions when serializing manual layouts', () => {
    const core = loadDagCore();
    const internal = core.ensureDefaults({
        layout: { source: { x: -240, y: -120 } },
        nodes: [{ id: 'source', tool: 'workflow.input', input: {}, dependsOn: [] }]
    });

    const serialized = JSON.parse(JSON.stringify(core.serialize(internal)));
    assert.deepEqual(serialized.layout, { source: { x: -240, y: -120 } });
});

test('DAG core keeps a new workflow empty until the user adds a node', () => {
    const core = loadDagCore();
    const internal = core.ensureDefaults({ nodes: [] });
    const serialized = JSON.parse(JSON.stringify(core.serialize(internal)));

    assert.deepEqual(serialized.nodes, []);
    assert.deepEqual(serialized.layout, {});
});

test('LLM output mode keeps the default output contract aligned', () => {
    const core = loadDagCore();
    const jsonNode = { tool: 'agent.llm', input: { responseFormat: 'json' }, outputSchema: { type: 'string' } };
    core.syncLlmOutputContract(jsonNode, jsonNode.input);
    assert.equal(JSON.stringify(jsonNode.outputSchema), '{}');

    const textNode = { tool: 'agent.llm', input: { responseFormat: 'text' }, outputSchema: {} };
    core.syncLlmOutputContract(textNode, textNode.input);
    assert.equal(JSON.stringify(textNode.outputSchema), JSON.stringify({ type: 'string' }));
});

test('incremental node placement leaves existing manual positions unchanged', () => {
    const core = loadDagCore();
    const internal = core.ensureDefaults({
        layout: {
            source: { x: 80, y: 90 },
            llm: { x: 420, y: 210 }
        },
        nodes: [
            { id: 'source', tool: 'rag.search', input: {}, dependsOn: [] },
            { id: 'llm', tool: 'agent.llm', input: { model: 'model-a', prompt: '{{goal}}' }, dependsOn: [] }
        ]
    });
    const before = internal.nodes.map(node => ({ id: node.id, x: node._x, y: node._y }));
    const added = { id: 'chart', tool: 'viz.build_chart', dependsOn: ['source'] };

    internal.nodes.push(added);
    core.placeNewNode(internal.nodes, added, 'source');

    assert.deepEqual(
        internal.nodes.slice(0, 2).map(node => ({ id: node.id, x: node._x, y: node._y })),
        before
    );
    assert.equal(added._x > internal.nodes[0]._x, true);
    assert.equal(Number.isFinite(added._y), true);

    const reloaded = core.ensureDefaults({
        layout: { source: { x: 80, y: 90 } },
        nodes: [
            { id: 'source', tool: 'rag.search', input: {}, dependsOn: [] },
            {
                id: 'llm',
                tool: 'agent.llm',
                input: { model: 'model-a', prompt: '{{nodes.source.output}}' },
                dependsOn: ['source']
            }
        ]
    });
    assert.deepEqual(
        { x: reloaded.nodes[0]._x, y: reloaded.nodes[0]._y },
        { x: 80, y: 90 }
    );
    assert.equal(reloaded.nodes[1]._x > reloaded.nodes[0]._x, true);
});

test('editor dependency rules are independent from canvas direction', () => {
    const editor = fs.readFileSync(path.join(__dirname, '..', 'client', 'chat', 'agents-dag-editor.js'), 'utf8');
    const interaction = fs.readFileSync(path.join(__dirname, '..', 'client', 'chat', 'dag-interaction.js'), 'utf8');

    assert.doesNotMatch(editor, /isForwardDependency/);
    assert.doesNotMatch(interaction, /isForwardDependency/);
    assert.match(editor, /!wouldCreateCycle\(candidate\.id, node\?\.id\)/);
    assert.match(interaction, /ctx\.wouldCreateCycle\(connecting\.fromId, targetId\)/);
    assert.match(interaction, /node\._x = clampDagCoordinate\(origin\.x \+ dx\)/);
    assert.match(interaction, /node\._y = clampDagCoordinate\(origin\.y \+ dy\)/);
    assert.match(interaction, /event\.button === 1 \|\| spacePressed/);
    assert.match(interaction, /const onKeyUp = event =>/);
    assert.match(interaction, /ctx\.zoomAt\(event, factor\)/);
    assert.doesNotMatch(interaction, /const nextX = Math\.max\(0,/);
});

test('DAG editor supports infinite canvas coordinates and explicit view controls', () => {
    const editor = fs.readFileSync(path.join(__dirname, '..', 'client', 'chat', 'agents-dag-editor.js'), 'utf8');
    const core = fs.readFileSync(path.join(__dirname, '..', 'client', 'chat', 'dag-core.js'), 'utf8');
    const toolbar = fs.readFileSync(path.join(__dirname, '..', 'client', 'chat', 'dag-toolbar.js'), 'utf8');
    const minimap = fs.readFileSync(path.join(__dirname, '..', 'client', 'chat', 'styles', 'workspaces', 'agent', 'agent-dag-minimap.css'), 'utf8');

    assert.match(core, /const DAG_COORDINATE_MIN = -100000/);
    assert.match(core, /function clampDagCoordinate/);
    assert.doesNotMatch(core, /x: Math\.max\(0, node\._x\)/);
    assert.match(editor, /const minX = Math\.min\(0, bounds\.minX - PADDING\)/);
    assert.match(editor, /const zoomAt = \(event, factor\) =>/);
    assert.match(editor, /const resetView = \(\) =>/);
    assert.match(editor, /bounds\.minX \+ bounds\.width \/ 2 - vbW \/ 2/);
    assert.match(editor, /bounds\.minY \+ bounds\.height \/ 2 - vbH \/ 2/);
    assert.match(editor, /pivot-dag-viewport-controls/);
    assert.match(editor, /zoomIn: \(\) => zoomAt\(null, 1\.18\)/);
    assert.match(toolbar, /makeButton\('初始视图'/);
    assert.match(minimap, /\.pivot-dag-viewport-controls/);
});

test('workflow editor exposes the embedded page node and its safe result renderer', () => {
    const presets = fs.readFileSync(path.join(__dirname, '..', 'client', 'chat', 'dag-node-presets.js'), 'utf8');
    const renderer = fs.readFileSync(path.join(__dirname, '..', 'client', 'chat', 'agent-run-step-renderers.js'), 'utf8');
    const embedRenderer = fs.readFileSync(path.join(__dirname, '..', 'client', 'chat', 'agent-run-embed-renderers.js'), 'utf8');
    const workflowRuntime = fs.readFileSync(path.join(__dirname, '..', 'server', 'services', 'agent-tools-workflow-nodes.js'), 'utf8');

    assert.match(presets, /title: '嵌入页面'/);
    assert.match(presets, /toolName: 'workflow\.embed_page'/);
    assert.match(workflowRuntime, /['"]workflow\.embed_page['"]/);
    assert.match(workflowRuntime, /type: 'embedded_page'/);
    assert.match(workflowRuntime, /type: 'embedded_image'/);
    assert.match(workflowRuntime, /type: 'embedded_video'/);
    assert.match(workflowRuntime, /type: 'embedded_audio'/);
    assert.match(workflowRuntime, /type: 'link_card'/);
    assert.match(workflowRuntime, /type: 'embed_code'/);
    assert.match(renderer, /agentWorkflowEmbedCodeMarkup/);
    assert.match(embedRenderer, /agentWorkflowEmbeddedPageMarkup/);
    assert.match(embedRenderer, /agentWorkflowEmbedCodeMarkup/);
    assert.match(embedRenderer, /sandbox="allow-forms allow-modals allow-popups allow-presentation allow-scripts"/);
});

test('visual SQL wizard styles are bundled with agent workspaces', () => {
    const workspaceCss = fs.readFileSync(path.join(__dirname, '..', 'client', 'chat', 'chat.workspace.agent.entry.css'), 'utf8');
    const wizard = fs.readFileSync(path.join(__dirname, '..', 'client', 'chat', 'dag-wizard.js'), 'utf8');

    assert.match(workspaceCss, /agent-dag-query-builder\.css/);
    assert.doesNotMatch(workspaceCss, /workspaces\/agent\.css/);
    assert.match(wizard, /pivot-dag-wizard-form\$\{isVisualSqlQuery \? ' is-visual-sql' : ''\}/);
});

test('visual SQL mode switch keeps the clicked query mode', () => {
    const queryBuilder = fs.readFileSync(path.join(__dirname, '..', 'client', 'chat', 'dag-query-builder.js'), 'utf8');

    assert.match(queryBuilder, /const updatePreview = \(modeOverride = ''\) =>/);
    assert.match(queryBuilder, /if \(modeOverride\) \{\s+config\.mode = modeOverride;\s+\}/);
    assert.match(queryBuilder, /config\.mode = modeButton\.dataset\.pivotDagQueryMode === 'advanced' \? 'advanced' : 'visual';[\s\S]+updatePreview\(config\.mode\);/);
});

test('workflow node presets are organized into approved 6 business categories', () => {
    const presetsSource = fs.readFileSync(path.join(__dirname, '..', 'client', 'chat', 'dag-node-presets.js'), 'utf8');
    const sandbox = {
        window: {
            Pivot: {
                moduleApi: () => ({}),
                exposeModule: (name, mod) => { sandbox.exported = mod; }
            }
        }
    };
    vm.createContext(sandbox);
    vm.runInContext(presetsSource, sandbox, { filename: 'dag-node-presets.js' });
    const groups = JSON.parse(JSON.stringify(sandbox.exported.groups));
    const groupNames = groups.map(g => g.group);

    assert.deepEqual(groupNames, [
        '起始与交付',
        'AI 与智能体',
        '知识与检索',
        '数据与文档',
        '流程与控制',
        '呈现与多媒体'
    ]);

    const totalPresets = groups.reduce((sum, g) => sum + g.items.length, 0);
    assert.equal(totalPresets, 43);

    // 验证各分类预设节点数量
    const counts = Object.fromEntries(groups.map(g => [g.group, g.items.length]));
    assert.equal(counts['起始与交付'], 3);
    assert.equal(counts['AI 与智能体'], 4);
    assert.equal(counts['知识与检索'], 6);
    assert.equal(counts['数据与文档'], 11);
    assert.equal(counts['流程与控制'], 9);
    assert.equal(counts['呈现与多媒体'], 10);
});
