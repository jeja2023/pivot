const { callModelText, recordAgentModelUsage } = require('../agent-model');
const { normalizeContextConfig, normalizeRunMode } = require('../agent-validators');
const { fitMessagesToContextBudget } = require('../context-budget');

function observationMessages(observations = []) {
    return observations.map((observation, index) => ({
        role: 'assistant',
        content: `PIVOT_MCP_TOOL_RESULT_BEGIN\n执行观察 ${index + 1}：\n${JSON.stringify(observation, null, 2)}\nPIVOT_MCP_TOOL_RESULT_END`
    }));
}

function buildPlannerMessages(goal, toolList, observations, runMode = 'standard', contextConfig = {}, modelCfg = null) {
    const context = normalizeContextConfig(contextConfig);
    const contextLines = [];
    if (context.mode === 'recent') contextLines.push('使用最近的对话上下文。');
    if (context.mode === 'knowledge') contextLines.push('使用知识库上下文。');
    if (context.mode === 'none') contextLines.push('不包含额外的会话上下文。');
    if (context.notes) contextLines.push(`附加说明：${context.notes}`);
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
                '可用工具：',
                JSON.stringify(toolList, null, 2)
            ].join('\n')
        },
        ...observationMessages(observations),
        {
            role: 'user',
            content: [
                `目标：${goal}`,
                observations.length ? `已有 ${observations.length} 条执行观察，请基于上述观察决定下一步。` : '当前还没有执行观察。'
            ].join('\n\n')
        }
    ];
    return modelCfg ? fitMessagesToContextBudget(messages, modelCfg).messages : messages;
}

async function synthesizeFinalAnswer(modelCfg, goal, observations, user = null, runId = '', options = {}) {
    const messages = [
        {
            role: 'system',
            content: '你是 Pivot Agent。请将 Agent 的观察记录总结为清晰的最终答案。如适用，请说明局限性和有用的后续步骤。输出请使用中文。'
        },
        ...observationMessages(observations),
        {
            role: 'user',
            content: `任务目标：${goal}\n\n请基于上述 ${observations.length} 条执行观察生成最终答案。`
        }
    ];
    const fitted = fitMessagesToContextBudget(messages, modelCfg);
    const content = await callModelText(modelCfg, fitted.messages, { user, signal: options.signal || null });
    if (user) recordAgentModelUsage(user, modelCfg, fitted.messages, content, 'agent_summary', runId);
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
    observationMessages,
    synthesizeFinalAnswer,
    isMissingFinalAnswer
};
