'use strict';

// 多 Agent 委派的结构化输出与一次修正逻辑独立于通用工具分派器，避免
// agent-tools.js 持续同时承担目录、浏览器、HTTP 与协作协议职责。
const DELEGATE_ROLE_LABELS = Object.freeze({
    researcher: '研究员', analyst: '分析员', reviewer: '审阅员', writer: '撰写员', custom: '领域专家'
});

function createAgentDelegateExecutor(deps = {}) {
    const {
        callModelText, recordAgentModelUsage, chooseAgentLlmModel, clampText,
        fitMessagesToContextBudget, isNativeStructuredOutputUnsupported,
        normalizeJsonSchema, requestStructuredOutput, resolveWorkflowMaxTokens,
        schemaHasRules, validateJsonSchemaDefinition, validateStructuredOutput
    } = deps;
    return async function executeAgentDelegate(input = {}, user, context = {}) {
        const task = String(input.task || '').trim();
        const agentName = String(input.agentName || input.agent_name || '').trim().slice(0, 80);
        const role = Object.hasOwn(DELEGATE_ROLE_LABELS, input.role) ? input.role : 'custom';
        if (!task) throw new Error('委派智能体需要填写明确任务。');
        if (!agentName) throw new Error('委派智能体需要填写名称。');
        const modelCfg = await chooseAgentLlmModel(input, user, context);
        if (!modelCfg) throw new Error('没有可用于委派智能体的模型，或当前用户无权访问指定模型。');
        const outputSchema = normalizeJsonSchema(input.outputSchema || input.output_schema || {});
        const outputSchemaIssues = schemaHasRules(outputSchema) ? validateJsonSchemaDefinition(outputSchema, '委派输出契约', []) : [];
        if (outputSchemaIssues.length) {
            const error = new Error(`委派输出契约无效：${outputSchemaIssues[0]}`);
            error.code = 'AGENT_DELEGATE_OUTPUT_SCHEMA_INVALID';
            throw error;
        }
        const responseFormat = schemaHasRules(outputSchema) ? 'json' : (['markdown', 'text', 'json'].includes(String(input.responseFormat || input.response_format || 'markdown')) ? String(input.responseFormat || input.response_format || 'markdown') : 'markdown');
        const roleLabel = DELEGATE_ROLE_LABELS[role];
        const instructions = String(input.instructions || '').trim();
        const contextText = clampText(input.context || '', 20000);
        const formatGuide = responseFormat === 'json' ? '只输出合法 JSON，不要使用 Markdown 代码块。' : responseFormat === 'text' ? '输出简洁纯文本。' : '输出结构清晰的 Markdown。';
        const messages = [
            { role: 'system', content: [`你是 Pivot 多智能体团队中的“${agentName}”，职责是${roleLabel}。`, '你只处理当前委派任务，不擅自扩展目标；明确区分事实、推断和未知信息。', instructions, formatGuide].filter(Boolean).join('\n') },
            { role: 'user', content: [`委派任务：\n${task}`, contextText ? `可用上下文：\n${contextText}` : '', '请给出可直接交给 Supervisor 审核的结果，并指出关键依据、风险和仍待确认的问题。'].filter(Boolean).join('\n\n') }
        ];
        const temperature = Math.max(0, Math.min(Number(input.temperature ?? 0.2), 2));
        const maxTokens = resolveWorkflowMaxTokens(input, modelCfg);
        const fitted = fitMessagesToContextBudget(messages, modelCfg, { maxOutputTokens: maxTokens });
        const usageRef = {};
        let content = '';
        let nativeStructured = false;
        let validation = { value: null, issues: [] };
        if (responseFormat === 'json') {
            try {
                const result = await requestStructuredOutput({ modelCfg, messages: fitted.messages, user, temperature, maxTokens, schema: outputSchema, schemaName: `${context.node?.id || 'delegate'}_result`, signal: context.signal || null, usageRef });
                content = result.content;
                nativeStructured = result.native;
            } catch (error) {
                if (!isNativeStructuredOutputUnsupported(error)) throw error;
                content = await callModelText(modelCfg, fitted.messages, { user, temperature, maxTokens, signal: context.signal || null, usageRef });
            }
            validation = validateStructuredOutput(content, outputSchema);
            if (validation.issues.length) {
                const repairMessages = [
                    { role: 'system', content: `请修复下面的委派结果，只输出合法 JSON，不要输出解释或 Markdown。${schemaHasRules(outputSchema) ? `\n输出必须符合 JSON Schema：\n${JSON.stringify(outputSchema)}` : ''}` },
                    { role: 'user', content: `原始结果：\n${String(content || '').slice(0, 16000)}\n\n校验问题：\n${validation.issues.join('\n')}` }
                ];
                const repairUsageRef = {};
                content = await callModelText(modelCfg, repairMessages, { user, temperature: 0, maxTokens, signal: context.signal || null, usageRef: repairUsageRef });
                await recordAgentModelUsage(user, modelCfg, repairMessages, content, 'agent_delegate_json_repair', context.run?.id || context.runId || '', { usageRef: repairUsageRef });
                validation = validateStructuredOutput(content, outputSchema);
                if (validation.issues.length) {
                    const error = new Error(`委派智能体结构化输出校验失败：${validation.issues[0]}`);
                    error.code = 'AGENT_DELEGATE_OUTPUT_INVALID';
                    error.contractIssues = validation.issues;
                    throw error;
                }
            }
        } else {
            content = await callModelText(modelCfg, fitted.messages, { user, temperature, maxTokens, signal: context.signal || null, usageRef });
        }
        await recordAgentModelUsage(user, modelCfg, fitted.messages, content, 'agent_delegate', context.run?.id || context.runId || '', { usageRef });
        return {
            content, text: content,
            agent: { name: agentName, role, roleLabel, modelId: modelCfg.id, modelName: modelCfg.name },
            handoff: { fromAgent: agentName, toAgent: 'Supervisor', summary: content, status: 'ready', createdAt: new Date().toISOString() },
            responseFormat,
            structuredOutput: responseFormat === 'json' ? { native: nativeStructured, schema: outputSchema, value: validation.value } : undefined,
            contextBudget: fitted.metadata
        };
    };
}

module.exports = { createAgentDelegateExecutor };
