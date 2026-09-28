'use strict';

const { recordDecisionOutcome } = require('./decision-observability');
const { buildRouteMetadata } = require('./semantic-router');

async function persistFinalChatResponse({
    persistAssistantResponse, sessionId, userId, userMessageId, user, modelCfg, visibleContent, assistantContent,
    assistantTokens, costTime, tokensPerSec, routePlan, providerUsage
} = {}) {
    if (routePlan) routePlan.providerUsage = providerUsage || routePlan.providerUsage || null;
    const persisted = await persistAssistantResponse({
        sessionId, userId, userMessageId, user, modelCfg, visibleContent, assistantContent, assistantTokens,
        costTime, tps: tokensPerSec, routeMetadata: routePlan ? buildRouteMetadata(routePlan) : null
    });
    recordFinalChatDecisionOutcomes({
        routePlan, assistantMessageId: persisted.assistantMessageId, sessionId, durationMs: costTime
    });
    return persisted;
}


function recordFinalChatDecisionOutcomes({ routePlan, assistantMessageId, sessionId, durationMs }) {
    const isClarification = routePlan?.execution?.nextStep?.action === 'clarify';
    const status = isClarification ? 'partial' : 'unknown';
    const reasonCode = isClarification ? 'clarification_prompt_persisted' : 'assistant_message_persisted';
    Object.values(routePlan?.decisions || {}).filter(Boolean).forEach(decision => {
        if (!decision?.decisionId) return;
        recordDecisionOutcome({
            decisionId: decision.decisionId,
            eventType: 'execution',
            source: 'runtime',
            status,
            selectedActionId: decision.selectedActionId,
            durationMs,
            reasonCode,
            resultReference: String(assistantMessageId || sessionId),
            metadata: { phase: 'final_answer' }
        });
    });
}

module.exports = {
    persistFinalChatResponse,
    recordFinalChatDecisionOutcomes
};
