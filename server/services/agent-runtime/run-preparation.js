'use strict';

const { prepareProgressiveToolDiscovery } = require('./progressive-tool-discovery');
const { capabilitiesCoverTool } = require('../agent-capability-registry');

function createRunPreparation(deps = {}) {
    const { formatToolList, listToolReliability, selectToolOrder, setRunMetadata, logger, verifyAgentOutcome } = deps;
    async function prepareTools({ runId, user, run, runtimeMetadata, chatBridge }) {
        let toolList = await formatToolList(user, { toolPolicy: run.tool_policy, toolAllowlist: run.tool_allowlist, preserveDiscoveryTools: true });
        if (runtimeMetadata.capabilityConstraints?.present === true) {
            toolList = toolList.filter(tool => (tool.capabilities || []).length && tool.capabilities.every(cap => capabilitiesCoverTool(runtimeMetadata.capabilityConstraints.capabilities || [], [cap])));
        }
        if (runtimeMetadata.capabilityConstraints?.excludeKnowledge === true) toolList = toolList.filter(tool => !(tool.capabilities || []).some(cap => /^knowledge\./.test(cap)));
        try {
            const reliability = await listToolReliability(user, { days: 30, persist: false });
            toolList = selectToolOrder(toolList, reliability.signals);
            await setRunMetadata(runId, { toolReliabilityWindow: { days: reliability.days, minSampleCount: reliability.minSampleCount, signals: reliability.signals.slice(0, 100) } });
        } catch (reliabilityError) {
            logger.warn({ runId, err: reliabilityError.message }, '工具可靠性信号加载失败，继续固定排序');
        }
        if (chatBridge && chatBridge.mcpEnabled === true && Array.isArray(chatBridge.mcpToolAllowlist)) {
            const allowedMcpTools = new Set(chatBridge.mcpToolAllowlist.map(value => String(value || '').trim()).filter(Boolean));
            toolList = toolList.map(tool => {
                if (tool?.source !== 'mcp') return tool;
                if (allowedMcpTools.has(String(tool?.name || '').trim())) return tool;
                if (!tool?.databaseTool || !Array.isArray(tool.databaseConnections)) return null;
                const allowedConnections = tool.databaseConnections.filter(connection => allowedMcpTools.has(String(connection?.fullName || '').trim()));
                return allowedConnections.length ? { ...tool, databaseConnections: allowedConnections } : null;
            }).filter(Boolean);
        }
        if (chatBridge && chatBridge.ragEnabled !== true) {
            toolList = toolList.filter(tool => !['rag.search', 'knowledge.list', 'knowledge.graph.query'].includes(String(tool?.name || '')));
        }
        if (runtimeMetadata.chatBridge && runtimeMetadata.chatBridge.mcpEnabled !== true && !runtimeMetadata.automaticExecution) {
            toolList = toolList.filter(tool => !tool?.network
                && !tool?.side_effect
                && !tool?.approval_required
                && !tool?.requiresApproval
                && !tool?.alwaysRequiresApproval);
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
        return async (answer, partial = false, reason = '') => await verifyAgentOutcome({
            runId, run, user, taskContract: getTaskContract(), answer,
            observations: getObservations(), partial, reason, signal, budget
        });
    }
    return { prepareTools, buildPlannerContext, createOutcomeVerifier };
}

module.exports = { createRunPreparation };

