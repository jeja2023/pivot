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
const { extractCompletionContent, shouldDisableThinking, applyNoThinkSoftSwitch, buildThinkingControlPayload, coalesceSystemMessages, requiresSingleLeadingSystemMessage } = require('./model-response');
const { fitMessagesToContextBudget } = require('./context-budget');
const { recordSlowModelResponse } = require('./observability');
const { ensureModelQuota } = require('./model-daily-quota');

function rejectsJsonObject(error) {
    const { status, data } = error?.response || {};
    const detail = typeof data === 'string' ? data : JSON.stringify(data || {});
    const text = `${error?.message || ''} ${detail}`;
    return [400, 422].includes(Number(status))
        && /response[_ ]format|json[_ ]object/i.test(text)
        && /unsupported|unrecognized|unknown|not (?:supported|allowed|available)|不支持/i.test(text);
}

/**
 * 非流式文本模型调用的公共实现。数据分析、文档审查等后台任务都复用这里，
 * 确保上下文预算、并发槽位、模型端点和用量记录保持一致。
 */
async function callModelTextWithBudget({ modelCfg, user, messages, source = 'ai', maxTokens = null, maxOutputTokensCap = 0,
    temperature = 0.2, signal = null, timeout = 180000, jsonObject = false }) {
    if (!modelCfg || modelCfg.secret_error) {
        throw new Error(modelCfg?.secret_error || '未找到可用模型。');
    }
    const requestedOutputTokens = Math.max(1, Number.parseInt(maxTokens, 10) || Number(modelCfg.max_tokens) || 1200);
    const outputTokens = Math.min(requestedOutputTokens, Number(modelCfg.max_tokens) > 0 ? Number(modelCfg.max_tokens) : Infinity,
        maxOutputTokensCap > 0 ? Number.parseInt(maxOutputTokensCap, 10) : Infinity);
    // 仅 Qwen3.8 在预算前归并 system；其他模型维持原来的分段 system 语义。
    const orderedInputMessages = requiresSingleLeadingSystemMessage(modelCfg)
        ? coalesceSystemMessages(messages)
        : messages;
    const fitted = fitMessagesToContextBudget(orderedInputMessages, modelCfg, { maxOutputTokens: outputTokens });
    const payloadMessages = shouldDisableThinking(modelCfg) ? applyNoThinkSoftSwitch(fitted.messages) : fitted.messages;
    let endpointRelease = null;
    let globalAcquired = false;
    let releaseQuota = () => {};
    const startedAt = Date.now();
    try {
        await aiSemaphore.acquire({ signal });
        globalAcquired = true;
        releaseQuota = await ensureModelQuota(user, modelCfg, payloadMessages, outputTokens, { signal });
        endpointRelease = await acquireModelSlot(modelCfg, { signal });
        const request = {
            modelCfg,
            user,
            url: buildChatCompletionsUrl(modelCfg.url, { appendV1ForLocal: true }),
            data: {
                model: modelCfg.model_name,
                messages: payloadMessages,
                stream: false,
                temperature,
                max_tokens: outputTokens,
                ...buildThinkingControlPayload(modelCfg)
            },
            headers: buildModelHeaders(modelCfg),
            stream: false,
            signal,
            timeout
        };
        let jsonObjectAccepted = jsonObject;
        if (jsonObject) request.data.response_format = { type: 'json_object' };
        let response;
        const requestStartedAt = Date.now();
        try {
            response = await forwardChatCompletion(request);
        } catch (error) {
            if (!jsonObject || !rejectsJsonObject(error)) throw error;
            signal?.throwIfAborted();
            const remaining = timeout - (Date.now() - requestStartedAt);
            if (remaining <= 0) throw error;
            jsonObjectAccepted = false;
            const { response_format: _responseFormat, ...data } = request.data;
            response = await forwardChatCompletion({ ...request, data, timeout: remaining });
        }
        const content = extractCompletionContent(response.data);
        recordSlowModelResponse(modelCfg, Date.now() - startedAt, { source });
        const inputTokens = response.data?.usage?.prompt_tokens || estimateTokens(JSON.stringify(fitted.messages));
        const outputUsed = response.data?.usage?.completion_tokens || estimateTokens(content);
        const usage = {
            inputTokens,
            outputTokens: outputUsed,
            totalTokens: response.data?.usage?.total_tokens || inputTokens + outputUsed
        };
        await recordModelTokenUsage(user.id, modelCfg.id, usage.totalTokens, source, usage.inputTokens, usage.outputTokens);
        recordModelSuccess(modelCfg, Date.now() - startedAt);
        const finishReason = String(response.data?.choices?.[0]?.finish_reason || '');
        return { content, usage, contextBudget: fitted.metadata, finishReason, truncated: finishReason === 'length', jsonObjectAccepted };
    } catch (err) {
        if (endpointRelease) recordModelFailure(modelCfg, err, { signal });
        throw err;
    } finally {
        releaseQuota();
        if (endpointRelease) endpointRelease();
        if (globalAcquired) aiSemaphore.release();
    }
}

module.exports = { callModelTextWithBudget };
