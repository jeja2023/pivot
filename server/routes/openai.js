const express = require('express');
const http = require('http');
const https = require('https');
const { db } = require('../db');
const { asyncHandler } = require('../http');
const {
    getAccessibleModel,
    getModelDailyUsage,
    getUserAccessibleModels,
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
        Number(data.inputTokens) || 0,
        Number(data.outputTokens) || 0,
        Number(data.totalTokens) || 0,
        data.stream ? 1 : 0,
        req.ip,
        getBeijingTimestamp()
    );
}

function createOpenAIRouter({ authMiddleware, logAction }) {
    const router = express.Router();

    // 1. 获取模型列表 (OpenAI 兼容)
    router.get('/models', authMiddleware, asyncHandler(async (req, res) => {
        const models = getUserAccessibleModels(req.user);
        res.json({
            object: 'list',
            data: models.map(m => ({
                id: m.model_name || m.id.toString(), // 外部调用核心标识：优先使用语义化的 model_name
                object: 'model',
                created: Math.floor(new Date(m.created_at).getTime() / 1000) || 0,
                owned_by: m.user_id ? 'user' : 'system',
                display_name: m.name // 非标扩展，方便部分 UI
            }))
        });
    }));

    // 2. 聊天补全接口
    router.post('/chat/completions', authMiddleware, asyncHandler(async (req, res) => {
        const { model, messages, stream, temperature, max_tokens } = req.body;
        const userId = req.user.id;

        if (!Array.isArray(messages) || messages.length === 0) {
            return res.status(400).json({ error: { message: 'messages must be a non-empty array.', type: 'invalid_request_error' } });
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
            const promptTokens = estimateTokens(JSON.stringify(messages));
            const completionTokens = estimateTokens(fallback);
            const totalTokens = promptTokens + completionTokens;
            if (req.isApiKey && req.apiKeyId && totalTokens > 0) {
                db.prepare('UPDATE api_keys SET usage_tokens = usage_tokens + ?, input_tokens = input_tokens + ?, output_tokens = output_tokens + ? WHERE id = ?')
                  .run(totalTokens, promptTokens, completionTokens, req.apiKeyId);
            }
            recordModelTokenUsage(userId, modelCfg.id, totalTokens, req.isApiKey ? 'openai_api_key' : 'openai_cookie', promptTokens, completionTokens);
            recordApiCallLog(req, modelCfg, messages, {
                responseText: fallback,
                inputTokens: promptTokens,
                outputTokens: completionTokens,
                totalTokens,
                stream: !!stream
            });
            logAction(req, 'OpenAI 能力不支持提示', `能力: ${unsupportedCapability.code}, 模型: ${model}`);
            return res.json({
                id: `chatcmpl-${Date.now().toString(36)}`,
                object: 'chat.completion',
                created: Math.floor(Date.now() / 1000),
                model: String(model || modelCfg.id),
                choices: [{ index: 0, message: { role: 'assistant', content: fallback }, finish_reason: 'stop' }],
                usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: totalTokens }
            });
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
            messages: messages,
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
                    const promptTokens = apiUsage?.prompt_tokens || estimateTokens(JSON.stringify(messages));
                    const completionTokens = apiUsage?.completion_tokens || estimateTokens(totalContent);
                    const tokens = apiUsage?.total_tokens || (promptTokens + completionTokens);
                    if (req.isApiKey && req.apiKeyId && tokens > 0) {
                        db.prepare('UPDATE api_keys SET usage_tokens = usage_tokens + ?, input_tokens = input_tokens + ?, output_tokens = output_tokens + ? WHERE id = ?')
                          .run(tokens, promptTokens, completionTokens, req.apiKeyId);
                    }
                    recordModelTokenUsage(userId, modelCfg.id, tokens, req.isApiKey ? 'openai_api_key' : 'openai_cookie', promptTokens, completionTokens);
                    recordApiCallLog(req, modelCfg, messages, {
                        responseText: totalContent,
                        inputTokens: promptTokens,
                        outputTokens: completionTokens,
                        totalTokens: tokens,
                        stream: true
                    });
                    logAction(req, 'OpenAI 流式调用完成', `模型: ${modelCfg.name}, 估算Tokens: ${tokens}`);
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
                const promptTokens = response.data?.usage?.prompt_tokens || estimateTokens(JSON.stringify(messages));
                const completionTokens = response.data?.usage?.completion_tokens || estimateTokens(JSON.stringify(response.data?.choices || []));
                const tokens = response.data?.usage?.total_tokens || (promptTokens + completionTokens);
                if (req.isApiKey && req.apiKeyId && tokens > 0) {
                    db.prepare('UPDATE api_keys SET usage_tokens = usage_tokens + ?, input_tokens = input_tokens + ?, output_tokens = output_tokens + ? WHERE id = ?')
                      .run(tokens, promptTokens, completionTokens, req.apiKeyId);
                }
                recordModelTokenUsage(userId, modelCfg.id, tokens, req.isApiKey ? 'openai_api_key' : 'openai_cookie', promptTokens, completionTokens);
                recordApiCallLog(req, modelCfg, messages, {
                    responseText: JSON.stringify(response.data?.choices || []),
                    inputTokens: promptTokens,
                    outputTokens: completionTokens,
                    totalTokens: tokens,
                    stream: false
                });
                recordModelSuccess(modelCfg, Date.now() - requestStartedAt);
                releaseSemaphore();
            }
        } catch (e) {
            const errorMsg = e.response?.data?.error?.message || e.message;
            logger.error({ err: errorMsg, model: modelCfg.name }, 'OpenAI 转发失败');
            recordModelFailure(modelCfg, e);
            recordApiCallLog(req, modelCfg, messages, {
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

module.exports = { createOpenAIRouter };
