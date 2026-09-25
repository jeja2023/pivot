const {
    buildLongTermMemoryContextMessage,
    compareMemoryRetrievalShadow,
    recordMemoryUsage,
    retrieveLongTermMemories
} = require('../long-term-memory');
const { getModelContextBudget } = require('../context-budget');
const { readTypedEnv } = require('../../config/env-registry');
const { getBeijingTimestamp } = require('../../time');
const { setRunMetadata } = require('./metadata');

async function resolveRunLongTermMemory({
    run,
    user,
    modelCfg,
    contextConfig = {},
    logger
} = {}) {
    const runId = run?.id;
    let longTermMemoryContext = '';
    let longTermMemoryMatches = [];
    let injectedMemoryMatches = [];
    try {
        longTermMemoryMatches = await retrieveLongTermMemories(user?.id, run?.goal, {
            user,
            sessionId: run?.session_id || '',
            projectId: contextConfig?.projectId || ''
        });
        const message = buildLongTermMemoryContextMessage(longTermMemoryMatches, {
            inputBudget: getModelContextBudget(modelCfg).inputBudget
        });
        longTermMemoryContext = message?.content || '';
        if (longTermMemoryContext) {
            injectedMemoryMatches = longTermMemoryMatches.filter(memory => message.metadata?.memoryIds?.includes(memory.id));
            await setRunMetadata(runId, {
                memoryUsage: {
                    memoryIds: message.metadata?.memoryIds || [],
                    reasons: message.metadata?.usageReasons || [],
                    capturedAt: getBeijingTimestamp()
                }
            });
            if (readTypedEnv('PIVOT_LONG_TERM_MEMORY_SHADOW_MODE')) {
                void compareMemoryRetrievalShadow(user?.id, run?.goal, longTermMemoryMatches, {
                    user,
                    sessionId: run?.session_id || '',
                    runId,
                    limit: longTermMemoryMatches.length
                }).catch(error => logger?.warn?.({ runId, err: error.message }, 'Agent 长期记忆影子排序比较失败'));
            }
        }
    } catch (error) {
        logger?.warn?.({ runId, userId: user?.id, err: error.message }, 'Agent 长期记忆检索失败，继续无记忆上下文执行');
    }

    let memoryUsageRecorded = false;
    const recordActualMemoryUsage = async (eventType = 'injected', reason = '') => {
        if (memoryUsageRecorded || injectedMemoryMatches.length === 0) return;
        memoryUsageRecorded = true;
        try {
            await recordMemoryUsage(user?.id, injectedMemoryMatches, {
                eventType,
                sessionId: run?.session_id || '',
                runId,
                queryText: run?.goal,
                reason
            });
        } catch (error) {
            logger?.warn?.({ runId, err: error.message }, 'Agent 长期记忆实际注入事件记录失败');
        }
    };

    const recordPlannerMemoryUsage = async (plannerMessages = []) => {
        if (memoryUsageRecorded || !longTermMemoryContext) return;
        const retained = plannerMessages.some(message => String(message?.content || '').includes('PIVOT_LONG_TERM_MEMORY_BEGIN'));
        await recordActualMemoryUsage(retained ? 'injected' : 'trimmed', retained ? '' : 'context_budget_trimmed');
    };

    return {
        longTermMemoryContext,
        recordActualMemoryUsage,
        recordPlannerMemoryUsage
    };
}

module.exports = {
    resolveRunLongTermMemory
};
