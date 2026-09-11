const assert = require('node:assert/strict');
const test = require('node:test');
const {
    lazyWorkspaceTemplates,
    loadChatHtmlTemplate,
    loadChatWorkspaceTemplate
} = require('../server/chat-template');
const fs = require('node:fs');
const path = require('node:path');

test('聊天首屏不再内嵌大型隐藏工作区 DOM', () => {
    const html = loadChatHtmlTemplate();
    const lazyPanels = {
        apps: 'apps-workbench-modal',
        agent: 'agent-workbench-modal',
        'agent-dag': 'agent-dag-workbench-modal',
        knowledge: 'knowledge-workbench-modal',
        mcp: 'mcp-workbench-modal',
        settings: 'admin-container'
    };
    Object.entries(lazyPanels).forEach(([name, panelId]) => {
        assert.match(html, new RegExp(`id="workspace-lazy-slot-${name}"`));
        assert.doesNotMatch(html, new RegExp(`id="${panelId}"`));
    });
});

test('按需工作区模板只能从固定白名单读取并递归展开片段', () => {
    assert.deepEqual(Object.keys(lazyWorkspaceTemplates), ['apps', 'agent', 'agent-dag', 'knowledge', 'mcp', 'settings']);
    assert.match(loadChatWorkspaceTemplate('apps'), /id="apps-workbench-modal"/);
    assert.match(loadChatWorkspaceTemplate('agent'), /id="agent-workbench-modal"/);
    assert.match(loadChatWorkspaceTemplate('agent-dag'), /id="agent-dag-workbench-modal"/);
    assert.match(loadChatWorkspaceTemplate('knowledge'), /id="knowledge-workbench-modal"/);
    assert.match(loadChatWorkspaceTemplate('mcp'), /id="mcp-workbench-modal"/);
    assert.match(loadChatWorkspaceTemplate('settings'), /id="admin-container"/);
    assert.throws(() => loadChatWorkspaceTemplate('../settings'), /未知的聊天工作区模板/);
});

test('模板加载职责独立于工作区导航脚本，并在导航脚本之前加载', () => {
    const root = path.resolve(__dirname, '..');
    const scripts = fs.readFileSync(path.join(root, 'client', 'chat', 'partials', 'scripts.html'), 'utf8');
    const loader = fs.readFileSync(path.join(root, 'client', 'chat', 'workspace-template-loader.js'), 'utf8');
    const settingsScale = fs.readFileSync(path.join(root, 'client', 'chat', 'workspace-settings-scale.js'), 'utf8');
    assert.ok(scripts.indexOf('/chat/workspace-template-loader.js') < scripts.indexOf('/chat/app-workspaces.js'));
    assert.ok(scripts.indexOf('/chat/workspace-style-loader.js') < scripts.indexOf('/chat/app-workspaces.js'));
    assert.ok(scripts.indexOf('/chat/workspace-settings-scale.js') < scripts.indexOf('/chat/app-workspaces.js'));
    assert.match(loader, /ensureWorkspaceMarkup/);
    assert.match(loader, /\/chat\/workspaces\/settings/);
    assert.match(settingsScale, /scheduleSettingsWorkspaceScale/);
});

