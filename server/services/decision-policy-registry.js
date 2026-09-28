'use strict';

const { registerDecisionModelArtifact } = require('./decision-learning');
const { getActiveDecisionModelArtifact } = require('./decision-model-registry');
const { normalizePolicyConfig } = require('./decision-policy');

function policyArtifactConfig(value = {}) {
    const source = value && typeof value === 'object' ? value : {};
    const candidate = source.policyConfig && typeof source.policyConfig === 'object' ? source.policyConfig : source;
    const normalized = normalizePolicyConfig(candidate);
    return {
        version: normalized.version,
        autoThreshold: normalized.autoThreshold,
        highRiskThreshold: normalized.highRiskThreshold,
        calibrationScale: normalized.calibration.scale,
        calibrationIntercept: normalized.calibration.intercept
    };
}

async function registerDecisionPolicyArtifact({ version = '', dataVersion = '', codeVersion = '', policyConfig = {}, evaluationReport = {}, createdBy = null } = {}, deps = {}) {
    const normalized = policyArtifactConfig({ ...policyConfig, version: version || policyConfig.version });
    if (!normalized.version || !String(dataVersion || '').trim()) throw new Error('invalid_decision_policy_artifact');
    const register = deps.registerDecisionModelArtifact || registerDecisionModelArtifact;
    return await register({
        providerId: 'decision-policy',
        modelVersion: normalized.version,
        dataVersion: String(dataVersion).slice(0, 128),
        codeVersion: String(codeVersion || '').slice(0, 128),
        weightsHash: '',
        calibration: { policyConfig: normalized },
        evaluationReport,
        createdBy
    }, deps);
}

async function getActiveDecisionPolicyArtifact(deps = {}) {
    const artifact = await (deps.getActiveDecisionModelArtifact || getActiveDecisionModelArtifact)('decision-policy', deps);
    if (!artifact) return null;
    const policyConfig = policyArtifactConfig({ ...(artifact.calibration || {}), version: artifact.model_version });
    return { ...artifact, policyConfig };
}

module.exports = {
    getActiveDecisionPolicyArtifact,
    registerDecisionPolicyArtifact
};
