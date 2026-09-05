const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');

function createSelect() {
    const listeners = new Map();
    return {
        value: '',
        disabled: false,
        dataset: {},
        children: [],
        replaceChildren(...children) { this.children = children; },
        appendChild(child) { this.children.push(child); },
        addEventListener(name, callback) { listeners.set(name, callback); },
        trigger(name) { listeners.get(name)?.(); },
        get selectedOptions() { return this.children.filter(option => option.value === this.value); }
    };
}

function createSelectorHarness(models, defaultModelId) {
    const values = new Map();
    const select = createSelect();
    const document = {
        getElementById(id) { return id === 'data-analysis-ai-model' ? select : null; },
        createElement() { return { value: '', textContent: '', title: '' }; }
    };
    const window = {
        currentUser: { id: 'user-1' },
        document,
        localStorage: {
            getItem(key) { return values.get(key) || null; },
            setItem(key, value) { values.set(key, String(value)); }
        },
        loadSelectableModels: async () => ({ models, defaultModelId }),
        describeSelectorModel: model => `${model.name} | ${model.model_name}`,
        Pivot: { exposeModule() {} }
    };
    const context = { window, document, console, String, Set };
    vm.runInNewContext(read('client/chat/apps-model-selector.js'), context, {
        filename: 'client/chat/apps-model-selector.js'
    });
    return { select, values, api: window.PivotAppModels };
}

test('应用内模型选择器使用默认模型初始化，并按应用和用户隔离保存', async () => {
    const models = [
        { id: 'model-a', name: '模型 A', model_name: 'a' },
        { id: 'model-b', name: '模型 B', model_name: 'b', user_id: 'user-1' }
    ];
    const { select, values, api } = createSelectorHarness(models, 'model-b');

    await api.refresh('data-analysis', 'data-analysis-ai-model');
    assert.equal(select.value, 'model-b');
    assert.equal(select.disabled, false);
    assert.equal(values.get('pivot_app_model:user-1:data-analysis'), 'model-b');

    select.value = 'model-a';
    select.trigger('change');
    assert.equal(api.getSelectedModel('data-analysis', 'data-analysis-ai-model'), 'model-a');
    assert.equal(values.get('pivot_app_model:user-1:data-analysis'), 'model-a');
});

test('三个应用的 AI 请求均使用应用内模型选择器，而不读取主会话选择器', () => {
    const officialWriting = read('client/chat/apps-workbench-ai.js');
    const dataAnalysis = read('client/chat/data-analysis/ai.js');
    const regulations = read('client/chat/regulations/core.js');
    const officialEditor = read('client/chat/apps-workbench-editor.js');
    const officialRewrite = read('client/chat/apps-workbench-rewrite.js');
    const dataView = read('client/chat/data-analysis/view.js');
    const regulationsShell = read('client/chat/regulations/render-shell.js');
    const appsPartial = read('client/chat/partials/workspaces/apps.html');
    const workspace = read('client/chat/app-workspaces.js');

    assert.match(workspace, /\/chat\/apps-model-selector\.js/);
    assert.match(officialWriting, /function getOfficialWritingTaskModelId\(task = 'selection'\)/);
    assert.match(dataAnalysis, /getSelectedModel\?\.\('data-analysis', 'data-analysis-ai-model'\)/);
    assert.match(regulations, /getSelectedModel\?\.\('regulations', 'regulations-ai-model'\)/);
    assert.doesNotMatch(officialWriting, /getElementById\('model-selector'\)/);
    assert.doesNotMatch(dataAnalysis, /getElementById\('model-selector'\)/);
    assert.doesNotMatch(regulations, /getElementById\('model-selector'\)/);
    assert.match(appsPartial, /id="official-writing-selection-model"/);
    assert.match(appsPartial, /id="official-writing-draft-model"/);
    assert.match(officialWriting, /draft: \['official-writing-draft', 'official-writing-draft-model'\]/);
    assert.match(officialWriting, /review: \['official-writing-review', 'official-writing-review-model'\]/);
    assert.match(officialWriting, /selection: \['official-writing-selection', 'official-writing-selection-model'\]/);
    assert.match(officialEditor, /refresh\?\.\('official-writing-draft', 'official-writing-draft-model'\)/);
    assert.match(officialRewrite, /modelId: getOfficialWritingTaskModelId\('selection'\)/);
    assert.match(dataView, /id="data-analysis-ai-model"/);
    assert.match(regulationsShell, /id="regulations-ai-model"/);
});

test('公文审校弹窗提供模型切换，并可中止正在进行的请求', () => {
    const partial = read('client/chat/partials/workspaces/apps.html');
    const ai = read('client/chat/apps-workbench-ai.js');
    const proofread = read('client/chat/apps-workbench-proofread.js');
    const events = read('client/chat/apps-workbench-rag.js');

    assert.match(partial, /id="official-writing-review-model"/);
    assert.match(partial, /id="official-writing-stop-review-btn"/);
    assert.match(proofread, /refresh\?\.\('official-writing-review', 'official-writing-review-model'\)/);
    assert.match(events, /official-writing-stop-review-btn'\)\?\.addEventListener\('click', stopOfficialWritingReview\)/);
    assert.match(ai, /function stopOfficialWritingReview\(\)/);
    assert.match(ai, /officialWritingAiAbortController\.abort\(\)/);
    assert.match(ai, /signal:\s*abortController\?\.signal/);
    assert.match(ai, /result\.aborted/);
});

test('选区润色、扩写、压缩不会自动打开审校建议弹窗', () => {
    const ai = read('client/chat/apps-workbench-ai.js');
    const proofread = read('client/chat/apps-workbench-proofread.js');

    assert.match(proofread, /function addOfficialWritingSuggestion\(payload, \{ openDrawer = true \} = \{\}\)/);
    assert.match(proofread, /if \(openDrawer\) openOfficialWritingDrawer\('suggestions'\)/);
    const selectionSection = ai.slice(ai.indexOf('async function runOfficialWritingSelectionCustomAi'));
    assert.equal((selectionSection.match(/\{ openDrawer: false \}/g) || []).length, 2);
});