test('聊天首屏只加载壳样式，懒加载工作区各自加载样式包', () => {
    const root = path.resolve(__dirname, '..');
    const html = fs.readFileSync(path.join(root, 'client', 'chat', 'chat.html'), 'utf8');
    const shellStyles = fs.readFileSync(path.join(root, 'client', 'chat', 'chat.css'), 'utf8');
    const workspaces = fs.readFileSync(path.join(root, 'client', 'chat', 'app-workspaces.js'), 'utf8');
    const styleLoader = fs.readFileSync(path.join(root, 'client', 'chat', 'workspace-style-loader.js'), 'utf8');
    const loader = fs.readFileSync(path.join(root, 'client', 'chat', 'workspace-template-loader.js'), 'utf8');
    assert.match(html, /\/chat\/chat\.shell\.css/);
    assert.doesNotMatch(html, /\/chat\/chat\.workspace\./);
    assert.match(shellStyles, /styles\/workspaces\/table-foundation\.css/);
    assert.match(shellStyles, /styles\/workspaces\/shared\.css/);
    assert.match(shellStyles, /styles\/workspaces\/responsive\.css/);
    ['apps', 'agent', 'knowledge', 'mcp', 'settings'].forEach(name => {
        assert.match(styleLoader, new RegExp(`chat\\.workspace\\.${name}\\.css`));
    });
    assert.doesNotMatch(styleLoader, /chat\.workspace\.shared\.css/);
    assert.match(workspaces, /workspaces\.styleLoader/);
    assert.doesNotMatch(workspaces, /await window\.Pivot\.moduleApi\('workspaces\.styleLoader'\)\.ensureWorkspaceStyles/);
    assert.match(workspaces, /样式资源不可成为功能入口的单点阻塞/);
    assert.match(styleLoader, /function preloadWorkspaceStyles/);
    assert.match(loader, /function preloadWorkspaceMarkup/);
    assert.match(workspaces, /function showWorkspaceWithStyleGate/);
    assert.match(workspaces, /function prewarmAutomationWorkspaces/);
    assert.match(fs.readFileSync(path.join(root, 'client', 'chat', 'agents.js'), 'utf8'), /showWorkspaceWithStyleGate/);
    assert.match(fs.readFileSync(path.join(root, 'client', 'chat', 'agent-workflows.js'), 'utf8'), /showWorkspaceWithStyleGate/);
    assert.match(fs.readFileSync(path.join(root, 'client', 'chat', 'auth.js'), 'utf8'), /pivot:app-shown/);
});

