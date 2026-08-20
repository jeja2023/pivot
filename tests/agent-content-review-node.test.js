const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const { getBuiltInToolDefinitions } = require('../server/services/agent-tools');

function loadDagCore(modelState = {}) {
    const source = fs.readFileSync(path.join(__dirname, '..', 'client', 'chat', 'dag-core.js'), 'utf8');
    const sandbox = {
        window: {
            PivotSafeHtml: null,
            _cachedAgentModels: modelState.agent || [],
            _cachedModels: modelState.chat || [],
            isSelectableModelForCurrentUser: model => !model.user_id || String(model.user_id) === '7'
        },
        document: { getElementById: () => null },
        currentUser: { id: 7 },
        console
    };
    vm.createContext(sandbox);
    vm.runInContext(`${source}\nglobalThis.__dagModelApi = { workflowModelOptions, defaultWorkflowModelId };`, sandbox);
    return sandbox.__dagModelApi;
}

function loadWizardFieldRenderer(models = []) {
    const source = fs.readFileSync(path.join(__dirname, '..', 'client', 'chat', 'dag-wizard-fields.js'), 'utf8');
    const escapeHtml = value => String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    const sandbox = {
        window: { Pivot: { moduleApi: () => ({ listWorkflows: () => [] }) } },
        console,
        normalizeSchemaType: schema => String(Array.isArray(schema?.type) ? schema.type[0] : (schema?.type || 'string')),
        friendlySchemaTypeLabel: () => '文本',
        friendlyFieldLabel: name => name,
        friendlyFieldDescription: () => '',
        friendlyFieldPlaceholder: () => '',
        isDatabaseConnectionField: () => false,
        toolValue: tool => tool?.fullName || tool?.name || '',
        normalizeFieldKey: name => String(name || '').replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase(),
        formatWizardFieldValue: (_schema, value) => value == null ? '' : (typeof value === 'string' ? value : JSON.stringify(value, null, 2)),
        buildWizardFieldSuggestions: () => [],
        workflowModelOptions: () => models,
        defaultWorkflowModelId: () => String(models[0]?.id || ''),
        databaseToolConnectionOptions: () => [],
        selectedDatabaseConnectionId: () => '',
        dagEscapeAttr: escapeHtml,
        dagEscapeHtml: escapeHtml,
        isTextualSchemaField: () => true,
        fieldUsageHint: () => ''
    };
    vm.createContext(sandbox);
    vm.runInContext(`${source}\nglobalThis.__renderWizardField = renderWizardField;`, sandbox);
    return sandbox.__renderWizardField;
}

function loadWizardInputHelpers() {
    const source = fs.readFileSync(path.join(__dirname, '..', 'client', 'chat', 'dag-wizard-input.js'), 'utf8');
    const sandbox = {
        normalizeSchemaType: schema => String(Array.isArray(schema?.type) ? schema.type[0] : (schema?.type || 'string'))
    };
    vm.createContext(sandbox);
    vm.runInContext(`${source}\nglobalThis.__wizardInputHelpers = { formatWizardFieldValue, isTextualSchemaField };`, sandbox);
    return sandbox.__wizardInputHelpers;
}

test('workflow model options merge caches, remove duplicates, and enforce visibility', () => {
    const api = loadDagCore({
        agent: [
            { id: 1, name: 'Agent model' },
            { id: 'embedding:x', type: 'embedding', name: 'Embedding' }
        ],
        chat: [
            { id: 1, name: 'Duplicate model' },
            { id: 2, user_id: 7, name: 'Personal model' },
            { id: 3, user_id: 8, name: 'Other private model' }
        ]
    });
    assert.deepEqual(Array.from(api.workflowModelOptions(), model => String(model.id)), ['1', '2']);
    assert.equal(api.defaultWorkflowModelId(), '1');
});

