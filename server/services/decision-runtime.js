'use strict';

const crypto = require('crypto');
const { readTypedEnv } = require('../config/env-registry');
const { createDecisionId, createHttpDecisionProvider, createLinearDecisionProvider, createScoreDecisionProvider, createStructuredModelDecisionProvider, evaluateDecisionProviders, sanitizeDecisionContext } = require('./decision-provider');
const { computeDecisionModelHash, loadLocalLinearDecisionModel } = require('./decision-light-model');
const { artifactScopeAllowsTenant, getActiveDecisionModelArtifact, isDecisionModelArtifactActive } = require('./decision-model-registry');
const { getDecisionPreference } = require('./decision-preferences');
const { getActiveDecisionPolicyArtifact } = require('./decision-policy-registry');
const { callModelText } = require('./agent-model');
const { applyDecisionPolicy } = require('./decision-policy');
const { recordDecision } = require('./decision-observability');

const layaConcurrency = new Map();
const qwenConcurrency = new Map();

function stableRolloutBucket(value) {
    return crypto.createHash('sha256').update(String(value || '')).digest()[0] % 100;
}

function isDecisionActiveForScope({ config, scenario, tenantId, sessionId, userId }) {
    if (config.mode !== 'active') return false;
    const tenantAllowlist = new Set(Array.isArray(config.rolloutTenants) ? config.rolloutTenants : []);
    const scenarioAllowlist = new Set(Array.isArray(config.rolloutScenarios) ? config.rolloutScenarios : []);
    if (tenantAllowlist.size && !tenantAllowlist.has(String(tenantId ?? ''))) return false;
    if (scenarioAllowlist.size && !scenarioAllowlist.has(String(scenario || ''))) return false;
    return stableRolloutBucket(tenantId + ':' + sessionId + ':' + userId) < Math.max(0, Number(config.rolloutPercent) || 0);
}

function acquireProviderSlot(slots, limit) {
    const safeLimit = Math.max(1, Number.parseInt(limit, 10) || 1);
    const key = String(safeLimit);
    const current = slots.get(key) || 0;
    if (current >= safeLimit) return false;
    slots.set(key, current + 1);
    return true;
}

function releaseProviderSlot(slots, limit) {
    const key = String(Math.max(1, Number.parseInt(limit, 10) || 1));
    const current = slots.get(key) || 0;
    if (current <= 1) slots.delete(key);
    else slots.set(key, current - 1);
}

function acquireLayaSlot(limit) {
    return acquireProviderSlot(layaConcurrency, limit);
}

function releaseLayaSlot(limit) {
    releaseProviderSlot(layaConcurrency, limit);
}

function acquireQwenSlot(limit) {
    return acquireProviderSlot(qwenConcurrency, limit);
}

function releaseQwenSlot(limit) {
    releaseProviderSlot(qwenConcurrency, limit);
}

function resolveTenantScopeArgs(tenantIdOrDeps = null, deps = {}) {
    if (tenantIdOrDeps && typeof tenantIdOrDeps === 'object' && !Array.isArray(tenantIdOrDeps)) {
        return { tenantId: null, deps: tenantIdOrDeps };
    }
    const tenantId = Number.parseInt(tenantIdOrDeps, 10);
    return { tenantId: Number.isSafeInteger(tenantId) && tenantId > 0 ? tenantId : null, deps: deps || {} };
}

async function isLocalLightArtifactEligible(model, config, tenantIdOrDeps = null, injectedDeps = {}) {
    const { tenantId, deps } = resolveTenantScopeArgs(tenantIdOrDeps, injectedDeps);
    if (config.mode !== 'active' || config.requireActiveArtifact !== true) return true;
    try {
        const artifact = await withDecisionTimeout((deps.getActiveDecisionModelArtifact || getActiveDecisionModelArtifact)('light-linear', { tenantId, fresh: true }), config.artifactTimeoutMs);
        return Boolean(artifact
            && String(artifact.model_version || '') === String(model?.modelVersion || '')
            && String(artifact.weights_hash || '') === computeDecisionModelHash(model)
            && (deps.artifactScopeAllowsTenant || artifactScopeAllowsTenant)(artifact, tenantId));
    } catch (_) {
        return false;
    }
}

async function isLearningProviderEligible(providerId, modelVersion, config, tenantIdOrDeps = null, injectedDeps = {}) {
    const { tenantId, deps } = resolveTenantScopeArgs(tenantIdOrDeps, injectedDeps);
    if (config.mode !== 'active' || config.requireActiveArtifact !== true) return true;
    try {
        return await withDecisionTimeout((deps.isDecisionModelArtifactActive || isDecisionModelArtifactActive)(providerId, modelVersion, { tenantId, fresh: true }), config.artifactTimeoutMs);
    } catch (_) {
        return false;
    }
}

