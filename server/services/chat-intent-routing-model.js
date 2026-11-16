'use strict';

const { getAccessibleModelAsync } = require('./models');
const { getModelContextBudget, estimateMessagesTokens, estimateContentTokens } = require('./context-budget');
const { CHAT_INTENT_RESPONSE_FORMAT } = require('./chat-intent-schema');

async function resolveIntentRoutingModel(current, user, messages, configuredId, budget, deps = {}) {
    const id = Number(configuredId) || 0;
    if (!id || id === Number(current?.id)) return { model: current, source: 'current' };
    const candidate = await budget.run('routing_model', () => (deps.getAccessibleModelAsync || getAccessibleModelAsync)(id, user),
        { optional: true, fallback: null, timeoutMs: 1000 });
    if (!candidate || candidate.secret_error) return { model: current, source: 'fallback_unavailable' };
    const context = getModelContextBudget(candidate, { maxOutputTokens: 2000 });
    const inputTokens = estimateMessagesTokens(messages) + estimateContentTokens(JSON.stringify(CHAT_INTENT_RESPONSE_FORMAT));
    if (!context.unbounded && inputTokens > context.inputBudget) return { model: current, source: 'fallback_context_limit' };
    return { model: candidate, source: 'dedicated' };
}

module.exports = { resolveIntentRoutingModel };
