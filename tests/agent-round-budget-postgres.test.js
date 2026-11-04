'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { queryOne, execute } = require('../server/db/client');
const { prepareExecutionBudget } = require('../server/services/agent-runtime/execution-budget');
const { getChatTaskFeed } = require('../server/services/chat-task-feed');

test('累计预算跨运行实例恢复，聊天快照按本段和总轮次展示且用尽后禁止请求', async () => {
    const suffix = `${process.pid}-${Date.now()}`, runId = `round-budget-${suffix}`;
    const user = await queryOne("INSERT INTO users(username,password_hash,role,status) VALUES (?,'hash','user','active') RETURNING id,role", [`round-budget-${suffix}`]);
    try {
        await execute("INSERT INTO agent_runs(id,user_id,title,goal,status,run_mode,max_steps,budget_config,usage_stats,metadata,created_at,updated_at) VALUES (?,?,'轮次预算','检查数据','executing','standard',3,?,'{}','{}',NOW(),NOW())", [runId, user.id, JSON.stringify({ max_steps: 5, max_tool_calls: 8, max_tokens_total: 100000 })]);
        const load = () => queryOne('SELECT * FROM agent_runs WHERE id = ?', [runId]);
        const deps = { listSteps: async () => [], updateRun: async (_id, patch) => execute('UPDATE agent_runs SET usage_stats = ? WHERE id = ?', [patch.usage_stats, runId]) };
        const first = (await prepareExecutionBudget(await load(), deps)).taskBudget;
        for (let index = 0; index < 3; index++) {
            await first.beginPlanningRound(); first.consumeTool({ name: 'example.read', risk_level: 1, network: true });
            first.recordProgress('example.read', {}, { row: index }); await first.persistUsageSnapshot();
        }
        await execute('UPDATE agent_runs SET metadata = ? WHERE id = ?', [JSON.stringify({ autoContinuation: { count: 1 } }), runId]);
        const second = (await prepareExecutionBudget(await load(), deps)).taskBudget;
        assert.equal(second.counts.steps, 3); assert.equal(second.counts.tool_calls, 3);
        assert.equal(second.counts.network_requests, 3); assert.equal(second.counts.risk, 3);
        await second.beginPlanningRound();
        const feed = await getChatTaskFeed(runId, user);
        assert.equal(feed.progress.segmentRoundCount, 1); assert.equal(feed.progress.segmentRoundLimit, 3);
        assert.equal(feed.progress.totalRoundCount, 4); assert.equal(feed.progress.totalRoundLimit, 5);
        await second.beginPlanningRound();
        await assert.rejects(second.beginPlanningRound(), error => error.code === 'AGENT_BUDGET_EXCEEDED');
        const third = (await prepareExecutionBudget(await load(), deps)).taskBudget;
        assert.equal(third.counts.steps, 5);
        await assert.rejects(third.beginPlanningRound(), error => error.code === 'AGENT_BUDGET_EXCEEDED');
        await execute('UPDATE agent_runs SET metadata = ? WHERE id = ?', [JSON.stringify({ budgetStop: { code: 'AGENT_TOTAL_ROUND_LIMIT' } }), runId]);
        const metrics = await require('../server/repositories/agent-budget-quality').readBudgetStopSummary(user, '2026-01-01');
        assert.equal(metrics[0].code, 'AGENT_TOTAL_ROUND_LIMIT'); assert.equal(Number(metrics[0].samples), 1);
        assert.deepEqual(await require('../server/repositories/agent-budget-quality').readBudgetStopSummary({ id: Number(user.id) + 999999 }, '2026-01-01'), []);
    } finally {
        await execute('DELETE FROM agent_runs WHERE id = ?', [runId]);
        await execute('DELETE FROM users WHERE id = ?', [user.id]);
    }
});
