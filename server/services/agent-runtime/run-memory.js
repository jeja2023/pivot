const {
    buildLongTermMemoryContextMessage,
    compareMemoryRetrievalShadow,
    recordMemoryUsage,
    retrieveLongTermMemories
} = require('../long-term-memory');
const { getModelContextBudget } = require('../context-budget');
const { readTypedEnv } = require('../../config/env-registry');
const { getBeijingTimestamp } = require('../../time');
const { patchAgentRunMetadata: setRunMetadata } = require('../agent-run-metadata-patch');
const { parseJsonObject } = require('../agent-validators');
const { getAgentProfile, buildAgentProfileContext } = require('../agent-profile');
const { resolveResponsePreferences } = require('../agent-response-preferences');

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
            projectId: contextConfig?.projectId || parseJsonObject(run?.metadata)?.projectId || ''
        });
        const profile = await getAgentProfile(user?.id);
        const effective = resolveResponsePreferences(profile, longTermMemoryMatches, { prompt: run?.goal || '' });
        longTermMemoryMatches = effective.memories;
        const profileContext = buildAgentProfileContext(effective.profile);
        // 对话与持久任务采用相同偏好优先级，后续规划不能继续使用旧档案快照。
        const metadata = parseJsonObject(run?.metadata) || {};
        metadata.agentProfileContext = profileContext;
        metadata.agentProfileVersion = profile.version;
        run.metadata = metadata;
        await setRunMetadata(runId, { agentProfileContext: profileContext, agentProfileVersion: profile.version });
        const message = buildLongTermMemoryContextMessage(longTermMemoryMatches, {
            // 模型路由/故障降级阶段可能尚未取得完整配置；预算模块支持空配置的
            // 无界安全回退，不能因读取 null 字段把正常记忆检索误记为失败。
            inputBudget: getModelContextBudget(modelCfg || {}).inputBudget
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
