'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { execute, queryOne } = require('../server/db/client');
const {
    configureAgentGoals, createAgentGoal, getAgentGoal, normalizeGoalInput,
    previewAgentGoal, runAgentGoalNow, updateAgentGoal
} = require('../server/services/agent-goals');
const { createGoalDraft, confirmedGoalDraftInput, mergeConfirmedGoalDraftOverrides } = require('../server/services/agent-goal-drafts');

const suffix = `${process.pid}-${Date.now()}`;
const goalIds = [];
const modelIds = [];
const runIds = [];
let owner;
let other;
let firstModel;
let secondModel;
let privateModel;
let disabledModel;
let restrictedModel;

test.before(async () => {
    owner = await queryOne("SELECT id, username, unit, role FROM users WHERE username = 'admin'");
    other = await queryOne("INSERT INTO users (username, password_hash, nickname, unit, role, status, created_at) VALUES (?, 'hash', '模型隔离用户', '测试单位', 'user', 'active', NOW()) RETURNING id", [`goal-model-${suffix}`]);
    const addModel = async (userId, name, status = 'active', allowedUnits = null) => {
        const row = await queryOne('INSERT INTO models (user_id, name, url, model_name, status, allowed_units, created_at) VALUES (?, ?, ?, ?, ?, ?, NOW()) RETURNING id', [userId, `${name}-${suffix}`, 'http://127.0.0.1:65530/v1/chat/completions', `goal-model-${name}-${suffix}`, status, allowedUnits]);
        modelIds.push(Number(row.id));
        return Number(row.id);
    };
    firstModel = await addModel(owner.id, '目标执行一');
    secondModel = await addModel(owner.id, '目标执行二');
    privateModel = await addModel(other.id, '其他用户私有');
    disabledModel = await addModel(owner.id, '已停用', 'disabled');
    restrictedModel = await addModel(null, '其他单位专用', 'active', `无权访问-${suffix}`);
});

test.after(async () => {
    for (const id of goalIds) await execute('DELETE FROM agent_goals WHERE id = ?', [id]);
    for (const id of runIds) await execute('DELETE FROM agent_runs WHERE id = ?', [id]);
    for (const id of modelIds) await execute('DELETE FROM models WHERE id = ?', [id]);
    if (other) await execute('DELETE FROM users WHERE id = ?', [other.id]);
});

function goalInput(modelId) {
    return { title: `目标模型回归-${suffix}`, goal: '检查项目风险并汇总结果', triggerSpec: { type: 'manual' }, authorizationSpec: { modelId } };
}

async function createBoundGoal(input = goalInput(firstModel)) {
    const result = await createAgentGoal(owner, input);
    goalIds.push(result.goal.id);
    return result.goal;
}

test('持续目标保存前拒绝缺失、停用、越权及格式非法的模型', async () => {
    const before = await queryOne('SELECT COUNT(*) AS count FROM agent_goals WHERE title = ?', [goalInput().title]);
    for (const modelId of [undefined, null, '', 0, -1, 1.5, true, [], `${firstModel}abc`, Number.MAX_SAFE_INTEGER, privateModel, disabledModel, restrictedModel]) {
        await assert.rejects(() => createAgentGoal(owner, goalInput(modelId)), error => error.status === 400 && /模型/.test(error.message));
    }
    const after = await queryOne('SELECT COUNT(*) AS count FROM agent_goals WHERE title = ?', [goalInput().title]);
    assert.equal(after.count, before.count);
    assert.equal(normalizeGoalInput(goalInput(String(firstModel))).authorizationSpec.modelId, firstModel);
});

