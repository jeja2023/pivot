const { estimateMessagesTokens } = require('./context-budget');
const { getGlobalSamplingRuntimeConfig } = require('./runtime-settings');
const {
    buildModelHeaders,
    buildResponsesUrl,
    buildChatCompletionsUrl,
    convertChatMessagesToResponsesInput,
    normalizeModelBaseUrl,
    shouldUseResponsesApi
} = require('./model-adapter');
const { forwardChatCompletion } = require('./model-forwarder');
const { isChatThinkingEnabled, buildThinkingControlPayload } = require('./models');

function buildChatRequestData(modelCfg, modelName) {
    const runtimeSampling = getGlobalSamplingRuntimeConfig();
    const requestData = {
        model: modelName,
        stream: true,
        temperature: modelCfg.temperature ?? runtimeSampling.temperature,
        top_p: runtimeSampling.topP,
        presence_penalty: runtimeSampling.presencePenalty,
        frequency_penalty: runtimeSampling.frequencyPenalty
    };
    if (modelCfg.max_tokens !== null && modelCfg.max_tokens !== undefined) {
        requestData.max_completion_tokens = modelCfg.max_tokens;
        requestData.max_tokens = modelCfg.max_tokens;
    }
    if (modelCfg.max_input_tokens !== null && modelCfg.max_input_tokens !== undefined) {
        requestData.max_input_tokens = modelCfg.max_input_tokens;
    }
    // 只有管理员显式开启"对话思考"时才保留思维链。未开启时（含未勾选"支持推理"的
    // 遗漏配置）在模型端直接关闭，否则 Qwen3 会先在思考里写完答案再正式输出一遍，
    // 用户看到重复内容，输出 token 和首字延迟都翻倍。
    if (!isChatThinkingEnabled(modelCfg)) {
        Object.assign(requestData, buildThinkingControlPayload(modelCfg));
    }
    return requestData;
}

async function openChatModelStream({ modelCfg, user, visionHistory, log, sessionId, userId, signal = null }) {
    const baseUrl = normalizeModelBaseUrl(modelCfg.url, { appendV1ForLocal: false });
    const modelName = modelCfg.model_name || 'default';
    const isResponsesApi = shouldUseResponsesApi(modelName);
    let targetUrl = isResponsesApi
        ? buildResponsesUrl(modelCfg.url, { appendV1ForLocal: false })
        : buildChatCompletionsUrl(modelCfg.url, { appendV1ForLocal: false });
    const headers = buildModelHeaders(modelCfg, { acceptJson: true });
    const requestData = buildChatRequestData(modelCfg, modelName);

    log.info({
        userId,
        model: modelCfg.name,
        modelName,
        targetUrl,
        mode: isResponsesApi ? 'Responses API' : 'Chat Completions API'
    }, '发起对话请求');
    log.info({
        sessionId,
        userId,
        modelId: modelCfg.id,
        estimatedInputTokens: estimateMessagesTokens(visionHistory)
    }, '准备发送模型请求');

    if (isResponsesApi) {
        log.info('正在建立连接 (Responses API, 流式)');
        const responsesHistory = convertChatMessagesToResponsesInput(visionHistory);
        const inputSummary = responsesHistory.map(m => ({
            role: m.role,
            contentType: Array.isArray(m.content) ? m.content.map(p => p.type).join('+') : 'text'
        }));
        log.info({ inputSummary }, '请求体结构');
        try {
            requestData.input = responsesHistory;
            const response = await forwardChatCompletion({
                modelCfg, user, url: targetUrl, headers,
                data: requestData, stream: true, timeout: 180000,
                signal
            });
            log.info('连接成功 (Responses API)');
            return { response, modelName, targetUrl, mode: 'responses', requestData };
        } catch (err) {
            const status = err.response?.status;
            if (![404, 405, 502, 503].includes(status)) throw err;
            log.warn({ status }, 'Responses API 暂不可用，正在自动回退到常规接口');
            targetUrl = buildChatCompletionsUrl(baseUrl, { appendV1ForLocal: false });
            delete requestData.input;
            requestData.messages = visionHistory;
            const response = await forwardChatCompletion({
                modelCfg, user, url: targetUrl, headers,
                data: requestData, stream: true, timeout: 300000,
                signal
            });
            log.info('降级连接成功 (Chat Completions)');
            return { response, modelName, targetUrl, mode: 'chat_completions_fallback', requestData };
        }
    }

    log.info('正在建立连接 (Chat Completions API, 流式)');
    requestData.messages = visionHistory;
    const response = await forwardChatCompletion({
        modelCfg, user, url: targetUrl, headers,
        data: requestData, stream: true, timeout: 300000,
        signal
    });
    log.info('连接成功');
    return { response, modelName, targetUrl, mode: 'chat_completions', requestData };
}

module.exports = {
    buildChatRequestData,
    openChatModelStream
};