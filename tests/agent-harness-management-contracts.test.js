const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

test('技能与助手日常入口合并档案与记忆，默认隐藏运维和实验面板', () => {
    const partial = read('client/chat/partials/workspaces/agent.html');
    const script = read('client/chat/agent-harness.js');
    const runtimePacks = read('client/chat/agent-runtime-packs-console.js');
    assert.match(partial, /data-agent-cp-subview="governance"/);
    assert.match(partial, />技能与助手<\/span>/);
    assert.match(partial, /data-agent-cp-subview="governance"[\s\S]*?aria-selected="true"/);
    assert.match(partial, /data-agent-cp-subview="inbox"[\s\S]*?>待办中心<\/span>/);
    assert.match(partial, /data-agent-cp-subview="goals"[\s\S]*?>自动目标<\/span>/);
    assert.match(partial, /data-agent-cp-subview="channels"[\s\S]*?>通知设置<\/span>/);
    assert.match(partial, /data-agent-cp-subview="quality"[\s\S]*?>运行质量<\/span>/);
    assert.match(partial, /data-agent-harness-nav="profile"[\s\S]*?>我的智能助手<\/button>/);
    assert.match(partial, /data-agent-harness-nav="skills"/);
    assert.match(partial, /data-agent-harness-nav="residency"[^>]*hidden/);
    assert.match(partial, /data-agent-harness-nav="evolution"[^>]*hidden/);
    assert.doesNotMatch(partial, /data-agent-harness-nav="governance"/);
    assert.match(partial, /data-agent-harness-section="profile"/);
    assert.match(partial, /data-agent-harness-section="governance"/);
    assert.match(partial, />记忆与隐私<\/strong>/);
    assert.match(partial, /agent-harness-skill-manifest/);
    assert.match(partial, /data-agent-harness-nav="packs"[^>]*hidden/);
    assert.match(partial, /data-agent-harness-section="packs"[^>]*hidden/);
    assert.match(partial, /agent-harness-pack-sync/);
    assert.match(partial, /agent-harness-residency-list/);
    assert.match(script, /\/agents\/skills/);
    assert.match(script, /agent\.runtimePacks/);
    assert.match(script, /target === 'profile'.*agentHarnessSection === 'governance'/);
    assert.match(script, /\['residency', 'evolution'\]/);
    assert.match(runtimePacks, /\/agents\/runtime-packs/);
    assert.match(runtimePacks, /\/agents\/runtime-packs\/console/);
    assert.match(runtimePacks, /state\.available/);
    assert.match(script, /\/agents\/residencies/);
    const route = read('server/routes/agents.js');
    assert.match(route, /isRuntimePackConsoleEnabled/);
    assert.match(route, /isSuperAdmin\(req\.user\) && isRuntimePackConsoleEnabled\(\)/);
});

test('任务详情提供 Harness 运行诊断的四类面板', () => {
    const script = read('client/chat/agent-harness.js');
    const detail = read('client/chat/agent-run-detail.js');
    assert.match(script, /data-agent-harness-diagnostic-tab="\$\{key\}"/);
    for (const tab of ['context', 'world', 'resources', 'control']) assert.match(script, new RegExp(`tab\\('${tab}'`));
    assert.match(detail, /renderAgentHarnessDiagnosticMarkup/);
    assert.match(detail, /bindAgentRunHarnessDiagnostics/);
});

test('任务详情刷新会按运行 ID 保留折叠面板状态', () => {
    const detail = read('client/chat/agent-run-detail.js');
    assert.match(detail, /agentRunDisclosureStates/);
    assert.match(detail, /captureAgentRunDisclosureState/);
    assert.match(detail, /restoreAgentRunDisclosureState/);
});

test('运行诊断刷新会保留当前子页面', () => {
    const harness = read('client/chat/agent-harness.js');
    const css = read('client/chat/styles/workspaces/agent/agent-harness.css');
    assert.match(harness, /state\.diagnostics\.get\(String\(runId\)\)/);
    assert.match(harness, /state\.diagnostics\.set\(String\(runId\), active\)/);
    assert.match(harness, /data-agent-harness-active-tab/);
    assert.match(harness, /aria-selected/);
    assert.match(harness, /data-agent-harness-panel=/);
    assert.match(harness, /diagnosticCache/);
    assert.match(css, /\.agent-harness-diagnostic-panels/);
    assert.match(css, /\.agent-harness-diagnostic-panel\.hidden/);
});

test('Residency 管理 API 保留用户隔离并提供管理员范围控制', () => {
    const route = read('server/routes/agents.js');
    assert.match(route, /router\.get\('\/agents\/residencies'/);
    assert.match(route, /isSuperAdmin\(req\.user\)/);
    assert.match(route, /router\.post\('\/agents\/residencies\/sweep'/);
    assert.match(route, /router\.post\('\/agents\/residencies\/:residentId\/evict'/);
});
