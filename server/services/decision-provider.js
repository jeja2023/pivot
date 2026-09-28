'use strict';

/*
 * 业务动作决策的通用契约接口。
 * Laya 的 Router 负责选择内部语言模型检查点；本模块则仅在已通过
 * Pivot 权限检查的候选动作中进行选择与打分。
 */
const crypto = require('crypto');

const MAX_ACTIONS = 32;
const MAX_DESCRIPTION_LENGTH = 400;
const MAX_ERROR_LENGTH = 240;
const ACTION_ID_RE = /^[a-z][a-z0-9._:-]{0,95}$/;

function clamp(value, min = 0, max = 1) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : min;
}

function safeText(value, maxLength = 160) {
    return String(value ?? '')
        .replace(/[\u0000-\u001F\u007F]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, maxLength);
}

function normalizeActionId(value) {
    const actionId = safeText(value, 96).toLowerCase();
    return ACTION_ID_RE.test(actionId) ? actionId : '';
}

function normalizeCandidates(value = []) {
    const seen = new Set();
    const input = Array.isArray(value) ? value : [];
    return input.flatMap(item => {
        const id = normalizeActionId(item?.id || item?.actionId);
        if (!id || seen.has(id)) return [];
        seen.add(id);
        return [{
            id,
            type: safeText(item?.type || 'business_action', 64) || 'business_action',
            description: safeText(item?.description || item?.label || id, MAX_DESCRIPTION_LENGTH),
            source: safeText(item?.source || item?.generationMethod || 'policy_filtered', 80) || 'policy_filtered',
            risk: ['low', 'medium', 'high'].includes(String(item?.risk || '').toLowerCase())
                ? String(item.risk).toLowerCase()
                : 'low',
            requiresApproval: item?.requiresApproval === true,
            allowed: item?.allowed !== false
        }];
    }).slice(0, MAX_ACTIONS);
}

function scoresFrom(value, candidates = []) {
    const valid = new Set(candidates.map(candidate => candidate.id));
    const source = value && typeof value === 'object' ? value : {};
    const values = source.scores || source.actionScores || source.action_scores || {};
    const output = {};
    if (Array.isArray(values)) {
        values.forEach(item => {
            const id = normalizeActionId(item?.actionId || item?.id || item?.action);
            if (valid.has(id)) output[id] = clamp(item?.score ?? item?.confidence);
        });
    } else if (values && typeof values === 'object') {
        Object.entries(values).forEach(([key, score]) => {
            const id = normalizeActionId(key);
            if (valid.has(id)) output[id] = clamp(score);
        });
    }
    candidates.forEach(candidate => {
        if (output[candidate.id] === undefined) output[candidate.id] = 0;
    });
    return output;
}

function highestScoringAction(scores, candidates = []) {
    return candidates
        .filter(candidate => candidate.allowed)
        .slice()
        .sort((left, right) => Number(scores[right.id] || 0) - Number(scores[left.id] || 0) || left.id.localeCompare(right.id))[0]?.id || '';
}

function sanitizeDecisionContext(context = {}) {
    const candidates = normalizeCandidates(context.candidates || context.allowedActions);
    const task = context.taskState && typeof context.taskState === 'object' ? context.taskState : {};
    const toolIntent = task.toolIntent && typeof task.toolIntent === 'object' ? task.toolIntent : {};
    return {
        contractVersion: 1,
        decisionId: safeText(context.decisionId || '', 128),
        scenario: safeText(context.scenario || 'unknown', 80) || 'unknown',
        language: ['zh', 'en', 'unknown'].includes(String(context.language || '').toLowerCase())
            ? String(context.language).toLowerCase()
            : 'unknown',
        tenantId: Number.isSafeInteger(Number(context.tenantId)) ? Number(context.tenantId) : null,
        requestState: {
            taskHash: safeText(task.hash || context.taskHash || '', 128),
            status: safeText(task.status || 'active', 32),
            evidenceNeeds: Array.isArray(task.evidenceNeeds) ? task.evidenceNeeds.map(item => safeText(item, 80)).filter(Boolean).slice(0, 8) : [],
            requestedCapabilities: Array.isArray(toolIntent.requestedCapabilities)
                ? toolIntent.requestedCapabilities.map(item => safeText(item, 80)).filter(Boolean).slice(0, 8)
                : [],
            constraintCount: Math.max(0, Math.min(Number(task.constraintCount ?? task.constraints?.length ?? 0) || 0, 32)),
            entityCount: Math.max(0, Math.min(Number(task.entityCount ?? task.entities?.length ?? 0) || 0, 32))
        },
        candidates: candidates.map(({ id, type, description, source, risk, requiresApproval, allowed }) => ({
            id, type, description, source, risk, requiresApproval, allowed
        }))
    };
}