test('会话列表保留独立滚动容器并通过滚动自动分页', () => {
    const root = path.resolve(__dirname, '..');
    const sidebarCss = fs.readFileSync(path.join(root, 'client', 'chat', 'styles', 'base', 'sidebar.css'), 'utf8');
    const layoutCss = fs.readFileSync(path.join(root, 'client', 'chat', 'styles', 'layout-refresh.css'), 'utf8');
    const sidebarJs = fs.readFileSync(path.join(root, 'client', 'chat', 'sidebar.js'), 'utf8');
    const chatShell = fs.readFileSync(path.join(root, 'client', 'chat', 'partials', 'workspaces', 'chat-shell.html'), 'utf8');
    assert.match(sidebarCss, /\.session-list[\s\S]*overflow-y:\s*(?:auto|scroll)/);
    assert.match(sidebarCss, /\.sidebar[\s\S]*height:\s*100%[\s\S]*min-height:\s*0/);
    assert.match(sidebarCss, /\.session-list[\s\S]*flex:\s*1\s+1\s+0/);
    assert.match(sidebarCss, /\.session-list::\-webkit-scrollbar[\s\S]*display:\s*block/);
    assert.match(layoutCss, /\.session-list[\s\S]*min-height:\s*0/);
    assert.match(sidebarJs, /pivot-desktop-runtime/);
    assert.match(sidebarJs, /addEventListener\('wheel'/);
    assert.doesNotMatch(sidebarJs, /session-load-more/);
    assert.match(sidebarJs, /loadSessions\(true\)/);
    assert.doesNotMatch(chatShell, /session-list-footer/);
    assert.doesNotMatch(sidebarCss, /session-list-footer|session-load-more/);
});

test('工作流入口同时挂载 Agent 与独立工作流模板，避免切换后目标面板缺失', () => {
    const root = path.resolve(__dirname, '..');
    const workspaces = fs.readFileSync(path.join(root, 'client', 'chat', 'app-workspaces.js'), 'utf8');
    assert.match(workspaces, /'agent-dag': \['agent', 'agent-dag'\]/);
    assert.match(workspaces, /'agent-dag': 'agent'/);
    assert.match(workspaces, /createLazyWorkspaceEntrypoint\('agent-dag', 'openAgentDagWorkbench'\)/);
});

test('所有懒加载工作区缺少目标模板时回到标准入口，脚本加载失败后允许重试', () => {
    const root = path.resolve(__dirname, '..');
    const workspaces = fs.readFileSync(path.join(root, 'client', 'chat', 'app-workspaces.js'), 'utf8');
    const learning = fs.readFileSync(path.join(root, 'client', 'chat', 'agent-learning.js'), 'utf8');
    assert.match(workspaces, /const LAZY_WORKSPACE_OPENERS = Object\.freeze/);
    assert.match(workspaces, /delete workspaceLoadPromises\[scriptGroup\]/);
    assert.match(workspaces, /工作区 \$\{target\} 尚未挂载，已保留当前页面/);
    assert.match(learning, /await window\.Pivot\.moduleApi\('workspaces\.navigation'\)\.openAdminPanel\?\.\(\{ restore: true \}\)/);
});

test('知识库与工具库关闭按钮只由挂载控件绑定层处理一次', () => {
    const root = path.resolve(__dirname, '..');
    const sources = [
        fs.readFileSync(path.join(root, 'client', 'chat', 'app', 'main.js'), 'utf8'),
        fs.readFileSync(path.join(root, 'client', 'chat', 'app-workspaces.js'), 'utf8'),
        fs.readFileSync(path.join(root, 'client', 'chat', 'rag.js'), 'utf8')
    ].join('\n');
    assert.equal((sources.match(/bind\('knowledge-modal-close'/g) || []).length, 1);
    assert.equal((sources.match(/bind\('mcp-modal-close'/g) || []).length, 1);
    assert.equal((sources.match(/closest\('#knowledge-modal-close'\)/g) || []).length, 0);
    assert.equal((sources.match(/closest\('#mcp-modal-close'\)/g) || []).length, 0);
});

test('工具库动态操作委托独立于主渲染模块并按顺序加载', () => {
    const root = path.resolve(__dirname, '..');
    const workspaces = fs.readFileSync(path.join(root, 'client', 'chat', 'app-workspaces.js'), 'utf8');
    const actions = fs.readFileSync(path.join(root, 'client', 'chat', 'mcp-workbench-actions.js'), 'utf8');
    const main = fs.readFileSync(path.join(root, 'client', 'chat', 'mcp-workbench-main.js'), 'utf8');
    const form = fs.readFileSync(path.join(root, 'client', 'chat', 'mcp-workbench-form.js'), 'utf8');
    assert.ok(workspaces.indexOf('/chat/mcp-workbench-actions.js') < workspaces.indexOf('/chat/mcp-workbench-main.js'));
    assert.match(actions, /boundMcpWorkbenchActions/);
    assert.match(actions, /exposeModule\?\.\('mcp\.actions'/);
    assert.doesNotMatch(main, /function bindMcpWorkbenchActions/);
    assert.doesNotMatch(main, /legacy\.(?:bindMcpWorkbenchActions|refreshMcpWorkbench|runMcpBatchHealthCheck)/);
    assert.match(form, /moduleApi\?\.\('mcp\.actions'\)/);
});

test('设置事件可在模板挂载后通过模块 API 补绑且不新增 legacy 别名', () => {
    const root = path.resolve(__dirname, '..');
    const scripts = fs.readFileSync(path.join(root, 'client', 'chat', 'partials', 'scripts.html'), 'utf8');
    const events = fs.readFileSync(path.join(root, 'client', 'chat', 'admin-settings-events.js'), 'utf8');
    const settings = fs.readFileSync(path.join(root, 'client', 'chat', 'admin-settings.js'), 'utf8');
    const admin = fs.readFileSync(path.join(root, 'client', 'chat', 'admin.js'), 'utf8');
    assert.ok(scripts.indexOf('/chat/admin-settings-events.js') < scripts.indexOf('/chat/admin.js'));
    assert.match(events, /registerAdminSettingsEvents/);
    assert.match(settings, /moduleApi\('settings\.events'\)\.registerAdminSettingsEvents/);
    assert.match(admin, /moduleApi\?\.\('settings\.events'\)\?\.bindAdminSettingsEvents/);
    assert.doesNotMatch(`${settings}\n${admin}`, /legacy\.bindAdminSettingsEvents/);
});
