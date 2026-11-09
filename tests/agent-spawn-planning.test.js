'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { planSpawnTasks } = require('../server/services/agent-spawn-planning');
const { executeAgentSpawn } = require('../server/services/agent-tools-collaboration');

const run = { id: 'spawn-plan', user_id: 1, model_id: 1, run_mode: 'standard', max_steps: 30,
    tool_policy: 'all', tool_allowlist: ['read'], budget_config: { max_tokens_total: 1000 } };
test('批量任务继承顶层资源参数并保留每项收紧，预检在创建任何任务前完成', () => {
    const plan = planSpawnTasks({ maxTokenBudget: 100, maxSteps: 12, toolPolicy: 'all',
        tasks: [{ goal: '读取甲资料' }, { goal: '读取乙资料', maxTokenBudget: 50, maxSteps: 6 }] }, run, {}, { tokens_consumed: 100 });
    assert.deepEqual(plan.map(item => item.constraints.maxTokenBudget), [100, 50]);
    assert.deepEqual(plan.map(item => item.constraints.maxSteps), [12, 6]);
    assert(plan.every(item => item.constraints.toolPolicy === 'all'));
    assert.throws(() => planSpawnTasks({ tasks: [{ goal: '有效目标' }, {}] }, run, {}), error => error.code === 'AGENT_CHILD_GOAL_REQUIRED');
    assert.throws(() => planSpawnTasks({ maxTokenBudget: 600, tasks: [{ goal: '读取甲资料' }, { goal: '读取乙资料' }] }, run, {}), error => error.code === 'AGENT_CHILD_BUDGET_EXCEEDED');
});

test('缺省批量子额度从真实剩余量分配，不独占余额，显式零总预算仍拒绝', () => {
    const input = { tasks: [{ goal: '读取甲资料' }, { goal: '读取乙资料' }] };
    const plan = planSpawnTasks(input, run, {}, { tokens_reserved: 100, tokens_consumed: 300 });
    assert.deepEqual(plan.map(item => item.constraints.maxTokenBudget), [200, 200]);
    assert.throws(() => planSpawnTasks(input, { ...run, budget_config: { max_tokens_total: 0 } }, {}), error => error.code === 'AGENT_CHILD_BUDGET_EXCEEDED');
});

test('并发准入导致半批创建时明确返回已创建子任务ID，不把部分创建藏在异常后', async () => {
    const created = [];
    const result = await executeAgentSpawn({ maxTokenBudget: 100, tasks: [{ goal: '读取甲资料' }, { goal: '读取乙资料' }] }, { id: 1 }, {
        run, collaborationRuntime: { createAgentRun: async input => {
            if (created.length) throw Object.assign(new Error('并发容量已变化'), { code: 'AGENT_CHILD_CONCURRENCY_EXCEEDED' });
            created.push(input); return { id: 'actual-child', status: 'queued' };
        } }
    });
    assert.equal(result.partial, true); assert.equal(result.complete, false);
    assert.equal(result.children[0].id, 'actual-child'); assert.equal(result.failedTaskIndex, 2);
    assert.equal(created[0].maxTokenBudget, 100);
});
