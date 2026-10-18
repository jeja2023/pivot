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

const { getUserRunnableModelsAsync, getRunnableModelForUserAsync, messagesContainVisionInput, modelSupportsVision } = require('./models');

const STRATEGIES = new Set(['fixed', 'auto-vision', 'auto-context', 'auto-cost', 'auto-load', 'auto-quality', 'auto-escalate']);
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
        { code: 'auto-load', label: '负载均衡', description: '挑选当前活跃占比最低的端点，降低排队等待。' },
        { code: 'auto-quality', label: '质量优先', description: '优先选择在同类已验收任务中通过率更高、且样本量足够的模型。' },
        { code: 'auto-escalate', label: '成本升级', description: '先用最便宜的模型出结果，置信不足时再升级到更强模型。' }
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

function findVisionCandidate(candidates, estimatedInputTokens = 0) {
    return pickAutoContext(candidates.filter(modelSupportsVision), estimatedInputTokens);
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

function pickAutoQuality(candidates, profiles = [], estimatedInputTokens) {
    const eligible = candidates.filter(model => hasUsableInputWindow(model, estimatedInputTokens));
    const profileByModel = new Map((profiles || []).filter(profile => profile?.eligible).map(profile => [Number(profile.modelId), profile]));
    const qualified = eligible.filter(model => profileByModel.has(Number(model.id)));
    if (!qualified.length) return null;
    return qualified.slice().sort((left, right) => {
        const leftProfile = profileByModel.get(Number(left.id));
        const rightProfile = profileByModel.get(Number(right.id));
        const quality = Number(rightProfile.verifiedRate) - Number(leftProfile.verifiedRate);
        if (quality !== 0) return quality;
        const incompleteness = Number(leftProfile.incompleteRate) - Number(rightProfile.incompleteRate);
        if (incompleteness !== 0) return incompleteness;
        const samples = Number(rightProfile.samples) - Number(leftProfile.samples);
        if (samples !== 0) return samples;
        return modelTotalPrice(left) - modelTotalPrice(right);
    })[0];
}

function summarizeQualityProfile(profile = null) {
    if (!profile) return null;
    return {
        taskType: String(profile.taskType || 'general'), samples: Number(profile.samples || 0),
        verifiedRate: Number(profile.verifiedRate || 0), verifiedRateLowerBound: Number(profile.verifiedRateLowerBound || 0),
        incompleteRate: Number(profile.incompleteRate || 0), ageDays: Number(profile.ageDays || 0),
        status: String(profile.status || ''), thresholds: profile.thresholds && typeof profile.thresholds === 'object' ? profile.thresholds : {}
    };
}

function modelProviderErrorText(error = {}) {
    const payload = error?.response?.data;
    let serialized = '';
    try { serialized = typeof payload === 'string' ? payload : JSON.stringify(payload || {}); } catch (_) {}
    return `${String(error?.code || '')} ${String(error?.message || '')} ${serialized}`.toLowerCase();
}

function isStructuredOutputIncompatibility(error = {}) {
    const status = Number(error?.response?.status || error?.status || error?.statusCode || 0);
    // 只把供应方明确拒绝 response_format / schema 的 4xx 视作可切换的能力
    // 不兼容；普通输入 4xx 仍须原样失败，不能借自动路由掩盖调用方错误。
    if (![400, 404, 422].includes(status)) return false;
    const message = modelProviderErrorText(error);
    const structuredFeature = /response[_ -]?format|json[_ -]?schema|json[_ -]?object|structured[_ -]?output|strict[_ -]?schema/.test(message);
    const unsupported = /unsupported|not\s+support(?:ed)?|does\s+not\s+support|unrecognized|unknown\s+(?:parameter|field|type)|not\s+available/.test(message);
    return structuredFeature && unsupported;
}

function modelProviderFailureReason(error = {}) {
    if (isStructuredOutputIncompatibility(error)) return 'structured_output_incompatible';
    const code = String(error?.code || '').trim();
    if (code) return code;
    const status = Number(error?.response?.status || error?.status || error?.statusCode || 0);
    return status ? `http_${status}` : 'provider_failure';
}

function isRecoverableModelProviderFailure(error = {}) {
    const code = String(error?.code || '').toUpperCase();
    if (['AGENT_RUN_CANCELLED', 'AGENT_TIMEOUT', 'AGENT_BUDGET_EXCEEDED', 'AGENT_USER_REVOKED'].includes(code)) return false;
    if (isStructuredOutputIncompatibility(error)) return true;
    if (['AGENT_MODEL_FIRST_RESPONSE_TIMEOUT', 'AGENT_MODEL_STREAM_IDLE', 'ECONNABORTED', 'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN', 'ENOTFOUND'].includes(code)) return true;
    const status = Number(error?.response?.status || error?.status || error?.statusCode || 0);
    return status === 429 || status >= 500;
}

async function pickFailoverModel({ user, currentModel, messages = [], candidateModels = null, endpointStatusGetter } = {}) {
    if (!user || !currentModel) return null;
    const estimatedTokens = estimateMessageTokens(messages);
    const visionRequired = messagesContainVisionInput(messages);
    const candidates = (Array.isArray(candidateModels) ? candidateModels : await getUserRunnableModelsAsync(user))
        .filter(model => model.status !== 'usage_only' && Number(model.id) !== Number(currentModel.id))
        .filter(model => !visionRequired || modelSupportsVision(model))
        .filter(model => hasUsableInputWindow(model, estimatedTokens));
    if (!candidates.length) return null;
    return pickAutoLoad(candidates, estimatedTokens, endpointStatusGetter) || pickAutoContext(candidates, estimatedTokens);
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
async function chooseModel({ user, strategy, hintModelId, messages = [], endpointStatusGetter, qualityProfiles = null, taskType = 'general', candidateModels = null }) {
    if (!user) return null;
    const normalized = normalizeStrategy(strategy);

    // fixed 策略：直接返回指定模型，不进行候选筛选
    if (normalized === 'fixed') {
        const fixed = hintModelId ? await getRunnableModelForUserAsync(hintModelId, user) : null;
        if (fixed) return { model: fixed, strategy: 'fixed', reason: '固定模型', candidatesCount: 1 };
        // 没有指定模型时也按 auto-context 兜底
    }

    const candidates = (Array.isArray(candidateModels) ? candidateModels : await getUserRunnableModelsAsync(user))
        .filter(model => model.status !== 'usage_only');
    if (candidates.length === 0) {
        const fallback = hintModelId ? await getRunnableModelForUserAsync(hintModelId, user) : null;
        return fallback ? { model: fallback, strategy: 'fixed', reason: '无可用模型候选，回退到原模型', candidatesCount: 0 } : null;
    }

    const estimatedTokens = estimateMessageTokens(messages);
    const hasVision = messagesContainVisionInput(messages);
    // 自动策略不能把含图片的请求路由到不支持视觉的模型。固定模型保留调用
    // 方原语义，由既有预检给出明确错误；自动选择则必须从能力兼容池中选。
    const eligibleCandidates = hasVision ? candidates.filter(modelSupportsVision) : candidates;
    if (!eligibleCandidates.length) {
        return { model: null, strategy: normalized, reason: '没有支持视觉输入的可用模型', candidatesCount: candidates.length };
    }
    let chosen = null;
    let reason = '';
    let qualityProfile = null;

    if (normalized === 'auto-vision') {
        if (hasVision) {
            chosen = findVisionCandidate(eligibleCandidates, estimatedTokens);
            reason = chosen ? '输入含图片，选用支持视觉的模型' : '';
        }
        if (!chosen) {
            chosen = pickAutoContext(eligibleCandidates, estimatedTokens);
            reason = reason || '无视觉模型可用，按上下文匹配';
        }
    } else if (normalized === 'auto-context') {
        chosen = pickAutoContext(eligibleCandidates, estimatedTokens);
        reason = chosen ? `按上下文匹配（估算 ${estimatedTokens} tokens）` : '';
    } else if (normalized === 'auto-cost') {
        chosen = pickAutoCost(eligibleCandidates, estimatedTokens);
        reason = chosen ? '按成本最低（输入+输出单价之和）' : '';
    } else if (normalized === 'auto-load') {
        chosen = pickAutoLoad(eligibleCandidates, estimatedTokens, endpointStatusGetter);
        reason = chosen ? '按端点负载最低' : '';
    } else if (normalized === 'auto-quality') {
        let profiles = Array.isArray(qualityProfiles) ? qualityProfiles : [];
        if (!profiles.length) {
            try {
                const { getModelQualityProfiles } = require('./agent-model-quality');
                profiles = await getModelQualityProfiles(user, taskType);
            } catch (_) {
                profiles = [];
            }
        }
        chosen = pickAutoQuality(eligibleCandidates, profiles, estimatedTokens);
        qualityProfile = chosen ? (profiles || []).find(profile => Number(profile?.modelId) === Number(chosen.id) && profile?.eligible) || null : null;
        reason = chosen ? '按同类已验收任务质量优先' : '';
        if (!chosen) {
            chosen = pickAutoContext(eligibleCandidates, estimatedTokens);
            reason = '质量样本不足，按上下文匹配回退';
        }
    } else if (normalized === 'auto-escalate') {
        // 第一轮：与 auto-cost 等同，挑最便宜的能用模型；调用方负责后续判断置信度并调用 pickEscalationModel
        chosen = pickAutoCost(eligibleCandidates, estimatedTokens);
        reason = chosen ? '先用成本最低模型尝试（auto-escalate 第一轮）' : '';
    }

    if (!chosen) {
        // 任何策略选不出时降级到 hint 指定模型
        const fallback = hintModelId ? await getRunnableModelForUserAsync(hintModelId, user) : null;
        if (fallback && (!hasVision || modelSupportsVision(fallback))) {
            return { model: fallback, strategy: 'fixed', reason: '路由未命中，回退到原模型', candidatesCount: candidates.length };
        }
        // 没有模型能同时满足自动策略、输入窗口与视觉能力时，宁可由调用方
        // 清晰失败，也不能静默换成不兼容的第一个候选。
        return { model: null, strategy: normalized, reason: hasVision ? '没有同时支持视觉输入和当前上下文的可用模型' : '没有能容纳当前上下文的可用模型', candidatesCount: candidates.length };
    }
    return { model: chosen, strategy: normalized, reason, candidatesCount: candidates.length, qualityProfile: summarizeQualityProfile(qualityProfile) };
}

// 低置信判定（auto-escalate 用）：根据输出内容、长度、finishReason 评估是否需要升级
// 这是启发式判断，不是绝对的；调用方可以叠加自己的业务规则
const LOW_CONFIDENCE_PATTERNS = [
    /不确定|无法判断|没有把握|缺少信息|信息不足|无法确认|很难判断|不清楚|抱歉.*?不能|抱歉.*?无法/,
    /\bi\s+don'?t\s+know\b|\bnot\s+sure\b|\bunclear\b|\binsufficient\s+information\b/i
];

function assessConfidence({ output = '', finishReason = '', minOutputChars = 20 } = {}) {
    const text = String(output || '').trim();
    if (!text) return { confident: false, reason: 'empty_output' };
    if (text.length < minOutputChars) return { confident: false, reason: 'too_short' };
    if (finishReason && !['stop', 'tool_calls', 'function_call', 'end_turn'].includes(String(finishReason).toLowerCase())) {
        return { confident: false, reason: `finish_reason:${finishReason}` };
    }
    if (LOW_CONFIDENCE_PATTERNS.some(pattern => pattern.test(text))) {
        return { confident: false, reason: 'low_confidence_phrase' };
    }
    return { confident: true, reason: 'pass' };
}

/**
 * auto-escalate 第二轮：从可用候选中挑一个比当前模型更强的（按"成本更高 OR 上下文更大"）
 * 输入：用户、当前模型、估算 token；输出：升级目标模型或 null（没有更强候选）
 */
async function pickEscalationModel({ user, currentModel, messages = [], candidateModels = null }) {
    if (!user || !currentModel) return null;
    const candidates = (Array.isArray(candidateModels) ? candidateModels : await getUserRunnableModelsAsync(user))
        .filter(m => m.status !== 'usage_only' && m.id !== currentModel.id);
    if (candidates.length === 0) return null;
    const estimatedTokens = estimateMessageTokens(messages);
    const currentPrice = modelTotalPrice(currentModel);
    const currentMaxInput = Number(currentModel.max_input_tokens) || 0;
    // 优先选"价格高于当前 + 能容纳输入"的候选；次选"上下文窗口更大"的
    const stronger = candidates.filter(m => hasUsableInputWindow(m, estimatedTokens)).filter(model => {
        const modelPrice = modelTotalPrice(model);
        const modelMaxInput = Number(model.max_input_tokens) || 0;
        return modelPrice > currentPrice || modelMaxInput > currentMaxInput;
    });
    if (stronger.length === 0) return null;
    stronger.sort((a, b) => {
        // 成本升级优先选择最小的价格增幅；同等价格下优先更大的上下文。
        // 上下文更大且不涨价的候选同样是有效升级，不应被更贵但更弱的
        // 候选遮蔽。
        const aPriceDelta = Math.max(0, modelTotalPrice(a) - currentPrice);
        const bPriceDelta = Math.max(0, modelTotalPrice(b) - currentPrice);
        if (aPriceDelta !== bPriceDelta) return aPriceDelta - bPriceDelta;
        const aLimit = Number(a.max_input_tokens) || Number.MAX_SAFE_INTEGER;
        const bLimit = Number(b.max_input_tokens) || Number.MAX_SAFE_INTEGER;
        return bLimit - aLimit;
    });
    return stronger[0];
}

module.exports = {
    STRATEGIES,
    DEFAULT_STRATEGY,
    normalizeStrategy,
    listStrategies,
    estimateMessageTokens,
    hasUsableInputWindow,
    modelTotalPrice,
    pickAutoQuality,
    pickFailoverModel,

    chooseModel,
    assessConfidence,
    isRecoverableModelProviderFailure,
    modelProviderFailureReason,
    pickEscalationModel
};
