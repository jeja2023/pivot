const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { normalizeShortcuts } = require('../server/services/personal-workbench');

const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');

test('个人工作台仅保存受支持的常用入口，并为空配置回退默认入口', () => {
    assert.deepEqual(normalizeShortcuts(['chat', 'unknown', 'ocr', 'chat']), ['chat', 'ocr']);
    assert.deepEqual(normalizeShortcuts('[]'), ['official-writing', 'data-analysis', 'regulations', 'ocr', 'pdf-tools']);
});

test('个人工作台接入主模板、当前用户聚合接口与持久化快捷入口', () => {
    const template = read('client/chat/partials/workspaces/personal.html');
    const workspace = read('client/chat/app-workspaces.js');
    const client = read('client/chat/personal-workbench.js');
    const routes = read('server/routes/agent-control-plane.js');

    assert.match(template, /id="personal-workbench-modal"/);
    assert.match(template, /class="personal-rail"/);
    assert.match(template, /id="personal-rail-user-initial"/);
    assert.doesNotMatch(template, /id="personal-header-user-initial"/);
    assert.match(template, /class="personal-hero"/);
    assert.match(template, /id="personal-shortcuts-modal"/);
    assert.match(workspace, /personal: 'personal-workbench-modal'/);
    assert.match(workspace, /RESTORABLE_WORKSPACES = new Set\(\['personal'/);
    assert.match(client, /\/user\/workbench-summary/);
    assert.match(client, /\/agents\/workbench\/shortcuts/);
    assert.match(routes, /router\.get\('\/user\/workbench-summary'/);
    assert.match(routes, /router\.get\('\/agents\/workbench'/);
    assert.match(routes, /router\.put\('\/agents\/workbench\/shortcuts'/);
});

test('工作台作为系统主入口，关闭二级页面时回到来源工作区', () => {
    const workspace = read('client/chat/app-workspaces.js');
    const apps = read('client/chat/apps-workbench-rag.js');
    const auth = read('client/chat/auth.js');

    assert.match(workspace, /returnFromWorkspace/);
    assert.match(workspace, /pivot_return_workspace/);
    assert.match(apps, /returnFromWorkspace/);
    assert.match(auth, /showMainWorkspace(?:\?\.)?\('personal'\)/);
});
