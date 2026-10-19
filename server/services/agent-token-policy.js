const { normalizeTaskBudget } = require('./agent-budget');
const { getModelContextBudget } = require('./context-budget');

const MAX_AUTOMATIC_TOKEN_BUDGET = 10000000;
const MIN_AUTOMATIC_TOKEN_BUDGET = 500000;
const CONTEXT_ROUNDS = 8;

function resolveModelTaskTokenBudget(modelCfg = {}, env = process.env) {
    const configured = Number(env.AGENT_TASK_MAX_TOKENS_TOTAL);
    // 正数是部署方明确设置的累计限额；0 或留空按模型窗口自动分配。
    if (Number.isSafeInteger(configured) && configured > 0) return Math.min(MAX_AUTOMATIC_TOKEN_BUDGET, configured);
    const contextWindow = getModelContextBudget(modelCfg).contextWindow;
    return Math.min(MAX_AUTOMATIC_TOKEN_BUDGET, Math.max(MIN_AUTOMATIC_TOKEN_BUDGET, contextWindow * CONTEXT_ROUNDS));
}

function normalizeModelTaskBudget(config = {}, modelCfg = {}) {
    const source = config && typeof config === 'object' ? config : {};
    // 显式任务预算（含 0）及审批快照原样保留，不在恢复运行时扩大授权。
    if (source.max_tokens_total != null || source.maxTokensTotal != null) return normalizeTaskBudget(source);
    return normalizeTaskBudget({ ...source, max_tokens_total: resolveModelTaskTokenBudget(modelCfg) });
}

module.exports = { normalizeModelTaskBudget, resolveModelTaskTokenBudget };
