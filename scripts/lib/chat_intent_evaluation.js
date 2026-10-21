'use strict';

function evaluateChatIntentCase(item, decision = {}) {
    const available = decision.capabilityDecisionUnavailable !== true && !decision.failureCode
        && !['intent_unavailable', 'decision_unavailable', 'intent_shadow'].includes(decision.reasonCode) && decision.shadow !== true;
    const actionPassed = item.expected.includes(decision.action);
    const routingPassed = Object.entries(item.expectedRouting || {}).every(([key, value]) => JSON.stringify(decision.routing?.[key]) === JSON.stringify(value));
    const acceptancePassed = Object.entries(item.expectedAcceptance || {}).every(([key, value]) => decision.acceptance?.[key] === value);
    const queryPassed = (item.expectedQueryIncludes || []).every(part => String(decision.routing?.retrievalQuery || '').includes(part));
    const capabilitiesPassed = (item.expectedCapabilities || []).every(cap => decision.requiredCapabilities?.includes(cap));
    const continuationPassed = item.expectedContinuationOf === undefined || decision.continuationOf === item.expectedContinuationOf;
    const constraintsPassed = (item.expectedConstraintIncludes || []).every(part => (decision.constraints || []).some(constraint => constraint.includes(part)));
    return { passed: available && actionPassed && routingPassed && acceptancePassed && queryPassed && capabilitiesPassed && continuationPassed && constraintsPassed,
        available, actionPassed, routingPassed, acceptancePassed, queryPassed, capabilitiesPassed, continuationPassed, constraintsPassed };
}

function summarizeChatIntentEvaluation(results) {
    const durations = results.map(item => Number(item.durationMs) || 0).sort((left, right) => left - right);
    const percentile = ratio => durations.length ? durations[Math.max(0, Math.ceil(durations.length * ratio) - 1)] : 0;
    return { total: results.length, passed: results.filter(item => item.passed).length,
        baselineActionPassed: results.filter(item => item.baselinePassed).length,
        criticalFailures: results.filter(item => item.critical && !item.passed).length,
        unavailable: results.filter(item => !item.available).length,
        actionFailures: results.filter(item => !item.actionPassed).length,
        routingFailures: results.filter(item => !item.routingPassed).length,
        contractFailures: results.filter(item => !item.acceptancePassed || !item.queryPassed || !item.capabilitiesPassed || !item.continuationPassed || !item.constraintsPassed).length,
        p50Ms: percentile(0.5), p95Ms: percentile(0.95) };
}

module.exports = { evaluateChatIntentCase, summarizeChatIntentEvaluation };
