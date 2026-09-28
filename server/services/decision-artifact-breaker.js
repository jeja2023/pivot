'use strict';

const { query } = require('../db/client');
const { rollbackDecisionModelArtifact } = require('./decision-model-registry');
const { logger } = require('../logger');
const { readTypedEnv } = require('../config/env-registry');

const ACTIVE_ARTIFACTS_SQL = [
    "SELECT id, provider_id, model_version, evaluation_report FROM decision_model_artifacts WHERE status = 'active'",
    "ORDER BY promoted_at DESC NULLS LAST, created_at DESC LIMIT 100"
].join(' ');
const POLICY_WINDOW_METRICS_SQL = [
    "SELECT COUNT(DISTINCT d.decision_id) AS samples,",
    "0 AS provider_errors,",
    "COUNT(DISTINCT d.decision_id) FILTER (WHERE EXISTS (",
    "SELECT 1 FROM decision_outcomes o WHERE o.decision_id = d.decision_id",
    "AND o.event_type = 'execution' AND o.status = 'failure'",
    ")) AS execution_failures",
    "FROM decision_records d",
    "WHERE d.policy_outcome->>'policyArtifactId' = ?",
    "AND d.created_at >= CURRENT_TIMESTAMP - (?::integer * INTERVAL '1 minute')"
].join(' ');

const PROVIDER_WINDOW_METRICS_SQL = [
    "SELECT COUNT(DISTINCT d.decision_id) AS samples,",
    "COUNT(DISTINCT d.decision_id) FILTER (WHERE COALESCE(provider.value->>'error', '') <> '') AS provider_errors,",
    "COUNT(DISTINCT d.decision_id) FILTER (WHERE EXISTS (",
    "SELECT 1 FROM decision_outcomes o WHERE o.decision_id = d.decision_id",
    "AND o.event_type = 'execution' AND o.status = 'failure'",
    ")) AS execution_failures",
    "FROM decision_records d CROSS JOIN LATERAL jsonb_array_elements(d.provider_outputs) provider(value)",
    "WHERE provider.value->>'providerId' = ? AND provider.value->>'providerVersion' = ?",
    "AND d.created_at >= CURRENT_TIMESTAMP - (?::integer * INTERVAL '1 minute')"
].join(' ');

function parseJson(value, fallback = {}) {
    if (value && typeof value === 'object') return value;
    try { return JSON.parse(String(value || '')); } catch (_) { return fallback; }
}

function normalizeBreakerThresholds(value = {}) {
    const source = value && typeof value === 'object' ? value : {};
    const minSamples = Math.max(1, Math.min(Number.parseInt(source.minSamples, 10) || 0, 100000));
    const maxProviderErrorRate = Number(source.maxProviderErrorRate);
    const maxExecutionFailureRate = Number(source.maxExecutionFailureRate);
    if (!minSamples || !Number.isFinite(maxProviderErrorRate) || !Number.isFinite(maxExecutionFailureRate)) return null;
    return {
        minSamples,
        maxProviderErrorRate: Math.max(0, Math.min(maxProviderErrorRate, 1)),
        maxExecutionFailureRate: Math.max(0, Math.min(maxExecutionFailureRate, 1))
    };
}

function artifactBreakerThresholds(artifact = {}) {
    const report = parseJson(artifact.evaluation_report, {});
    return normalizeBreakerThresholds(report.breakerThresholds || report.breaker_thresholds || {});
}

function evaluateDecisionArtifactBreaker(thresholds, metrics = {}) {
    const samples = Math.max(0, Number(metrics.samples) || 0);
    const providerErrors = Math.max(0, Number(metrics.providerErrors ?? metrics.provider_errors) || 0);
    const executionFailures = Math.max(0, Number(metrics.executionFailures ?? metrics.execution_failures) || 0);
    if (!thresholds || samples < thresholds.minSamples) return { tripped: false, reason: 'insufficient_samples', samples };
    const providerErrorRate = providerErrors / samples;
    const executionFailureRate = executionFailures / samples;
    if (providerErrorRate > thresholds.maxProviderErrorRate) {
        return { tripped: true, reason: 'provider_error_rate', samples, actual: providerErrorRate, limit: thresholds.maxProviderErrorRate, providerErrorRate, executionFailureRate };
    }
    if (executionFailureRate > thresholds.maxExecutionFailureRate) {
        return { tripped: true, reason: 'execution_failure_rate', samples, actual: executionFailureRate, limit: thresholds.maxExecutionFailureRate, providerErrorRate, executionFailureRate };
    }
    return { tripped: false, reason: 'within_threshold', samples, providerErrorRate, executionFailureRate };
}

