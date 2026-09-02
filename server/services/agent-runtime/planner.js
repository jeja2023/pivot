const { callModelText, recordAgentModelUsage } = require('../agent-model');
const { normalizeContextConfig, normalizeRunMode } = require('../agent-validators');
const { fitMessagesToContextBudget } = require('../context-budget');
const { logger } = require('../../logger');
const { AGENT_ANSWER_MIN_MAX_TOKENS } = require('../agent-model');

const AGENT_CONTEXT_FALLBACK_TOKENS = Math.max(
    Number.parseInt(process.env.AGENT_CONTEXT_WINDOW_TOKENS || '32768', 10) || 32768,
    8192
);

function fitAgentMessages(messages, modelCfg, options = {}) {
    const fitted = fitMessagesToContextBudget(messages, modelCfg, options);
    if (!fitted.metadata?.unbounded) return fitted.messages;
    return fitMessagesToContextBudget(messages, modelCfg, {
        ...options,
        contextWindowTokens: AGENT_CONTEXT_FALLBACK_TOKENS
    }).messages;
}
const { buildWorldStatePrompt } = require('../agent-step-context');

function observationMessages(observations = []) {
    return observations.map((observation, index) => ({
        role: 'assistant',
        content: `PIVOT_MCP_TOOL_RESULT_BEGIN\n执行观察 ${index + 1}：\n${JSON.stringify(observation, null, 2)}\nPIVOT_MCP_TOOL_RESULT_END`
    }));
}

function chatHistoryMessages(contextConfig = {}) {
    const history = Array.isArray(contextConfig?.chatHistory)
        ? contextConfig.chatHistory
        : Array.isArray(contextConfig?.history) ? contextConfig.history : [];
    return history
        .filter(message => ['user', 'assistant'].includes(String(message?.role || '').trim().toLowerCase()))
        .map(message => ({
            role: String(message.role).trim().toLowerCase(),
            content: Array.isArray(message.content)
                ? message.content.filter(part => part && typeof part === 'object' && (part.type === 'text' || part.type === 'image_url'))
                : String(message.content || '').trim()
        }))
        .filter(message => Array.isArray(message.content) ? message.content.length > 0 : message.content);
}

function chatAgentContextMessages(contextConfig = {}) {
    const chatAgent = contextConfig?.chatAgent;
    if (!chatAgent || typeof chatAgent !== 'object') return [];
    return [
        chatAgent.memoryContext ? { role: 'user', content: String(chatAgent.memoryContext) } : null,
        chatAgent.ragContext ? { role: 'user', content: String(chatAgent.ragContext) } : null
    ].filter(Boolean);
}

function buildCurrentGoalContent(goal, observations, contextConfig = {}) {
    const prefix = [
        `目标：${goal}`,
        observations.length ? `已有 ${observations.length} 条执行观察，请基于上述观察决定下一步。` : '当前还没有执行观察。'
    ].join('\n\n');
    const currentMessage = contextConfig?.chatAgent?.currentMessage;
    if (!Array.isArray(currentMessage?.content)) return prefix;
    const parts = currentMessage.content.filter(part => part && typeof part === 'object');
    // 图片消息的文本已经包含在 Agent 目标中；只追加媒体部分，避免同一段
    // 用户输入在每轮规划中重复占用上下文窗口。
    const mediaParts = parts.filter(part => part.type === 'image_url' || part.type === 'input_image');
    return [{ type: 'text', text: prefix }, ...(mediaParts.length ? mediaParts : parts)];
}

