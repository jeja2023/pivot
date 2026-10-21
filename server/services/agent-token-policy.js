const { normalizeTaskBudget } = require('./agent-budget');
const { getModelContextBudget, estimateMessagesTokens } = require('./context-budget');
const { classifyChatAutoExecution } = require('./chat-auto-execution');

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

function resolveChatAgentBudget({ modelCfg = {}, decision = {}, ragEnabled = false, mcpEnabled = false, content = '', history = [], systemPrompt = '', context = {} } = {}) {
    const automatic = decision.action === 'agent_run';
    const capabilities = decision.requiredCapabilities || [];
    const knowledgeOnly = ragEnabled && !mcpEnabled && String(content).length <= 12000
        && !decision.acceptance?.artifactRequired
        && !/【参考文档[:：]/.test(String(content))
        && (automatic
            ? capabilities.some(cap => /^knowledge\./.test(cap)) && capabilities.every(cap => /^(?:knowledge\.|agent\.execute$|conversation\.read_source$)/.test(cap))
            : classifyChatAutoExecution({ prompt: content }).action === 'direct_answer');
    const generalLimit = resolveModelTaskTokenBudget(modelCfg);
    if (!knowledgeOnly) return { profile: 'standard', history, budget: { max_steps: 30, max_tokens_total: generalLimit, max_runtime_seconds: 600 } };
    const recentHistory = history.slice(-6);
    const inputTokens = estimateMessagesTokens([
        { role: 'system', content: systemPrompt }, ...recentHistory,
        { role: 'user', content: [content, context.ragContext || '', context.memoryContext || ''].join('\n') }
    ]);
    // 简单问答按实际资料量预留少量回合，不按大模型窗口一次分配八轮额度。
    const tokenLimit = Math.min(generalLimit, 131072, Math.max(32768, inputTokens * 3 + 8192));
    return { profile: 'knowledge_qa', history: recentHistory, budget: { max_steps: 6, max_tool_calls: 6, max_tokens_total: tokenLimit, max_runtime_seconds: 600 } };
}

module.exports = { normalizeModelTaskBudget, resolveModelTaskTokenBudget, resolveChatAgentBudget };
