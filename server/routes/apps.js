// 应用中心后端接口：当前承载“公文写作”AI 调用。
// 前端只传结构化参数（mode/action/source/draft/requirements/selection 等），
// 由后端负责提示词组装、模型权限/配额/上下文预算、上游转发、用量统计与审计标签。
const express = require('express');
const { asyncHandler } = require('../http');
const { logger } = require('../logger');
const { estimateTokens } = require('../llm');
const {
    getAccessibleModel,
    getModelDailyUsage,
    recordModelTokenUsage
} = require('../services/models');
const { aiSemaphore } = require('../services/concurrency');
const {
    acquireModelSlot,
    recordModelSuccess,
    recordModelFailure
} = require('../services/model-runtime');
const { createSseEventParser, createStreamAccumulator } = require('../streaming');
const {
    buildChatCompletionsUrl,
    buildModelHeaders
} = require('../services/model-adapter');
const { forwardChatCompletion } = require('../services/model-forwarder');
const { normalizeTokenUsage } = require('../services/token-accounting');
const {
    ContextLengthExceededError,
    fitMessagesToContextBudget
} = require('../services/context-budget');
const {
    buildOfficialWritingMessages,
    parseOfficialWritingReviewItems,
    OFFICIAL_WRITING_MODE_LABELS
} = require('../services/official-writing');

// 解析非流式补全响应中的文本内容（兼容字符串与多段数组形态）。
function extractCompletionContent(data) {
    const content = data?.choices?.[0]?.message?.content;
    if (Array.isArray(content)) {
        return content.map(part => (typeof part === 'string' ? part : part?.text || '')).join('');
    }
    return String(content || '');
}

// 解析公文写作可用模型：优先显式选择，其次个人默认模型，最后系统默认模型。
function resolveOfficialWritingModel(requestedModel, user) {
    if (requestedModel) {
        const selected = getAccessibleModel(requestedModel, user);
        if (selected) return selected;
    }
    if (user?.default_model_id) {
        const personal = getAccessibleModel(user.default_model_id, user);
        if (personal) return personal;
    }
    return getAccessibleModel(null, user);
}