test('持续目标编辑保留模型和既有授权，允许换模并拒绝无效修改', async () => {
    const goal = await createBoundGoal({ ...goalInput(firstModel), kind: 'monitor', authorizationSpec: {
        modelId: firstModel, toolPolicy: 'builtin_only', toolAllowlist: ['rag.search'],
        approvalPolicy: 'approve_all_mcp', expiresAt: '2099-01-01T00:00:00Z', networkPolicy: { allowedHosts: ['example.com'] }
    } });
    const renamed = await updateAgentGoal(goal.id, owner, { title: '仅修改名称' });
    assert.equal(renamed.authorizationSpec.modelId, firstModel);
    const updated = await updateAgentGoal(goal.id, owner, { authorizationSpec: { modelId: secondModel, modelRouter: 'auto-cost' } });
    assert.equal(updated.authorizationSpec.modelId, secondModel);
    assert.equal(updated.authorizationSpec.modelRouter, 'auto-cost');
    assert.equal(updated.authorizationSpec.toolPolicy, 'builtin_only');
    assert.deepEqual(updated.authorizationSpec.toolAllowlist, ['rag.search']);
    assert.equal(updated.authorizationSpec.approvalPolicy, 'approve_all_mcp');
    assert.equal(updated.authorizationSpec.expiresAt, '2099-01-01T00:00:00Z');
    assert.deepEqual(updated.authorizationSpec.networkPolicy, { allowedHosts: ['example.com'] });
    assert.equal(updated.kind, 'monitor');
    const aliased = await updateAgentGoal(goal.id, owner, { authorization_spec: { model_id: firstModel, model_router: 'fixed', time_zone: 'UTC' } });
    assert.equal(aliased.authorizationSpec.modelId, firstModel);
    assert.equal(aliased.authorizationSpec.timezone, 'UTC');
    for (const modelId of [null, privateModel, disabledModel]) await assert.rejects(() => updateAgentGoal(goal.id, owner, { authorizationSpec: { modelId } }), /模型/);
    assert.equal((await getAgentGoal(goal.id, owner)).authorizationSpec.modelId, firstModel);
    assert.equal(await updateAgentGoal(goal.id, other, { authorizationSpec: { modelId: privateModel } }), null);
});

test('签名草案确认可绑定模型，历史未绑定目标可通过编辑修复', async () => {
    const options = { secret: 'goal-model-draft-test-secret-012345678901234567890' };
    const draft = createGoalDraft(owner, '每天 09:00 汇总项目风险', options);
    const signed = confirmedGoalDraftInput(owner, draft.confirmationToken, options);
    const goal = await createBoundGoal(mergeConfirmedGoalDraftOverrides(signed, { authorizationSpec: { modelId: firstModel } }));
    assert.equal(goal.authorizationSpec.modelId, firstModel);
    await execute("UPDATE agent_goals SET authorization_spec = '{}'::jsonb WHERE id = ?", [goal.id]);
    await assert.rejects(() => updateAgentGoal(goal.id, owner, { title: '未补模型' }), /执行模型/);
    const repaired = await updateAgentGoal(goal.id, owner, { authorizationSpec: { modelId: secondModel } });
    assert.equal(repaired.authorizationSpec.modelId, secondModel);
});

test('测试运行和实际触发传递绑定模型，并在模型失效后拒绝运行', async () => {
    const requests = [];
    configureAgentGoals({ createAgentRun: async request => {
        requests.push(request);
        const id = `goal-model-run-${suffix}-${requests.length}`;
        await execute("INSERT INTO agent_runs (id, user_id, title, goal, model_id, status, metadata, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'queued', ?, NOW(), NOW())", [id, owner.id, request.title, request.goal, request.modelId, JSON.stringify(request.metadata)]);
        runIds.push(id);
        return { id, model_id: request.modelId };
    } });
    const goal = await createBoundGoal();
    const preview = await previewAgentGoal(owner, goalInput(firstModel));
    assert.equal(preview.model_id, firstModel);
    assert.equal(requests[0].metadata.source, 'goal_preview');
    assert.equal((await getAgentGoal(goal.id, owner)).lastRunId, null);
    const run = await runAgentGoalNow(goal, owner, { triggerType: 'manual' });
    assert.equal(run.model_id, firstModel);
    assert.equal(requests[1].metadata.goalSnapshot.modelId, firstModel);
    await execute("UPDATE models SET status = 'disabled' WHERE id = ?", [firstModel]);
    await assert.rejects(() => previewAgentGoal(owner, goalInput(firstModel)), /模型不可用/);
    await assert.rejects(() => runAgentGoalNow(goal, owner, { triggerType: 'manual' }), /模型不可用/);
    assert.equal(requests.length, 2);
});
