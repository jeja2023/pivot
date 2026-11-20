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
const { getModelEndpointRuntimeStatus, normalizeEndpointKey } = require('./model-runtime');
const { estimateMessagesTokens, getModelContextBudget, fitMessagesToContextBudget } = require('./context-budget');

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

function modelBudgetOptions(model, options = {}) {
    if (!options.minOutputTokens) return options;
    return { ...options, maxOutputTokens: require('./agent-model').resolveAgentMaxTokens(model, { minMaxTokens: options.minOutputTokens }) };
}

function hasUsableInputWindow(model, messages, budgetOptions) {
    try {
        fitMessagesToContextBudget(messages, model, modelBudgetOptions(model, budgetOptions));
        return true;
    } catch (error) {
        if (error.code !== 'CONTEXT_LENGTH_EXCEEDED') throw error;
        return false;
    }
}

function inputWindow(model, budgetOptions) {
    const budget = getModelContextBudget(model, modelBudgetOptions(model, budgetOptions));
    return budget.unbounded ? Number.MAX_SAFE_INTEGER : budget.inputBudget;
}

async function listModelCandidates(user, candidateModels) {
    const models = Array.isArray(candidateModels) ? candidateModels : await getUserRunnableModelsAsync(user, { forExecution: true });
    return models.filter(model => !model.secret_error && (!model.status || model.status === 'active'));
}

function modelTotalPrice(model) {
    const input = Number(model.input_price_per_million) || 0;
    const output = Number(model.output_price_per_million) || 0;
    return input + output;
}

function pickAutoContext(candidates, budgetOptions) {
    return candidates.slice().sort((a, b) => inputWindow(a, budgetOptions) - inputWindow(b, budgetOptions))[0] || null;
}

function pickAutoCost(candidates) {
    return candidates.slice().sort((a, b) => modelTotalPrice(a) - modelTotalPrice(b))[0] || null;
}

function readEndpointStatus(endpointStatusGetter) {
    try {
        const status = (endpointStatusGetter || getModelEndpointRuntimeStatus)();
        return Array.isArray(status) ? status : [];
    } catch (_) { return []; }
}

function endpointForModel(model, runtimeStatus) {
    return runtimeStatus.find(entry => entry.key === normalizeEndpointKey(model)
        || entry.models?.some(item => item.id != null && model.id != null && String(item.id) === String(model.id)));
}

function endpointAvailable(model, runtimeStatus) {
    const endpoint = endpointForModel(model, runtimeStatus);
    // 未采样的端点继续交给既有准入检查；明确熔断或拒绝准入不能被低负载排序重新选中。
    return !(Number(endpoint?.circuitOpenMs) > 0 || endpoint?.concurrency?.rejectingNewRequests === true);
}

function pickAutoLoad(candidates, runtimeStatus, budgetOptions) {
    if (!candidates.length) return null;
    if (!runtimeStatus.length) {
        // 没有运行时数据时回退到上下文匹配
        return pickAutoContext(candidates, budgetOptions);
    }
    const loadFor = (model) => {
        const entry = endpointForModel(model, runtimeStatus);
        if (!entry) return 0;
        const active = Number(entry.concurrency?.active) || 0;
        const max = Math.max(1, Number(entry.concurrency?.max) || Number(entry.configuredMaxConcurrent) || 1);
        return active / max;
    };
    return candidates.slice().sort((a, b) => loadFor(a) - loadFor(b))[0];
}