function createAppsRouter({ authMiddleware, logAction }) {
    const router = express.Router();

    router.post('/apps/official-writing/ai', authMiddleware, asyncHandler(async (req, res) => {
        const body = req.body || {};
        const mode = String(body.mode || '').trim();

        let built;
        try {
            built = buildOfficialWritingMessages(body);
        } catch (e) {
            return res.status(400).json({ error: { message: e.message, type: 'invalid_request_error' } });
        }

        const wantStream = !!body.stream && mode === 'rewrite_stream';
        const modelCfg = resolveOfficialWritingModel(String(body.model || '').trim(), req.user);
        if (!modelCfg) {
            return res.status(404).json({
                error: {
                    message: '未找到可用模型，请在聊天页选择模型或设置默认模型后再使用 AI 功能。',
                    type: 'invalid_request_error',
                    code: 'model_not_found'
                }
            });
        }
        if (modelCfg.secret_error) {
            return res.status(400).json({ error: { message: modelCfg.secret_error, type: 'invalid_request_error' } });
        }

        const userId = req.user.id;
        const maxTokens = built.maxTokens;

        // 上下文预算检查（与聊天/OpenAI 兼容接口同一套口径）。
        let upstreamMessages = built.messages;
        try {
            const budgetResult = fitMessagesToContextBudget(built.messages, modelCfg, { maxOutputTokens: maxTokens });
            upstreamMessages = budgetResult.messages;
            if (budgetResult.metadata?.adjusted) {
                logger.warn({ userId, model: modelCfg.name, contextBudget: budgetResult.metadata }, '公文写作请求上下文已裁剪');
            }
        } catch (e) {
            if (e instanceof ContextLengthExceededError || e.code === 'CONTEXT_LENGTH_EXCEEDED') {
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

        // 配额检查。
        if (modelCfg.daily_token_limit > 0) {
            const usedToday = getModelDailyUsage(userId, modelCfg.id);
            if (usedToday >= modelCfg.daily_token_limit) {
                return res.status(429).json({ error: { message: 'Quota exceeded.', type: 'insufficient_quota' } });
            }
        }

        const auditLabel = OFFICIAL_WRITING_MODE_LABELS[mode] || mode || '处理';
        const auditAction = body.action ? `/${String(body.action).slice(0, 20)}` : '';
        logAction(req, '公文写作 AI', `操作: ${auditLabel}${auditAction}，模型: ${modelCfg.name}，流式: ${wantStream}`);

        // --- 并发控制 ---
        try {
            await aiSemaphore.acquire();
        } catch (e) {
            return res.status(e.statusCode || 503).json({
                error: { message: e.message || 'Model service is busy. Please retry later.', type: 'server_overloaded', code: e.code || 'AI_OVERLOADED' }
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
                error: { message: e.message || 'Model endpoint is busy. Please retry later.', type: 'server_overloaded', code: e.code || 'AI_ENDPOINT_OVERLOADED' }
            });
        }
        const releaseSemaphore = () => {
            if (!semaphoreReleased) {
                if (endpointRelease) endpointRelease();
                aiSemaphore.release();
                semaphoreReleased = true;
            }
        };

        const targetUrl = buildChatCompletionsUrl(modelCfg.url, { appendV1ForLocal: true });
        const payload = {
            model: modelCfg.model_name,
            messages: upstreamMessages,
            stream: wantStream,
            temperature: modelCfg.temperature ?? 0.4,
            max_tokens: maxTokens
        };
        if (modelCfg.max_input_tokens !== null && modelCfg.max_input_tokens !== undefined) {
            payload.max_input_tokens = modelCfg.max_input_tokens;
        }
        const headers = buildModelHeaders(modelCfg);

        try {
            const response = await forwardChatCompletion({
                modelCfg,
                user: req.user,
                url: targetUrl,
                data: payload,
                headers,
                stream: wantStream
            });

            if (wantStream) {
                res.setHeader('Content-Type', 'text/event-stream');
                res.setHeader('Cache-Control', 'no-cache');
                res.setHeader('Connection', 'keep-alive');

                const accumulator = createStreamAccumulator();
                const parser = createSseEventParser({ onData(p) { accumulator.pushPayload(p); } });
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
                    recordModelTokenUsage(userId, modelCfg.id, usage.totalTokens, 'official_writing', usage.inputTokens, usage.outputTokens);
                    recordModelSuccess(modelCfg, Date.now() - requestStartedAt);
                    res.end();
                    releaseSemaphore();
                });
                response.data.on('error', err => {
                    logger.error({ err: err.message, model: modelCfg.name }, '公文写作流式转发中断');
                    recordModelFailure(modelCfg, err);
                    if (!res.writableEnded) res.end();
                    releaseSemaphore();
                });
                req.on('close', () => {
                    if (response.data && typeof response.data.destroy === 'function') response.data.destroy();
                    releaseSemaphore();
                });
            } else {
                const content = extractCompletionContent(response.data);
                const usage = normalizeTokenUsage({
                    inputTokens: response.data?.usage?.prompt_tokens || estimateTokens(JSON.stringify(upstreamMessages)),
                    outputTokens: response.data?.usage?.completion_tokens || estimateTokens(content),
                    totalTokens: response.data?.usage?.total_tokens
                });
                recordModelTokenUsage(userId, modelCfg.id, usage.totalTokens, 'official_writing', usage.inputTokens, usage.outputTokens);
                recordModelSuccess(modelCfg, Date.now() - requestStartedAt);
                releaseSemaphore();

                const result = { content: content.trim(), model: modelCfg.model_name };
                // 审校模式在后端完成 JSON 提取与校验，前端直接使用结构化结果。
                if (mode === 'review') result.items = parseOfficialWritingReviewItems(content);
                res.json(result);
            }
        } catch (e) {
            const errorMsg = e.response?.data?.error?.message || e.message;
            logger.error({ err: errorMsg, model: modelCfg.name }, '公文写作 AI 转发失败');
            recordModelFailure(modelCfg, e);
            if (!res.headersSent) {
                res.status(e.response?.status || 500).json({ error: { message: errorMsg, type: 'api_error' } });
            } else if (!res.writableEnded) {
                res.end();
            }
            releaseSemaphore();
        }
    }));

    return router;
}

module.exports = { createAppsRouter };
