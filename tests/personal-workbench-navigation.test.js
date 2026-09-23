const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');

test('个人工作台后端 toRecentWork 对演示文稿与各类产物建立正确分类与目标 ID', () => {
    // We can simulate toRecentWork using the exported module or require the service
    const personalWorkbench = require('../server/services/personal-workbench');
    assert.ok(typeof personalWorkbench.getPersonalWorkbench === 'function');

    const serverCode = read('server/services/personal-workbench.js');
    assert.match(serverCode, /const isPresentation = artifactType === 'presentation';/);
    assert.match(serverCode, /const isOfficialWriting = artifactType === 'official_writing';/);
    assert.match(serverCode, /kind:\s*isPresentation \? 'presentation' : kind/);
    assert.match(serverCode, /targetId/);
    assert.match(serverCode, /presentationId:\s*isPresentation \? targetId : undefined/);
    assert.match(serverCode, /title:\s*record\.title \|\| \(isPresentation \? '未命名演示文稿' : \(isOfficialWriting \? '未命名公文' : '未命名成果'\)\)/);
    assert.match(serverCode, /meta:\s*isPresentation\s*\?\s*'演示文稿'/);
});

test('个人工作台快捷入口允许展示 presentations（PPT制作）', () => {
    const { normalizeShortcuts } = require('../server/services/personal-workbench');
    const list = normalizeShortcuts(['presentations', 'official-writing', 'data-analysis']);
    assert.deepEqual(list, ['presentations', 'official-writing', 'data-analysis']);

    const clientCode = read('client/chat/personal-workbench.js');
    assert.match(clientCode, /presentations:\s*\{[\s\S]*?label:\s*'PPT 制作'/);
    assert.match(clientCode, /key === 'presentations'[\s\S]*?openAppsWorkbench\?\.\(\{\s*app:\s*'presentations'\s*\}\)/);
});

test('继续工作区域各类条目具备精准分流：未命名演示文稿直达 PPT 编辑器，不进入任务活动抽屉', () => {
    const clientCode = read('client/chat/personal-workbench.js');

    // 验证渲染时挂载属性
    assert.match(clientCode, /const isPpt = kind === 'presentation' \|\| artifactType === 'presentation';/);
    assert.match(clientCode, /row\.dataset\.personalRecentKind = kind;/);
    assert.match(clientCode, /row\.dataset\.personalRecentArtifactType = artifactType;/);
    assert.match(clientCode, /row\.dataset\.personalRecentTargetId = item\.targetId;/);
    assert.match(clientCode, /row\.dataset\.personalRecentRunId = item\.runId;/);

    // 验证点击分流逻辑
    assert.match(clientCode, /async function handleRecentWork\(button\)/);

    // 1. 会话：展开侧边栏并切换会话
    assert.match(clientCode, /if \(kind === 'session' && id\) \{[\s\S]*?selectSession\?\.\(id/);

    // 2. 演示文稿：优先匹配，绝不被后面的 runId 捕获进任务面板
    assert.match(clientCode, /if \(kind === 'presentation' \|\| artifactType === 'presentation'\) \{\s*return window\.Pivot\.moduleApi\('workspaces\.navigation'\)\.openAppsWorkbench\?\.\(\{\s*app:\s*'presentations',\s*presentationId:\s*targetId\s*\}\);\s*\}/);

    // 3. 公文写作：直达公文单篇编辑
    assert.match(clientCode, /if \(artifactType === 'official_writing'\) \{\s*return window\.Pivot\.moduleApi\('workspaces\.navigation'\)\.openAppsWorkbench\?\.\(\{\s*app:\s*'official-writing',\s*docId:\s*targetId\s*\}\);\s*\}/);

    // 4. 带 runId 或 run 类型：进入任务详情
    assert.match(clientCode, /if \(runId \|\| \(kind === 'run' && id\)\) \{/);

    // 5. 普通 artifact：进入已完成任务
    assert.match(clientCode, /if \(kind === 'artifact'\) \{\s*return window\.Pivot\.moduleApi\('workspaces\.navigation'\)\.openAgentWorkbench\?\.\(\{\s*tab:\s*'tasks',\s*status:\s*'completed'\s*\}\);\s*\}/);
});

test('应用中心及 PPT 工作台完整透传并响应 presentationId 唤起', () => {
    const ragCode = read('client/chat/apps-workbench-rag.js');
    const coreCode = read('client/chat/apps-workbench-core.js');
    const pptCode = read('client/chat/apps-workbench-presentations.js');

    // apps-workbench-rag 透传 presentationId 与 docId
    assert.match(ragCode, /targetApp === 'presentations'/);
    assert.match(ragCode, /showPresentationsAppFromRegistry\(options\)/);
    assert.match(ragCode, /openPresentation\?\.\(options\.presentationId\)/);
    assert.match(ragCode, /switchOfficialWritingDoc\(options\.docId/);

    // apps-workbench-core 透传 options 到模块
    assert.match(coreCode, /async function showPresentationsAppFromRegistry\(options = \{\}\)/);
    assert.match(coreCode, /presentations\.showPresentationsApp\(options\)/);

    // PPT 工作台原生接受 options 并直接打开对应文稿
    assert.match(pptCode, /async function showPresentationsApp\(options = \{\}\)/);
    assert.match(pptCode, /if \(options\?\.presentationId\) \{\s*await openPresentation\(options\.presentationId\);\s*return;\s*\}/);
});
