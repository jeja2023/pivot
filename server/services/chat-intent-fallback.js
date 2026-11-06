'use strict';

const TEXT_ONLY_FALLBACK_INSTRUCTIONS = '本轮任务路由暂不可用，只提供文本回答、代码示例、草稿或计划，不调用工具、不创建或续接任务、不运行代码、不修改文件、不发送消息，也不能声称已生成下载文件。目标明确的写作或代码示例应直接完成，不要把路由故障当作用户需求不明确。组织内部事实、实时数据及未提供的材料必须有可靠依据；缺少依据时具体说明尚不能核实的内容，不得编造。用户要求实际操作或文件时，明确本轮仅提供了文本内容，操作或文件尚未完成。';

function buildIntentFallback(baseline = {}, failureCode = 'intent_provider_unavailable', reasonCode = 'intent_unavailable') {
    const action = baseline.action === 'plan_only' ? 'plan_only' : 'direct_answer';
    return { ...baseline, action, nextAction: action, intent: action === 'plan_only' ? 'plan' : 'understand',
        delegated: false, continuation: false, continuationOf: null, conversationTaskId: null, allowMcp: false,
        requiredCapabilities: [], question: '', missingFacts: [], confidence: 0, acceptance: { requireEvidence: false, artifactRequired: false },
        constraints: [...(baseline.constraints || []), '本轮仅提供文本内容，未确认的工具与任务操作不执行。'],
        routing: { version: 1, source: 'semantic_intent', knowledge: 'none', tools: 'none', retrievalQuery: baseline.objective || '',
            requestedCapabilities: [], toolNames: [], requireEvidence: false, allowAutomaticRead: false },
        reasonCode, failureCode, capabilityDecisionUnavailable: true, textOnlyFallback: true };
}

function restrictIntentFallbackState(state) {
    if (!state.intentDecision?.textOnlyFallback) return state;
    state.mcpEnabled = false;
    state.ragEnabled = false;
    state.automaticReadCapabilities = [];
    state.routeOverrides = { ...state.routeOverrides, excludeTools: true, excludeRag: true, forceRag: false, tools: [] };
    return state;
}

module.exports = { TEXT_ONLY_FALLBACK_INSTRUCTIONS, buildIntentFallback, restrictIntentFallbackState };
