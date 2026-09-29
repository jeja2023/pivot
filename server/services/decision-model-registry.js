'use strict';

const { query, queryOne, execute, transaction } = require('../db/client');
const { getBeijingTimestamp } = require('../time');
const { getDecisionEvaluationSetGovernance } = require('./decision-evaluation-reviews');

const CACHE_TTL_MS = 30_000;
const activeCache = new Map();
const ARTIFACT_SQL = 'SELECT * FROM decision_model_artifacts WHERE id = ?';
const PROMOTE_SQL = "UPDATE decision_model_artifacts SET status = 'active', promoted_at = ?, retired_at = NULL WHERE id = ?";
const ROLLBACK_SQL = "UPDATE decision_model_artifacts SET status = 'retired', retired_at = ? WHERE id = ? AND status = 'active'";

function parseJson(value, fallback = {}) {
    if (value && typeof value === 'object') return value;
    try { return JSON.parse(String(value || '')); } catch (_) { return fallback; }
}

function clearDecisionModelRegistryCache(providerId = '') {
    const provider = String(providerId || '').trim();
    if (!provider) return activeCache.clear();
    for (const key of activeCache.keys()) {
        if (key.startsWith(provider + '|')) activeCache.delete(key);
    }
}

function normalizeTenantId(value) {
    const tenantId = Number.parseInt(value, 10);
    return Number.isSafeInteger(tenantId) && tenantId > 0 ? tenantId : null;
}

function activeArtifactCacheKey(providerId, tenantId = null) {
    return String(providerId || '').trim() + '|' + String(normalizeTenantId(tenantId) || 'global');
}

function activeArtifactQuery(providerId, tenantId = null) {
    const provider = String(providerId || '').trim();
    const tenant = normalizeTenantId(tenantId);
    const fields = 'SELECT id, provider_id, model_version, data_version, weights_hash, calibration, evaluation_report, training_tenant_id, global_training_approved, status, promoted_at FROM decision_model_artifacts';
    if (provider === 'decision-policy') {
        return { sql: fields + " WHERE provider_id = ? AND status = 'active' ORDER BY promoted_at DESC NULLS LAST, created_at DESC LIMIT 1", params: [provider] };
    }
    if (!tenant) {
        return {
            sql: fields + " WHERE provider_id = ? AND status = 'active' AND training_tenant_id IS NULL AND global_training_approved = TRUE ORDER BY promoted_at DESC NULLS LAST, created_at DESC LIMIT 1",
            params: [provider]
        };
    }
    return {
        sql: fields + " WHERE provider_id = ? AND status = 'active' AND (training_tenant_id = ? OR (training_tenant_id IS NULL AND global_training_approved = TRUE)) ORDER BY CASE WHEN training_tenant_id = ? THEN 0 ELSE 1 END, promoted_at DESC NULLS LAST, created_at DESC LIMIT 1",
        params: [provider, tenant, tenant]
    };
}

function retireActiveScopeQuery(artifact = {}) {
    const provider = String(artifact.provider_id || '').trim();
    const tenantId = normalizeTenantId(artifact.training_tenant_id);
    if (provider === 'decision-policy') {
        return { sql: "UPDATE decision_model_artifacts SET status = 'retired', retired_at = ? WHERE provider_id = ? AND status = 'active' AND id <> ?", params: [provider] };
    }
    if (tenantId) {
        return { sql: "UPDATE decision_model_artifacts SET status = 'retired', retired_at = ? WHERE provider_id = ? AND status = 'active' AND id <> ? AND training_tenant_id = ?", params: [provider, tenantId] };
    }
    return { sql: "UPDATE decision_model_artifacts SET status = 'retired', retired_at = ? WHERE provider_id = ? AND status = 'active' AND id <> ? AND training_tenant_id IS NULL AND global_training_approved = TRUE", params: [provider] };
}

function artifactScopeAllowsTenant(artifact = {}, tenantId = null) {
    const scopedTenantId = normalizeTenantId(artifact.training_tenant_id ?? artifact.trainingTenantId);
    if (scopedTenantId) return scopedTenantId === normalizeTenantId(tenantId);
    return artifact.global_training_approved === true || artifact.globalTrainingApproved === true;
}

function hasArtifactTrainingScope(artifact = {}) {
    if (String(artifact.provider_id || artifact.providerId || '') === 'decision-policy') return true;
    return Boolean(normalizeTenantId(artifact.training_tenant_id ?? artifact.trainingTenantId)
        || artifact.global_training_approved === true
        || artifact.globalTrainingApproved === true);
}

function frozenEvaluationEvidence(artifact = {}) {
    const report = parseJson(artifact?.evaluation_report, {});
    const evidence = report.frozenEvaluation && typeof report.frozenEvaluation === 'object'
        ? report.frozenEvaluation
        : report.evaluationSet && typeof report.evaluationSet === 'object'
            ? report.evaluationSet
            : report;
    return {
        version: String(evidence?.version || evidence?.evaluationSetVersion || report.evaluationSetVersion || '').trim().slice(0, 128),
        sourceDigest: String(evidence?.sourceDigest || evidence?.evaluationSetDigest || report.evaluationSetDigest || '').trim().slice(0, 160),
        caseCount: Math.max(0, Number(evidence?.caseCount ?? evidence?.reviewedCaseCount ?? report.evaluationCaseCount) || 0)
    };
}

