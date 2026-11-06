'use strict';

const { decideAutomaticChatExecution } = require('../../server/services/chat-auto-execution-handler');

async function evaluateChatIntentEntry(item, input, resolve) {
    const effects = [];
    const decision = await decideAutomaticChatExecution({ ...input, userId: input.user.id, modelContent: item.modelContent || item.prompt,
        agentExecutionAllowed: true, autoExecutionEnabled: true,
        sessionsRepository: { listMessages: async () => item.history || [] } }, {
        getConversationTasks: async () => item.tasks || [], retrieveLongTermMemories: async () => [],
        getChatCapabilityAvailability: async () => item.availability || { status: 'available', tools: [] },
        resolveChatIntent: value => resolve({ ...value, providedSources: value.providedSources?.length ? value.providedSources : item.providedSources || [] }),
        updateMetadata: async () => { effects.push('restrict_task'); },
        sendAgentControlMessage: async () => { effects.push('steer_task'); },
        pauseAgentRun: async id => { effects.push('pause_task'); return { id, status: 'needs_input' }; },
        recordChatRouteCorrection: async () => []
    });
    return { ...decision, evaluationEffects: effects };
}

module.exports = { evaluateChatIntentEntry };
