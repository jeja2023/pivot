'use strict';

const { isRegisteredCapability } = require('./agent-capability-registry');

// 只为无需资料和动作的明确短对话保留零模型快速路径，业务问答进入统一语义判断。
function isDirectConversation(prompt = '', { history = null, tasks = [], providedSources = [] } = {}) {
    const text = String(prompt).trim();
    return /^(?:你好|您好|嗨|在吗|谢谢|感谢|再见|晚安|早上好|下午好|hello|hi|thanks)[！!。,.，\s]*$/i.test(text)
        || (Array.isArray(history) && !history.length && !tasks.length && !providedSources.length && /^(?:好的|收到|明白了)[！!。,.，\s]*$/.test(text));
}

function normalizeCapabilityDecision(raw = {}, { action = 'direct_answer', prompt = '', capabilities = [], availability = {} } = {}) {
    const route = raw.routing && typeof raw.routing === 'object' && !Array.isArray(raw.routing) ? raw.routing : {};
    const requested = [...new Set(capabilities)].filter(isRegisteredCapability);
    const knowledge = ['required', 'none', 'auto'].includes(route.knowledge) ? route.knowledge
        : requested.some(cap => /^knowledge\./.test(cap)) ? 'required' : 'auto';
    const tools = ['read_only', 'task', 'none'].includes(route.tools) ? route.tools
        : ['agent_run', 'continue_run'].includes(action) ? 'task'
            : requested.some(cap => /^(?:data\.|network\.|browser\.|filesystem\.read)/.test(cap)) ? 'read_only' : 'none';
    const forbidden = action === 'plan_only' || action === 'clarify';
    const query = typeof route.retrievalQuery === 'string' ? route.retrievalQuery.trim().slice(0, 4000) : '';
    const availableNames = new Set((availability.tools || []).map(tool => tool.name));
    const toolNames = Array.isArray(route.toolNames) ? [...new Set(route.toolNames)].filter(name => typeof name === 'string' && availableNames.has(name)).slice(0, 8) : [];
    return {
        version: 1, source: 'semantic_intent',
        knowledge: forbidden ? 'none' : knowledge,
        tools: forbidden ? 'none' : tools,
        retrievalQuery: query || String(prompt).trim().slice(0, 4000),
        requestedCapabilities: requested,
        toolNames,
        requireEvidence: !forbidden && (knowledge === 'required' || tools === 'read_only' || requested.some(cap => /^(?:knowledge\.|data\.|filesystem\.read|artifact\.read|conversation\.read_source|network\.)/.test(cap)) || raw.acceptance?.requireEvidence === true),
        allowAutomaticRead: !forbidden && tools === 'read_only' && requested.length > 0
    };
}

function getCapabilityDecision(state = {}) {
    const decision = state.intentDecision;
    return decision?.routing?.source === 'semantic_intent' && decision.shadow !== true ? decision.routing : null;
}

module.exports = { isDirectConversation, normalizeCapabilityDecision, getCapabilityDecision };
