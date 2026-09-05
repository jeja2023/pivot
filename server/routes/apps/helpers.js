const { extractModelText } = require('../../services/chat-route-helpers');
const { getAccessibleModelAsync, modelSupportsReasoning, buildThinkingControlPayload } = require('../../services/models');

function stripThinkTags(text) {
    return String(text || '')
        .replace(/<think>[\s\S]*?<\/think>/gi, '')
        .replace(/<think>[\s\S]*$/i, '')
        .trim();
}

// 解析非流式补全响应中的正文：复用聊天侧的健壮解析（兼容字符串/数组 content、
// Responses 风格 output_text/output[]），再剥离思考块。
// 不把 reasoning_content 当作正文返回——它是思考过程而非成稿，空正文交由上层给出明确提示。
function extractCompletionContent(data) {
    return stripThinkTags(extractModelText(data));
}

// 从模型文本中尽力解析一个 JSON 对象：剥离 ```json 代码围栏后取首个 { 到末个 }。
// 解析失败返回 null（调用方据此把整段文本当作普通回答兜底）。
function parseJsonObject(text) {
    const raw = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/i, '').trim();
    try {
        const direct = JSON.parse(raw);
        return direct && typeof direct === 'object' && !Array.isArray(direct) ? direct : null;
    } catch (_e) { /* fall through to brace extraction */ }
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start >= 0 && end > start) {
        try {
            const parsed = JSON.parse(raw.slice(start, end + 1));
            return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
        } catch (_e2) { /* not JSON */ }
    }
    return null;
}

function clampText(value, max = 4000) {
    const text = String(value ?? '');
    return text.length > max ? `${text.slice(0, max)}…（已截断）` : text;
}

function buildModelSecretErrorPayload(modelCfg) {
    return {
        error: {
            message: `${modelCfg.secret_error}，请在模型管理中重新保存该模型的 API Key，或恢复原 DATA_ENCRYPTION_KEY/JWT_SECRET 后重启服务。`,
            type: 'invalid_request_error',
            code: 'api_key_decrypt_failed'
        }
    };
}

// 判断是否应为该模型关闭“思考”模式：公文起草/润色/审校属工具型任务，无需思维链。
// 依据管理员设置的 supports_reasoning，或常见推理型模型名（Qwen3 / QwQ / DeepSeek-R1）兜底识别。
function shouldDisableThinking(modelCfg) {
    if (modelSupportsReasoning(modelCfg)) return true;
    const name = String(modelCfg?.model_name || modelCfg?.name || '');
    return /qwen-?3|qwq|deepseek-?r1/i.test(name);
}

// 对推理型模型在最后一条 user 消息追加 /no_think 软开关（Qwen3 等的 chat template 原生支持）。
function applyNoThinkSoftSwitch(messages) {
    const lastUserIndex = messages.map(m => m.role).lastIndexOf('user');
    if (lastUserIndex < 0) return messages;
    return messages.map((message, index) => {
        if (index !== lastUserIndex || typeof message.content !== 'string') return message;
        return { ...message, content: `${message.content}\n/no_think` };
    });
}

// Qwen3 的思考模式控制实现在 services/models.js，那里是模型能力判定的归属地；
// 聊天流式路径与后台文本调用共用同一份实现，避免模型名匹配范围出现两套口径。

// 解析公文写作可用模型：优先显式选择，其次个人默认模型，最后系统默认模型。
async function resolveOfficialWritingModel(requestedModel, user) {
    if (requestedModel) {
        const selected = await getAccessibleModelAsync(requestedModel, user);
        if (selected) return selected;
    }
    if (user?.default_model_id) {
        const personal = await getAccessibleModelAsync(user.default_model_id, user);
        if (personal) return personal;
    }
    return await getAccessibleModelAsync(null, user);
}

async function resolveAppsModel(requestedModel, user) {
    return await resolveOfficialWritingModel(requestedModel, user);
}


