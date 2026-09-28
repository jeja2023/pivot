'use strict';

const { query, queryOne, execute, transaction } = require('../db/client');
const { getBeijingTimestamp } = require('../time');

const CACHE_TTL_MS = 30_000;
const activeCache = new Map();
const ACTIVE_ARTIFACT_SQL = "SELECT id, provider_id, model_version, data_version, weights_hash, calibration, evaluation_report, status, promoted_at FROM decision_model_artifacts WHERE provider_id = ? AND status = 'active' ORDER BY promoted_at DESC NULLS LAST, created_at DESC LIMIT 1";
const ARTIFACT_SQL = 'SELECT * FROM decision_model_artifacts WHERE id = ?';
const PROMOTE_SQL = "UPDATE decision_model_artifacts SET status = 'active', promoted_at = ?, retired_at = NULL WHERE id = ?";
const RETIRE_ACTIVE_SQL = "UPDATE decision_model_artifacts SET status = 'retired', retired_at = ? WHERE provider_id = ? AND status = 'active' AND id <> ?";
const ROLLBACK_SQL = "UPDATE decision_model_artifacts SET status = 'retired', retired_at = ? WHERE id = ? AND status = 'active'";

function parseJson(value, fallback = {}) {
    if (value && typeof value === 'object') return value;
    try { return JSON.parse(String(value || '')); } catch (_) { return fallback; }
}

function clearDecisionModelRegistryCache(providerId = '') {
    if (providerId) activeCache.delete(String(providerId));
    else activeCache.clear();
}

async function getActiveDecisionModelArtifact(providerId, deps = {}) {
    const provider = String(providerId || '').trim().slice(0, 80);
    if (!provider) return null;
    const cached = activeCache.get(provider);
    if (cached && cached.expiresAt > Date.now()) return cached.value;
    const row = await (deps.queryOne || queryOne)(ACTIVE_ARTIFACT_SQL, [provider]);
    const value = row ? { ...row, calibration: parseJson(row.calibration, {}), evaluationReport: parseJson(row.evaluation_report, {}) } : null;
    activeCache.set(provider, { value, expiresAt: Date.now() + CACHE_TTL_MS });
    return value;
}

async function isDecisionModelArtifactActive(providerId, modelVersion, deps = {}) {
    const active = await getActiveDecisionModelArtifact(providerId, deps);
    return Boolean(active && String(active.model_version || '') === String(modelVersion || ''));
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
        if (!artifact || artifact.status === 'retired' || !artifactPassedReleaseGate(artifact) || !hasLayaDeploymentEvidence(artifact)) return null;
        const now = getBeijingTimestamp();
        await trx.execute(RETIRE_ACTIVE_SQL, [now, artifact.provider_id, artifactId]);
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
        ? 'SELECT id, provider_id, model_version, data_version, code_version, weights_hash, calibration, evaluation_report, status, created_at, promoted_at, retired_at FROM decision_model_artifacts WHERE provider_id = ? ORDER BY created_at DESC LIMIT ?'
        : 'SELECT id, provider_id, model_version, data_version, code_version, weights_hash, calibration, evaluation_report, status, created_at, promoted_at, retired_at FROM decision_model_artifacts ORDER BY created_at DESC LIMIT ?';
    const params = provider ? [provider, safeLimit] : [safeLimit];
    const rows = await (deps.query || query)(sql, params);
    return rows.map(row => ({ ...row, calibration: parseJson(row.calibration, {}), evaluationReport: parseJson(row.evaluation_report, {}) }));
}

module.exports = {
    activateDecisionModelArtifact,
    getActiveDecisionModelArtifact,
    isDecisionModelArtifactActive,
    listDecisionModelArtifacts,
    rollbackDecisionModelArtifact
};