function redactRoutingText(value = '') {
    return String(value || '')
        .replace(/[\u0000-\u001F\u007F]/g, ' ')
        .replace(/(?:sk-|pk-|Bearer\s+)[A-Za-z0-9._~+/=-]{12,}/giu, '[SECRET]')
        .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/giu, '[EMAIL]')
        .replace(/(?:\+?86[-\s]?)?1[3-9]\d{9}/gu, '[PHONE]')
        .replace(/\b(?:\d{15}|\d{17}[0-9Xx])\b/gu, '[ID]')
        .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/gu, '[IP]')
        .replace(/[A-Za-z]:\\[^\s,，。；;]{1,240}|\/(?:[^\s/]+\/){1,12}[^\s,，。；;]*/gu, '[PATH]')
        .replace(/\b\d{7,}\b/gu, '[NUMBER]')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 512);
}

function buildDecisionProviderContext(context = {}, { includeRoutingText = false } = {}) {
    const safe = sanitizeDecisionContext(context);
    if (!includeRoutingText) return safe;
    const task = context.taskState && typeof context.taskState === 'object' ? context.taskState : {};
    const source = context.requestState?.routingText || task.routingText || task.retrievalQuery || task.currentQuestion || task.goal || '';
    const routingText = redactRoutingText(source);
    if (!routingText) return safe;
    return { ...safe, requestState: { ...safe.requestState, routingText } };
}

function normalizeProviderResult(value, { providerId, providerVersion = '', candidates = [], durationMs = 0, error = '' } = {}) {
    const source = value && typeof value === 'object' ? value : {};
    const scores = scoresFrom(source, candidates);
    const requested = normalizeActionId(source.selectedActionId || source.selected_action || source.actionId || source.action);
    const selectedActionId = candidates.some(candidate => candidate.id === requested && candidate.allowed)
        ? requested
        : highestScoringAction(scores, candidates);
    return {
        providerId: safeText(providerId || source.providerId || 'unknown', 80) || 'unknown',
        providerVersion: safeText(source.providerVersion || source.modelVersion || providerVersion, 128),
        selectedActionId,
        scores,
        durationMs: Math.max(0, Math.round(Number(source.durationMs ?? durationMs) || 0)),
        error: safeText(source.error || error, MAX_ERROR_LENGTH),
        metadata: source.metadata && typeof source.metadata === 'object' ? {
            model: safeText(source.metadata.model || source.model || '', 128),
            configurationVersion: safeText(source.metadata.configurationVersion || source.configurationVersion || '', 128)
        } : {}
    };
}

function createScoreDecisionProvider({ id = 'existing-router', version = 'heuristic-v1', scores = {}, selectedActionId = '', weight = 1 } = {}) {
    return {
        id: safeText(id, 80) || 'existing-router',
        version: safeText(version, 128),
        weight: Math.max(0, Number(weight) || 0),
        async decide(context) {
            return {
                selectedActionId,
                scores: typeof scores === 'function' ? scores(context) : scores,
                metadata: { model: 'deterministic', configurationVersion: version }
            };
        }
    };
}

function decisionFeatureMap(context = {}) {
    const safe = sanitizeDecisionContext(context);
    const request = safe.requestState || {};
    const features = new Set([
        'scenario:' + safe.scenario,
        'language:' + safe.language,
        'status:' + String(request.status || 'active'),
        'constraints:' + Math.min(3, Number(request.constraintCount || 0)),
        'entities:' + Math.min(3, Number(request.entityCount || 0)),
        'candidates:' + Math.min(8, safe.candidates.length)
    ]);
    (request.evidenceNeeds || []).forEach(value => features.add('evidence:' + safeText(value, 80)));
    (request.requestedCapabilities || []).forEach(value => features.add('capability:' + safeText(value, 80)));
    safe.candidates.filter(candidate => candidate.allowed).forEach(candidate => features.add('candidate:' + candidate.id));
    return [...features].sort();
}

