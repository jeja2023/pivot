const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

test('Harness 管理入口覆盖技能、运行时资源包和 Residency', () => {
    const partial = read('client/chat/partials/workspaces/agent.html');
    const script = read('client/chat/agent-harness.js');
    assert.match(partial, /data-agent-config-open="harness"/);
    assert.match(partial, /data-agent-harness-nav="skills"/);
    assert.match(partial, /agent-harness-skill-manifest/);
    assert.match(partial, /agent-harness-pack-sync/);
    assert.match(partial, /agent-harness-residency-list/);
    assert.match(script, /\/agents\/skills/);
    assert.match(script, /\/agents\/runtime-packs/);
    assert.match(script, /\/agents\/residencies/);
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
    assert.match(detail, /captureAgentRunDisclosureState\(detail, runId\)/);
    assert.match(detail, /restoreAgentRunDisclosureState\(detail, run\.id\)/);
    assert.match(detail, /agentDisclosureRunId/);
});

test('底座诊断刷新会保留当前子页面', () => {
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
