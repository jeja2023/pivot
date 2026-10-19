'use strict';

const { AGENT_DEFAULT_TIMEOUT_MS, AGENT_TOOL_TIMEOUT_MS } = require('./agent-runtime/runtime-env');
const {
    buildChatAgentMetadata,
    normalizeChatHistory,
    prepareChatAgentContext
} = require('./chat-agent-bridge');

/**
 * 通过现有运行时边界构建聊天支撑的 Agent Run。
 * 调用方决定切换是显式还是自动；本辅助函数
 * 保留相同的预算、恢复、聊天结果和工具策略控制。
 */
async function createChatAgentHandoff({
    user,
    userId,
    sessionId,
    userMessageId = null,
    visibleContent,
    modelContent,
    modelCfg,
    sessionMessages = [],
    sessionSystemPrompt = '',
    mcpEnabled = false,
    mcpToolAllowlist = null,
    ragEnabled = false,
    ragScope = {},
    retrieveContext,
    isRagEnabled,
    agentRunFactory,
    automaticExecution = null
} = {}) {
    if (typeof agentRunFactory !== 'function') throw new Error('Agent 运行时尚未初始化。');
    const chatHistory = normalizeChatHistory((Array.isArray(sessionMessages) ? sessionMessages : []).filter(message => (
        !userMessageId || Number(message?.id || 0) !== Number(userMessageId)
    )));
    const agentContext = await prepareChatAgentContext({
        userId,
        user,
        sessionId,
        modelCfg,
        modelContent,
        ragEnabled,
        ragScope,
        retrieveContext,
        isRagEnabled
    });
    const automatic = automaticExecution && automaticExecution.action === 'agent_run';
    // 明确的自然语言委托可授权系统使用已有权限的能力。
    // Agent 运行时在执行前仍会依据策略和审批要求对每个候选工具进行评估。
    const effectiveMcpEnabled = Boolean(mcpEnabled || (automatic && automaticExecution.allowMcp === true));
    const modeNote = automatic
        ? '系统已根据当前委托、会话上下文和有效授权启动受控任务。工具、网络与副作用仍由运行时策略和审批逐项决定。'
        : effectiveMcpEnabled
            ? '这是用户显式选择的聊天 Agent 执行模式。遵守当前会话的 MCP 授权和工具白名单。'
            : '这是用户显式选择的聊天 Agent 执行模式。当前会话未授权外部 MCP，只能使用内置安全能力。';
    const metadata = {
        ...buildChatAgentMetadata({
            sessionId,
            userMessageId,
            visibleContent,
            history: chatHistory,
            source: automatic ? 'chat_auto' : 'chat_explicit',
            systemPrompt: sessionSystemPrompt,
            mcpEnabled: effectiveMcpEnabled,
            mcpToolAllowlist,
            ragEnabled,
            ragScope,
            currentContent: modelContent,
            memoryContext: agentContext.memoryContext,
            memoryUsageReasons: agentContext.memoryUsageReasons,
            ragContext: agentContext.ragContext
        }),
        ...(automatic ? {
            automaticExecution: {
                version: 1,
                confidence: Number(automaticExecution.confidence || 0),
                reasonCode: String(automaticExecution.reasonCode || ''),
                delegated: automaticExecution.delegated === true,
                continuation: automaticExecution.continuation === true,
                source: 'chat_auto_execution',
                intentDecision: {
                    version: Number(automaticExecution.version || 1),
                    intent: String(automaticExecution.intent || ''),
                    nextAction: String(automaticExecution.nextAction || ''),
                    requiredCapabilities: Array.isArray(automaticExecution.requiredCapabilities)
                        ? automaticExecution.requiredCapabilities.slice(0, 12).map(value => String(value || '')).filter(Boolean)
                        : [],
                    missingFacts: Array.isArray(automaticExecution.missingFacts)
                        ? automaticExecution.missingFacts.slice(0, 8).map(value => String(value || '')).filter(Boolean)
                        : [],
                    evidenceRefs: Array.isArray(automaticExecution.evidenceRefs)
                        ? automaticExecution.evidenceRefs.slice(0, 8).map(value => String(value || '')).filter(Boolean)
                        : []
                }
            }
        } : {})
    };
    const run = await agentRunFactory({
        user,
        chatAgent: true,
        goal: modelContent,
        modelId: modelCfg.id,
        sessionId,
        title: visibleContent || modelContent,
        maxSteps: automatic ? 30 : 30,
        runMode: 'standard',
        toolPolicy: effectiveMcpEnabled ? 'all' : 'builtin_only',
        toolAllowlist: [],
        approvalPolicy: 'safe_mcp_auto',
        timeoutMs: AGENT_DEFAULT_TIMEOUT_MS,
        toolTimeoutMs: AGENT_TOOL_TIMEOUT_MS,
        retryLimit: 1,
        contextConfig: { mode: 'recent', notes: modeNote },
        networkPolicy: { enabled: true },
        metadata
    });
    return { run, agentContext, automatic };
}

module.exports = { createChatAgentHandoff };