function buildPlannerMessages(goal, toolList, observations, runMode = 'standard', contextConfig = {}, modelCfg = null, worldState = null, worldStateInjection = null) {
    const context = normalizeContextConfig(contextConfig);
    const contextLines = [];
    if (context.mode === 'recent') contextLines.push('使用最近的对话上下文。');
    if (context.mode === 'knowledge') contextLines.push('使用知识库上下文。');
    if (context.mode === 'none') contextLines.push('不包含额外的会话上下文。');
    if (context.notes) contextLines.push(`附加说明：${context.notes}`);
    if (contextConfig?.chatAgent && typeof contextConfig.chatAgent === 'object') {
        const chatAgent = contextConfig.chatAgent;
        if (String(chatAgent.systemPrompt || '').trim()) {
            contextLines.push(`当前会话系统提示词：${String(chatAgent.systemPrompt).trim()}`);
        }
        contextLines.push(chatAgent.mcpEnabled === true
            ? '当前普通聊天已获得用户确认的 MCP 工具权限，只能在工具策略和白名单允许时调用。'
            : '当前普通聊天未确认外部 MCP，禁止调用外部 MCP 工具。');
        contextLines.push(chatAgent.ragEnabled === true
            ? '用户已开启知识库检索，需要相关资料时可以调用 rag.search。'
            : '用户未开启知识库检索，不要调用知识库工具。');
    }
    if (String(contextConfig?.agentProfileContext || '').trim()) {
        contextLines.push(String(contextConfig.agentProfileContext).trim());
    }
    if (contextConfig?.feedbackSignals && typeof contextConfig.feedbackSignals === 'object') {
        const signals = contextConfig.feedbackSignals;
        const unreliableTools = Array.isArray(signals.unreliableTools) ? signals.unreliableTools.filter(Boolean).slice(0, 8) : [];
        if (unreliableTools.length) contextLines.push(`结果反馈提示：工具 ${unreliableTools.join('、')} 近期失败较多，调用前应验证输入、必要时说明限制并准备替代方案。`);
    }
    if (String(contextConfig?.skillInstructions || '').trim()) {
        contextLines.push(`个人经验（已验证 Skill）：${String(contextConfig.skillTitle || '个人经验')}\n${String(contextConfig.skillInstructions).slice(0, 12000)}`);
    }
    const runModeLabel = { standard: '标准模式—稳扎稳打', deep: '深度模式—允许额外检索', audit: '审计模式—必须强调证据、限制和风险', dag: 'DAG 模式—按工作流图执行' }[normalizeRunMode(runMode)] || normalizeRunMode(runMode);
    const messages = [
        {
            role: 'system',
            content: [
                '你是 Pivot Agent。请仔细规划，在需要时调用工具，并返回简洁的结果。',
                '选择操作时只返回 JSON；仅在最终答案中使用 Markdown。',
                '【重要语言规则】你的思考（thought）、推理和最终答案必须使用中文。禁止使用英文提纲或英文推理过程。',
                'Schema: {"thought":"简短推理（中文）","action":"tool|final","tool":"tool.name","input":{},"answer":"最终答案（中文）"}',
                `运行模式：${runModeLabel}。`,
                '如果 action 为 tool，请选择一个可用的工具并提供 JSON 输入。如果 action 为 final，请提供答案。',
                '以观察结果为依据，不要编造工具返回结果。',
                contextLines.length ? `上下文指导：${contextLines.join(' ')}` : '无额外上下文指导。',
                worldState ? buildWorldStatePrompt(worldState, { injection: worldStateInjection }) : '',
                '可用工具：',
                JSON.stringify(toolList, null, 2)
            ].join('\n')
        },
        ...chatHistoryMessages(contextConfig),
        ...chatAgentContextMessages(contextConfig),
        ...observationMessages(observations),
        {
            role: 'user',
            content: buildCurrentGoalContent(goal, observations, contextConfig)
        }
    ];
    return modelCfg ? fitAgentMessages(messages, modelCfg) : messages;
}

async function synthesizeFinalAnswer(modelCfg, goal, observations, user = null, runId = '', options = {}) {
    const finalContext = {
        chatHistory: options.chatHistory,
        chatAgent: options.chatAgent
    };
    const messages = [
        {
            role: 'system',
            content: '你是 Pivot Agent。请将 Agent 的观察记录总结为清晰的最终答案。如适用，请说明局限性和有用的后续步骤。输出请使用中文。'
        },
        ...chatHistoryMessages(finalContext),
        ...chatAgentContextMessages(finalContext),
        ...observationMessages(observations),
        {
            role: 'user',
            content: buildCurrentGoalContent(
                `任务目标：${goal}\n\n请基于上述 ${observations.length} 条执行观察生成最终答案。`,
                observations,
                finalContext
            )
        }
    ];
    const fitted = { messages: fitAgentMessages(messages, modelCfg) };
    const usageRef = {};
    // 最终答案是面向用户的完整回复，不能沿用规划一步的 1200 兜底预算，否则综合
    // 多步观察的答案会被直接截断。minMaxTokens 只抬下限，模型配置更高时不被压低。
    const content = await callModelText(modelCfg, fitted.messages, {
        user,
        signal: options.signal || null,
        usageRef,
        minMaxTokens: AGENT_ANSWER_MIN_MAX_TOKENS
    });
    if (usageRef.truncated) {
        logger.warn({
            runId,
            maxTokens: usageRef.maxTokens,
            outputTokens: usageRef.usage?.completion_tokens ?? usageRef.usage?.output_tokens ?? null,
            observations: observations.length
        }, 'Agent 最终答案因输出预算耗尽被截断，请提高模型的最大输出 Token 或 AGENT_ANSWER_MIN_MAX_TOKENS');
    }
    if (user) await recordAgentModelUsage(user, modelCfg, fitted.messages, content, 'agent_summary', runId, {
        budget: options.budget,
        usageRef,
        allowBudgetExceeded: options.allowBudgetExceeded === true
    });
    return content || '未能生成最终答案。';
}

function isMissingFinalAnswer(value) {
    const text = String(value || '').trim();
    return !text
        || text === '\u672a\u80fd\u751f\u6210\u6700\u7ec8\u7b54\u6848\u3002'
        || text === 'No final answer was generated.';
}

module.exports = {
    buildPlannerMessages,
    chatHistoryMessages,
    observationMessages,
    synthesizeFinalAnswer,
    isMissingFinalAnswer
};