function pickAutoQuality(candidates, profiles = []) {
    const profileByModel = new Map((profiles || []).filter(profile => profile?.eligible).map(profile => [Number(profile.modelId), profile]));
    const qualified = candidates.filter(model => profileByModel.has(Number(model.id)));
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
    if (['AGENT_RUN_CANCELLED', 'AGENT_TIMEOUT', 'AGENT_BUDGET_EXCEEDED', 'AGENT_USER_REVOKED', 'INSUFFICIENT_QUOTA'].includes(code)) return false;
    if (isStructuredOutputIncompatibility(error)) return true;
    if (['AI_ENDPOINT_CIRCUIT_OPEN', 'AGENT_MODEL_FIRST_RESPONSE_TIMEOUT', 'AGENT_MODEL_STREAM_IDLE', 'ECONNABORTED', 'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN', 'ENOTFOUND'].includes(code)) return true;
    const status = Number(error?.response?.status || error?.status || error?.statusCode || 0);
    return status === 429 || status >= 500;
}

async function pickFailoverModel({ user, currentModel, messages = [], candidateModels = null, endpointStatusGetter, error = null, budgetOptions } = {}) {
    if (!user || !currentModel) return null;
    const visionRequired = messagesContainVisionInput(messages);
    const runtimeStatus = readEndpointStatus(endpointStatusGetter);
    const excludeFailedEndpoint = error && isRecoverableModelProviderFailure(error) && !isStructuredOutputIncompatibility(error);
    const candidates = (await listModelCandidates(user, candidateModels))
        .filter(model => Number(model.id) !== Number(currentModel.id))
        .filter(model => !visionRequired || modelSupportsVision(model))
        .filter(model => endpointAvailable(model, runtimeStatus)
            && (!excludeFailedEndpoint || normalizeEndpointKey(model) !== normalizeEndpointKey(currentModel)))
        .filter(model => hasUsableInputWindow(model, messages, budgetOptions));
    return pickAutoLoad(candidates, runtimeStatus, budgetOptions);
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
async function chooseModel({ user, strategy, hintModelId, messages = [], endpointStatusGetter, qualityProfiles = null, taskType = 'general', candidateModels = null, budgetOptions }) {
    if (!user) return null;
    let normalized = normalizeStrategy(strategy);

    // fixed 策略：直接返回指定模型，不进行候选筛选
    if (normalized === 'fixed') {
        const fixed = hintModelId ? await getRunnableModelForUserAsync(hintModelId, user) : null;
        if (fixed) return { model: fixed, strategy: 'fixed', reason: '固定模型', candidatesCount: 1 };
        normalized = 'auto-context';
    }

    const runtimeStatus = readEndpointStatus(endpointStatusGetter);
    const candidates = await listModelCandidates(user, candidateModels);
    if (candidates.length === 0) {
        const fallback = hintModelId ? await getRunnableModelForUserAsync(hintModelId, user) : null;
        return fallback && !fallback.secret_error && endpointAvailable(fallback, runtimeStatus) && hasUsableInputWindow(fallback, messages, budgetOptions)
            && (!messagesContainVisionInput(messages) || modelSupportsVision(fallback)) ? { model: fallback, strategy: 'fixed', reason: '无可用模型候选，回退到原模型', candidatesCount: 0 } : null;
    }

    const estimatedTokens = estimateMessagesTokens(messages);
    const hasVision = messagesContainVisionInput(messages);
    // 自动策略不能把含图片的请求路由到不支持视觉的模型。固定模型保留调用
    // 方原语义，由既有预检给出明确错误；自动选择则必须从能力兼容池中选。
    const availableCandidates = candidates.filter(model => endpointAvailable(model, runtimeStatus));
    if (!availableCandidates.length) return { model: null, strategy: normalized, reason: '所有可用模型端点暂时熔断或拒绝新请求，请稍后重试。', candidatesCount: candidates.length };
    const eligibleCandidates = hasVision ? availableCandidates.filter(modelSupportsVision) : availableCandidates;
    if (!eligibleCandidates.length) {
        return { model: null, strategy: normalized, reason: '没有支持视觉输入的可用模型', candidatesCount: candidates.length };
    }
    const fitting = eligibleCandidates.filter(model => hasUsableInputWindow(model, messages, budgetOptions));
    const fullContext = fitting.filter(model => estimatedTokens <= inputWindow(model, budgetOptions));
    const compatible = fullContext.length ? fullContext : fitting;
    let chosen = null;
    let reason = '';
    let qualityProfile = null;

    if (normalized === 'auto-vision') {
        chosen = pickAutoContext(compatible, budgetOptions);
        reason = hasVision ? '输入含图片，选用支持视觉的模型' : '按上下文匹配';
    } else if (normalized === 'auto-context') {
        chosen = pickAutoContext(compatible, budgetOptions);
        reason = chosen ? `按上下文匹配（估算 ${estimatedTokens} tokens）` : '';
    } else if (normalized === 'auto-cost') {
        chosen = pickAutoCost(compatible);
        reason = chosen ? '按成本最低（输入+输出单价之和）' : '';
    } else if (normalized === 'auto-load') {
        chosen = pickAutoLoad(compatible, runtimeStatus, budgetOptions);
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
        chosen = pickAutoQuality(compatible, profiles);
        qualityProfile = chosen ? (profiles || []).find(profile => Number(profile?.modelId) === Number(chosen.id) && profile?.eligible) || null : null;
        reason = chosen ? '按同类已验收任务质量优先' : '';
        if (!chosen) {
            chosen = pickAutoContext(compatible, budgetOptions);
            reason = '质量样本不足，按上下文匹配回退';
        }
    } else if (normalized === 'auto-escalate') {
        // 第一轮：与 auto-cost 等同，挑最便宜的能用模型；调用方负责后续判断置信度并调用 pickEscalationModel
        chosen = pickAutoCost(compatible);
        reason = chosen ? '先用成本最低模型尝试（auto-escalate 第一轮）' : '';
    }

    if (!chosen) {
        // 任何策略选不出时降级到 hint 指定模型
        const fallback = hintModelId ? await getRunnableModelForUserAsync(hintModelId, user) : null;
        if (fallback && !fallback.secret_error && endpointAvailable(fallback, runtimeStatus) && hasUsableInputWindow(fallback, messages, budgetOptions) && (!hasVision || modelSupportsVision(fallback))) {
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

// 升级优先采用同类任务的有效质量证据；没有证据时仅允许扩大上下文容量。
async function pickEscalationModel({ user, currentModel, messages = [], candidateModels = null, qualityProfiles = null, taskType = 'general', endpointStatusGetter, budgetOptions }) {
    if (!user || !currentModel) return null;
    const needsVision = messagesContainVisionInput(messages);
    const runtimeStatus = readEndpointStatus(endpointStatusGetter);
    const candidates = (await listModelCandidates(user, candidateModels))
        .filter(model => Number(model.id) !== Number(currentModel.id) && (!needsVision || modelSupportsVision(model))
            && endpointAvailable(model, runtimeStatus) && hasUsableInputWindow(model, messages, budgetOptions));
    if (!candidates.length) return null;
    let profiles = qualityProfiles;
    if (!Array.isArray(profiles)) {
        try { profiles = await require('./agent-model-quality').getModelQualityProfiles(user, taskType); } catch (_) { profiles = []; }
    }
    const current = profiles.find(profile => profile.modelId === Number(currentModel.id) && profile.eligible);
    const better = profiles.filter(profile => profile.eligible && (!current || profile.verifiedRateLowerBound > current.verifiedRateLowerBound));
    const proven = pickAutoQuality(candidates, better);
    if (proven) return proven;
    const currentWindow = inputWindow(currentModel, budgetOptions);
    return candidates.filter(model => inputWindow(model, budgetOptions) > currentWindow)
        .sort((left, right) => inputWindow(right, budgetOptions) - inputWindow(left, budgetOptions) || modelTotalPrice(left) - modelTotalPrice(right))[0] || null;
}

module.exports = {
    STRATEGIES,
    DEFAULT_STRATEGY,
    normalizeStrategy,
    listStrategies,
    estimateMessageTokens: estimateMessagesTokens,
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
