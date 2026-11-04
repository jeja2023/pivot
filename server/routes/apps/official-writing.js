const { asyncHandler } = require('../../http');
const { logger } = require('../../logger');
const { estimateTokens } = require('../../llm');
const {
    getModelDailyUsageAsync,
    recordModelTokenUsage
} = require('../../services/models');
const { aiSemaphore } = require('../../services/concurrency');
const {
    acquireModelSlot,
    recordModelSuccess,
    recordModelFailure
} = require('../../services/model-runtime');
const { createSseEventParser, createStreamAccumulator } = require('../../streaming');
const { createSseResponseWriter } = require('../../services/sse-response');
const { createStreamIdleWatchdog } = require('../../services/stream-idle-watchdog');
const {
    buildChatCompletionsUrl,
    buildModelHeaders
} = require('../../services/model-adapter');
const { forwardChatCompletion } = require('../../services/model-forwarder');
const { normalizeTokenUsage } = require('../../services/token-accounting');
const {
    ContextLengthExceededError,
    fitMessagesToContextBudget
} = require('../../services/context-budget');
const {
    buildOfficialWritingMessages,
    parseOfficialWritingReviewResult,
    OFFICIAL_WRITING_MODE_LABELS,
    OFFICIAL_WRITING_STREAMABLE_MODES
} = require('../../services/official-writing');
const {
    ensureOfficialWritingExportArtifact, getOfficialWritingDocument, listOfficialWritingDocumentPage,
    deleteOfficialWritingDocument,
    saveOfficialWritingDocument
} = require('../../services/official-writing-documents');
const { extractCompletionContent, buildModelSecretErrorPayload, shouldDisableThinking, applyNoThinkSoftSwitch, buildThinkingControlPayload, resolveOfficialWritingModel } = require('./helpers');
const { createOfficialWritingTextFilter } = require('../../services/official-writing-stream');

