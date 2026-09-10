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
    assert.match(template, /data-personal-action="open-manual"/);
    assert.match(client, /openUserProfileModal/);
    assert.match(client, /action === 'open-automation'/);
    assert.match(client, /action === 'open-manual'/);
    assert.match(client, /action === 'open-completed-tasks'/);
    assert.match(client, /status: 'completed'/);
    assert.match(workspace, /personal: 'personal-workbench-modal'/);
    assert.match(workspace, /openManualWorkbench:\s*\(\)\s*=>\s*showMainWorkspace\('manual'\)/);
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

test('从个人工作台进入对话默认不创建或恢复会话记录', () => {
    const personal = read('client/chat/personal-workbench.js');
    const sessions = read('client/chat/engine-sessions.js');

    assert.match(personal, /key === 'chat'[\s\S]*?clearActiveChatSession/);
    assert.doesNotMatch(personal, /key === 'chat'[\s\S]*?createSession\?\.\('新对话'\)/);
    assert.doesNotMatch(personal, /action === 'open-chat'[\s\S]*?getStoredActiveChatSession/);
    assert.match(personal, /action === 'open-history'[\s\S]*?clearActiveChatSession/);
    assert.match(sessions, /function clearActiveChatSession\(\)/);
    assert.match(sessions, /persistActiveChatSession\?\.\(''\)/);
});

test('从个人工作台打开自动化时，默认跳转到任务列表页面', () => {
    const personal = read('client/chat/personal-workbench.js');
    assert.match(personal, /action === 'open-automation'[\s\S]*?openAgentWorkbench\?\.\(\{\s*tab:\s*'tasks'\s*\}\)/);
});

test('任务状态全面中文化且需要我处理精准过滤非审批任务', () => {
    const { formatAgentStatus } = require('../server/services/agent-validators');
    assert.strictEqual(formatAgentStatus('running'), '运行中');
    assert.strictEqual(formatAgentStatus('completed'), '已完成');
    assert.strictEqual(formatAgentStatus('completed_with_errors'), '完成（含部分异常）');
    assert.strictEqual(formatAgentStatus('failed'), '已失败');
    assert.strictEqual(formatAgentStatus('error'), '运行异常');
    assert.strictEqual(formatAgentStatus('waiting_approval'), '待审批');
    assert.strictEqual(formatAgentStatus('awaiting_approval'), '等待审批');
    assert.strictEqual(formatAgentStatus('queued'), '排队中');
    assert.strictEqual(formatAgentStatus('active'), '运行中');
    assert.strictEqual(formatAgentStatus('paused'), '已暂停');

    const personalServer = read('server/services/personal-workbench.js');
    const personalClient = read('client/chat/personal-workbench.js');
    const harnessClient = read('client/chat/agent-harness.js');

    // 服务端最近工作与待办均中文化任务状态
    assert.match(personalServer, /formatAgentStatus\(record\.status\)/);
    assert.match(personalServer, /waiting_approval/);

    // 客户端待处理条目支持标记已读与属性挂载
    assert.match(personalClient, /personalItemId/);
    assert.match(personalClient, /personalUnread/);
    assert.match(personalClient, /markAttentionItemRead/);

    // 待办中心详情按钮调用 openAgentRun
    assert.match(harnessClient, /openAgentRun.*returnTab:\s*'workbench'.*returnSubview:\s*'inbox'/);
});

test('用户个人信息弹窗支持展示真实注册时间，并在缺少时间时优雅回退系统初始用户', () => {
    const authServer = read('server/auth.js');
    const personalClient = read('client/chat/personal-workbench.js');

    assert.match(authServer, /SELECT id, username, nickname, unit, role, status, created_at, default_model_id/);
    assert.match(authServer, /created_at:\s*user\.created_at/);
    assert.match(personalClient, /personal-user-created-at/);
    assert.match(personalClient, /系统初始用户/);
});