async function hasApprovedFrozenEvaluation(artifact = {}, deps = {}) {
    const evidence = frozenEvaluationEvidence(artifact);
    if (!evidence.version || !/^sha256:[a-f0-9]{64}$/i.test(evidence.sourceDigest) || evidence.caseCount <= 0) return false;
    try {
        const governance = await (deps.getDecisionEvaluationSetGovernance || getDecisionEvaluationSetGovernance)(evidence.version, deps);
        return Boolean(governance
            && Number(governance.total || 0) > 0
            && Number(governance.pending || 0) === 0
            && Number(governance.verified || 0) === Number(governance.total || 0)
            && Number(governance.total || 0) === evidence.caseCount
            && String(governance.sourceDigest || '') === evidence.sourceDigest);
    } catch (_) {
        return false;
    }
}

async function getActiveDecisionModelArtifact(providerId, deps = {}) {
    const provider = String(providerId || '').trim().slice(0, 80);
    if (!provider) return null;
    const tenantId = normalizeTenantId(deps.tenantId);
    const cacheKey = activeArtifactCacheKey(provider, tenantId);
    const cached = activeCache.get(cacheKey);
    if (deps.fresh !== true && cached && cached.expiresAt > Date.now()) return cached.value;
    const statement = activeArtifactQuery(provider, tenantId);
    const row = await (deps.queryOne || queryOne)(statement.sql, statement.params);
    const value = row ? { ...row, calibration: parseJson(row.calibration, {}), evaluationReport: parseJson(row.evaluation_report, {}) } : null;
    activeCache.set(cacheKey, { value, expiresAt: Date.now() + CACHE_TTL_MS });
    return value;
}

async function isDecisionModelArtifactActive(providerId, modelVersion, options = {}) {
    const active = await getActiveDecisionModelArtifact(providerId, options);
    return Boolean(active
        && String(active.model_version || '') === String(modelVersion || '')
        && artifactScopeAllowsTenant(active, options.tenantId));
}

function artifactPassedReleaseGate(row) {
    const report = parseJson(row?.evaluation_report, {});
    return report?.releaseGate?.passed === true || report?.passed === true;
}

const SHA256_DIGEST_RE = /^sha256:[a-f0-9]{64}$/i;

function hasLayaDeploymentEvidence(row) {
    if (String(row?.provider_id || '') !== 'laya') return true;
    const report = parseJson(row?.evaluation_report, {});
    let evidence = report?.deploymentEvidence;
    if (!evidence || typeof evidence !== 'object') evidence = report?.deployment;
    if (!evidence || typeof evidence !== 'object') return false;
    return [evidence.imageDigest, evidence.modelSha256, evidence.dependencyLockSha256, evidence.launchCommandDigest]
        .every(value => SHA256_DIGEST_RE.test(String(value || '')));
}

async function activateDecisionModelArtifact(id, deps = {}) {
    const artifactId = String(id || '').trim().slice(0, 128);
    if (!artifactId) return null;
    const tx = deps.transaction || transaction;
    const result = await tx(async trx => {
        const artifact = await trx.queryOne(ARTIFACT_SQL, [artifactId]);
        if (!artifact
            || artifact.status === 'retired'
            || !artifactPassedReleaseGate(artifact)
            || !hasLayaDeploymentEvidence(artifact)
            || !hasArtifactTrainingScope(artifact)) return null;
        const approvedFrozenEvaluation = await (deps.hasApprovedFrozenEvaluation || hasApprovedFrozenEvaluation)(artifact, deps);
        if (!approvedFrozenEvaluation) return null;
        const now = getBeijingTimestamp();
        const retire = retireActiveScopeQuery(artifact);
        await trx.execute(retire.sql, [now, retire.params[0], artifactId, ...retire.params.slice(1)]);
        await trx.execute(PROMOTE_SQL, [now, artifactId]);
        return await trx.queryOne(ARTIFACT_SQL, [artifactId]);
    });
    if (result) clearDecisionModelRegistryCache(result.provider_id);
    return result;
}

async function rollbackDecisionModelArtifact(id, deps = {}) {
    const artifactId = String(id || '').trim().slice(0, 128);
    if (!artifactId) return null;
    const row = await (deps.queryOne || queryOne)(ARTIFACT_SQL, [artifactId]);
    if (!row || row.status !== 'active') return null;
    await (deps.execute || execute)(ROLLBACK_SQL, [getBeijingTimestamp(), artifactId]);
    clearDecisionModelRegistryCache(row.provider_id);
    return { ...row, status: 'retired' };
}

async function listDecisionModelArtifacts({ providerId = '', limit = 100 } = {}, deps = {}) {
    const provider = String(providerId || '').trim().slice(0, 80);
    const safeLimit = Math.max(1, Math.min(Number.parseInt(limit, 10) || 100, 500));
    const sql = provider
        ? 'SELECT id, provider_id, model_version, data_version, code_version, weights_hash, calibration, evaluation_report, training_tenant_id, global_training_approved, status, created_at, promoted_at, retired_at FROM decision_model_artifacts WHERE provider_id = ? ORDER BY created_at DESC LIMIT ?'
        : 'SELECT id, provider_id, model_version, data_version, code_version, weights_hash, calibration, evaluation_report, training_tenant_id, global_training_approved, status, created_at, promoted_at, retired_at FROM decision_model_artifacts ORDER BY created_at DESC LIMIT ?';
    const params = provider ? [provider, safeLimit] : [safeLimit];
    const rows = await (deps.query || query)(sql, params);
    return rows.map(row => ({ ...row, calibration: parseJson(row.calibration, {}), evaluationReport: parseJson(row.evaluation_report, {}) }));
}

module.exports = {
    activateDecisionModelArtifact,
    artifactScopeAllowsTenant,
    getActiveDecisionModelArtifact,
    hasApprovedFrozenEvaluation,
    isDecisionModelArtifactActive,
    listDecisionModelArtifacts,
    rollbackDecisionModelArtifact
};
