const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');

test('自动化页面避免后台轮询误触发并防止列表响应倒灌', () => {
    const realtime = read('client/chat/agent-run-realtime.js');
    const runs = read('client/chat/agent-run-loaders.js');
    const workflows = read('client/chat/agent-workflow-library.js');
    const schedules = read('client/chat/agent-schedules.js');
    const workflowSchedules = read('client/chat/agent-workflow-schedules.js');

    assert.match(realtime, /isAgentElementVisible\('agent-workbench-modal'\)/);
    assert.doesNotMatch(realtime, /!document\.getElementById\('agent-workbench-modal'\)\?\.classList\.contains\('hidden'\)/);
    assert.match(runs, /let agentRunsLoadSequence = 0/);
    assert.match(runs, /requestId !== agentRunsLoadSequence/);
    assert.match(workflows, /requestId !== agentWorkflowsLoadSequence/);
    assert.match(schedules, /requestId !== agentSchedulesLoadSequence/);
    assert.match(workflowSchedules, /requestId !== agentWorkflowSchedulesLoadSequence/);
});

test('自动化执行操作具备幂等键、忙碌锁和网络错误恢复', () => {
    const actions = read('client/chat/agent-run-actions.js');
    const runners = read('client/chat/agent-workflow-runners.js');
    const schedules = read('client/chat/agent-schedules.js');
    const workflowSchedules = read('client/chat/agent-workflow-schedules.js');

    assert.match(actions, /const agentRunActionLocks = new Set/);
    assert.match(actions, /'Idempotency-Key': createAgentIdempotencyKey\(\)/);
    assert.match(runners, /'Idempotency-Key': \(typeof createAgentIdempotencyKey === 'function'/);
    assert.match(runners, /const agentWorkflowRunLocks = new Set/);
    assert.match(runners, /setAgentWorkflowRunBusy\(source, true\)/);
    assert.match(actions, /showToast\(error\.message \|\| fallbackMessage, 'error'\)/);
    assert.match(schedules, /const agentScheduleActionLocks = new Set/);
    assert.match(workflowSchedules, /const agentWorkflowScheduleActionLocks = new Set/);
});

test('自动化弹窗和主导航提供完整的对话框与选项卡语义', () => {
    const agent = read('client/chat/partials/workspaces/agent.html');
    const dag = read('client/chat/partials/workspaces/agent-dag.html');
    const library = read('client/chat/agent-workflow-library.js');
    const core = read('client/chat/agent-workflow-core.js');

    assert.match(agent, /role="tab"[^>]*aria-controls="agent-workbench-modal"/);
    assert.match(agent, /id="agent-run-detail-modal"[^>]*aria-hidden="true"/);
    assert.match(dag, /id="automation-workflows-panel"[^>]*role="tabpanel"/);
    assert.match(dag, /id="agent-workflow-metadata-modal"[^>]*role="dialog"[^>]*aria-hidden="true"/);
    assert.match(dag, /id="agent-workflow-share-modal"[^>]*role="dialog"[^>]*aria-hidden="true"/);
    assert.match(dag, /id="agent-workflow-dependency-modal"[^>]*role="dialog"[^>]*aria-hidden="true"/);
    assert.match(dag, /id="agent-dag-json-modal"[^>]*role="dialog"[^>]*aria-hidden="true"/);
    assert.match(library, /setAgentWorkflowLibraryModalVisibility\(modal, false\)/);
    assert.match(core, /modal\.setAttribute\('aria-hidden', 'false'\)/);
});

test('自动化资源将触发器和凭据能力接入页面，并避免回显敏感值', () => {
    const dag = read('client/chat/partials/workspaces/agent-dag.html');
    const resources = read('client/chat/agent-automation-resources.js');
    const credentials = read('server/services/workflow-credentials.js');
    const migrations = read('server/db/migrations/index.js');

    const extraModals = read('client/chat/partials/admin-extra-modals.html');
    assert.match(dag, /id="agent-workflow-dependency-manage-creds-btn"/);
    assert.match(dag, /id="agent-workflow-triggers-btn"[^>]*>自动启动</);
    assert.match(extraModals, /id="agent-automation-resources-modal"[^>]*role="dialog"[^>]*aria-hidden="true"/);
    assert.match(extraModals, /id="agent-automation-triggers-tab"[^>]*role="tab"/);
    assert.match(resources, /apiFetch\(`\$\{API_BASE\}\/agents\/triggers`\)/);
    assert.match(resources, /apiFetch\(`\$\{API_BASE\}\/agents\/credentials`\)/);
    assert.match(resources, /const agentAutomationResourceActionLocks = new Set/);
    assert.match(resources, /访问令牌只显示这一次/);
    assert.match(resources, /clearAgentAutomationResourceNotice\(\)/);
    assert.match(resources, /agentAutomationResourceWorkflowId/);
    assert.match(resources, /data-agent-automation-resource-tab/);
    assert.match(resources, /modal\.parentElement !== document\.body/);
    assert.match(resources, /modal\.style\.zIndex = '5600'/);
    assert.match(resources, /agent-automation-resources-modal--trigger/);
    assert.match(resources, /footer\?\.classList\.toggle\('hidden', isOpen\)/);
    const modalStyles = read('client/chat/styles/workspaces/agent/agent-workflow-modals.css');
    assert.match(modalStyles, /\.agent-automation-resources-modal--trigger/);
    assert.match(credentials, /allowed_user_ids: parseAllowedUserIds\(row\.allowed_user_ids\)/);
    assert.match(credentials, /allowed_units = \?, allowed_user_ids = \?, updated_at/);
    assert.match(migrations, /202608220008_workflow_credential_user_visibility/);
});