async function withDecisionTimeout(work, timeoutMs) {
    let timer = null;
    try {
        return await Promise.race([
            work,
            new Promise((_, reject) => {
                timer = setTimeout(() => reject(new Error('decision_preference_timeout')), Math.max(25, Number(timeoutMs) || 100));
            })
        ]);
    } finally {
        if (timer) clearTimeout(timer);
    }
}

async function resolvePolicyArtifactConfiguration(config = {}, deps = {}) {
    const fallback = {
        version: config.version,
        autoThreshold: config.autoThreshold,
        highRiskThreshold: config.highRiskThreshold,
        calibrationScale: config.calibrationScale,
        calibrationIntercept: config.calibrationIntercept
    };
    if (config.useActivePolicyArtifact !== true) return { ...fallback, artifactId: '', artifactStatus: 'env_only', activeEligible: config.mode !== 'active' };
    try {
        // active 灰度不接受进程内缓存的过期策略制品：另一实例的回滚必须在
        // 下一轮决策就生效，而不是等 30 秒 TTL。
        const artifact = await withDecisionTimeout((deps.getActiveDecisionPolicyArtifact || getActiveDecisionPolicyArtifact)({ ...deps, fresh: config.mode === 'active' }), config.artifactTimeoutMs);
        if (!artifact?.policyConfig) return { ...fallback, artifactId: '', artifactStatus: 'unavailable', activeEligible: false };
        return {
            ...fallback,
            ...artifact.policyConfig,
            artifactId: String(artifact.id || ''),
            artifactStatus: 'active',
            activeEligible: true
        };
    } catch (_) {
        return { ...fallback, artifactId: '', artifactStatus: 'unavailable', activeEligible: false };
    }
}

function isQwenDecisionModel(modelCfg = {}) {
    return /(?:qwen|qwq)/iu.test(String(modelCfg?.model_name || '') + ' ' + String(modelCfg?.name || ''));
}

function inferLanguage(taskState = {}) {
    const values = [taskState.currentQuestion, taskState.retrievalQuery, taskState.goal].filter(Boolean).join(' ');
    if (/[\u4e00-\u9fff]/u.test(values)) return 'zh';
    if (/[A-Za-z]/.test(values)) return 'en';
    return 'unknown';
}

function getDecisionRuntimeConfig(env = process.env) {
    return {
        mode: readTypedEnv('PIVOT_DECISION_PROVIDER_MODE', env),
        version: readTypedEnv('PIVOT_DECISION_POLICY_VERSION', env),
        evaluationSetVersion: readTypedEnv('PIVOT_DECISION_EVALUATION_SET_VERSION', env),
        autoThreshold: readTypedEnv('PIVOT_DECISION_AUTO_THRESHOLD', env),
        highRiskThreshold: readTypedEnv('PIVOT_DECISION_HIGH_RISK_THRESHOLD', env),
        calibrationScale: readTypedEnv('PIVOT_DECISION_CALIBRATION_SCALE', env),
        calibrationIntercept: readTypedEnv('PIVOT_DECISION_CALIBRATION_INTERCEPT', env),
        rolloutPercent: readTypedEnv('PIVOT_DECISION_ROLLOUT_PERCENT', env),
        rolloutTenants: readTypedEnv('PIVOT_DECISION_ROLLOUT_TENANTS', env),
        rolloutScenarios: readTypedEnv('PIVOT_DECISION_ROLLOUT_SCENARIOS', env),
        requireActiveArtifact: readTypedEnv('PIVOT_DECISION_REQUIRE_ACTIVE_ARTIFACT', env),
        useActivePolicyArtifact: readTypedEnv('PIVOT_DECISION_USE_ACTIVE_POLICY_ARTIFACT', env),
        preferencesEnabled: readTypedEnv('PIVOT_DECISION_PREFERENCES_ENABLED', env),
        includeRedactedRoutingText: readTypedEnv('PIVOT_DECISION_INCLUDE_REDACTED_ROUTING_TEXT', env),
        artifactTimeoutMs: readTypedEnv('PIVOT_DECISION_ARTIFACT_TIMEOUT_MS', env),
        preferenceTimeoutMs: readTypedEnv('PIVOT_DECISION_PREFERENCE_TIMEOUT_MS', env),
        light: {
            enabled: readTypedEnv('PIVOT_LIGHT_DECISION_ENABLED', env),
            modelRoot: readTypedEnv('PIVOT_LIGHT_DECISION_MODEL_ROOT', env),
            modelFile: readTypedEnv('PIVOT_LIGHT_DECISION_MODEL_FILE', env),
            weight: readTypedEnv('PIVOT_LIGHT_DECISION_WEIGHT', env)
        },
        qwen: {
            enabled: readTypedEnv('PIVOT_QWEN_DECISION_ENABLED', env),
            version: readTypedEnv('PIVOT_QWEN_DECISION_VERSION', env),
            maxTokens: readTypedEnv('PIVOT_QWEN_DECISION_MAX_TOKENS', env),
            timeoutMs: readTypedEnv('PIVOT_QWEN_DECISION_TIMEOUT_MS', env),
            maxConcurrent: readTypedEnv('PIVOT_QWEN_DECISION_MAX_CONCURRENT', env),
            weight: readTypedEnv('PIVOT_QWEN_DECISION_WEIGHT', env)
        },
        laya: {
            enabled: readTypedEnv('PIVOT_LAYA_DECISION_ENABLED', env),
            url: readTypedEnv('PIVOT_LAYA_DECISION_URL', env),
            version: readTypedEnv('PIVOT_LAYA_DECISION_VERSION', env),
            timeoutMs: readTypedEnv('PIVOT_LAYA_DECISION_TIMEOUT_MS', env),
            maxConcurrent: readTypedEnv('PIVOT_LAYA_DECISION_MAX_CONCURRENT', env),
            weight: readTypedEnv('PIVOT_LAYA_DECISION_WEIGHT', env)
        }
    };
}

