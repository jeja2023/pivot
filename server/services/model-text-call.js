const { estimateTokens } = require('../llm');
const { recordModelTokenUsage } = require('./models');
const { aiSemaphore } = require('./concurrency');
const {
    acquireModelSlot,
    recordModelFailure,
    recordModelSuccess
} = require('./model-runtime');
const { buildChatCompletionsUrl, buildModelHeaders } = require('./model-adapter');
const { forwardChatCompletion } = require('./model-forwarder');
const { extractCompletionContent, shouldDisableThinking, applyNoThinkSoftSwitch } = require('../routes/apps/helpers');
const { fitMessagesToContextBudget } = require('./context-budget');

/**
 * 非流式文本模型调用的公共实现。数据分析、文档审查等后台任务都复用这里，
 * 确保上下文预算、并发槽位、模型端点和用量记录保持一致。
 */
async function callModelTextWithBudget({ modelCfg, user, messages, source = 'ai', maxTokens = 1200, maxOutputTokensCap = 0, temperature = 0.2, signal = null, timeout = 180000 }) {
    if (!modelCfg || modelCfg.secret_error) {
        throw new Error(modelCfg?.secret_error || '未找到可用模型。');
    }
    const requestedOutputTokens = Math.max(Number.parseInt(maxTokens, 10) || 1200, Number(modelCfg.max_tokens) || 0, 256);
    const outputTokens = maxOutputTokensCap > 0
        ? Math.min(requestedOutputTokens, Number.parseInt(maxOutputTokensCap, 10) || requestedOutputTokens)
        : requestedOutputTokens;
    const fitted = fitMessagesToContextBudget(messages, modelCfg, { maxOutputTokens: outputTokens });
    const payloadMessages = shouldDisableThinking(modelCfg) ? applyNoThinkSoftSwitch(fitted.messages) : fitted.messages;
    let endpointRelease = null;
    let globalAcquired = false;
    const startedAt = Date.now();
    try {
        await aiSemaphore.acquire();
        globalAcquired = true;
        endpointRelease = await acquireModelSlot(modelCfg);
        const response = await forwardChatCompletion({
            modelCfg,
            user,
            url: buildChatCompletionsUrl(modelCfg.url, { appendV1ForLocal: true }),
            data: {
                model: modelCfg.model_name,
                messages: payloadMessages,
                stream: false,
                temperature,
                max_tokens: outputTokens
            },
            headers: buildModelHeaders(modelCfg),
            stream: false,
            signal,
            timeout
        });
        const content = extractCompletionContent(response.data);
        const inputTokens = response.data?.usage?.prompt_tokens || estimateTokens(JSON.stringify(fitted.messages));
        const outputUsed = response.data?.usage?.completion_tokens || estimateTokens(content);
        const usage = {
            inputTokens,
            outputTokens: outputUsed,
            totalTokens: response.data?.usage?.total_tokens || inputTokens + outputUsed
        };
        recordModelTokenUsage(user.id, modelCfg.id, usage.totalTokens, source, usage.inputTokens, usage.outputTokens);
        recordModelSuccess(modelCfg, Date.now() - startedAt);
        return { content, usage, contextBudget: fitted.metadata };
    } catch (err) {
        recordModelFailure(modelCfg, err);
        throw err;
    } finally {
        if (endpointRelease) endpointRelease();
        if (globalAcquired) aiSemaphore.release();
    }
}

module.exports = { callModelTextWithBudget };
