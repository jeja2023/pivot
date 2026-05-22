const express = require('express');
const http = require('http');
const https = require('https');
const { db } = require('../db');
const { asyncHandler } = require('../http');
const {
    getAccessibleModel,
    getModelDailyUsage,
    getUserAccessibleModels,
    getOrCreateEmbeddingUsageModel,
    recordModelTokenUsage,
    modelSupportsVision,
    messagesContainVisionInput
} = require('../services/models');
const { estimateTokens } = require('../llm');
const { logger } = require('../logger');
const { aiSemaphore } = require('../services/concurrency');
const {
    acquireModelSlot,
    recordModelSuccess,
    recordModelFailure
} = require('../services/model-runtime');
const {
    detectUnsupportedCapability,
    buildCapabilityFallbackMessage
} = require('../capabilities');
const axios = require('axios');
const { createSseEventParser, createStreamAccumulator } = require('../streaming');
const { getBeijingTimestamp } = require('../time');
const {
    buildChatCompletionsUrl,
    buildModelHeaders
} = require('../services/model-adapter');
const { getEmbeddingConfig } = require('../services/rag-config');
const { requestEmbeddings } = require('../services/rag-index');
const { executeBuiltInTool, getBuiltInToolDefinitions } = require('../services/agent-tools');
const {
    estimateEmbeddingTokens,
    normalizeTokenUsage
} = require('../services/token-accounting');
const {
    ContextLengthExceededError,
    estimateMessagesTokens,
    fitMessagesToContextBudget
} = require('../services/context-budget');

const httpAgent = new http.Agent({ keepAlive: true });
const httpsAgent = new https.Agent({ keepAlive: true });

function stringifyForAudit(value) {
    try {
        const text = JSON.stringify(value);
        return text && text.length > 200000 ? `${text.slice(0, 200000)}...[truncated]` : text;
    } catch (e) {
        return '[unserializable]';
    }
}

