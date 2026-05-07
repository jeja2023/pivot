const express = require('express');
const http = require('http');
const https = require('https');
const { db } = require('../db');
const { asyncHandler } = require('../http');
const {
    getAccessibleModel,
    getModelDailyUsage,
    getUserAccessibleModels,
    recordModelTokenUsage
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
const { createSseEventParser, extractStreamPayload } = require('../streaming');

const httpAgent = new http.Agent({ keepAlive: true });
const httpsAgent = new https.Agent({ keepAlive: true });

function createOpenAIRouter({ authMiddleware, logAction }) {
    const router = express.Router();

    // 1. 获取模型列表 (OpenAI 兼容)
    router.get('/models', authMiddleware, asyncHandler(async (req, res) => {
        const models = getUserAccessibleModels(req.user);
        res.json({
            object: 'list',
            data: models.map(m => ({
                id: m.id.toString(), // 使用数字 ID 或标识符，推荐使用 ID 保证唯一
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

        const lastUserContent = [...messages].reverse().find(m => m?.role === 'user')?.content;
        const plainUserContent = Array.isArray(lastUserContent)
            ? lastUserContent.map(part => typeof part === 'string' ? part : part?.text || '').join('\n')
            : String(lastUserContent || '');
        const unsupportedCapability = detectUnsupportedCapability(plainUserContent);
        if (unsupportedCapability) {
            const fallback = buildCapabilityFallbackMessage(unsupportedCapability);
            const promptTokens = estimateTokens(JSON.stringify(messages));
            const completionTokens = estimateTokens(fallback);
            logAction(req, 'OpenAI 能力不支持提示', `能力: ${unsupportedCapability.code}, 模型: ${model}`);
            return res.json({
                id: `chatcmpl-${Date.now().toString(36)}`,
                object: 'chat.completion',
                created: Math.floor(Date.now() / 1000),
                model: String(model || modelCfg.id),
                choices: [{ index: 0, message: { role: 'assistant', content: fallback }, finish_reason: 'stop' }],
                usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens }
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
        const baseUrl = modelCfg.url.trim().replace(/\/+$/, '').replace(/\/chat\/completions$/, '');
        const targetUrl = baseUrl + (baseUrl.includes('/v1') ? '' : '/v1') + '/chat/completions';

        const payload = {
            model: modelCfg.model_name,
            messages: messages,
            stream: !!stream,
            temperature: temperature ?? modelCfg.temperature ?? 0.7,
            max_tokens: max_tokens ?? modelCfg.max_tokens ?? 2000
        };

        const headers = {
            'Content-Type': 'application/json',
            'Authorization': modelCfg.api_key ? `Bearer ${modelCfg.api_key}` : undefined,
            'x-api-key': modelCfg.api_key || undefined,
            'User-Agent': 'Pivot-AI-Client/1.0'
        };

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
                
                let totalContent = '';
                const parser = createSseEventParser({
                    onData(payload) {
                        try {
                            const json = JSON.parse(payload);
                            const { delta } = extractStreamPayload(json);
                            if (delta) totalContent += delta;
                        } catch (e) {
                            // 转发兼容接口时忽略无法解析的非标准事件
                        }
                    }
                });
                response.data.on('data', chunk => {
                    res.write(chunk);
                    parser.write(chunk);
                });

                response.data.on('end', () => {
                    parser.end();
                    const tokens = estimateTokens(JSON.stringify(messages) + totalContent);
                    if (req.isApiKey && req.apiKeyId && tokens > 0) {
                        db.prepare('UPDATE api_keys SET usage_tokens = usage_tokens + ? WHERE id = ?').run(tokens, req.apiKeyId);
                    }
                    recordModelTokenUsage(userId, modelCfg.id, tokens, req.isApiKey ? 'openai_api_key' : 'openai_cookie');
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
                const tokens = response.data?.usage?.total_tokens || 0;
                if (req.isApiKey && req.apiKeyId && tokens > 0) {
                    db.prepare('UPDATE api_keys SET usage_tokens = usage_tokens + ? WHERE id = ?').run(tokens, req.apiKeyId);
                }
                recordModelTokenUsage(userId, modelCfg.id, tokens, req.isApiKey ? 'openai_api_key' : 'openai_cookie');
                recordModelSuccess(modelCfg, Date.now() - requestStartedAt);
                releaseSemaphore();
            }
        } catch (e) {
            const errorMsg = e.response?.data?.error?.message || e.message;
            logger.error({ err: errorMsg, model: modelCfg.name }, 'OpenAI 转发失败');
            recordModelFailure(modelCfg, e);
            res.status(e.response?.status || 500).json({ error: { message: errorMsg, type: 'api_error' } });
            releaseSemaphore();
        }
    }));

    return router;
}

module.exports = { createOpenAIRouter };
