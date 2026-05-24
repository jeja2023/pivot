/* 模型路由策略 Model Router
 *
 * 在用户/智能体配置了"模型路由策略"后，根据输入特征（视觉、上下文长度、成本、负载）
 * 自动从该用户可见的模型列表中选出一个。
 *
 * 策略：
 *   - fixed         保持原有行为：使用传入 hint 指定的 modelId，没有匹配则降级到 auto-context
 *   - auto-vision   含图片输入时优先选 supports_vision = 1 的模型；否则用次选（auto-context 兜底）
 *   - auto-context  在能容纳估算输入 Token 的候选中选 max_input_tokens 最小但满足的，避免大窗口模型浪费配额
 *   - auto-cost     在能容纳输入的候选中选 input_price_per_million + output_price_per_million 最低的
 *   - auto-load     按"端点当前活跃 / 端点并发上限"比值最小的候选，缓解长任务期间的排队
 *
 * 设计目标：
 *   - 默认行为兼容现有 agent_runs 流程（fixed = 旧行为）
 *   - 路由不会越权：候选池始终由 getUserRunnableModels 过滤
 *   - 路由失败时不抛错，回退到 hint 指定的模型或用户默认模型
 *   - 不依赖第三方包；所有信号都来自现有 DB / runtime 状态
 */

const { getUserRunnableModels, getRunnableModelForUser, messagesContainVisionInput, modelSupportsVision } = require('./models');

const STRATEGIES = new Set(['fixed', 'auto-vision', 'auto-context', 'auto-cost', 'auto-load']);
const DEFAULT_STRATEGY = 'fixed';

function normalizeStrategy(value) {
    const strategy = String(value || '').trim() || DEFAULT_STRATEGY;
    return STRATEGIES.has(strategy) ? strategy : DEFAULT_STRATEGY;
}

function listStrategies() {
    return [
        { code: 'fixed', label: '固定模型', description: '始终使用所选模型，等同于旧行为。' },
        { code: 'auto-vision', label: '视觉优先', description: '输入含图片时挑选支持视觉的模型，否则按上下文容量。' },
        { code: 'auto-context', label: '上下文匹配', description: '挑选能容纳输入但窗口最小的模型，节约大窗口配额。' },
        { code: 'auto-cost', label: '成本优先', description: '挑选输入+输出单价最低的可用模型。' },
        { code: 'auto-load', label: '负载均衡', description: '挑选当前活跃占比最低的端点，降低排队等待。' }
    ];
}

// 输入 Token 粗估：中文 2、其他 0.5；与 server/llm.js 中 estimateTokens 行为一致
function estimateMessageTokens(messages = []) {
    if (!Array.isArray(messages)) return 0;
    let total = 0;
    for (const message of messages) {
        const content = message?.content;
        const text = typeof content === 'string'
            ? content
            : Array.isArray(content)
                ? content.map(part => (part && typeof part === 'object' && typeof part.text === 'string') ? part.text : '').join(' ')
                : '';
        const chinese = (text.match(/[一-龥]/g) || []).length;
        const other = text.length - chinese;
        total += Math.ceil(chinese * 2 + other * 0.5);
    }
    return total;
}

function hasUsableInputWindow(model, estimatedInputTokens) {
    const limit = Number(model.max_input_tokens) || 0;
    if (limit <= 0) return true;
    return estimatedInputTokens <= limit;
}

function modelTotalPrice(model) {
    const input = Number(model.input_price_per_million) || 0;
    const output = Number(model.output_price_per_million) || 0;
    return input + output;
}

function findVisionCandidate(candidates) {
    return candidates.find(modelSupportsVision) || null;
}

function pickAutoContext(candidates, estimatedInputTokens) {
    const fit = candidates.filter(m => hasUsableInputWindow(m, estimatedInputTokens));
    if (fit.length === 0) return null;
    return fit.slice().sort((a, b) => {
        const aLimit = Number(a.max_input_tokens) || Number.MAX_SAFE_INTEGER;
        const bLimit = Number(b.max_input_tokens) || Number.MAX_SAFE_INTEGER;
        return aLimit - bLimit;
    })[0];
}

function pickAutoCost(candidates, estimatedInputTokens) {
    const fit = candidates.filter(m => hasUsableInputWindow(m, estimatedInputTokens));
    if (fit.length === 0) return null;
    return fit.slice().sort((a, b) => modelTotalPrice(a) - modelTotalPrice(b))[0];
}

