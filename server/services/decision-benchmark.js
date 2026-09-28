'use strict';

const { evaluateDecisionProviders, normalizeActionId, sanitizeDecisionContext } = require('./decision-provider');
const { evaluateDecisionSamples } = require('./decision-learning');

function normalizeEvaluationCase(value = {}) {
    const rawTaskState = value?.taskState && typeof value.taskState === 'object' ? value.taskState : {};
    const expectedActionId = normalizeActionId(value?.expectedActionId);
    const routingText = String(value?.providerInput?.routingText || '').trim().slice(0, 2048);
    const context = {
        decisionId: String(value?.id || ''),
        scenario: value?.scenario,
        language: value?.language,
        includeRoutingText: Boolean(routingText),
        taskState: {
            ...rawTaskState,
            ...(routingText ? { routingText } : {}),
            toolIntent: { requestedCapabilities: rawTaskState.requestedCapabilities || rawTaskState.toolIntent?.requestedCapabilities || [] }
        },
        candidates: value?.candidates
    };
    const safe = sanitizeDecisionContext(context);
    const allowed = new Set(safe.candidates.filter(candidate => candidate.allowed).map(candidate => candidate.id));
    if (!String(value?.id || '') || value?.reviewStatus !== 'verified' || !expectedActionId || !allowed.has(expectedActionId)) return null;
    return { id: String(value.id), context, expectedActionId };
}

function percentile(values = [], ratio = 0.95) {
    const ordered = values.map(Number).filter(Number.isFinite).sort((left, right) => left - right);
    return ordered.length ? ordered[Math.min(ordered.length - 1, Math.max(0, Math.ceil(ordered.length * ratio) - 1))] : null;
}

async function benchmarkDecisionProviders({ cases = [], providers = [], signal = null } = {}) {
    const normalizedCases = (Array.isArray(cases) ? cases : []).map(normalizeEvaluationCase).filter(Boolean);
    const resultsByProvider = new Map();
    for (const evaluationCase of normalizedCases) {
        const outputs = await evaluateDecisionProviders({ providers, context: evaluationCase.context, signal });
        outputs.forEach(output => {
            const result = resultsByProvider.get(output.providerId) || { providerId: output.providerId, providerVersion: output.providerVersion, samples: [], errors: 0, durations: [] };
            const selectedActionId = normalizeActionId(output.selectedActionId);
            const confidence = Number(output.scores?.[selectedActionId] || 0);
            result.samples.push({
                scenario: evaluationCase.context.scenario,
                language: evaluationCase.context.language,
                selectedActionId,
                verifiedActionId: evaluationCase.expectedActionId,
                confidence,
                durationMs: output.durationMs
            });
            result.errors += output.error ? 1 : 0;
            result.durations.push(output.durationMs);
            resultsByProvider.set(output.providerId, result);
        });
    }
    return {
        evaluationCaseCount: normalizedCases.length,
        providers: [...resultsByProvider.values()].map(result => ({
            providerId: result.providerId,
            providerVersion: result.providerVersion,
            errorCount: result.errors,
            timeoutOrErrorRate: result.samples.length ? result.errors / result.samples.length : null,
            p50DurationMs: percentile(result.durations, 0.5),
            p95DurationMs: percentile(result.durations, 0.95),
            metrics: evaluateDecisionSamples(result.samples)
        }))
    };
}

module.exports = {
    benchmarkDecisionProviders,
    normalizeEvaluationCase
};
