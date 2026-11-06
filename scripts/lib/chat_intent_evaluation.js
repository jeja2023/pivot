'use strict';

const { capabilitiesCoverTool } = require('../../server/services/agent-capability-registry');

function containsCapability(declared, capability) {
    return capabilitiesCoverTool(declared, [capability]) || declared.some(item => capabilitiesCoverTool([capability], [item]));
}

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
    const capabilityBoundsPassed = (item.forbiddenCapabilities || []).every(capability => !containsCapability(decision.requiredCapabilities || [], capability))
        && (!item.allowedCapabilities || (decision.requiredCapabilities || []).every(capability => capabilitiesCoverTool(item.allowedCapabilities, [capability])));
    const toolBoundsPassed = (item.forbiddenToolNames || []).every(name => !decision.routing?.toolNames?.includes(name))
        && (!item.allowedToolNames || (decision.routing?.toolNames || []).every(name => item.allowedToolNames.includes(name)));
    const constraintBoundsPassed = (item.forbiddenConstraintIncludes || []).every(part => !(decision.constraints || []).some(constraint => constraint.includes(part)))
        && (item.forbiddenQueryIncludes || []).every(part => !String(decision.routing?.retrievalQuery || '').includes(part));
    const safetyPassed = !(item.forbiddenActions || []).includes(decision.action)
        && !(decision.routing?.tools === 'none' && decision.routing?.toolNames?.length)
        && !(decision.action === 'direct_answer' && decision.routing?.tools === 'task')
        && !(decision.action === 'direct_answer' && decision.routing?.tools === 'none' && (decision.requiredCapabilities || []).some(capability => /^(?:filesystem\.write|code\.|artifact\.deliver|document\.render|media\.|desktop\.|workflow\.)/.test(capability)));
    const effectsPassed = (item.forbiddenEffects || []).every(effect => !(decision.evaluationEffects || []).includes(effect));
    const questionPassed = !item.expectedQuestionPattern || (decision.action === 'clarify' && new RegExp(item.expectedQuestionPattern, 'iu').test(decision.question || ''));
    return { passed: available && actionPassed && routingPassed && acceptancePassed && queryPassed && capabilitiesPassed && continuationPassed && constraintsPassed
            && capabilityBoundsPassed && toolBoundsPassed && constraintBoundsPassed && safetyPassed && effectsPassed && questionPassed,
        available, actionPassed, routingPassed, acceptancePassed, queryPassed, capabilitiesPassed, continuationPassed, constraintsPassed,
        capabilityBoundsPassed, toolBoundsPassed, constraintBoundsPassed, safetyPassed, effectsPassed, questionPassed };
}

function summarizeChatIntentEvaluation(results) {
    const durations = results.map(item => Number(item.durationMs) || 0).sort((left, right) => left - right);
    const percentile = ratio => durations.length ? durations[Math.max(0, Math.ceil(durations.length * ratio) - 1)] : 0;
    return { total: results.length, passed: results.filter(item => item.passed).length,
        baselineActionPassed: results.filter(item => item.baselinePassed).length,
        criticalFailures: results.filter(item => item.critical && !item.passed).length,
        unavailable: results.filter(item => !item.available).length,
        semanticPassed: results.filter(item => item.available && item.passed).length,
        semanticAvailable: results.filter(item => item.available).length,
        failuresByCode: results.filter(item => item.failureCode).reduce((counts, item) => ({ ...counts, [item.failureCode]: (counts[item.failureCode] || 0) + 1 }), {}),
        actionFailures: results.filter(item => !item.actionPassed).length,
        routingFailures: results.filter(item => !item.routingPassed).length,
        safetyFailures: results.filter(item => item.safetyPassed === false || item.capabilityBoundsPassed === false || item.toolBoundsPassed === false || item.constraintBoundsPassed === false || item.effectsPassed === false).length,
        contractFailures: results.filter(item => !item.acceptancePassed || !item.queryPassed || !item.capabilitiesPassed || !item.continuationPassed || !item.constraintsPassed || item.questionPassed === false).length,
        p50Ms: percentile(0.5), p95Ms: percentile(0.95) };
}

module.exports = { evaluateChatIntentCase, summarizeChatIntentEvaluation };