async function collectDecisionArtifactMetrics(artifact, windowMinutes, deps = {}) {
    const queryFn = deps.query || query;
    const safeWindowMinutes = Math.max(1, Math.min(Number.parseInt(windowMinutes, 10) || 30, 24 * 60));
    const rows = String(artifact.provider_id || '') === 'decision-policy'
        ? await queryFn(POLICY_WINDOW_METRICS_SQL, [String(artifact.id || ''), safeWindowMinutes])
        : await queryFn(PROVIDER_WINDOW_METRICS_SQL, [
            String(artifact.provider_id || ''),
            String(artifact.model_version || ''),
            safeWindowMinutes
        ]);
    const row = rows?.[0] || {};
    return {
        samples: Number(row.samples || 0),
        providerErrors: Number(row.provider_errors || 0),
        executionFailures: Number(row.execution_failures || 0)
    };
}

async function sweepDecisionArtifactBreakers({ windowMinutes = 30 } = {}, deps = {}) {
    const artifacts = await (deps.query || query)(ACTIVE_ARTIFACTS_SQL);
    const actions = [];
    for (const artifact of artifacts || []) {
        const thresholds = artifactBreakerThresholds(artifact);
        if (!thresholds) continue;
        const metrics = await collectDecisionArtifactMetrics(artifact, windowMinutes, deps);
        const decision = evaluateDecisionArtifactBreaker(thresholds, metrics);
        if (!decision.tripped) continue;
        const rolledBack = await (deps.rollbackDecisionModelArtifact || rollbackDecisionModelArtifact)(artifact.id, deps);
        if (!rolledBack) continue;
        actions.push({ artifactId: artifact.id, providerId: artifact.provider_id, modelVersion: artifact.model_version, decision, metrics });
        logger.warn({ artifactId: artifact.id, providerId: artifact.provider_id, modelVersion: artifact.model_version, decision, metrics }, '决策模型制品触发熔断，已退役并回退影子路由');
    }
    return { evaluated: (artifacts || []).length, tripped: actions.length, actions };
}

function getDecisionBreakerConfig(env = process.env) {
    return {
        enabled: readTypedEnv('PIVOT_DECISION_BREAKER_ENABLED', env),
        intervalMs: readTypedEnv('PIVOT_DECISION_BREAKER_INTERVAL_MS', env),
        windowMinutes: readTypedEnv('PIVOT_DECISION_BREAKER_WINDOW_MINUTES', env)
    };
}

function createDecisionArtifactBreakerRunner(options = {}) {
    const config = { ...getDecisionBreakerConfig(options.env), ...options };
    if (config.enabled !== true) return { start() { return null; }, stop() {}, tick: async () => ({ evaluated: 0, tripped: 0, actions: [] }) };
    const intervalMs = Math.max(60 * 1000, Number(config.intervalMs) || 5 * 60 * 1000);
    let timer = null;
    let running = false;
    const tick = async () => {
        if (running) return { skipped: true, reason: 'running' };
        running = true;
        try { return await sweepDecisionArtifactBreakers({ windowMinutes: config.windowMinutes }, options); }
        catch (error) { logger.warn({ err: error.message }, '决策模型制品熔断巡检失败'); return { error: error.message }; }
        finally { running = false; }
    };
    return {
        start() {
            if (timer) return timer;
            timer = setInterval(() => { void tick(); }, intervalMs);
            timer.unref?.();
            return timer;
        },
        stop() { if (timer) clearInterval(timer); timer = null; },
        tick,
        intervalMs
    };
}

module.exports = {
    createDecisionArtifactBreakerRunner,
    evaluateDecisionArtifactBreaker,
    sweepDecisionArtifactBreakers
};