function boundedWeight(value) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.max(-32, Math.min(32, number)) : 0;
}

function normalizeLinearModel(value = {}) {
    const source = value && typeof value === 'object' ? value : {};
    const actionWeights = source.actionWeights && typeof source.actionWeights === 'object' ? source.actionWeights : {};
    const normalized = {};
    Object.entries(actionWeights).slice(0, MAX_ACTIONS).forEach(([actionId, weights]) => {
        const id = normalizeActionId(actionId);
        if (!id || !weights || typeof weights !== 'object') return;
        const features = {};
        Object.entries(weights.features && typeof weights.features === 'object' ? weights.features : {}).slice(0, 256).forEach(([feature, weight]) => {
            const key = safeText(feature, 160);
            if (key) features[key] = boundedWeight(weight);
        });
        normalized[id] = { bias: boundedWeight(weights.bias), features };
    });
    return {
        schemaVersion: 1,
        providerId: safeText(source.providerId || 'light-linear', 80) || 'light-linear',
        modelVersion: safeText(source.modelVersion || source.version || '', 128),
        actionWeights: normalized
    };
}

function linearScores(context = {}, model = {}) {
    const safe = sanitizeDecisionContext(context);
    const normalizedModel = normalizeLinearModel(model);
    const features = decisionFeatureMap(context);
    const logits = {};
    safe.candidates.filter(candidate => candidate.allowed).forEach(candidate => {
        const weights = normalizedModel.actionWeights[candidate.id] || { bias: 0, features: {} };
        logits[candidate.id] = weights.bias + features.reduce((sum, feature) => sum + boundedWeight(weights.features && weights.features[feature]), 0);
    });
    const maximum = Math.max(...Object.values(logits), 0);
    const exponentials = Object.fromEntries(Object.entries(logits).map(([id, value]) => [id, Math.exp(Math.max(-64, Math.min(0, value - maximum)))]));
    const denominator = Object.values(exponentials).reduce((sum, value) => sum + value, 0);
    return Object.fromEntries(safe.candidates.map(candidate => [candidate.id, denominator && exponentials[candidate.id] ? exponentials[candidate.id] / denominator : 0]));
}

function createLinearDecisionProvider({ id = 'light-linear', version = '', model = {}, weight = 1 } = {}) {
    const normalizedModel = normalizeLinearModel(model);
    return {
        id: safeText(id, 80) || 'light-linear',
        version: safeText(version || normalizedModel.modelVersion, 128),
        weight: Math.max(0, Number(weight) || 0),
        async decide(context) {
            return {
                scores: linearScores(context, normalizedModel),
                metadata: { model: normalizedModel.providerId, configurationVersion: normalizedModel.modelVersion }
            };
        }
    };
}

function parseStructuredDecisionJson(value) {
    const raw = String(value || '').trim();
    if (!raw) return {};
    const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const candidate = fenced ? fenced[1].trim() : raw;
    try { return JSON.parse(candidate); } catch (_) {}
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start >= 0 && end > start) {
        try { return JSON.parse(candidate.slice(start, end + 1)); } catch (_) {}
    }
    return {};
}

function createStructuredModelDecisionProvider({ id = 'qwen', version = '', modelCfg = null, user = null, invoke = null, maxTokens = 256, weight = 1 } = {}) {
    return {
        id: safeText(id, 80) || 'qwen',
        version: safeText(version || modelCfg?.model_name || modelCfg?.name, 128),
        weight: Math.max(0, Number(weight) || 0),
        async decide(context, { signal } = {}) {
            if (!modelCfg || typeof invoke !== 'function') throw new Error('provider_not_configured');
            const safe = buildDecisionProviderContext(context, { includeRoutingText: context?.requestState?.routingText !== undefined });
            const messages = [
                { role: 'system', content: '你是 Pivot 的受控业务动作决策器。仅输出 JSON 对象：{"selectedActionId":"候选动作ID","scores":{"候选动作ID":0到1}}。只能从 candidates 中选；不得解释、不得调用工具、不得输出请求原文。' },
                { role: 'user', content: JSON.stringify(safe) }
            ];
            const output = await invoke(modelCfg, messages, {
                user,
                maxTokens: Math.max(64, Math.min(Number(maxTokens) || 256, 1024)),
                temperature: 0,
                enableThinking: false,
                responseFormat: { type: 'json_object' },
                signal
            });
            return {
                ...parseStructuredDecisionJson(output),
                metadata: { model: modelCfg.model_name || modelCfg.name || 'qwen', configurationVersion: version }
            };
        }
    };
}

