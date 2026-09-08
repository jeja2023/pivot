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
    assert.ok(scripts.indexOf('/chat/workspace-template-loader.js') < scripts.indexOf('/chat/app-workspaces.js'));
    assert.match(loader, /ensureWorkspaceMarkup/);
    assert.match(loader, /\/chat\/workspaces\/settings/);
});