test('content review wizard always renders a model selector and preserves unavailable values', () => {
    const models = [{ id: 2, name: 'Review model', model_name: 'review-upstream', context_window_tokens: 8192 }];
    const render = loadWizardFieldRenderer(models);
    const selectedHtml = render('model', { type: 'string' }, 'review-upstream', true, [], { name: 'agent.content_review' }, []);
    assert.match(selectedHtml, /data-pivot-dag-model-select="1"/);
    assert.match(selectedHtml, /value="2" selected/);
    assert.match(selectedHtml, /Review model · 上下文 8K/);
    assert.doesNotMatch(selectedHtml, /type="text"[^>]+data-pivot-dag-wizard-field="model"/);

    const staleHtml = render('model', { type: 'string' }, 'removed-model', true, [], { name: 'agent.content_review' }, []);
    assert.match(staleHtml, /当前配置（不可用）：removed-model/);

    const emptyHtml = loadWizardFieldRenderer([])('model', { type: 'string' }, '', true, [], { name: 'agent.content_review' }, []);
    assert.match(emptyHtml, /暂无可用模型/);
    assert.match(emptyHtml, /disabled aria-disabled="true"/);
});

test('content review wizard uses structured records input and numeric schema bounds', () => {
    const render = loadWizardFieldRenderer([{ id: 1, name: 'Model' }]);
    const recordsHtml = render('records', {}, '{{nodes.query.output.structuredContent}}', true, [], { name: 'agent.content_review' }, []);
    assert.match(recordsHtml, /<textarea[^>]+data-pivot-dag-wizard-field="records"/);
    const structuredHtml = render('records', {}, { structuredContent: { rows: [{ id: 1 }] } }, true, [], { name: 'agent.content_review' }, []);
    assert.match(structuredHtml, /&quot;structuredContent&quot;/);
    const numberHtml = render('maxRecords', { type: 'integer', minimum: 1, maximum: 200 }, 50, false, [], { name: 'agent.content_review' }, []);
    assert.match(numberHtml, /min="1"/);
    assert.match(numberHtml, /max="200"/);
});

test('wizard formats schema-less structured records as JSON', () => {
    const helpers = loadWizardInputHelpers();
    const formatted = helpers.formatWizardFieldValue({}, { rows: [{ id: 1 }] });
    assert.match(formatted, /^\{\n/);
    assert.match(formatted, /"rows"/);
    assert.doesNotMatch(formatted, /\[object Object\]/);
    assert.equal(helpers.isTextualSchemaField('records', {}), true);
});

test('content review schema exposes complete configurable limits', () => {
    const tool = getBuiltInToolDefinitions({ id: 1, role: 'user' })
        .find(item => item.name === 'agent.content_review');
    assert.ok(tool);
    assert.deepEqual(tool.input_schema.required, ['records', 'model']);
    assert.equal(tool.input_schema.properties.instructions.maxLength, 6000);
    assert.equal(tool.input_schema.properties.reportTitle.maxLength, 120);
    assert.equal(tool.input_schema.properties.chunkTokens.minimum, 512);
    assert.equal(tool.input_schema.properties.chunkTokens.maximum, 12000);
});

test('content review hardened input parser accepts raw string and single object with common fields', () => {
    const { rowsFromReviewInput, normalizeReviewRecords, parseModelJson } = require('../server/services/agent-content-review');
    
    // 纯文本字符串输入
    const strRows = rowsFromReviewInput('今天去按装空调');
    assert.equal(strRows.length, 1);
    assert.equal(strRows[0].content, '今天去按装空调');
    
    const strRecords = normalizeReviewRecords({ records: '今天去按装空调' });
    assert.equal(strRecords.length, 1);
    assert.equal(strRecords[0].cleanContent, '今天去按装空调');

    // 单对象包含 text 字段
    const objRows = rowsFromReviewInput({ text: '这是一段文本', title: '测试' });
    assert.equal(objRows.length, 1);
    const objRecords = normalizeReviewRecords({ records: { text: '这是一段文本', title: '测试' } });
    assert.equal(objRecords[0].cleanContent, '这是一段文本');
    assert.equal(objRecords[0].title, '测试');

    // 带 <think> 标签的推理模型输出解析
    const thinkOutput = '<think>我来检查一下错别字：按装应该为安装。</think>\n```json\n{"issues": [{"field": "content", "category": "错别字", "original": "按装", "suggestion": "安装", "reason": "同音别字", "confidence": "certain"}]}\n```';
    const parsed = parseModelJson(thinkOutput);
    assert.ok(parsed);
    assert.equal(Array.isArray(parsed.issues), true);
    assert.equal(parsed.issues[0].original, '按装');
});