function createHttpDecisionProvider({ id = 'laya', version = '', url = '', timeoutMs = 1200, headers = {}, weight = 1, fetchFn = globalThis.fetch } = {}) {
    const endpoint = String(url || '').trim();
    return {
        id: safeText(id, 80) || 'laya',
        version: safeText(version, 128),
        weight: Math.max(0, Number(weight) || 0),
        async decide(context, { signal } = {}) {
            if (!endpoint) throw new Error('provider_not_configured');
            if (typeof fetchFn !== 'function') throw new Error('fetch_unavailable');
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(new Error('provider_timeout')), Math.max(100, Number(timeoutMs) || 1200));
            const abortFromCaller = () => controller.abort(signal?.reason || new Error('provider_aborted'));
            signal?.addEventListener?.('abort', abortFromCaller, { once: true });
            try {
                const response = await fetchFn(endpoint, {
                    method: 'POST',
                    headers: { 'content-type': 'application/json', ...headers },
                    body: JSON.stringify(buildDecisionProviderContext(context, { includeRoutingText: context?.requestState?.routingText !== undefined })),
                    signal: controller.signal
                });
                if (!response.ok) throw new Error('provider_http_' + response.status);
                const body = await response.json();
                const returnedVersion = safeText(body?.providerVersion || body?.modelVersion || '', 128);
                if (version && returnedVersion && returnedVersion !== safeText(version, 128)) throw new Error('provider_version_mismatch');
                if (version && !returnedVersion) throw new Error('provider_version_missing');
                return {
                    ...body,
                    providerVersion: body?.providerVersion || body?.modelVersion || version,
                    metadata: { ...(body?.metadata || {}), model: body?.model || body?.metadata?.model || 'laya' }
                };
            } finally {
                clearTimeout(timer);
                signal?.removeEventListener?.('abort', abortFromCaller);
            }
        }
    };
}

async function evaluateDecisionProviders({ providers = [], context = {}, signal = null } = {}) {
    const sanitized = buildDecisionProviderContext(context, { includeRoutingText: context?.includeRoutingText === true });
    const candidates = sanitized.candidates;
    const safeProviders = Array.isArray(providers) ? providers.filter(provider => provider && typeof provider.decide === 'function') : [];
    return await Promise.all(safeProviders.map(async provider => {
        const startedAt = Date.now();
        try {
            const result = await provider.decide(sanitized, { signal });
            return {
                ...normalizeProviderResult(result, {
                    providerId: provider.id,
                    providerVersion: provider.version,
                    candidates,
                    durationMs: Date.now() - startedAt
                }),
                weight: Math.max(0, Number(provider.weight) || 0)
            };
        } catch (error) {
            return {
                ...normalizeProviderResult({}, {
                    providerId: provider.id,
                    providerVersion: provider.version,
                    candidates,
                    durationMs: Date.now() - startedAt,
                    error: error?.name === 'AbortError' ? 'provider_timeout' : error?.message || 'provider_error'
                }),
                weight: Math.max(0, Number(provider.weight) || 0)
            };
        }
    }));
}

function createDecisionId(prefix = 'decision') {
    return (safeText(prefix, 32) || 'decision') + '_' + crypto.randomUUID();
}

module.exports = {
    createDecisionId,
    createHttpDecisionProvider,
    createLinearDecisionProvider,
    createScoreDecisionProvider,
    createStructuredModelDecisionProvider,
    buildDecisionProviderContext,
    decisionFeatureMap,
    evaluateDecisionProviders,
    linearScores,
    normalizeActionId,
    normalizeCandidates,
    normalizeLinearModel,
    sanitizeDecisionContext
};