function recordApiCallLog(req, modelCfg, messages, data = {}) {
    if (!req.isApiKey || !req.apiKeyId) return;
    const usage = normalizeTokenUsage({
        inputTokens: data.inputTokens,
        outputTokens: data.outputTokens,
        totalTokens: data.totalTokens
    });
    db.prepare(`
        INSERT INTO api_call_logs (
            user_id, api_key_id, model_id, model_name, request_messages, response_text,
            status, error_message, input_tokens, output_tokens, total_tokens, stream,
            ip_address, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        req.user.id,
        req.apiKeyId,
        modelCfg?.id || null,
        modelCfg?.name || modelCfg?.model_name || null,
        stringifyForAudit(messages),
        data.responseText ? String(data.responseText).slice(0, 200000) : '',
        data.status || 'success',
        data.errorMessage ? String(data.errorMessage).slice(0, 4000) : '',
        usage.inputTokens,
        usage.outputTokens,
        usage.totalTokens,
        data.stream ? 1 : 0,
        req.ip,
        getBeijingTimestamp()
    );
}

function normalizeEmbeddingInputItem(item) {
    if (typeof item === 'string') {
        const text = item.trim();
        if (!text) throw new Error('input contains an empty string.');
        return text;
    }
    if (Array.isArray(item) && item.every(value => Number.isInteger(value))) {
        if (item.length === 0) throw new Error('input contains an empty token array.');
        return item.join(' ');
    }
    throw new Error('input must be a string, an array of strings, or token arrays.');
}

function normalizeEmbeddingInputs(input) {
    const inputs = Array.isArray(input) && !(input.every(value => Number.isInteger(value)))
        ? input.map(normalizeEmbeddingInputItem)
        : [normalizeEmbeddingInputItem(input)];

    if (inputs.length === 0) {
        throw new Error('input must not be empty.');
    }
    if (inputs.length > 128) {
        throw new Error('input array is too large; maximum is 128 items.');
    }
    if (inputs.some(text => text.length > 100000)) {
        throw new Error('input item is too large; maximum is 100000 characters.');
    }
    return inputs;
}

function buildEmbeddingResponse({ vectors, model, promptTokens }) {
    return {
        object: 'list',
        data: vectors.map((embedding, index) => ({
            object: 'embedding',
            embedding,
            index
        })),
        model,
        usage: {
            prompt_tokens: promptTokens,
            total_tokens: promptTokens
        }
    };
}

function buildEmbeddingModelItem(config) {
    const model = String(config?.http?.model || '').trim();
    if (!model || !String(config?.http?.url || '').trim()) return null;
    return {
        id: model,
        object: 'model',
        created: 0,
        owned_by: config.source?.model === 'user' || config.source?.url === 'user' ? 'user-embedding' : 'system-embedding',
        display_name: `${model} (Embedding)`,
        capabilities: ['embeddings']
    };
}

function updateApiKeyUsage(req, { inputTokens = 0, outputTokens = 0, totalTokens = 0 } = {}) {
    const usage = normalizeTokenUsage({ inputTokens, outputTokens, totalTokens });
    if (!req.isApiKey || !req.apiKeyId || usage.totalTokens <= 0) return;
    db.prepare('UPDATE api_keys SET usage_tokens = usage_tokens + ?, input_tokens = input_tokens + ?, output_tokens = output_tokens + ? WHERE id = ?')
      .run(usage.totalTokens, usage.inputTokens, usage.outputTokens, req.apiKeyId);
}

function createOpenAIRouter({ authMiddleware, logAction, embeddingLimiter = (_req, _res, next) => next() }) {
    const router = express.Router();

    // 1. 获取模型列表 (OpenAI 兼容)
    router.get('/models', authMiddleware, asyncHandler(async (req, res) => {
        const models = getUserAccessibleModels(req.user);
        const embeddingModel = buildEmbeddingModelItem(getEmbeddingConfig(req.user?.id));
        const data = models.map(m => ({
            id: m.model_name || m.id.toString(), // 外部调用核心标识：优先使用语义化的 model_name
            object: 'model',
            created: Math.floor(new Date(m.created_at).getTime() / 1000) || 0,
            owned_by: m.user_id ? 'user' : 'system',
            display_name: m.name, // 非标扩展，方便部分 UI
            capabilities: ['chat']
        }));
        if (embeddingModel && !data.some(item => item.id === embeddingModel.id && item.capabilities?.includes('embeddings'))) {
            data.push(embeddingModel);
        }
        data.push({
            id: 'pivot-tools',
            object: 'model',
            created: 0,
            owned_by: 'pivot',
            display_name: 'Pivot Built-in Tools',
            capabilities: ['tools'],
            tools: getBuiltInToolDefinitions(req.user).map(tool => ({
                name: tool.name,
                description: tool.description,
                input_schema: tool.input_schema
            }))
        });
        res.json({
            object: 'list',
            data
        });
    }));

    router.get('/tools', authMiddleware, asyncHandler(async (req, res) => {
        res.json({
            object: 'list',
            data: getBuiltInToolDefinitions(req.user).map(tool => ({
                type: 'function',
                function: {
                    name: tool.name,
                    description: tool.description,
                    parameters: tool.input_schema
                }
            }))
        });
    }));

    router.post('/tools/call', authMiddleware, asyncHandler(async (req, res) => {
        const name = String(req.body?.name || req.body?.tool || '').trim();
        if (!name) {
            return res.status(400).json({ error: { message: 'Tool name is required.', type: 'invalid_request_error' } });
        }
        try {
            const args = req.body?.arguments || req.body?.input || {};
            const result = await executeBuiltInTool(name, args, req.user);
            const inputTokens = estimateTokens(JSON.stringify(args));
            const outputTokens = estimateTokens(JSON.stringify(result));
            updateApiKeyUsage(req, { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens });
            recordApiCallLog(req, { name: 'pivot-tools', model_name: name }, [{ role: 'tool', content: name }], {
                responseText: JSON.stringify(result),
                inputTokens,
                outputTokens,
                totalTokens: inputTokens + outputTokens,
                stream: false
            });
            logAction(req, 'OpenAI 工具调用', `工具: ${name}`);
            res.json({ object: 'tool_result', tool: name, result });
        } catch (e) {
            recordApiCallLog(req, { name: 'pivot-tools', model_name: name }, [{ role: 'tool', content: name }], {
                status: 'error',
                errorMessage: e.message,
                stream: false
            });
            res.status(e.status || 400).json({ error: { message: e.message, type: 'tool_error' } });
        }
    }));

    router.post('/embeddings', authMiddleware, embeddingLimiter, asyncHandler(async (req, res) => {
        const config = getEmbeddingConfig(req.user?.id);
        const configuredModel = String(config.http?.model || '').trim();
        const requestedModel = String(req.body?.model || configuredModel || '').trim();

        if (!String(config.http?.url || '').trim() || !configuredModel) {
            return res.status(400).json({
                error: {
                    message: 'Embedding model is not configured for this user.',
                    type: 'invalid_request_error',
                    code: 'embedding_not_configured'
                }
            });
        }
        if (requestedModel && requestedModel !== configuredModel) {
            return res.status(404).json({
                error: {
                    message: `Embedding model '${requestedModel}' not found or no access.`,
                    type: 'invalid_request_error',
                    code: 'model_not_found'
                }
            });
        }

        let inputs;
        try {
            inputs = normalizeEmbeddingInputs(req.body?.input);
        } catch (e) {
            return res.status(400).json({
                error: {
                    message: e.message,
                    type: 'invalid_request_error'
                }
            });
        }

        const startedAt = Date.now();
        const promptTokens = estimateEmbeddingTokens(inputs, estimateTokens);
        try {
            const vectors = await requestEmbeddings(inputs, config.http, { model: configuredModel });
            const payload = buildEmbeddingResponse({ vectors, model: configuredModel, promptTokens });
            const usageModelId = getOrCreateEmbeddingUsageModel({
                userId: config.source?.url === 'user' || config.source?.model === 'user' || config.source?.apiKey === 'user' ? req.user.id : null,
                url: config.http.url,
                model: configuredModel
            });
            recordModelTokenUsage(req.user.id, usageModelId, payload.usage.total_tokens, req.isApiKey ? 'embedding_api_key' : 'embedding_cookie', payload.usage.prompt_tokens, 0);
            updateApiKeyUsage(req, {
                inputTokens: payload.usage.prompt_tokens,
                totalTokens: payload.usage.total_tokens
            });
            recordApiCallLog(req, { name: configuredModel, model_name: configuredModel }, inputs, {
                responseText: JSON.stringify({
                    count: vectors.length,
                    dimensions: vectors[0]?.length || 0,
                    durationMs: Date.now() - startedAt
                }),
                inputTokens: payload.usage.prompt_tokens,
                outputTokens: 0,
                totalTokens: payload.usage.total_tokens,
                stream: false
            });
            logAction(req, 'OpenAI 向量接口调用', `模型: ${configuredModel}，输入数: ${inputs.length}`);
            return res.json(payload);
        } catch (e) {
            const errorMsg = e.response?.data?.error?.message || e.message;
            logger.error({ err: errorMsg, model: configuredModel }, 'OpenAI Embeddings 转发失败');
            recordApiCallLog(req, { name: configuredModel, model_name: configuredModel }, inputs || [], {
                status: 'error',
                errorMessage: errorMsg,
                inputTokens: promptTokens,
                totalTokens: promptTokens,
                stream: false
            });
            return res.status(e.response?.status || 500).json({ error: { message: errorMsg, type: 'api_error' } });
        }
    }));

    // 2. 聊天补全接口
    router.post('/chat/completions', authMiddleware, asyncHandler(async (req, res) => {
        const { model, messages, stream, temperature, max_tokens, tool_choice } = req.body;
        const userId = req.user.id;

        if (!Array.isArray(messages) || messages.length === 0) {
            return res.status(400).json({ error: { message: 'messages must be a non-empty array.', type: 'invalid_request_error' } });
        }

        if (model === 'pivot-tools' || tool_choice?.type === 'function') {
            const toolName = model === 'pivot-tools'
                ? String(req.body?.tool || req.body?.name || '').trim()
                : String(tool_choice?.function?.name || '').trim();
            if (!toolName) {
                return res.status(400).json({ error: { message: 'Tool name is required for pivot tool calls.', type: 'invalid_request_error' } });
            }
            let args = req.body?.arguments || req.body?.input || {};
            if (typeof args === 'string') {
                try {
                    args = JSON.parse(args);
                } catch (e) {}
            }
            const result = await executeBuiltInTool(toolName, args, req.user);
            const content = JSON.stringify(result, null, 2);
            const promptTokens = estimateTokens(JSON.stringify(args));
            const completionTokens = estimateTokens(content);
            updateApiKeyUsage(req, { inputTokens: promptTokens, outputTokens: completionTokens, totalTokens: promptTokens + completionTokens });
            recordApiCallLog(req, { name: 'pivot-tools', model_name: toolName }, messages, {
                responseText: content,
                inputTokens: promptTokens,
                outputTokens: completionTokens,
                totalTokens: promptTokens + completionTokens,
                stream: false
            });
            return res.json({
                id: `chatcmpl-tool-${Date.now()}`,
                object: 'chat.completion',
                created: Math.floor(Date.now() / 1000),
                model: 'pivot-tools',
                choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
                usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens }
            });
        }

        // 1. 获取模型配置 (通过模型标识符或 ID)
        const modelCfg = getAccessibleModel(model, req.user);
        if (!modelCfg) return res.status(404).json({ error: { message: `Model '${model}' not found or no access.`, type: 'invalid_request_error' } });
        if (modelCfg.secret_error) {
            return res.status(400).json({ error: { message: modelCfg.secret_error, type: 'invalid_request_error' } });
        }

        if (messagesContainVisionInput(messages) && !modelSupportsVision(modelCfg)) {
            return res.status(400).json({
                error: {
                    message: `Model '${model}' is not configured for visual input. Enable vision support for images/scanned documents or choose a vision-capable model.`,
                    type: 'invalid_request_error',
                    code: 'vision_not_supported'
                }
            });
        }

        const lastUserContent = [...messages].reverse().find(m => m?.role === 'user')?.content;
        const plainUserContent = Array.isArray(lastUserContent)
            ? lastUserContent.map(part => typeof part === 'string' ? part : part?.text || '').join('\n')
            : String(lastUserContent || '');
        const unsupportedCapability = detectUnsupportedCapability(plainUserContent);
        if (unsupportedCapability) {
            const fallback = buildCapabilityFallbackMessage(unsupportedCapability);
            const usage = normalizeTokenUsage({
                inputTokens: estimateTokens(JSON.stringify(messages)),
                outputTokens: estimateTokens(fallback)
            });
            if (req.isApiKey && req.apiKeyId && usage.totalTokens > 0) {
                updateApiKeyUsage(req, usage);
            }
            recordModelTokenUsage(userId, modelCfg.id, usage.totalTokens, req.isApiKey ? 'openai_api_key' : 'openai_cookie', usage.inputTokens, usage.outputTokens);
            recordApiCallLog(req, modelCfg, messages, {
                responseText: fallback,
                ...usage,
                stream: !!stream
            });
            logAction(req, 'OpenAI 能力不支持提示', `能力: ${unsupportedCapability.code}, 模型: ${model}`);
            return res.json({
                id: `chatcmpl-${Date.now().toString(36)}`,
                object: 'chat.completion',
                created: Math.floor(Date.now() / 1000),
                model: String(model || modelCfg.id),
                choices: [{ index: 0, message: { role: 'assistant', content: fallback }, finish_reason: 'stop' }],
                usage: { prompt_tokens: usage.inputTokens, completion_tokens: usage.outputTokens, total_tokens: usage.totalTokens }
            });
        }

        let upstreamMessages = messages;
        try {
            const budgetResult = fitMessagesToContextBudget(messages, modelCfg, {
                maxOutputTokens: max_tokens ?? modelCfg.max_tokens ?? 2000
            });
            upstreamMessages = budgetResult.messages;
            if (budgetResult.metadata.adjusted) {
                logger.warn({
                    userId,
                    model: modelCfg.name,
                    contextBudget: budgetResult.metadata
                }, 'OpenAI-compatible request context trimmed before upstream call');
            }
        } catch (e) {
            if (e instanceof ContextLengthExceededError || e.code === 'CONTEXT_LENGTH_EXCEEDED') {
                logger.warn({
                    userId,
                    model: modelCfg.name,
                    contextBudget: e.metadata
                }, 'OpenAI-compatible request rejected because context length exceeded');
                recordApiCallLog(req, modelCfg, messages, {
                    status: 'error',
                    errorMessage: e.message,
                    inputTokens: e.metadata?.inputTokensBefore || estimateMessagesTokens(messages),
                    stream: !!stream
                });
                return res.status(400).json({
                    error: {
                        message: e.message,
                        type: 'invalid_request_error',
                        code: 'context_length_exceeded',
                        context_budget: e.metadata || {}
                    }
                });
            }
            throw e;
        }
        
        // 2. 检查配额
        if (modelCfg.daily_token_limit > 0) {
            const usedToday = getModelDailyUsage(userId, modelCfg.id);
            if (usedToday >= modelCfg.daily_token_limit) {
                return res.status(429).json({ error: { message: 'Quota exceeded.', type: 'insufficient_quota' } });
            }
        }

        logAction(req, 'OpenAI 接口调用', `模型: ${model}, 流式: ${!!stream}`);
        
        // --- 进入并发控制 ---
        try {
            await aiSemaphore.acquire();
        } catch (e) {
            return res.status(e.statusCode || 503).json({
                error: {
                    message: e.message || 'Model service is busy. Please retry later.',
                    type: 'server_overloaded',
                    code: e.code || 'AI_OVERLOADED'
                }
            });
        }
        let semaphoreReleased = false;
        let endpointRelease = null;
        const requestStartedAt = Date.now();
        try {
            endpointRelease = await acquireModelSlot(modelCfg);
        } catch (e) {
            aiSemaphore.release();
            return res.status(e.statusCode || 503).json({
                error: {
                    message: e.message || 'Model endpoint is busy. Please retry later.',
                    type: 'server_overloaded',
                    code: e.code || 'AI_ENDPOINT_OVERLOADED'
                }
            });
        }
        const releaseSemaphore = () => {
            if (!semaphoreReleased) {
                if (endpointRelease) endpointRelease();
                aiSemaphore.release();
                semaphoreReleased = true;
            }
        };

        // 3. 构建下游请求
        const targetUrl = buildChatCompletionsUrl(modelCfg.url, { appendV1ForLocal: true });

        const payload = {
            model: modelCfg.model_name,
            messages: upstreamMessages,
            stream: !!stream,
            temperature: temperature ?? modelCfg.temperature ?? 0.7,
            max_tokens: max_tokens ?? modelCfg.max_tokens ?? 2000
        };
        if (modelCfg.max_input_tokens !== null && modelCfg.max_input_tokens !== undefined) {
            payload.max_input_tokens = modelCfg.max_input_tokens;
        }

        const headers = buildModelHeaders(modelCfg);

        try {
            const response = await axios({
                method: 'post',
                url: targetUrl,
                data: payload,
                headers: headers,
                responseType: stream ? 'stream' : 'json',
                timeout: 180000,
                proxy: false,
                httpAgent,
                httpsAgent
            });

            if (stream) {
                res.setHeader('Content-Type', 'text/event-stream');
                res.setHeader('Cache-Control', 'no-cache');
                res.setHeader('Connection', 'keep-alive');
                
                const accumulator = createStreamAccumulator();
                const parser = createSseEventParser({
                    onData(payload) {
                        accumulator.pushPayload(payload);
                    }
                });
                response.data.on('data', chunk => {
                    res.write(chunk);
                    parser.write(chunk);
                });

                response.data.on('end', () => {
                    parser.end();
                    accumulator.finish();
                    const totalContent = accumulator.getContent();
                    const apiUsage = accumulator.getUsage();
                    const usage = normalizeTokenUsage({
                        inputTokens: apiUsage?.prompt_tokens || estimateTokens(JSON.stringify(upstreamMessages)),
                        outputTokens: apiUsage?.completion_tokens || estimateTokens(totalContent),
                        totalTokens: apiUsage?.total_tokens
                    });
                    if (req.isApiKey && req.apiKeyId && usage.totalTokens > 0) {
                        updateApiKeyUsage(req, usage);
                    }
                    recordModelTokenUsage(userId, modelCfg.id, usage.totalTokens, req.isApiKey ? 'openai_api_key' : 'openai_cookie', usage.inputTokens, usage.outputTokens);
                    recordApiCallLog(req, modelCfg, upstreamMessages, {
                        responseText: totalContent,
                        ...usage,
                        stream: true
                    });
                    logAction(req, 'OpenAI 流式接口调用完成', `模型: ${modelCfg.name}，估算令牌数: ${usage.totalTokens}`);
                    recordModelSuccess(modelCfg, Date.now() - requestStartedAt);
                    res.end();
                    releaseSemaphore();
                });
                response.data.on('error', err => {
                    logger.error({ err: err.message, model: modelCfg.name }, 'OpenAI 流式转发中断');
                    recordModelFailure(modelCfg, err);
                    if (!res.writableEnded) res.end();
                    releaseSemaphore();
                });
                req.on('close', () => {
                    if (response.data && typeof response.data.destroy === 'function') response.data.destroy();
                    releaseSemaphore();
                });
            } else {
                res.json(response.data);
                const usage = normalizeTokenUsage({
                    inputTokens: response.data?.usage?.prompt_tokens || estimateTokens(JSON.stringify(upstreamMessages)),
                    outputTokens: response.data?.usage?.completion_tokens || estimateTokens(JSON.stringify(response.data?.choices || [])),
                    totalTokens: response.data?.usage?.total_tokens
                });
                if (req.isApiKey && req.apiKeyId && usage.totalTokens > 0) {
                    updateApiKeyUsage(req, usage);
                }
                recordModelTokenUsage(userId, modelCfg.id, usage.totalTokens, req.isApiKey ? 'openai_api_key' : 'openai_cookie', usage.inputTokens, usage.outputTokens);
                recordApiCallLog(req, modelCfg, upstreamMessages, {
                    responseText: JSON.stringify(response.data?.choices || []),
                    ...usage,
                    stream: false
                });
                recordModelSuccess(modelCfg, Date.now() - requestStartedAt);
                releaseSemaphore();
            }
        } catch (e) {
            const errorMsg = e.response?.data?.error?.message || e.message;
            logger.error({ err: errorMsg, model: modelCfg.name }, 'OpenAI 转发失败');
            recordModelFailure(modelCfg, e);
            recordApiCallLog(req, modelCfg, upstreamMessages, {
                status: 'error',
                errorMessage: errorMsg,
                stream: !!stream
            });
            res.status(e.response?.status || 500).json({ error: { message: errorMsg, type: 'api_error' } });
            releaseSemaphore();
        }
    }));

    return router;
}

module.exports = {
    createOpenAIRouter,
    normalizeEmbeddingInputs,
    buildEmbeddingResponse,
    buildEmbeddingModelItem
};