function pickAutoLoad(candidates, estimatedInputTokens, endpointStatusGetter) {
    const fit = candidates.filter(m => hasUsableInputWindow(m, estimatedInputTokens));
    if (fit.length === 0) return null;
    let runtimeStatus = [];
    try {
        runtimeStatus = typeof endpointStatusGetter === 'function' ? (endpointStatusGetter() || []) : [];
    } catch (e) {
        runtimeStatus = [];
    }
    if (!Array.isArray(runtimeStatus) || runtimeStatus.length === 0) {
        // 没有运行时数据时回退到上下文匹配
        return pickAutoContext(fit, estimatedInputTokens);
    }
    const loadFor = (model) => {
        const entry = runtimeStatus.find(rt => Array.isArray(rt?.models) && rt.models.some(m => Number(m.id) === Number(model.id) || m.model_name === model.model_name));
        if (!entry) return 0;
        const active = Number(entry.concurrency?.active) || 0;
        const max = Math.max(1, Number(entry.concurrency?.max) || Number(entry.configuredMaxConcurrent) || 1);
        return active / max;
    };
    return fit.slice().sort((a, b) => loadFor(a) - loadFor(b))[0];
}

/**
 * 选择模型主入口。
 * @param {object} params
 * @param {object} params.user - 当前用户
 * @param {string} params.strategy - 路由策略，未识别时回退到 fixed
 * @param {string|number} params.hintModelId - 调用方原本想用的模型，作为 fixed 模式 + 兜底
 * @param {Array} [params.messages] - 即将发往模型的消息列表，用于估算 token 与视觉判断
 * @param {function} [params.endpointStatusGetter] - 注入式：返回 getModelEndpointRuntimeStatus()，便于测试
 * @returns {{ model: object, strategy: string, reason: string, candidatesCount: number }|null}
 */
function chooseModel({ user, strategy, hintModelId, messages = [], endpointStatusGetter }) {
    if (!user) return null;
    const normalized = normalizeStrategy(strategy);

    // fixed 策略：直接返回指定模型，不进行候选筛选
    if (normalized === 'fixed') {
        const fixed = hintModelId ? getRunnableModelForUser(hintModelId, user) : null;
        if (fixed) return { model: fixed, strategy: 'fixed', reason: '固定模型', candidatesCount: 1 };
        // 没有指定模型时也按 auto-context 兜底
    }

    const candidates = getUserRunnableModels(user).filter(model => model.status !== 'usage_only');
    if (candidates.length === 0) {
        const fallback = hintModelId ? getRunnableModelForUser(hintModelId, user) : null;
        return fallback ? { model: fallback, strategy: 'fixed', reason: '无可用模型候选，回退到原模型', candidatesCount: 0 } : null;
    }

    const estimatedTokens = estimateMessageTokens(messages);
    const hasVision = messagesContainVisionInput(messages);
    let chosen = null;
    let reason = '';

    if (normalized === 'auto-vision') {
        if (hasVision) {
            chosen = findVisionCandidate(candidates);
            reason = chosen ? '输入含图片，选用支持视觉的模型' : '';
        }
        if (!chosen) {
            chosen = pickAutoContext(candidates, estimatedTokens);
            reason = reason || '无视觉模型可用，按上下文匹配';
        }
    } else if (normalized === 'auto-context') {
        chosen = pickAutoContext(candidates, estimatedTokens);
        reason = chosen ? `按上下文匹配（估算 ${estimatedTokens} tokens）` : '';
    } else if (normalized === 'auto-cost') {
        chosen = pickAutoCost(candidates, estimatedTokens);
        reason = chosen ? '按成本最低（输入+输出单价之和）' : '';
    } else if (normalized === 'auto-load') {
        chosen = pickAutoLoad(candidates, estimatedTokens, endpointStatusGetter);
        reason = chosen ? '按端点负载最低' : '';
    }

    if (!chosen) {
        // 任何策略选不出时降级到 hint 指定模型
        const fallback = hintModelId ? getRunnableModelForUser(hintModelId, user) : null;
        if (fallback) return { model: fallback, strategy: 'fixed', reason: '路由未命中，回退到原模型', candidatesCount: candidates.length };
        // hint 都拿不到再回到候选第一个
        return { model: candidates[0], strategy: normalized, reason: '路由未命中，使用第一个可用候选', candidatesCount: candidates.length };
    }
    return { model: chosen, strategy: normalized, reason, candidatesCount: candidates.length };
}

module.exports = {
    STRATEGIES,
    DEFAULT_STRATEGY,
    normalizeStrategy,
    listStrategies,
    estimateMessageTokens,
    hasUsableInputWindow,
    modelTotalPrice,
    chooseModel
};