function registerOfficialWritingRoutes({ router, authMiddleware, logAction }) {
    router.get('/apps/official-writing/format', authMiddleware, asyncHandler(async (_req, res) => {
        res.json(await require('../../services/document-rendering/official-fonts').officialFontStatus());
    }));
    router.post('/apps/official-writing/documents/:clientId/references/check', authMiddleware, asyncHandler(async (req, res) => {
        res.json({ checks: await require('../../services/official-writing-references').checkOfficialWritingReferences(req.user, req.params.clientId) });
    }));
    router.get('/apps/official-writing/documents', authMiddleware, asyncHandler(async (req, res) => {
        const summaryView = Object.keys(req.query).some(key => ['view', 'page', 'limit', 'query', 'docType', 'sort'].includes(key));
        if (summaryView) return res.json(await listOfficialWritingDocumentPage(req.user, req.query));
        // 旧标签页仍需要完整正文，不能把摘要当成空文档再保存回去。
        return res.json({ data: await require('../../services/official-writing-documents').listOfficialWritingDocuments(req.user) });
    }));

    router.get('/apps/official-writing/documents/:clientId', authMiddleware, asyncHandler(async (req, res) => {
        res.json({ document: await getOfficialWritingDocument(req.user, req.params.clientId) });
    }));
    router.post('/apps/official-writing/documents/:clientId/export-artifact', authMiddleware, asyncHandler(async (req, res) => {
        res.json(await ensureOfficialWritingExportArtifact(req.user, req.params.clientId, req.body || {}));
    }));
    router.put('/apps/official-writing/documents/:clientId', authMiddleware, asyncHandler(async (req, res) => {
        if (req.body?.state?.schemaVersion !== 2 && req.body?.version !== 0) {
            return res.status(409).json({ error: '公文编辑器已升级，请保留当前正文并刷新页面后继续编辑。', code: 'OFFICIAL_WRITING_CLIENT_UPGRADE_REQUIRED' });
        }
        const document = await saveOfficialWritingDocument(req.user, req.params.clientId, req.body || {});
        if (document.isModified !== false) {
            logAction(req, '保存公文写作草稿', `公文标识: ${document.id}`);
        }
        res.json({ success: true, document });
    }));

    router.delete('/apps/official-writing/documents/:clientId', authMiddleware, asyncHandler(async (req, res) => {
        const deleted = await deleteOfficialWritingDocument(req.user, req.params.clientId);
        if (!deleted) return res.status(404).json({ error: '公文不存在或无权访问。' });
        logAction(req, '删除公文写作草稿', `公文标识: ${req.params.clientId}`);
        return res.json({ success: true });
    }));

    router.post('/apps/official-writing/ai', authMiddleware, asyncHandler(async (req, res) => {
        const body = req.body || {};
        const mode = String(body.mode || '').trim();

        let built;
        try {
            built = buildOfficialWritingMessages(body);
        } catch (e) {
            return res.status(400).json({ error: { message: e.message, type: 'invalid_request_error' } });
        }

        // 文本类模式（起草/润色/全文改写/选区/逐句改写）均可流式；
        // review 模式需要在后端把整段输出解析为结构化 JSON 条目，必须拿到完整文本，故不参与流式。
        const wantStream = !!body.stream && OFFICIAL_WRITING_STREAMABLE_MODES.has(mode);
        const modelCfg = await resolveOfficialWritingModel(String(body.model || '').trim(), req.user);
        if (!modelCfg) {
            return res.status(404).json({
                error: {
                    message: '未找到可用模型，请在当前应用中选择模型或设置默认模型后再使用 AI 功能。',
                    type: 'invalid_request_error',
                    code: 'model_not_found'
                }
            });
        }
        if (modelCfg.secret_error) {
            return res.status(400).json(buildModelSecretErrorPayload(modelCfg));
        }

        const userId = req.user.id;
        // 获取模型配置的最大输出 Token 限制
        const modelMaxTokens = Number(modelCfg.max_tokens) || 0;
        // 输出长度完全由模型决定：公文不再设内置默认上限。
        // 预算检查时，若模型未配置最大输出限制，则传 null，由全局上下文预算用默认预留量裁剪输入。
        const maxTokens = modelMaxTokens > 0 ? modelMaxTokens : null;
        // 推理型模型：公文工具任务关闭思考，避免思考耗尽 token 导致正文为空（Qwen3 等）。
        const disableThinking = shouldDisableThinking(modelCfg);
        const requestMessages = disableThinking ? applyNoThinkSoftSwitch(built.messages) : built.messages;

        // 上下文预算检查（与聊天/OpenAI 兼容接口同一套口径）。
        let upstreamMessages = requestMessages;
        try {
            const budgetResult = fitMessagesToContextBudget(requestMessages, modelCfg, { maxOutputTokens: maxTokens });
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
            const usedToday = await getModelDailyUsageAsync(userId, modelCfg.id);
            if (usedToday >= modelCfg.daily_token_limit) {
                return res.status(429).json({ error: { message: '今日模型调用额度已用尽。', type: 'insufficient_quota' } });
            }
        }

        const auditLabel = OFFICIAL_WRITING_MODE_LABELS[mode] || mode || '处理';
        const auditAction = body.action ? `/${String(body.action).slice(0, 20)}` : '';
        logAction(req, '公文写作 AI', `操作: ${auditLabel}${auditAction}，模型: ${modelCfg.name}，流式: ${wantStream}`);

        // 从排队开始监听取消，防止已关闭的请求在获取队列名额后继续消耗模型。
        const abortController = new AbortController();
        const abortPending = () => { if (!res.writableEnded) abortController.abort(); };
        req.once?.('aborted', abortPending);
        res.once?.('close', abortPending);
        // 全局与端点等待共享取消信号。
        try {
            await aiSemaphore.acquire({ signal: abortController.signal });
        } catch (e) {
            return res.status(e.statusCode || 503).json({
                error: { message: e.message || 'Model service is busy. Please retry later.', type: 'server_overloaded', code: e.code || 'AI_OVERLOADED' }
            });
        }
        let semaphoreReleased = false;
        let endpointRelease = null;
        const requestStartedAt = Date.now();
        try {
            endpointRelease = await acquireModelSlot(modelCfg, { signal: abortController.signal });
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
        const onClientDisconnect = () => {
            try { abortController.abort(); } catch (_) {}
            releaseSemaphore();
        };
        if (typeof req.once === 'function') req.once('aborted', onClientDisconnect);
        if (typeof res.once === 'function') res.once('close', onClientDisconnect);

        const targetUrl = buildChatCompletionsUrl(modelCfg.url, { appendV1ForLocal: true });
        const payload = {
            model: modelCfg.model_name,
            messages: upstreamMessages,
            stream: wantStream,
            temperature: modelCfg.temperature ?? 0.4
        };
        if (modelMaxTokens > 0) {
            payload.max_tokens = modelMaxTokens;
        }
        if (modelCfg.max_input_tokens !== null && modelCfg.max_input_tokens !== undefined) {
            payload.max_input_tokens = modelCfg.max_input_tokens;
        }
        // 上面的 /no_think 软开关在 Qwen3.6 的 chat template 中已不生效，必须再显式关闭，
        // 否则思考会吃掉输出预算导致正文为空。是否附加由 buildThinkingControlPayload 自行按模型判定。
        Object.assign(payload, buildThinkingControlPayload(modelCfg));
        const headers = buildModelHeaders(modelCfg);

        try {
            const response = await forwardChatCompletion({
                modelCfg,
                user: req.user,
                url: targetUrl,
                data: payload,
                headers,
                stream: wantStream,
                signal: abortController.signal
            });

            if (wantStream) {
                const sse = createSseResponseWriter(res);

                const accumulator = createStreamAccumulator();
                const textFilter = createOfficialWritingTextFilter();
                let upstreamError = false;
                const sendVisible = content => { if (content) sse.writeData({ choices: [{ delta: { content } }] }); };
                const parser = createSseEventParser({
                    onData(p) {
                        accumulator.pushPayload(p);
                        let data;
                        try { data = JSON.parse(p); } catch (_) { return; }
                        if (data.error) { upstreamError = true; recordModelFailure(modelCfg, new Error(data.error.message || '公文模型流式响应失败')); sse.writeData({ error: data.error }); return; }
                        const choice = data.choices?.[0];
                        const content = data.content ?? choice?.delta?.content ?? choice?.message?.content ?? '';
                        if (typeof content === 'string') sendVisible(textFilter.push(content));
                        if (choice?.finish_reason) {
                            sendVisible(textFilter.finish());
                            sse.writeData({ choices: [{ delta: {}, finish_reason: choice.finish_reason }] });
                        }
                    },
                    onDone() { sendVisible(textFilter.finish()); sse.writeData('[DONE]'); }
                });
                // 与上面同理：axios 的 timeout 不覆盖流体传输，上游静默挂住需要看门狗兜底
                let streamIdleAborted = false;
                const streamIdleWatchdog = createStreamIdleWatchdog({
                    onIdle: (idleMs) => {
                        streamIdleAborted = true;
                        const idleError = new Error(`上游流式响应空闲超过 ${Math.round(idleMs / 1000)} 秒`);
                        idleError.code = 'MODEL_STREAM_IDLE_TIMEOUT';
                        logger.error({ model: modelCfg.name, idleMs }, '公文写作流式上游长时间无数据，已主动中止');
                        recordModelFailure(modelCfg, idleError);
                        try { response.data?.destroy?.(); } catch (_) {}
                        try { abortController.abort(); } catch (_) {}
                        if (!res.writableEnded) {
                            sse.writeData({ error: { message: idleError.message, code: idleError.code, type: 'upstream_timeout' } });
                            res.end();
                        }
                        releaseSemaphore();
                    }
                });
                response.data.on('data', chunk => {
                    streamIdleWatchdog.touch();
                    parser.write(chunk);
                });
                response.data.on('end', () => {
                    streamIdleWatchdog.stop();
                    parser.end();
                    sendVisible(textFilter.finish());
                    accumulator.finish();
                    const totalContent = accumulator.getContent();
                    const apiUsage = accumulator.getUsage();
                    const usage = normalizeTokenUsage({
                        inputTokens: apiUsage?.prompt_tokens || estimateTokens(JSON.stringify(upstreamMessages)),
                        outputTokens: apiUsage?.completion_tokens || estimateTokens(totalContent),
                        totalTokens: apiUsage?.total_tokens
                    });
                    recordModelTokenUsage(userId, modelCfg.id, usage.totalTokens, 'official_writing', usage.inputTokens, usage.outputTokens);
                    if (!upstreamError && !abortController.signal.aborted) recordModelSuccess(modelCfg, Date.now() - requestStartedAt);
                    res.end();
                    releaseSemaphore();
                });
                response.data.on('error', err => {
                    streamIdleWatchdog.stop();
                    if (streamIdleAborted) {
                        releaseSemaphore();
                        return;
                    }
                    logger.error({ err: err.message, model: modelCfg.name }, '公文写作流式转发中断');
                    recordModelFailure(modelCfg, err);
                    if (!res.writableEnded) { sse.writeData({ error: { message: '上游生成中断，请重试', code: 'MODEL_STREAM_INTERRUPTED' } }); res.end(); }
                    releaseSemaphore();
                });
                response.data.on('close', () => {
                    streamIdleWatchdog.stop();
                    releaseSemaphore();
                });
                if (typeof req.on === 'function') {
                    req.on('close', () => {
                        streamIdleWatchdog.stop();
                        if (response.data && typeof response.data.destroy === 'function') response.data.destroy();
                        onClientDisconnect();
                    });
                }
            } else {
                const choice = response.data?.choices?.[0];
                const finishReason = choice?.finish_reason || null;
                const content = extractCompletionContent(response.data);
                const usage = normalizeTokenUsage({
                    inputTokens: response.data?.usage?.prompt_tokens || estimateTokens(JSON.stringify(upstreamMessages)),
                    outputTokens: response.data?.usage?.completion_tokens || estimateTokens(content),
                    totalTokens: response.data?.usage?.total_tokens
                });
                recordModelTokenUsage(userId, modelCfg.id, usage.totalTokens, 'official_writing', usage.inputTokens, usage.outputTokens);
                recordModelSuccess(modelCfg, Date.now() - requestStartedAt);
                releaseSemaphore();

                // 空正文诊断：记录 finish_reason / usage / 是否含 reasoning_content，便于定位“返回 200 但无正文”。
                if (!content) {
                    logger.warn({
                        model: modelCfg.name,
                        modelName: modelCfg.model_name,
                        mode,
                        finishReason,
                        hasReasoningContent: !!choice?.message?.reasoning_content,
                        disableThinking,
                        maxTokens,
                        usage: response.data?.usage || null
                    }, '公文写作 AI 返回空正文');
                }

                const result = { content, model: modelCfg.model_name, finish_reason: finishReason };
                // 审校模式在后端完成 JSON 提取与校验，前端直接使用结构化结果。
                if (mode === 'review') Object.assign(result, parseOfficialWritingReviewResult(content, finishReason));
                else result.status = ['length', 'content_filter'].includes(finishReason) ? 'partial' : 'complete';
                res.json(result);
            }
        } catch (e) {
            releaseSemaphore();
            if (abortController.signal.aborted || e.name === 'AbortError' || e.name === 'CanceledError' || e.code === 'ERR_CANCELED') {
                if (!res.headersSent && !res.writableEnded) {
                    return res.status(499).json({ error: { message: '客户端请求已取消。', type: 'client_closed_request' } });
                }
                return undefined;
            }
            const errorMsg = e.response?.data?.error?.message || e.message;
            logger.error({ err: errorMsg, model: modelCfg.name }, '公文写作 AI 转发失败');
            recordModelFailure(modelCfg, e);
            if (!res.headersSent) {
                res.status(e.response?.status || 500).json({ error: { message: errorMsg, type: 'api_error' } });
            } else if (!res.writableEnded) {
                res.end();
            }
            return undefined;
        }
    }));

}
module.exports = { registerOfficialWritingRoutes };
