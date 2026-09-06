const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { normalizeShortcuts } = require('../server/services/personal-workbench');

const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');

test('个人工作台仅保存受支持的常用入口，并为空配置回退默认入口', () => {
    assert.deepEqual(normalizeShortcuts(['workflows', 'unknown', 'ocr', 'workflows']), ['workflows', 'ocr']);
    assert.deepEqual(normalizeShortcuts(['knowledge', 'chat']), ['official-writing', 'data-analysis', 'regulations', 'ocr', 'pdf-tools']);
    assert.deepEqual(
        normalizeShortcuts(['official-writing', 'data-analysis', 'regulations', 'ocr', 'pdf-tools', 'workflows']),
        ['official-writing', 'data-analysis', 'regulations', 'ocr', 'pdf-tools', 'workflows']
    );
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
    assert.match(template, /id="personal-user-modal"/);
    assert.match(template, /data-personal-action="open-user-profile"/);
    assert.match(template, /data-personal-action="open-automation"/);
    assert.match(client, /openUserProfileModal/);
    assert.match(client, /action === 'open-automation'/);
    assert.match(client, /action === 'open-completed-tasks'/);
    assert.match(client, /status: 'completed'/);
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

test('从个人工作台打开对话时，侧边栏会话列表默认保持展开状态', () => {
    const sidebar = read('client/chat/sidebar.js');
    const main = read('client/chat/app/main.js');
    const workspace = read('client/chat/app-workspaces.js');
    const personal = read('client/chat/personal-workbench.js');

    // 侧边栏与主流程在无本地缓存时默认展开
    assert.match(sidebar, /function readChatSidebarDrawerState\(\)\s*\{[\s\S]*?stored === null\)\s*return true;/);
    assert.match(main, /syncSidebarForViewport[\s\S]*?stored === null\)\s*return true;/);

    // 工作台切换到对话视图时同步侧边栏展开状态
    assert.match(workspace, /target === 'chat'[\s\S]*?readChatSidebarDrawerState/);
    assert.match(workspace, /setChatSidebarDrawerOpen\?\.\(shouldOpen/);

    // 个人工作台主要打开对话的动作确保侧边栏抽屉打开
    assert.match(personal, /openShortcut\(key\)[\s\S]*?key === 'chat'[\s\S]*?setChatSidebarDrawerOpen\?\.\(true\)/);
    assert.match(personal, /handleRecentWork[\s\S]*?kind === 'session'[\s\S]*?setChatSidebarDrawerOpen\?\.\(true\)/);
    assert.match(personal, /action === 'open-history'[\s\S]*?setChatSidebarDrawerOpen\?\.\(true\)/);
});

test('从个人工作台打开自动化时，默认跳转到任务列表页面', () => {
    const personal = read('client/chat/personal-workbench.js');
    assert.match(personal, /action === 'open-automation'[\s\S]*?openAgentWorkbench\?\.\(\{\s*tab:\s*'tasks'\s*\}\)/);
});

