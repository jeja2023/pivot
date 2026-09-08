const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');

test('Agent 状态标签通过受控模块 API 共享，而非新增 legacy 全局别名', () => {
    const utils = read('client/chat/agent-run-utils.js');
    const harness = read('client/chat/agent-harness.js');
    const workbench = read('client/chat/personal-workbench.js');

    assert.match(utils, /exposeModule\?\.\('agent\.runUtils', \{ statusLabel: agentStatusLabel \}\)/);
    assert.doesNotMatch(utils, /legacy\.agentStatusLabel\s*=/);
    assert.match(harness, /moduleApi\?\.\('agent\.runUtils'\)\?\.statusLabel/);
    assert.match(workbench, /moduleApi\?\.\('agent\.runUtils'\)\?\.statusLabel/);
});

test('工作流工作台通过 navigation / implementations 模块完成懒加载分发', () => {
    const workspaces = read('client/chat/app-workspaces.js');
    const workflows = read('client/chat/agent-workflows.js');
    const clientSources = fs.readdirSync(path.join(root, 'client', 'chat'));

    assert.match(workspaces, /exposeModule\?\.\('workspaces\.navigation', \{[\s\S]*openAgentDagWorkbench:/);
    assert.match(workspaces, /moduleApi\?\.\('workspaces\.implementations'\)\?\.\[functionName\]/);
    assert.match(workflows, /exposeModule\('workspaces\.implementations', \{ openAgentDagWorkbench \}\)/);
    assert.doesNotMatch(workspaces, /legacy\.openAgentDagWorkbench\s*=/);
    assert.doesNotMatch(workflows, /legacy\.openAgentDagWorkbench\s*=/);
    assert.ok(clientSources.includes('agent-workflows.js'));
});

test('知识库工作台同样通过 navigation / implementations 模块完成懒加载分发', () => {
    const workspaces = read('client/chat/app-workspaces.js');
    const knowledge = read('client/chat/rag-documents.js');
    const workspaceConsumers = [
        read('client/chat/app/main.js'),
        read('client/chat/engine-streaming.js'),
        read('client/chat/personal-workbench.js')
    ].join('\n');

    assert.match(workspaces, /openKnowledgeWorkbench: openKnowledgeWorkbenchEntrypoint/);
    assert.match(knowledge, /exposeModule\('workspaces\.implementations', \{ openKnowledgeWorkbench \}\)/);
    assert.doesNotMatch(workspaces, /legacy\.openKnowledgeWorkbench\s*=/);
    assert.doesNotMatch(knowledge, /legacy\.openKnowledgeWorkbench\s*=/);
    assert.match(workspaceConsumers, /moduleApi\('workspaces\.navigation'\)\.openKnowledgeWorkbench/);
});

test('工具库工作台通过 navigation / implementations 模块完成懒加载分发', () => {
    const workspaces = read('client/chat/app-workspaces.js');
    const mcp = read('client/chat/mcp-workbench-form.js');
    const workspaceConsumers = [
        read('client/chat/app/main.js'),
        read('client/chat/engine-streaming.js'),
        read('client/chat/personal-workbench.js')
    ].join('\n');

    assert.match(workspaces, /openMcpWorkbench: openMcpWorkbenchEntrypoint/);
    assert.match(mcp, /exposeModule\('workspaces\.implementations', \{ openMcpWorkbench \}\)/);
    assert.doesNotMatch(workspaces, /legacy\.openMcpWorkbench\s*=/);
    assert.doesNotMatch(mcp, /legacy\.openMcpWorkbench\s*=/);
    assert.match(workspaceConsumers, /moduleApi\('workspaces\.navigation'\)\.openMcpWorkbench/);
});

test('应用中心通过 navigation / implementations 模块完成懒加载分发', () => {
    const workspaces = read('client/chat/app-workspaces.js');
    const apps = read('client/chat/apps-workbench-rag.js');
    const workspaceConsumers = [
        read('client/chat/app/main.js'),
        read('client/chat/mcp-workbench-main.js'),
        read('client/chat/personal-workbench.js')
    ].join('\n');

    assert.match(workspaces, /openAppsWorkbench: openAppsWorkbenchEntrypoint/);
    assert.match(apps, /exposeModule\('workspaces\.implementations', \{ openAppsWorkbench \}\)/);
    assert.doesNotMatch(workspaces, /legacy\.openAppsWorkbench\s*=/);
    assert.doesNotMatch(apps, /legacy\.openAppsWorkbench\s*=/);
    assert.match(workspaceConsumers, /moduleApi\('workspaces\.navigation'\).*openAppsWorkbench/);
});

test('Agent 主工作台通过 navigation / implementations 模块完成懒加载分发', () => {
    const workspaces = read('client/chat/app-workspaces.js');
    const agents = read('client/chat/agents.js');
    const workspaceConsumers = [
        read('client/chat/app/main.js'),
        read('client/chat/agent-schedules.js'),
        read('client/chat/personal-workbench.js'),
        read('client/chat/sidebar.js')
    ].join('\n');

    assert.match(workspaces, /openAgentWorkbench: openAgentWorkbenchEntrypoint/);
    assert.match(agents, /exposeModule\('workspaces\.implementations', \{ openAgentWorkbench \}\)/);
    assert.doesNotMatch(workspaces, /legacy\.openAgentWorkbench\s*=/);
    assert.doesNotMatch(agents, /legacy\.openAgentWorkbench\s*=/);
    assert.match(workspaceConsumers, /moduleApi\('workspaces\.navigation'\)\.openAgentWorkbench/);
});

test('设置工作台通过 navigation / implementations 模块完成懒加载分发', () => {
    const workspaces = read('client/chat/app-workspaces.js');
    const admin = read('client/chat/admin.js');
    const workspaceConsumers = [
        read('client/chat/app/main.js'),
        read('client/chat/mcp-workbench-main.js'),
        read('client/chat/personal-workbench.js')
    ].join('\n');

    assert.match(workspaces, /openAdminPanel: openAdminPanelEntrypoint/);
    assert.match(admin, /exposeModule\('workspaces\.implementations', \{ openAdminPanel \}\)/);
    assert.doesNotMatch(workspaces, /legacy\.openAdminPanel\s*=/);
    assert.doesNotMatch(admin, /legacy\.openAdminPanel\s*=/);
    assert.match(workspaceConsumers, /moduleApi\('workspaces\.navigation'\)\.openAdminPanel/);
});

test('工作区显示与返回通过 navigation 模块共享，而非 legacy 别名', () => {
    const workspaces = read('client/chat/app-workspaces.js');
    const consumers = [
        read('client/chat/auth.js'),
        read('client/chat/engine-sessions.js'),
        read('client/chat/personal-workbench.js'),
        read('client/chat/rag-documents.js')
    ].join('\n');

    assert.match(workspaces, /showMainWorkspace,\s*returnFromWorkspace,/);
    assert.doesNotMatch(workspaces, /legacy\.showMainWorkspace\s*=/);
    assert.doesNotMatch(workspaces, /legacy\.returnFromWorkspace\s*=/);
    assert.match(consumers, /moduleApi\('workspaces\.navigation'\)\.showMainWorkspace/);
    assert.match(consumers, /moduleApi\('workspaces\.navigation'\)\.returnFromWorkspace/);
});

test('个人工作台入口和刷新操作通过受控模块共享', () => {
    const workspaces = read('client/chat/app-workspaces.js');
    const personal = read('client/chat/personal-workbench.js');
    const main = read('client/chat/app/main.js');

    assert.match(workspaces, /openPersonalWorkbench: openPersonalWorkbenchEntrypoint/);
    assert.match(personal, /exposeModule\?\.\('workspaces\.personal', \{ loadPersonalWorkbench \}\)/);
    assert.match(personal, /exposeModule\?\.\('workspaces\.implementations', \{ openPersonalWorkbench \}\)/);
    assert.doesNotMatch(personal, /legacy\.openPersonalWorkbench\s*=/);
    assert.doesNotMatch(personal, /legacy\.loadPersonalWorkbench\s*=/);
    assert.match(main, /moduleApi\('workspaces\.navigation'\)\.openPersonalWorkbench/);
});
