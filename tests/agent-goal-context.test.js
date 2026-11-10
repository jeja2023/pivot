'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { execute, queryOne } = require('../server/db/client');
const { selectGoalContinuation, resolveGoalRunContext, goalContextMessages, assertGoalContextPreserved } = require('../server/services/agent-goal-context');
const { buildPlannerMessages } = require('../server/services/agent-runtime/planner');
const { inspectRunKnowledgeAccess } = require('../server/services/knowledge-run-access');
const { assertAgentKnowledgeCurrent } = require('../server/services/agent-knowledge-boundary');
const { holdKnowledgeOutput } = require('../server/services/knowledge-output-guard');

const suffix = `${process.pid}-${Date.now()}`;
let user;
const runIds = [];
const goalId = `context-goal-${suffix}`;
async function addRun(name, metadata, status = 'partial', answer = '') {
    const id = `context-${name}-${suffix}`;
    await execute(`INSERT INTO agent_runs (id, user_id, title, goal, status, metadata, final_answer, created_at, updated_at)
        VALUES (?, ?, '跨次目标', '完成同一目标的未完成事项', ?, ?::jsonb, ?, NOW(), NOW())`, [id, user.id, status, JSON.stringify(metadata), answer]);
    runIds.push(id);
    return id;
}

test.before(async () => { user = await queryOne('SELECT id, role, unit FROM users ORDER BY id LIMIT 1'); });
test.after(async () => { for (const id of runIds.reverse()) await execute('DELETE FROM agent_runs WHERE id = ?', [id]); });

test('目标接续绑定同账号和同版本，定时任务不继承，未结束任务不能另起接续', async () => {
    const id = await addRun('source', { goalId, goalVersion: 2 });
    const goal = { id: goalId, kind: 'goal', version: 2, lastRunId: id };
    assert.deepEqual(await selectGoalContinuation(goal, user), { sourceRunId: id, goalId, goalVersion: 2 });
    assert.equal(await selectGoalContinuation({ ...goal, version: 3 }, user), null);
    assert.equal(await selectGoalContinuation(goal, { id: -1 }), null);
    assert.equal(await selectGoalContinuation({ ...goal, kind: 'scheduled_job' }, user), null);
    await execute("UPDATE agent_runs SET status = 'waiting_input' WHERE id = ?", [id]);
    await assert.rejects(() => selectGoalContinuation(goal, user), error => error.code === 'AGENT_GOAL_ALREADY_RUNNING');
});

test('接续完整保留旧答复、未完成事项、验收反馈和当前产物版本，触发资料进入规划消息', async () => {
    const answer = '前次结果'.repeat(300) + '最后一项仍待处理';
    const id = await addRun('payload', { goalId, goalVersion: 2, workingState: { pendingWork: [{ text: '核对最后一项' }], decisions: [{ text: '保留原始统计口径' }] } }, 'partial', answer);
    const run = { id: 'next-run', metadata: { source: 'goal', goalKind: 'goal', goalId, goalVersion: 2,
        triggerType: 'database', triggerInputs: { rows: [{ amount: '123.45' }], watermark: 'cursor-2' }, goalContinuation: { sourceRunId: id, goalId, goalVersion: 2 } } };
    let artifactReads = 0;
    const context = await resolveGoalRunContext(run, user, {
        artifactIds: async () => [{ id: 100 }], artifact: async (_, actor) => { artifactReads++; assert.equal(actor.id, user.id); return { id: 100, type: 'report', title: '已有报告', current_version: 4 }; }
    });
    assert.equal(artifactReads, 1);
    assert.equal(context.continuation.previousAnswer, answer);
    assert.deepEqual(context.continuation.pendingWork, [{ text: '核对最后一项' }]);
    assert.equal(context.continuation.artifacts[0].version, 4);
    const messages = buildPlannerMessages('接续目标', [], [], 'standard', { goalContext: context });
    const injected = messages.find(item => String(item.content).startsWith('PIVOT_GOAL_CONTEXT_BEGIN'));
    assert.equal(injected.role, 'user');
    assert.match(injected.content, /最后一项仍待处理/);
    assert.match(injected.content, /123.45/);
    assert.match(injected.content, /不构成新的授权/);
    assert.doesNotThrow(() => assertGoalContextPreserved(messages, messages));
    assert.throws(() => assertGoalContextPreserved(messages, messages.filter(item => item !== injected)), error => error.code === 'AGENT_GOAL_CONTEXT_LIMIT');
    assert.throws(() => buildPlannerMessages('接续目标', [], [], 'standard', { goalContext: context }, { context_window: 128, max_input_tokens: 64 }), /上下文|接续/);
    assert.equal(goalContextMessages(null).length, 0);
});

test('没有历史接续的触发任务也保留本次参数，超量不静默裁剪', async () => {
    const context = await resolveGoalRunContext({ metadata: { source: 'goal', triggerType: 'file', triggerInputs: { filePath: 'workspace/input.csv' } } }, user);
    assert.equal(context.triggerInputs.filePath, 'workspace/input.csv');
    assert.equal(context.continuation, undefined);
    await assert.rejects(() => resolveGoalRunContext({ metadata: { source: 'goal', triggerInputs: { text: 'x'.repeat(65537) } } }, user), error => error.code === 'AGENT_GOAL_CONTEXT_LIMIT');
});

test('接续来源撤销后后代读取、模型轮次和输出交付均受保护，循环血缘拒绝', async () => {
    const parent = await addRun('ancestor', { goalId, goalVersion: 2 });
    const metadata = { source: 'goal', goalId, goalKind: 'goal', goalVersion: 2, goalContinuation: { sourceRunId: parent, goalId, goalVersion: 2 } };
    const child = await addRun('descendant', metadata);
    assert.equal((await inspectRunKnowledgeAccess(child, user)).current, true);
    assert.equal(holdKnowledgeOutput({ metadata }), true);
    await execute('UPDATE agent_runs SET deleted_at = NOW() WHERE id = ?', [parent]);
    assert.equal((await inspectRunKnowledgeAccess(child, user)).current, false);
    await assert.rejects(() => assertAgentKnowledgeCurrent({ run: { id: child, metadata }, user }), error => error.code === 'KNOWLEDGE_SOURCE_UNAVAILABLE');
    await assert.rejects(() => resolveGoalRunContext({ id: child, metadata }, user), /不可访问|不存在/);
    await execute('UPDATE agent_runs SET deleted_at = NULL, metadata = ?::jsonb WHERE id = ?', [JSON.stringify({ goalContinuation: { sourceRunId: child } }), parent]);
    assert.equal((await inspectRunKnowledgeAccess(child, user)).current, false);
});
