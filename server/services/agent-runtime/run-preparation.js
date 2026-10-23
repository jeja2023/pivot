'use strict';

const { prepareProgressiveToolDiscovery } = require('./progressive-tool-discovery');
const { filterRunToolCatalog } = require('../agent-tool-discovery-scope');

function createRunPreparation(deps = {}) {
    const { formatToolList, listToolReliability, selectToolOrder, setRunMetadata, logger, verifyAgentOutcome } = deps;
    async function prepareTools({ runId, user, run, runtimeMetadata, chatBridge }) {
        let toolList = await formatToolList(user, { toolPolicy: run.tool_policy, toolAllowlist: run.tool_allowlist, preserveDiscoveryTools: true });
        toolList = filterRunToolCatalog(toolList, { ...run, metadata: { ...runtimeMetadata, ...(chatBridge ? { chatBridge } : {}) } }, user);
        try {
            const reliability = await listToolReliability(user, { days: 30, persist: false });
            toolList = selectToolOrder(toolList, reliability.signals);
            await setRunMetadata(runId, { toolReliabilityWindow: { days: reliability.days, minSampleCount: reliability.minSampleCount, signals: reliability.signals.slice(0, 100) } });
        } catch (reliabilityError) {
            logger.warn({ runId, err: reliabilityError.message }, '工具可靠性信号加载失败，继续固定排序');
        }
        const { plannerToolList, toolDiscoveryState, plannerToolNames: progressivePlannerToolNames } = prepareProgressiveToolDiscovery(toolList);
        return { toolList, plannerToolList, toolDiscoveryState, progressivePlannerToolNames };
    }
    function buildPlannerContext({ chatBridge, plannerChatHistory, plannerCurrentMessage, longTermMemoryContext, runtimeMetadata, taskWorkingState }) {
        return chatBridge
            ? { chatHistory: plannerChatHistory, chatAgent: { ...chatBridge, memoryContext: longTermMemoryContext, currentMessage: plannerCurrentMessage }, longTermMemoryContext, agentProfileContext: runtimeMetadata.agentProfileContext || '', feedbackSignals: runtimeMetadata.feedbackSignals || null, skillTitle: runtimeMetadata.skillTitle || '', skillInstructions: runtimeMetadata.skillInstructions || '', projectContextPack: runtimeMetadata.projectContextPack || null, taskWorkingState }
            : { longTermMemoryContext, agentProfileContext: runtimeMetadata.agentProfileContext || '', feedbackSignals: runtimeMetadata.feedbackSignals || null, skillTitle: runtimeMetadata.skillTitle || '', skillInstructions: runtimeMetadata.skillInstructions || '', projectContextPack: runtimeMetadata.projectContextPack || null, taskWorkingState };
    }
    function createOutcomeVerifier({ runId, run, user, getTaskContract, getObservations, signal, budget }) {
        return async (answer, partial = false, reason = '', repairOptions = null) => await verifyAgentOutcome({
            runId, run, user, taskContract: getTaskContract(), answer,
            observations: getObservations(), partial, reason, signal, budget, repairOptions
        });
    }
    return { prepareTools, buildPlannerContext, createOutcomeVerifier };
}

module.exports = { createRunPreparation };

