'use strict';

const crypto = require('crypto');
const { resolveChatProject } = require('./chat-preference-context');
const { resolveChatAgentBudget } = require('./agent-token-policy');
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
    routeOverrides = {},
    ragEnabled = false,
    ragScope = {},
    retrieveContext,
    isRagEnabled,
    agentRunFactory,
    automaticExecution = null,
    turn = null,
    regenerate = false,
    requestKey = ''
} = {}) {
    if (typeof agentRunFactory !== 'function') throw new Error('Agent 运行时尚未初始化。');
    const chatHistory = normalizeChatHistory((Array.isArray(sessionMessages) ? sessionMessages : []).filter(message => (
        !userMessageId || Number(message?.id || 0) !== Number(userMessageId)
    )));
    const project = await resolveChatProject(user, sessionId, ragScope);
    const agentContext = await prepareChatAgentContext({
        userId,
        user,
        sessionId,
        projectId: project.projectId,
        modelCfg,
        modelContent: automaticExecution?.objective || modelContent,
        ragEnabled: ragEnabled && (!automaticExecution || (automaticExecution.requiredCapabilities || []).some(cap => cap.startsWith('knowledge.'))),
        ragScope,
        retrieveContext,
        isRagEnabled
    });
    const automatic = automaticExecution && automaticExecution.action === 'agent_run';
    // 明确的自然语言委托可授权系统使用已有权限的能力。
    // Agent 运行时在执行前仍会依据策略和审批要求对每个候选工具进行评估。
    const requestedTools = routeOverrides.tools?.length ? routeOverrides.tools
        : automatic && automaticExecution.routing?.tools === 'task' ? automaticExecution.routing.toolNames || [] : [];
    const selection = await require('./chat-selected-tools').resolveChatSelectedTools(user, { ...routeOverrides, tools: requestedTools }, mcpToolAllowlist);
    const selectedTools = selection.tools;
    const effectiveMcpEnabled = routeOverrides.excludeTools !== true && Boolean(mcpEnabled || (automatic && automaticExecution.allowMcp === true) || selectedTools.length);
    const capabilities = automatic ? [...new Set([...(automaticExecution.requiredCapabilities || ['agent.execute']), 'conversation.read_source', ...selectedTools.flatMap(tool => tool.capabilities || [])])] : [];
    const automaticEndpoints = automatic && effectiveMcpEnabled && !selection.names.length
        ? await require('./chat-selected-tools').resolveAutomaticMcpEndpoints(user, capabilities, mcpToolAllowlist) : {};
    const taskBudget = resolveChatAgentBudget({ modelCfg, decision: automaticExecution || {}, ragEnabled, mcpEnabled: effectiveMcpEnabled,
        content: modelContent, history: chatHistory, systemPrompt: sessionSystemPrompt, context: agentContext });
    const budget = taskBudget.budget;
    const authorizationRef = `user_message:${userMessageId}`;
    const budgetRef = `sha256:${crypto.createHash('sha256').update(JSON.stringify(budget)).digest('hex')}`;
    const conversationTaskId = automaticExecution?.conversationTaskId || turn?.id || `chat:${sessionId}:${userMessageId}`;
    const modeNote = automatic
        ? '系统已根据当前委托、会话上下文和有效授权启动受控任务。工具、网络与副作用仍由运行时策略和审批逐项决定。'
        : effectiveMcpEnabled
            ? '这是用户显式选择的聊天 Agent 执行模式。遵守当前会话的 MCP 授权和工具白名单。'
            : '这是用户显式选择的聊天 Agent 执行模式。当前会话未授权外部 MCP，只能使用内置安全能力。';
    const metadata = {
        conversationTaskId,
        projectId: project.projectId,
        conversationMessageIds: [userMessageId].filter(Boolean),
        requiredSourceMessages: automatic && modelContent.length > 12000 ? [userMessageId] : [],
        ...(automatic ? {
            capabilityConstraints: { present: true, capabilities, authorizationRef, budgetRef, sourceMessageId: userMessageId },
            taskContract: {
                goal: automaticExecution.objective || modelContent,
                constraints: automaticExecution.constraints || [],
                deliverables: automaticExecution.deliverables?.length ? automaticExecution.deliverables : [automaticExecution.objective || visibleContent],
                acceptance: {
                    requireCompleteSource: modelContent.length > 12000,
                    requireEvidence: automaticExecution.acceptance?.requireEvidence === true,
                    artifactRequired: automaticExecution.acceptance?.artifactRequired === true || /导出|下载|生成.{0,8}文件/.test(visibleContent),
                    requireSemanticVerification: true
                },
                source: 'chat_semantic_intent', authorizationRef, budgetRef
            }
        } : {}),
        ...buildChatAgentMetadata({
            sessionId,
            userMessageId,
            visibleContent,
            history: taskBudget.history,
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
                decisionId: automaticExecution.decisionId || null,
                intentDecision: {
                    version: Number(automaticExecution.version || 1),
                    intent: String(automaticExecution.intent || ''),
                    nextAction: String(automaticExecution.nextAction || ''),
                    conversationTaskId, continuationOf: automaticExecution.continuationOf || null, authorizationRef, budgetRef,
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
    metadata.chatBridge.executionProfile = taskBudget.profile;
    metadata.chatBridge.selectedTools = selection.names;
    if (selection.names.length) metadata.chatHistory.push({ role: 'user', content: `本次已选择工具：${selection.names.join('、')}。使用真实目录中的工具引用，工具权限与审批仍由服务端核验。` });
    if (automaticExecution?.completedWork) metadata.chatHistory.push({ role: 'assistant', content: `上一任务已结束。本次仅处理用户新要求，已完成操作不重放。\n${JSON.stringify(automaticExecution.completedWork).slice(0, 10000)}` });
    if (automatic && modelContent.length > 12000) metadata.chatHistory.push({ role: 'assistant', content: '本轮原始资料超过内联上限。必须通过 chat.read_source 从 offset=0 开始分页读取完整来源，不得把截断片段当作完整附件。' });
    const run = await agentRunFactory({
        user,
        chatAgent: true,
        goal: automatic ? automaticExecution.objective || modelContent : modelContent,
        modelId: modelCfg.id,
        sessionId,
        title: visibleContent || modelContent,
        maxSteps: budget.max_steps,
        dedupeKey: regenerate ? (requestKey ? `chat-regenerate:${sessionId}:${requestKey}` : null) : userMessageId ? `chat:${sessionId}:${userMessageId}` : null,
        ...((automatic || taskBudget.profile === 'knowledge_qa') ? { maxTokenBudget: budget.max_tokens_total, budgetConfig: budget } : {}),
        runMode: 'standard',
        toolPolicy: effectiveMcpEnabled ? 'all' : 'builtin_only',
        toolAllowlist: selection.names.length ? [...(selection.executionNames || selection.names), 'chat.read_source'] : [],
        approvalPolicy: 'safe_mcp_auto',
        timeoutMs: AGENT_DEFAULT_TIMEOUT_MS,
        toolTimeoutMs: AGENT_TOOL_TIMEOUT_MS,
        retryLimit: 1,
        contextConfig: { mode: 'recent', notes: selectedTools.length ? `${modeNote} 用户选择的工具：${selectedTools.map(tool => tool.name).join('、')}。请先搜索并使用返回的工具引用。` : modeNote },
        networkPolicy: { enabled: routeOverrides.excludeTools !== true && (selection.names.length > 0 || !automatic || capabilities.some(cap => /^(?:network\.|data\.)/.test(cap))),
            ...(selection.origins.length ? { allowed_origins: selection.origins, allowed_ports: selection.ports, allow_redirect: false } : {}),
            ...(Object.keys(automaticEndpoints).length ? { mcp_endpoints: automaticEndpoints } : {}) },
        metadata
    });
    return { run, agentContext, automatic };
}

module.exports = { createChatAgentHandoff };
