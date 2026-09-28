'use strict';

const { normalizeActionId, normalizeCandidates } = require('./decision-provider');

function clamp(value, min = 0, max = 1) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : min;
}

function normalizePolicyConfig(value = {}) {
    const mode = ['active', 'shadow', 'disabled'].includes(String(value.mode || '').toLowerCase())
        ? String(value.mode).toLowerCase()
        : 'shadow';
    return {
        mode,
        version: String(value.version || 'decision-policy-v1').slice(0, 128),
        autoThreshold: clamp(value.autoThreshold ?? 0.58),
        highRiskThreshold: clamp(value.highRiskThreshold ?? 0.85),
        calibration: {
            scale: Math.max(0.1, Math.min(Number(value.calibration?.scale ?? value.calibrationScale ?? 1) || 1, 10)),
            intercept: Math.max(-10, Math.min(Number(value.calibration?.intercept ?? value.calibrationIntercept ?? 0) || 0, 10))
        }
    };
}

function calibrateScore(score, calibration = {}) {
    const probability = clamp(score, 0.0001, 0.9999);
    const logit = Math.log(probability / (1 - probability));
    const scale = Math.max(0.1, Number(calibration.scale) || 1);
    const intercept = Number(calibration.intercept) || 0;
    return clamp(1 / (1 + Math.exp(-(logit * scale + intercept))));
}

function aggregateProviderScores(candidates = [], providerOutputs = [], calibration = {}) {
    const aggregate = Object.fromEntries(candidates.map(candidate => [candidate.id, { score: 0, weight: 0, support: 0 }]));
    providerOutputs.forEach(output => {
        const weight = Math.max(0, Number(output?.weight) || 0);
        if (!weight || output?.error) return;
        candidates.forEach(candidate => {
            const raw = Number(output?.scores?.[candidate.id] || 0);
            const score = calibrateScore(raw, calibration);
            aggregate[candidate.id].score += score * weight;
            aggregate[candidate.id].weight += weight;
            if (output.selectedActionId === candidate.id) aggregate[candidate.id].support += 1;
        });
    });
    return Object.fromEntries(Object.entries(aggregate).map(([id, value]) => [id, {
        confidence: value.weight ? clamp(value.score / value.weight) : 0,
        support: value.support
    }]));
}

function applyDecisionPolicy({ candidates = [], providerOutputs = [], fallbackActionId = '', explicitActionId = '', preferenceId = '', config = {} } = {}) {
    const normalizedCandidates = normalizeCandidates(candidates);
    const policy = normalizePolicyConfig(config);
    const fallback = normalizeActionId(fallbackActionId);
    const explicit = normalizeActionId(explicitActionId);
    const allowed = normalizedCandidates.filter(candidate => candidate.allowed);
    const scores = aggregateProviderScores(allowed, providerOutputs, policy.calibration);
    const suggested = allowed.slice().sort((left, right) => scores[right.id].confidence - scores[left.id].confidence
        || scores[right.id].support - scores[left.id].support || left.id.localeCompare(right.id))[0] || null;
    const fallbackCandidate = allowed.find(candidate => candidate.id === fallback) || allowed[0] || null;
    const explicitCandidate = allowed.find(candidate => candidate.id === explicit) || null;
    const explicitApplicable = Boolean(policy.mode !== 'disabled' && explicitCandidate && !explicitCandidate.requiresApproval);
    const threshold = suggested?.risk === 'high' || suggested?.requiresApproval ? policy.highRiskThreshold : policy.autoThreshold;
    const canApply = policy.mode === 'active'
        && suggested
        && !suggested.requiresApproval
        && scores[suggested.id].confidence >= threshold;
    const selectedActionId = explicitApplicable ? explicitCandidate.id : canApply ? suggested.id : fallbackCandidate?.id || '';
    let reasonCode = explicitApplicable ? 'explicit_preference' : canApply ? 'policy_auto_approved' : 'policy_fallback';
    if (explicitApplicable) reasonCode = 'explicit_preference';
    else if (explicit && explicitCandidate?.requiresApproval) reasonCode = 'explicit_preference_requires_approval';
    else if (!suggested) reasonCode = 'no_allowed_action';
    else if (policy.mode === 'shadow') reasonCode = 'shadow_mode';
    else if (policy.mode === 'disabled') reasonCode = 'policy_disabled';
    else if (suggested.requiresApproval) reasonCode = 'approval_required';
    else if (scores[suggested.id].confidence < threshold) reasonCode = 'low_confidence';
    return {
        policyVersion: policy.version,
        mode: policy.mode,
        selectedActionId,
        suggestedActionId: explicitApplicable ? explicitCandidate.id : suggested?.id || '',
        confidence: explicitApplicable ? 1 : suggested ? scores[suggested.id].confidence : 0,
        threshold: explicitApplicable ? 0 : threshold,
        reasonCode,
        fallbackActionId: fallbackCandidate?.id || '',
        scores,
        preferenceId: explicitApplicable ? String(preferenceId || '').slice(0, 128) : '',
        applied: explicitApplicable || canApply
    };
}

module.exports = {
    applyDecisionPolicy,
    normalizePolicyConfig
};