const { estimateTokens } = require('../../llm');
const { getModelDailyUsageAsync, recordModelTokenUsage } = require('../../services/models');
const { aiSemaphore } = require('../../services/concurrency');
const { acquireModelSlot, recordModelSuccess, recordModelFailure } = require('../../services/model-runtime');
const { createSseEventParser, createStreamAccumulator } = require('../../streaming');
const { createSseResponseWriter } = require('../../services/sse-response');
const { createStreamIdleWatchdog } = require('../../services/stream-idle-watchdog');
const { buildChatCompletionsUrl, buildModelHeaders } = require('../../services/model-adapter');
const { forwardChatCompletion } = require('../../services/model-forwarder');
const { normalizeTokenUsage } = require('../../services/token-accounting');
const { ContextLengthExceededError, fitMessagesToContextBudget } = require('../../services/context-budget');
const { logger } = require('../../logger');

async function runAppsAiCompletion({ req, res, logAction, source, auditAction, messages, maxTokens = 1200, temperature = 0.35, stream = false, extraPayload = null, onComplete = null }) {
    const modelCfg = await resolveAppsModel(String(req.body?.model || '').trim(), req.user);
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
        return res.status(400).json(buildModelSecretErrorPayload(modelCfg));
    }

    const userId = req.user.id;
    let upstreamMessages = messages;
    const outputTokens = Math.max(maxTokens, Number(modelCfg.max_tokens) || 0);
    try {
        const budgetResult = fitMessagesToContextBudget(messages, modelCfg, { maxOutputTokens: outputTokens });
        upstreamMessages = budgetResult.messages;
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

    if (modelCfg.daily_token_limit > 0) {
        const usedToday = await getModelDailyUsageAsync(userId, modelCfg.id);
        if (usedToday >= modelCfg.daily_token_limit) {
            return res.status(429).json({ error: { message: '今日模型调用额度已用尽。', type: 'insufficient_quota' } });
        }
    }

    logAction(req, auditAction, `模型: ${modelCfg.name}`);

    try {
        await aiSemaphore.acquire();
    } catch (e) {
        return res.status(e.statusCode || 503).json({
            error: { message: e.message || 'Model service is busy. Please retry later.', type: 'server_overloaded', code: e.code || 'AI_OVERLOADED' }
        });
    }
    let endpointRelease = null;
    let released = false;
    const abortController = new AbortController();
    const releaseSlots = () => {
        if (released) return;
        released = true;
        if (endpointRelease) endpointRelease();
        aiSemaphore.release();
    };
    const onClientDisconnect = () => {
        try { abortController.abort(); } catch (_e) {}
        releaseSlots();
    };
    if (typeof req.once === 'function') req.once('aborted', onClientDisconnect);
    if (typeof res.once === 'function') res.once('close', onClientDisconnect);
    const requestStartedAt = Date.now();
    const upstreamPayloadMessages = shouldDisableThinking(modelCfg) ? applyNoThinkSoftSwitch(upstreamMessages) : upstreamMessages;
    try {
        endpointRelease = await acquireModelSlot(modelCfg);
        const response = await forwardChatCompletion({
            modelCfg,
            user: req.user,
            url: buildChatCompletionsUrl(modelCfg.url, { appendV1ForLocal: true }),
            data: {
                model: modelCfg.model_name,
                messages: upstreamPayloadMessages,
                stream,
                temperature,
                max_tokens: outputTokens,
                ...buildThinkingControlPayload(modelCfg)
            },
            headers: buildModelHeaders(modelCfg),
            stream,
            signal: abortController.signal
        });

        if (stream) {
            const sse = createSseResponseWriter(res);
            const accumulator = createStreamAccumulator();
            const parser = createSseEventParser({ onData(p) { accumulator.pushPayload(p); } });
            // 上游发完响应头再静默挂住时 axios 的 timeout 已失效（只覆盖到响应头），
            // 没有看门狗则 aiSemaphore 与端点许可会被永久持有，只能重启进程释放。
            let streamIdleAborted = false;
            const streamIdleWatchdog = createStreamIdleWatchdog({
                onIdle: (idleMs) => {
                    streamIdleAborted = true;
                    const idleError = new Error(`上游流式响应空闲超过 ${Math.round(idleMs / 1000)} 秒`);
                    idleError.code = 'MODEL_STREAM_IDLE_TIMEOUT';
                    logger.error({ model: modelCfg.name, source, idleMs }, '应用中心 AI 流式上游长时间无数据，已主动中止');
                    recordModelFailure(modelCfg, idleError);
                    try { response.data?.destroy?.(); } catch (_) {}
                    try { abortController.abort(); } catch (_) {}
                    if (!res.writableEnded) {
                        sse.writeData({ error: { message: idleError.message, code: idleError.code, type: 'upstream_timeout' } });
                        res.end();
                    }
                    releaseSlots();
                }
            });
            response.data.on('data', chunk => {
                streamIdleWatchdog.touch();
                sse.writeRaw(chunk);
                parser.write(chunk);
            });
            response.data.on('end', () => {
                streamIdleWatchdog.stop();
                parser.end();
                accumulator.finish();
                const totalContent = accumulator.getContent();
                const apiUsage = accumulator.getUsage();
                const usage = normalizeTokenUsage({
                    inputTokens: apiUsage?.prompt_tokens || estimateTokens(JSON.stringify(upstreamMessages)),
                    outputTokens: apiUsage?.completion_tokens || estimateTokens(totalContent),
                    totalTokens: apiUsage?.total_tokens
                });
                recordModelTokenUsage(userId, modelCfg.id, usage.totalTokens, source, usage.inputTokens, usage.outputTokens);
                recordModelSuccess(modelCfg, Date.now() - requestStartedAt);
                if (typeof onComplete === 'function') {
                    Promise.resolve(onComplete(totalContent, { model: modelCfg.model_name, usage })).catch(err => logger.warn({ err: err.message, source }, '保存应用中心 AI 结果失败'));
                }
                if (!res.writableEnded) res.end();
                releaseSlots();
            });
            response.data.on('error', err => {
                streamIdleWatchdog.stop();
                // 空闲看门狗已经中止上游并回过错误帧，这里不再重复处理
                if (streamIdleAborted) {
                    releaseSlots();
                    return;
                }
                logger.error({ err: err.message, model: modelCfg.name, source }, '应用中心 AI 流式转发中断');
                recordModelFailure(modelCfg, err);
                if (!res.writableEnded) res.end();
                releaseSlots();
            });
            req.on('close', () => {
                streamIdleWatchdog.stop();
                if (response.data && typeof response.data.destroy === 'function') response.data.destroy();
                onClientDisconnect();
            });
            return undefined;
        }

        const content = extractCompletionContent(response.data);
        const usage = normalizeTokenUsage({
            inputTokens: response.data?.usage?.prompt_tokens || estimateTokens(JSON.stringify(upstreamMessages)),
            outputTokens: response.data?.usage?.completion_tokens || estimateTokens(content),
            totalTokens: response.data?.usage?.total_tokens
        });
        recordModelTokenUsage(userId, modelCfg.id, usage.totalTokens, source, usage.inputTokens, usage.outputTokens);
        recordModelSuccess(modelCfg, Date.now() - requestStartedAt);
        releaseSlots();
        if (typeof onComplete === 'function') {
            try { await onComplete(content, { model: modelCfg.model_name, usage }); } catch (err) {
                logger.warn({ err: err.message, source }, '保存应用中心 AI 结果失败');
            }
        }
        // extraPayload 用于让具体应用附带额外字段（如法规问答的引用来源），不影响其它调用方
        return res.json({ content, model: modelCfg.model_name, ...(extraPayload && typeof extraPayload === 'object' ? extraPayload : {}) });
    } catch (e) {
        releaseSlots();
        if (abortController.signal.aborted || e.name === 'AbortError' || e.name === 'CanceledError' || e.code === 'ERR_CANCELED') {
            if (!res.headersSent && !res.writableEnded) {
                return res.status(499).json({ error: { message: '客户端请求已取消。', type: 'client_closed_request' } });
            }
            return undefined;
        }
        const errorMsg = e.response?.data?.error?.message || e.message;
        logger.error({ err: errorMsg, model: modelCfg.name, source }, '应用中心 AI 调用失败');
        recordModelFailure(modelCfg, e);
        if (!res.headersSent) {
            return res.status(e.response?.status || 500).json({ error: { message: errorMsg, type: 'api_error' } });
        }
        if (!res.writableEnded) res.end();
        return undefined;
    }
}

module.exports = {
    stripThinkTags,
    extractCompletionContent,
    parseJsonObject,
    clampText,
    buildModelSecretErrorPayload,
    shouldDisableThinking,
    applyNoThinkSoftSwitch,
    buildThinkingControlPayload,
    resolveOfficialWritingModel,
    resolveAppsModel,
    runAppsAiCompletion
};
