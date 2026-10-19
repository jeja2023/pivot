'use strict';

const { fitMessagesToContextBudget } = require('./context-budget');
const { shouldDisableChatThinking } = require('./models');
const { coalesceSystemMessages, requiresSingleLeadingSystemMessage } = require('./model-response');
const { applyChatLanguageInstruction, applyChatNoThinkSoftSwitch } = require('./chat-helpers');

function normalizeVoiceHistory(value) {
    if (!Array.isArray(value)) return [];
    let size = 0;
    return value.slice(-12).map(item => {
        if (!['user', 'assistant'].includes(item?.role) || typeof item.content !== 'string') return null;
        const content = item.content.trim().slice(0, 4000);
        size += content.length;
        return content && size <= 16000 ? { role: item.role, content } : null;
    }).filter(Boolean);
}

function buildEphemeralVoiceContext(state, history, modelCfg) {
    let messages = [...history, ...normalizeVoiceHistory(state.voiceHistory), { role: 'user', content: state.modelContent }];
    messages = applyChatLanguageInstruction(messages);
    if (requiresSingleLeadingSystemMessage(modelCfg)) messages = coalesceSystemMessages(messages);
    messages = applyChatNoThinkSoftSwitch(messages, modelCfg);
    return { visionHistory: fitMessagesToContextBudget(messages, modelCfg).messages,
        effectiveUserPrompt: state.modelContent, retrievalQuery: '', retrievalPlan: {}, ragContext: '',
        ragSourceSummary: null, ragGrounding: { required: false }, disableChatThinking: shouldDisableChatThinking(modelCfg),
        chatStepContext: null, routePlan: null };
}

module.exports = { normalizeVoiceHistory, buildEphemeralVoiceContext };
