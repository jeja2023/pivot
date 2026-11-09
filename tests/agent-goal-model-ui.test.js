'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function createGoalUi(loader = async () => ({ models: [{ id: 11, name: '默认模型' }], defaultModelId: 11 })) {
    const nodes = new Map();
    for (const [id, value] of Object.entries({
        'agent-goal-model': '', 'agent-goal-title': '模型绑定测试', 'agent-goal-goal': '检查项目风险并汇总结果',
        'agent-goal-trigger': 'manual', 'agent-goal-kind': 'monitor', 'agent-goal-edit-id': '',
        'agent-goal-draft-token': '', 'agent-goal-preview': '', 'agent-goal-model-router': 'auto-cost'
    })) nodes.set(id, { value, disabled: false });
    const select = nodes.get('agent-goal-model');
    select.options = [];
    select.replaceChildren = (...options) => { select.options = options; };
    select.appendChild = option => select.options.push(option);
    const calls = [];
    const notices = [];
    const legacy = { currentUser: { id: 7 }, loadSelectableModels: loader };
    let factory;
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../client/chat/agent-personal-experience.js'), 'utf8'), {
        API_BASE: '/api',
        document: { getElementById: id => nodes.get(id), createElement: () => ({}) },
        window: { Pivot: { legacy, exposeModule: (_name, api) => { factory = api.create; } } }
    });
    const api = factory({
        state: {}, setNotice: (message, kind) => notices.push({ message, kind }),
        apiJson: async (url, options) => { calls.push({ url, body: JSON.parse(options.body) }); return {}; }
    });
    return { api, nodes, select, calls, notices, legacy };
}

test('持续目标新建使用默认模型，编辑回显原模型且失效时要求重新选择', async () => {
    const ui = createGoalUi(async () => ({ models: [
        { id: 11, name: '模型一' }, { id: 42, name: '模型二' },
        { id: 50, name: '嵌入模型', type: 'embedding' }, { id: 51, status: 'disabled' }
    ], defaultModelId: 42 }));
    await ui.api.loadGoalModels();
    assert.equal(ui.select.value, '42');
    assert.deepEqual(ui.select.options.map(option => option.value), ['', '11', '42']);
    await ui.api.loadGoalModels({ authorizationSpec: { modelId: 11 } });
    assert.equal(ui.select.value, '11');
    await ui.api.loadGoalModels({ authorizationSpec: { modelId: 999 } });
    assert.equal(ui.select.value, '');
    assert.match(ui.select.options[0].textContent, /重新选择/);
    await ui.api.loadGoalModels({ authorizationSpec: {} });
    assert.equal(ui.select.value, '');
    ui.legacy.loadSelectableModels = async () => ({ models: [] });
    await ui.api.loadGoalModels();
    assert.equal(ui.select.disabled, true);
    assert.match(ui.select.options[0].textContent, /暂无可用模型/);
});

test('持续目标创建、编辑、草案确认和测试运行都提交明确的模型绑定', async () => {
    const ui = createGoalUi();
    await ui.api.loadGoalModels();
    const event = { preventDefault() {} };
    await ui.api.saveGoal(event);
    assert.equal(ui.calls[0].body.authorizationSpec.modelId, 11);
    assert.equal(ui.calls[0].body.authorizationSpec.modelRouter, 'auto-cost');
    ui.nodes.get('agent-goal-draft-token').value = 'signed-draft';
    await ui.api.saveGoal(event);
    assert.equal(ui.calls[1].body.confirmationToken, 'signed-draft');
    assert.equal(ui.calls[1].body.goalOverrides.authorizationSpec.modelId, 11);
    ui.nodes.get('agent-goal-edit-id').value = 'existing-goal';
    await ui.api.saveGoal(event);
    assert.equal(ui.calls[2].url, '/api/agents/goals/existing-goal');
    assert.equal(ui.calls[2].body.authorizationSpec.modelId, 11);
    await ui.api.previewGoal();
    assert.equal(ui.calls[3].url, '/api/agents/goals/preview');
    assert.equal(ui.calls[3].body.authorizationSpec.modelId, 11);
});

test('持续目标模型加载失败、加载中或未选择时不会提交保存和测试运行', async () => {
    const ui = createGoalUi(async () => { throw new Error('模型列表加载失败'); });
    await ui.api.loadGoalModels();
    assert.equal(ui.select.disabled, true);
    assert.match(ui.select.options[0].textContent, /加载失败/);
    for (const value of ['', '0', '11abc']) {
        ui.select.disabled = false;
        ui.select.value = value;
        await ui.api.saveGoal({ preventDefault() {} });
        await ui.api.previewGoal();
    }
    ui.select.value = '11';
    ui.select.disabled = true;
    await ui.api.saveGoal({ preventDefault() {} });
    await ui.api.previewGoal();
    assert.equal(ui.calls.length, 0);
    assert.ok(ui.notices.every(notice => notice.kind === 'error' && /执行模型/.test(notice.message)));
});

test('持续目标模型的迟到加载不能覆盖新编辑、已关闭弹窗或其他账号', async () => {
    const pending = [];
    const ui = createGoalUi(() => new Promise(resolve => pending.push(resolve)));
    const first = ui.api.loadGoalModels({ authorizationSpec: { modelId: 11 } });
    const second = ui.api.loadGoalModels({ authorizationSpec: { modelId: 42 } });
    pending[1]({ models: [{ id: 42, name: '新模型' }] });
    await second;
    pending[0]({ models: [{ id: 11, name: '旧模型' }] });
    await first;
    assert.equal(ui.select.value, '42');
    const closed = ui.api.loadGoalModels();
    ui.api.resetGoalModal();
    pending[2]({ models: [{ id: 11, name: '旧模型' }] });
    await closed;
    assert.equal(ui.select.disabled, true);
    const switched = ui.api.loadGoalModels();
    ui.legacy.currentUser = { id: 8 };
    pending[3]({ models: [{ id: 11, name: '旧账号模型' }] });
    await switched;
    assert.equal(ui.select.disabled, true);
    assert.equal(ui.select.options.length, 1);
});
