'use strict';
const { resolveChildDelegationConstraints } = require('./agent-collaboration');

function budgetError(message) { return Object.assign(new Error(message), { code: 'AGENT_CHILD_BUDGET_EXCEEDED', status: 409, category: 'resource' }); }

function planSpawnTasks(input, run, rolePolicies, ledger = null) {
    const source = Array.isArray(input.tasks) ? input.tasks : [input];
    const inherited = {};
    for (const key of ['modelId', 'maxSteps', 'maxTokenBudget', 'toolPolicy', 'toolAllowlist', 'approvalPolicy', 'forkHistory']) {
        if (input[key] !== undefined) inherited[key] = input[key];
    }
    const tasks = source.map((value, index) => {
        const task = { ...inherited, ...(value && typeof value === 'object' ? value : {}) };
        const goal = String(task.goal || task.task || '').trim().slice(0, 12000);
        if (!goal) throw Object.assign(new Error(`第 ${index + 1} 个子任务缺少目标。`), { code: 'AGENT_CHILD_GOAL_REQUIRED', status: 400 });
        return { task, goal, constraints: resolveChildDelegationConstraints({ ...run, rolePolicies }, task) };
    });
    if (tasks.length < 2) return tasks;
    const budget = typeof run.budget_config === 'string' ? JSON.parse(run.budget_config) : run.budget_config || {};
    const limits = [Number(run.max_token_budget || 0) > 0 ? Number(run.max_token_budget) : null,
        Number(ledger?.token_budget || 0) > 0 ? Number(ledger.token_budget) : null,
        budget.max_tokens_total ?? budget.maxTokensTotal].filter(value => value != null && Number.isFinite(Number(value)) && Number(value) >= 0).map(Number);
    if (!limits.length) return tasks;
    const remaining = Math.max(0, Math.min(...limits) - Number(ledger?.tokens_reserved || 0) - Number(ledger?.tokens_consumed || 0));
    const explicit = tasks.reduce((sum, item) => sum + Math.max(0, Number(item.constraints.maxTokenBudget) || 0), 0);
    const unspecified = tasks.filter(item => !item.constraints.maxTokenBudget);
    if (explicit > remaining) throw budgetError('本批子任务的请求额度合计超过父任务剩余额度，请减少子任务额度。');
    // 未指定子额度时按剩余任务均分，并留一份给父任务收尾；不让第一个子任务占走全部余额。
    const share = Math.floor((remaining - explicit) / (unspecified.length + 1));
    if (unspecified.length && share <= 0) throw budgetError('父任务剩余额度不足以分配本批子任务并保留收尾空间。');
    for (const item of unspecified) item.constraints.maxTokenBudget = share;
    return tasks;
}

module.exports = { planSpawnTasks };