async function resolveBusinessDecision({ scenario, taskState, tenantId = null, userId = null, user = null, sessionId = '', candidates = [], fallbackActionId, actionScores = {}, baselineVersion = 'semantic-router-v1', modelCfg = null, signal = null, env = process.env } = {}, deps = {}) {
    const config = (deps.getDecisionRuntimeConfig || getDecisionRuntimeConfig)(env);
    const decisionId = createDecisionId('decision');
    const context = {
        decisionId,
        scenario,
        language: inferLanguage(taskState),
        tenantId,
        taskState,
        candidates,
        includeRoutingText: config.includeRedactedRoutingText === true
    };
    let preference = null;
    if (config.preferencesEnabled === true) {
        try {
            preference = await withDecisionTimeout((deps.getDecisionPreference || getDecisionPreference)({ userId, tenantId, scenario }), config.preferenceTimeoutMs);
        } catch (_) {
            // 偏好是可选的增强层；读取失败时继续执行原策略与回退。
        }
    }

    const providers = [createScoreDecisionProvider({
        id: 'existing-router',
        version: baselineVersion,
        scores: actionScores,
        selectedActionId: fallbackActionId,
        weight: 1,
        isBaseline: true
    })];
    const preparationOutputs = [];
    if (config.mode !== 'disabled' && config.light?.enabled) {
        try {
            const lightModel = await (deps.loadLocalLinearDecisionModel || loadLocalLinearDecisionModel)({
                rootDir: config.light.modelRoot,
                modelFile: config.light.modelFile
            });
            if (await isLocalLightArtifactEligible(lightModel, config, tenantId, deps)) {
                providers.push(createLinearDecisionProvider({
                    id: 'light-linear',
                    version: lightModel.modelVersion,
                    model: lightModel,
                    weight: config.light.weight
                }));
            } else {
                preparationOutputs.push({ providerId: 'light-linear', providerVersion: lightModel.modelVersion, selectedActionId: '', scores: {}, durationMs: 0, error: 'artifact_not_active', metadata: {}, weight: config.light.weight });
            }
        } catch (error) {
            preparationOutputs.push({
                providerId: 'light-linear',
                providerVersion: '',
                selectedActionId: '',
                scores: {},
                durationMs: 0,
                error: String(error?.message || 'light_model_unavailable').slice(0, 240),
                metadata: {},
                weight: config.light.weight
            });
        }
    }
    let qwenSlotAcquired = false;
    let qwenConcurrencyLimited = false;
    if (config.mode !== 'disabled' && config.qwen?.enabled) {
        if (isQwenDecisionModel(modelCfg)) {
            const modelVersion = String(config.qwen.version || '').trim();
            if (!modelVersion) {
                preparationOutputs.push({ providerId: 'qwen', providerVersion: '', selectedActionId: '', scores: {}, durationMs: 0, error: 'provider_version_not_configured', metadata: {}, weight: config.qwen.weight });
            } else if (!await isLearningProviderEligible('qwen', modelVersion, config, tenantId, deps)) {
                preparationOutputs.push({ providerId: 'qwen', providerVersion: modelVersion, selectedActionId: '', scores: {}, durationMs: 0, error: 'artifact_not_active', metadata: {}, weight: config.qwen.weight });
            } else if (acquireQwenSlot(config.qwen.maxConcurrent)) {
                qwenSlotAcquired = true;
                providers.push(createStructuredModelDecisionProvider({
                    id: 'qwen',
                    version: modelVersion,
                    modelCfg,
                    user,
                    invoke: deps.callModelText || callModelText,
                    maxTokens: config.qwen.maxTokens,
                    timeoutMs: config.qwen.timeoutMs,
                    weight: config.qwen.weight
                }));
            } else {
                qwenConcurrencyLimited = true;
            }
        } else {
            preparationOutputs.push({
                providerId: 'qwen',
                providerVersion: '',
                selectedActionId: '',
                scores: {},
                durationMs: 0,
                error: 'provider_model_ineligible',
                metadata: {},
                weight: config.qwen.weight
            });
        }
    }

    let layaSlotAcquired = false;
    let layaConcurrencyLimited = false;
    if (config.mode !== 'disabled' && config.laya?.enabled && config.laya.url) {
        if (!String(config.laya.version || '').trim()) {
            preparationOutputs.push({ providerId: 'laya', providerVersion: '', selectedActionId: '', scores: {}, durationMs: 0, error: 'provider_version_not_configured', metadata: {}, weight: config.laya.weight });
        } else if (!await isLearningProviderEligible('laya', config.laya.version, config, tenantId, deps)) {
            preparationOutputs.push({ providerId: 'laya', providerVersion: config.laya.version, selectedActionId: '', scores: {}, durationMs: 0, error: 'artifact_not_active', metadata: {}, weight: config.laya.weight });
        } else if (acquireLayaSlot(config.laya.maxConcurrent)) {
            layaSlotAcquired = true;
            providers.push(createHttpDecisionProvider({
                id: 'laya',
                version: config.laya.version,
                url: config.laya.url,
                timeoutMs: config.laya.timeoutMs,
                weight: config.laya.weight,
                fetchFn: deps.fetchFn || globalThis.fetch
            }));
        } else {
            layaConcurrencyLimited = true;
        }
    }
    let providerOutputs;
    try {
        providerOutputs = [...preparationOutputs, ...await evaluateDecisionProviders({ providers, context, signal })];
    } finally {
        if (layaSlotAcquired) releaseLayaSlot(config.laya.maxConcurrent);
        if (qwenSlotAcquired) releaseQwenSlot(config.qwen.maxConcurrent);
    }
    if (qwenConcurrencyLimited) {
        providerOutputs.push({
            providerId: 'qwen',
            providerVersion: config.qwen.version,
            selectedActionId: '',
            scores: {},
            durationMs: 0,
            error: 'provider_concurrency_limited',
            metadata: { model: 'qwen', configurationVersion: config.qwen.version },
            weight: config.qwen.weight
        });
    }
    if (layaConcurrencyLimited) {
        providerOutputs.push({
            providerId: 'laya',
            providerVersion: config.laya.version,
            selectedActionId: '',
            scores: {},
            durationMs: 0,
            error: 'provider_concurrency_limited',
            metadata: { model: 'laya', configurationVersion: config.laya.version },
            weight: config.laya.weight
        });
    }
    const policyParameters = await resolvePolicyArtifactConfiguration(config, deps);
    const requestedActive = isDecisionActiveForScope({ config, scenario, tenantId, sessionId, userId, decisionId });
    const policyMode = config.mode === 'disabled'
        ? 'disabled'
        : requestedActive && policyParameters.activeEligible ? 'active' : 'shadow';
    const policy = {
        ...applyDecisionPolicy({
            candidates,
            providerOutputs,
            fallbackActionId,
            explicitActionId: preference?.actionId || '',
            preferenceId: preference?.id || '',
            config: {
                mode: policyMode,
                version: policyParameters.version,
                autoThreshold: policyParameters.autoThreshold,
                highRiskThreshold: policyParameters.highRiskThreshold,
                calibrationScale: policyParameters.calibrationScale,
                calibrationIntercept: policyParameters.calibrationIntercept
            }
        }),
        policyArtifactId: policyParameters.artifactId,
        policyArtifactStatus: policyParameters.artifactStatus
    };
    const decision = {
        decisionId,
        context: sanitizeDecisionContext(context),
        tenantId,
        userId,
        sessionId,
        providerOutputs,
        policy,
        selectedActionId: policy.selectedActionId
    };
    try { (deps.recordDecision || recordDecision)(decision); } catch (_) {}
    return decision;
}

module.exports = {
    getDecisionRuntimeConfig,
    isDecisionActiveForScope,
    isLocalLightArtifactEligible,
    resolveBusinessDecision
};
