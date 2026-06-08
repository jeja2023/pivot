/* 对话接口路由 Chat API Routes */
const axios = require('axios');
const express = require('express');
const { asyncHandler } = require('../http');
const { db } = require('../db');
const {
    detectUnsupportedCapability,
    buildCapabilityFallbackMessage
} = require('../capabilities');
const { estimateTokens, getContext } = require('../llm');
const {
    getAccessibleModel,
    getModelDailyUsage,
    modelSupportsVision,
    contentContainsVisionInput
} = require('../services/models');
const { aiSemaphore } = require('../services/concurrency');
const {
    acquireModelSlot,
    recordModelSuccess,
    recordModelFailure
} = require('../services/model-runtime');
const { createSseEventParser, createStreamAccumulator, splitStreamTextForDisplay } = require('../streaming');
const {
    buildModelHeaders,
    buildResponsesUrl,
    buildChatCompletionsUrl,
    convertChatMessagesToResponsesInput,
    normalizeModelBaseUrl,
    shouldUseResponsesApi,
    assertSafeModelRuntimeUrl,
    createSafeModelHttpAgents
} = require('../services/model-adapter');
const {
    extractModelTextFromRawResponse,
    getRequestOrigin,
    normalizeRegenerateFlag,
    resolveRagQueryContent
} = require('../services/chat-route-helpers');
const {
    buildRagContextMessage,
    injectRagContextBeforeLatestUser,
    summarizeRagContextSources
} = require('../services/chat-rag-context');
const {
    saveAssistantMessage,
    saveUserMessage,
    touchSession,
    updateLastAssistantStats
} = require('../services/chat-messages');
const {
    ContextLengthExceededError,
    buildContextLengthExceededPayload,
    estimateMessagesTokens,
    fitMessagesToContextBudget
} = require('../services/context-budget');
const { maybeGenerateTitle } = require('../services/chat-title');
const {
    buildPersistedChatErrorContent,
    readStreamErrorDetail,
    writeChatErrorSse
} = require('../services/chat-errors');
const {
    buildVisionHistory,
    buildVisionUnsupportedMessage,
    limitVisionImages
} = require('../services/chat-vision');
const { listCachedMcpTools } = require('../services/mcp-client');
const { filterMcpToolsByCapability } = require('../services/capability-market');
const {
    buildFallbackDataQueryInput,
    detectStrongDataQueryIntent,
    filterMcpToolsForChatIntent,
    filterMcpToolsForPlanner,
    maybeBuildMcpChatContext
} = require('../services/chat-mcp-context');

const MAX_STREAM_FALLBACK_CAPTURE_CHARS = 2_000_000;
const CHAT_LANGUAGE_SYSTEM_PROMPT = [
    '【重要语言规则】你必须全程使用中文，包括：',
    '1. 最终回答必须使用中文。',
    '2. 所有可见的思考、推理、reasoning_content、<think> 或 <thought> 内容也必须使用中文，禁止使用英文提纲或英文推理。',
    '3. 即使用户问题中包含英文，思考和回答仍然默认使用中文。',
    '4. 仅当用户明确要求使用其他语言时，才可在该次回复中切换语言。',
    '',
    '【重要工具规则】',
    '1. 如果用户要求查询数据、统计分析或生成图表，不要生成 Python（matplotlib/pandas/plotly）、JavaScript（echarts/Chart.js）或其他编程语言的代码来画图。',
    '2. 如果你可以访问能力库工具（数据库查询、图表生成等），请引导用户开启并使用这些内置工具来获取数据和生成真正的交互式图表。',
    '3. 如果你收到了 ```pivot-echart 代码块，请在最终回答中原样保留该代码块——前端会自动将其渲染为交互式可视化图表，不要将其转换为纯文本或其他格式。',
    '4. 如果你收到了 ```pivot-table 代码块，请在最终回答中原样保留。'
].join('\n');

function serializeChartSpec(chartSpec) {
    try {
        const serialized = JSON.stringify(chartSpec);
        return serialized && serialized !== 'null' ? serialized : '';
    } catch (_err) {
        return '';
    }
}

function chartSpecToMarkdown(chartSpec) {
    const serialized = serializeChartSpec(chartSpec);
    if (!serialized) return '';
    return [
        '```pivot-echart',
        JSON.stringify(chartSpec, null, 2),
        '```'
    ].join('\n');
}

function contentIncludesRenderableChart(content = '') {
    return /```(?:pivot-echart|pivot-chart)\b/i.test(String(content || ''));
}

function appendStreamedChartsToAssistantContent(content = '', chartSpecs = []) {
    const baseContent = String(content || '').trimEnd();
    if (!Array.isArray(chartSpecs) || chartSpecs.length === 0 || contentIncludesRenderableChart(baseContent)) {
        return String(content || '');
    }

    const seen = new Set();
    const blocks = [];
    chartSpecs.forEach(chartSpec => {
        const key = serializeChartSpec(chartSpec);
        if (!key || seen.has(key)) return;
        seen.add(key);
        const block = chartSpecToMarkdown(chartSpec);
        if (block) blocks.push(block);
    });
    if (!blocks.length) return String(content || '');
    return [baseContent, ...blocks].filter(Boolean).join('\n\n');
}

function createChartSseCapture(writeRaw) {
    const streamedChartSpecs = [];
    const streamedChartSpecKeys = new Set();

    const writeSse = (payload) => {
        let data = null;
        try {
            data = typeof payload === 'string' ? JSON.parse(payload) : payload;
        } catch (_err) {
            data = null;
        }

        if (data && data.type === 'chart') {
            const key = serializeChartSpec(data.data);
            if (key && !streamedChartSpecKeys.has(key)) {
                streamedChartSpecKeys.add(key);
                streamedChartSpecs.push(data.data);
            }
            return false;
        }

        if (typeof writeRaw === 'function') writeRaw(payload);
        return true;
    };

    return { streamedChartSpecs, writeSse };
}

function applyChatLanguageInstruction(history = []) {
    const messages = Array.isArray(history) ? history.slice() : [];
    const first = messages[0];
    if (first?.role === 'system' && typeof first.content === 'string') {
        if (first.content.includes('【重要语言规则】') || first.content.includes('reasoning_content')) return messages;
        return [
            { ...first, content: `${first.content.trim()}\n\n${CHAT_LANGUAGE_SYSTEM_PROMPT}`.trim() },
            ...messages.slice(1)
        ];
    }
    return [
        { role: 'system', content: CHAT_LANGUAGE_SYSTEM_PROMPT },
        ...messages
    ];
}

function createChatRouter({
    authMiddleware,
    chatLimiter,
    logAction,
    retrieveContext,
    isRagEnabled,
    publicUrl = ''
}) {
    const router = express.Router();

    router.post('/chat/stats', authMiddleware, asyncHandler(async (req, res) => {
        const { sessionId, costTime, tps } = req.body;
        updateLastAssistantStats({ sessionId, userId: req.user.id, costTime, tps });
        res.json({ success: true });
    }));

    router.post('/chat', authMiddleware, chatLimiter, asyncHandler(async (req, res) => {
        const { content, displayContent } = req.body;
        const regenerate = normalizeRegenerateFlag(req.body.regenerate);
        const mcpEnabled = Boolean(req.body.mcpEnabled) && Boolean(req.body.mcpConfirmed);
        const ragEnabled = req.body.ragEnabled !== false;
        const sessionId = String(req.body.sessionId || '').trim();
        const modelId = req.body.modelId ? parseInt(req.body.modelId) : null;
        const userId = req.user.id;
        const modelContent = String(content || '').trim();
        const visibleContent = String(displayContent || modelContent).trim();
        let userMessagePersisted = false;

        req.log.info({ sessionId, userId, modelId, regenerate, contentLength: modelContent.length }, '处理对话请求');

        // --- 立即建立 SSE 连接 ---
        res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
        res.setHeader('Cache-Control', 'no-cache, no-transform');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Accel-Buffering', 'no');
        res.setHeader('Content-Encoding', 'identity');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.socket?.setNoDelay?.(true);
        res.socket?.setKeepAlive?.(true);
        res.flushHeaders?.();

        const chartSseCapture = createChartSseCapture((payload) => {
            res.write(`data: ${payload}\n\n`);
            res.flush?.();
        });
        const streamedChartSpecs = chartSseCapture.streamedChartSpecs;
        const writeSse = (payload) => {
            if (res.writableEnded) return;
            chartSseCapture.writeSse(payload);
        };

        const writeQueueNotice = (scope, info = {}) => {
            const queueAhead = Math.max(0, Number(info.queueAhead || 0));
            const label = scope === 'endpoint' ? '模型端点' : '模型服务';
            const activeText = Number.isFinite(Number(info.active)) && Number.isFinite(Number(info.max))
                ? `已有 ${info.active}/${info.max} 个请求正在生成`
                : '正在等待可用生成通道';
            const timeoutSeconds = info.queueTimeoutMs ? `，最长等待约 ${Math.round(info.queueTimeoutMs / 1000)} 秒` : '';
            const message = info.status === 'ready'
                ? `${label}排队结束，正在连接模型。`
                : `正在排队，前面${queueAhead === 0 ? '没有等待请求' : `还有 ${queueAhead} 个等待请求`}，${activeText}${timeoutSeconds}。`;
            writeSse(JSON.stringify({
                type: 'queue',
                scope,
                status: info.status || 'waiting',
                message,
                ...info
            }));
        };

        res.write(': stream-ready\n\n');
        res.flush?.();

        // --- 业务逻辑检查 ---
        const session = db.prepare('SELECT id FROM sessions WHERE id = ? AND user_id = ? AND deleted_at IS NULL').get(sessionId, userId);
        if (!session) {
            writeSse(JSON.stringify({ error: '无权访问或会话不存在', code: 'FORBIDDEN' }));
            return res.end();
        }

        const modelCfg = getAccessibleModel(modelId, req.user);
        if (!modelCfg) {
            writeSse(JSON.stringify({ error: '未找到可用的模型配置', code: 'MODEL_NOT_FOUND' }));
            return res.end();
        }

        if (modelCfg.secret_error) {
            writeSse(JSON.stringify({ error: `${modelCfg.secret_error}，请重新保存该模型的 API Key`, code: 'API_KEY_ERROR' }));
            return res.end();
        }

        try {
            fitMessagesToContextBudget([{ role: 'user', content: modelContent }], modelCfg);
        } catch (e) {
            if (e instanceof ContextLengthExceededError || e.code === 'CONTEXT_LENGTH_EXCEEDED') {
                req.log.warn({
                    sessionId,
                    userId,
                    modelId: modelCfg.id,
                    contentLength: modelContent.length,
                    contextBudget: e.metadata
                }, '聊天请求因当前输入超限被拦截');
                writeSse(JSON.stringify(buildContextLengthExceededPayload(e)));
                return res.end();
            }
            throw e;
        }

        if (modelCfg.daily_token_limit && modelCfg.daily_token_limit > 0) {
            const usedToday = getModelDailyUsage(userId, modelCfg.id);
            if (usedToday >= modelCfg.daily_token_limit) {
                logAction(req, '模型额度拦截', `模型: ${modelCfg.name}，今日已用: ${usedToday}/${modelCfg.daily_token_limit}`);
                writeSse(JSON.stringify({ error: `该模型今日额度已用完（${usedToday}/${modelCfg.daily_token_limit} Tokens）`, code: 'QUOTA_EXCEEDED' }));
                return res.end();
            }
        }

        if (!regenerate) {
            try {
                const userMessageResult = saveUserMessage({ sessionId, userId, content: modelContent, modelId: modelCfg.id });
                userMessagePersisted = true;
                writeSse(JSON.stringify({
                    type: 'message_saved',
                    role: 'user',
                    messageId: userMessageResult.lastInsertRowid
                }));
            } catch (dbErr) {
                req.log.error({ sessionId, err: dbErr.message }, '用户消息入库失败');
                writeSse(JSON.stringify({ error: '消息保存失败，请稍后重试', code: 'DB_ERROR' }));
                return res.end();
            }
        }

        touchSession(sessionId);
        logAction(req, regenerate ? '重新生成回答' : '发送消息', `${regenerate ? '重新生成' : '发送消息到'}会话: ${sessionId}`);

        if (contentContainsVisionInput(modelContent) && !modelSupportsVision(modelCfg)) {
            const assistantContent = buildVisionUnsupportedMessage(modelCfg);
            const assistantTokens = estimateTokens(assistantContent);
            const assistantMessageResult = saveAssistantMessage({ sessionId, userId, content: assistantContent, tokenCount: assistantTokens, modelId: modelCfg.id });

            maybeGenerateTitle(sessionId, userId, visibleContent, assistantContent, modelCfg, req.user);
            logAction(req, '模型多模态能力拦截', `模型: ${modelCfg.name}, 会话: ${sessionId}`);

            writeSse(JSON.stringify({
                unsupportedCapability: 'vision_input',
                content: assistantContent,
                messageId: assistantMessageResult.lastInsertRowid
            }));
            writeSse('[DONE]');
            return res.end();
        }

        const unsupportedCapability = detectUnsupportedCapability(modelContent);
        if (unsupportedCapability) {
            const assistantContent = buildCapabilityFallbackMessage(unsupportedCapability);
            const assistantTokens = estimateTokens(assistantContent);
            const assistantMessageResult = saveAssistantMessage({ sessionId, userId, content: assistantContent, tokenCount: assistantTokens, modelId: modelCfg.id });

            maybeGenerateTitle(sessionId, userId, visibleContent, assistantContent, modelCfg, req.user);
            logAction(req, '能力不支持提示', `能力: ${unsupportedCapability.code}, 会话: ${sessionId}`);
            
            writeSse(JSON.stringify({
                unsupportedCapability: unsupportedCapability.code,
                content: assistantContent,
                messageId: assistantMessageResult.lastInsertRowid
            }));
            writeSse('[DONE]');
            return res.end();
        }


        let semaphoreReleased = false;
        let endpointRelease = null;
        let globalSlotAcquired = false;
        const requestStartedAt = Date.now();
        const releaseSemaphore = () => {
            if (!semaphoreReleased) {
                if (endpointRelease) endpointRelease();
                if (globalSlotAcquired) aiSemaphore.release();
                semaphoreReleased = true;
            }
        };


        // --- 进入并发控制 ---
        let queuedAtGlobalGate = false;
        try {
            await aiSemaphore.acquire({
                onQueued(info) {
                    queuedAtGlobalGate = true;
                    writeQueueNotice('global', info);
                }
            });
            globalSlotAcquired = true;
            if (queuedAtGlobalGate) writeQueueNotice('global', { status: 'ready', active: aiSemaphore.getStatus().active, max: aiSemaphore.getStatus().max });
        } catch (e) {
            const message = e.message || '模型服务当前繁忙，请稍后重试。';
            logAction(req, '模型服务繁忙', `${message} 会话: ${sessionId}`);
            writeChatErrorSse({
                writeSse,
                sessionId,
                userId,
                modelId: modelCfg.id,
                error: message,
                code: e.code || 'AI_OVERLOADED',
                retryable: true,
                persist: userMessagePersisted || regenerate,
                log: req.log
            });
            return res.end();
        }

        let queuedAtEndpointGate = false;
        try {
            endpointRelease = await acquireModelSlot(modelCfg, {
                onQueued(info) {
                    queuedAtEndpointGate = true;
                    writeQueueNotice('endpoint', info);
                }
            });
            if (queuedAtEndpointGate) {
                const status = aiSemaphore.getStatus();
                writeQueueNotice('endpoint', { status: 'ready', active: status.active, max: status.max });
            }
        } catch (e) {
            releaseSemaphore();
            const message = e.message || '模型端点当前繁忙，请稍后重试。';
            logAction(req, '模型端点繁忙', `${message} 会话: ${sessionId}`);
            writeChatErrorSse({
                writeSse,
                sessionId,
                userId,
                modelId: modelCfg.id,
                error: message,
                code: e.code || 'AI_ENDPOINT_OVERLOADED',
                retryable: true,
                persist: userMessagePersisted || regenerate,
                log: req.log
            });
            return res.end();
        }

        let history = await getContext(sessionId, userId, modelCfg);
        const effectiveUserPrompt = resolveRagQueryContent(modelContent, history);
        if (ragEnabled && typeof retrieveContext === 'function' && typeof isRagEnabled === 'function' && isRagEnabled()) {
            const ragContext = effectiveUserPrompt ? await retrieveContext(userId, effectiveUserPrompt, null, { user: req.user }) : null;
            if (ragContext) {
                const ragSourceSummary = summarizeRagContextSources(ragContext);
                history = injectRagContextBeforeLatestUser(history, ragContext);
                writeSse(JSON.stringify({
                    type: 'rag',
                    status: 'hit',
                    message: ragSourceSummary.sourceCount > 0
                        ? `知识库已找到 ${ragSourceSummary.citationCount || ragSourceSummary.sourceCount} 条资料，正在基于来源生成回答`
                        : '知识库已找到相关资料，正在基于资料生成回答',
                    citationCount: ragSourceSummary.citationCount,
                    sourceCount: ragSourceSummary.sourceCount,
                    sources: ragSourceSummary.sources
                }));
            } else {
                writeSse(JSON.stringify({
                    type: 'rag',
                    status: 'empty',
                    message: '知识库未检索到足够相关内容，将按普通对话继续'
                }));
            }
        }
        let visionHistory = limitVisionImages(await buildVisionHistory(history, getRequestOrigin(req, publicUrl), userId, sessionId));
        visionHistory = applyChatLanguageInstruction(visionHistory);
        
        if (visionHistory.length === 0) {
            req.log.warn({ sessionId, userId }, '检测到空的消息历史，尝试补救');
            // 如果历史为空，至少把当前消息塞进去（如果是刚发送的消息）
            if (modelContent) {
                req.log.info({ sessionId }, '执行补救措施：将丢失的用户消息存入数据库并加入当前上下文');
                try {
                    saveUserMessage({ sessionId, userId, content: modelContent, modelId });
                } catch (dbErr) {
                    req.log.error({ err: dbErr.message }, '补救消息入库失败');
                }

                // 补救的消息也需要经过 buildVisionHistory 处理以支持多模态
                const rescuedHistory = limitVisionImages(await buildVisionHistory([{ role: 'user', content: modelContent }], getRequestOrigin(req, publicUrl), userId, sessionId));
                visionHistory.push(...rescuedHistory);
            } else {
                releaseSemaphore();
                writeChatErrorSse({
                    writeSse,
                    sessionId,
                    userId,
                    modelId: modelCfg.id,
                    error: '对话内容不能为空',
                    code: 'EMPTY_MESSAGE',
                    persist: userMessagePersisted || regenerate,
                    log: req.log
                });
                return res.end();
            }
        }

        if (mcpEnabled) {
            const mcpTools = filterMcpToolsByCapability(listCachedMcpTools(null, req.user), req.user);
            const mcpContext = await maybeBuildMcpChatContext({
                modelCfg,
                history: visionHistory,
                userPrompt: effectiveUserPrompt || modelContent,
                tools: mcpTools,
                user: req.user,
                writeSse,
                log: req.log
            });
            if (mcpContext) {
                visionHistory.push({ role: 'system', content: mcpContext });
            }
        }

        try {
            const budgetResult = fitMessagesToContextBudget(visionHistory, modelCfg);
            visionHistory = budgetResult.messages;
            if (budgetResult.metadata.adjusted) {
                req.log.warn({
                    sessionId,
                    userId,
                    modelId: modelCfg.id,
                    contextBudget: budgetResult.metadata
                }, '聊天上下文已按模型窗口自动裁剪');
                writeSse(JSON.stringify({
                    type: 'context_budget',
                    status: 'trimmed',
                    message: '本次请求内容较长，已自动减少较早历史或知识库片段后继续生成。',
                    contextBudget: budgetResult.metadata
                }));
            } else {
                req.log.info({
                    sessionId,
                    userId,
                    modelId: modelCfg.id,
                    inputTokens: budgetResult.metadata.inputTokensAfter,
                    inputBudget: budgetResult.metadata.budget.inputBudget
                }, '聊天上下文预算检查通过');
            }
        } catch (e) {
            releaseSemaphore();
            if (e instanceof ContextLengthExceededError || e.code === 'CONTEXT_LENGTH_EXCEEDED') {
                req.log.warn({
                    sessionId,
                    userId,
                    modelId: modelCfg.id,
                    contextBudget: e.metadata
                }, '聊天请求因上下文超限被拦截');
                const payload = buildContextLengthExceededPayload(e);
                writeChatErrorSse({
                    writeSse,
                    sessionId,
                    userId,
                    modelId: modelCfg.id,
                    error: payload.error,
                    detail: payload.detail,
                    code: payload.code,
                    persist: userMessagePersisted || regenerate,
                    log: req.log
                });
                return res.end();
            }
            throw e;
        }

        let baseUrl = normalizeModelBaseUrl(modelCfg.url, { appendV1ForLocal: false });

        const modelName = modelCfg.model_name || 'default';
        const isResponsesApi = shouldUseResponsesApi(modelName);

        let targetUrl = isResponsesApi
            ? buildResponsesUrl(modelCfg.url, { appendV1ForLocal: false })
            : buildChatCompletionsUrl(modelCfg.url, { appendV1ForLocal: false });

        req.log.info({
            userId,
            model: modelCfg.name,
            modelName,
            targetUrl,
            mode: isResponsesApi ? 'Responses API' : 'Chat Completions API'
        }, '发起对话请求');

        const headers = buildModelHeaders(modelCfg, { acceptJson: true });

        try {
            let response;

            // 将 Chat Completions 格式转换为 Responses API 格式
            const responsesHistory = convertChatMessagesToResponsesInput(visionHistory);

            const requestData = { 
                model: modelName, 
                stream: true 
            };
            if (modelCfg.temperature !== null && modelCfg.temperature !== undefined) {
                requestData.temperature = modelCfg.temperature;
            }
            if (modelCfg.max_tokens !== null && modelCfg.max_tokens !== undefined) {
                requestData.max_completion_tokens = modelCfg.max_tokens;
                requestData.max_tokens = modelCfg.max_tokens; // Some APIs use this instead
            }
            if (modelCfg.max_input_tokens !== null && modelCfg.max_input_tokens !== undefined) {
                requestData.max_input_tokens = modelCfg.max_input_tokens;
            }
            req.log.info({
                sessionId,
                userId,
                modelId: modelCfg.id,
                estimatedInputTokens: estimateMessagesTokens(visionHistory)
            }, '准备发送模型请求');

            if (isResponsesApi) {
                req.log.info('正在建立连接 (Responses API, 流式)');
                // 记录多模态内容的结构信息
                const inputSummary = responsesHistory.map(m => ({
                    role: m.role,
                    contentType: Array.isArray(m.content) ? m.content.map(p => p.type).join('+') : 'text'
                }));
                req.log.info({ inputSummary }, '请求体结构');
                try {
                    requestData.input = responsesHistory;
                    await assertSafeModelRuntimeUrl(modelCfg, targetUrl, req.user);
                    const agents = createSafeModelHttpAgents(modelCfg, req.user);
                    response = await axios({
                        method: 'post', url: targetUrl, headers,
                        data: requestData,
                        responseType: 'stream', timeout: 180000, proxy: false,
                        ...agents
                    });
                    req.log.info('连接成功 (Responses API)');
                } catch (err) {
                    const status = err.response?.status;
                    if ([404, 405, 502, 503].includes(status)) {
                        req.log.warn({ status }, 'Responses API 暂不可用，正在自动回退到常规接口');
                        targetUrl = buildChatCompletionsUrl(baseUrl, { appendV1ForLocal: false });
                        
                        delete requestData.input;
                        requestData.messages = visionHistory;
                        
                        await assertSafeModelRuntimeUrl(modelCfg, targetUrl, req.user);
                        const agents = createSafeModelHttpAgents(modelCfg, req.user);
                        response = await axios({
                            method: 'post', url: targetUrl, headers,
                            data: requestData,
                            responseType: 'stream', timeout: 300000, proxy: false,
                            ...agents
                        });
                        req.log.info('降级连接成功 (Chat Completions)');
                    } else {
                        throw err;
                    }
                }
            } else {
                req.log.info('正在建立连接 (Chat Completions API, 流式)');
                requestData.messages = visionHistory;
                await assertSafeModelRuntimeUrl(modelCfg, targetUrl, req.user);
                const agents = createSafeModelHttpAgents(modelCfg, req.user);
                response = await axios({
                    method: 'post', url: targetUrl, headers,
                    data: requestData,
                    responseType: 'stream', timeout: 300000, proxy: false,
                    ...agents
                });
                req.log.info('连接成功');
            }

            const writeContentSse = (content) => {
                splitStreamTextForDisplay(content).forEach(chunk => {
                    writeSse(JSON.stringify({ content: chunk }));
                });
            };
            const accumulator = createStreamAccumulator({
                includeThoughtTags: true,
                onContent(sendContent) {
                    writeContentSse(sendContent);
                }
            });
            const parser = createSseEventParser({
                onData(payload) {
                    accumulator.pushPayload(payload);
                },
                onDone() {}
            });

            let rawStreamText = '';
            let rawStreamCaptureTruncated = false;
            const captureRawStreamChunk = (chunk) => {
                if (rawStreamCaptureTruncated || rawStreamText.length >= MAX_STREAM_FALLBACK_CAPTURE_CHARS) return;
                const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk || '');
                const remaining = MAX_STREAM_FALLBACK_CAPTURE_CHARS - rawStreamText.length;
                if (text.length > remaining) {
                    rawStreamText += text.slice(0, remaining);
                    rawStreamCaptureTruncated = true;
                    return;
                }
                rawStreamText += text;
            };

            response.data.on('data', chunk => {
                captureRawStreamChunk(chunk);
                parser.write(chunk);
            });

            response.data.on('end', async () => {
                try {
                    parser.end();
                    accumulator.finish();

                    let assistantContent = accumulator.getContent();
                    let apiUsage = accumulator.getUsage();
                    if (!assistantContent.trim()) {
                        const fallback = extractModelTextFromRawResponse(rawStreamText);
                        if (fallback.content) {
                            assistantContent = fallback.content;
                            apiUsage = fallback.usage || apiUsage;
                            writeContentSse(assistantContent);
                            req.log.warn({
                                sessionId,
                                rawStreamCaptureTruncated
                            }, '上游未按 SSE 流式返回，已按完整 JSON 内容回放');
                        }
                    }
                    assistantContent = appendStreamedChartsToAssistantContent(assistantContent, streamedChartSpecs);
                    const assistantTokens = streamedChartSpecs.length > 0
                        ? estimateTokens(assistantContent)
                        : (apiUsage && apiUsage.completion_tokens)
                            ? apiUsage.completion_tokens
                            : estimateTokens(assistantContent);
                    const assistantMessageResult = saveAssistantMessage({ sessionId, userId, content: assistantContent, tokenCount: assistantTokens, modelId: modelCfg.id });

                    maybeGenerateTitle(sessionId, userId, visibleContent, assistantContent, modelCfg, req.user);

                    req.log.info({ length: assistantContent.length }, '生成结束');
                    recordModelSuccess(modelCfg, Date.now() - requestStartedAt);
                    writeSse(JSON.stringify({
                        type: 'message_saved',
                        role: 'assistant',
                        messageId: assistantMessageResult.lastInsertRowid,
                        modelName: modelCfg.name || modelCfg.model_name || '',
                        tokenCount: assistantTokens,
                        content: assistantContent
                    }));
                    writeSse('[DONE]');
                    res.end();
                    releaseSemaphore(); // 正常结束释放
                } catch (e) {
                    req.log.error({ err: e.message }, '流结束处理失败');
                    if (!res.writableEnded) {
                        writeSse(JSON.stringify({ error: '保存模型回复失败', detail: e.message }));
                        res.end();
                    }
                    releaseSemaphore(); // 报错释放
                }
            });

            response.data.on('error', err => {
                if (res.writableEnded) return; // 如果已经结束，忽略后续网络层错误
                
                if (err.code === 'ECONNRESET' || err.message.includes('aborted')) {
                    req.log.warn('流传输提醒: 连接被重置或中止，但可能已完成大部分接收');
                } else {
                    req.log.error({ err: err.message }, '流传输错误');
                }

                if (!res.writableEnded) {
                    writeChatErrorSse({
                        writeSse,
                        sessionId,
                        userId,
                        modelId: modelCfg.id,
                        error: '流传输中断',
                        detail: err.message,
                        persist: userMessagePersisted || regenerate,
                        log: req.log
                    });
                    res.end();
                }
                recordModelFailure(modelCfg, err);
                releaseSemaphore(); // 传输错误释放
            });

            req.on('close', () => {
                if (response.data && typeof response.data.destroy === 'function') response.data.destroy();
                releaseSemaphore(); // 客户端主动断开释放
            });
        } catch (e) {
            const errorData = e.response?.data;
            const statusCode = e.response?.status;
            recordModelFailure(modelCfg, e);

            req.log.error({ statusCode, err: e.message }, '模型响应错误');
            let streamErrorDetail = '';
            if (errorData) {
                if (typeof errorData.on === 'function') {
                    streamErrorDetail = await readStreamErrorDetail(errorData);
                    if (streamErrorDetail) {
                        req.log.error({ streamError: streamErrorDetail }, '模型流式报错详情');
                    }
                } else {
                    req.log.error({ errorData }, '模型报错详情');
                }
            }

            let safeDetail = e.message;
            if (errorData) {
                if (typeof errorData === 'string') {
                    safeDetail = errorData;
                } else if (typeof errorData.on === 'function') {
                    safeDetail = streamErrorDetail || '上游服务返回了流式错误，请检查 API 配置或余额';
                } else {
                    try {
                        safeDetail = JSON.stringify(errorData);
                    } catch (jsonErr) {
                        safeDetail = '无法解析的错误对象';
                    }
                }
            }

            writeChatErrorSse({
                writeSse,
                sessionId,
                userId,
                modelId: modelCfg.id,
                error: '模型响应异常',
                detail: safeDetail,
                statusCode: statusCode,
                persist: userMessagePersisted || regenerate,
                log: req.log
            });
            res.end();
            releaseSemaphore(); // 捕获异常释放
        }
    }));

    return router;
}

module.exports = {
    appendStreamedChartsToAssistantContent,
    applyChatLanguageInstruction,
    buildFallbackDataQueryInput,
    buildPersistedChatErrorContent,
    buildRagContextMessage,
    createChartSseCapture,
    createChatRouter,
    detectStrongDataQueryIntent,
    filterMcpToolsForChatIntent,
    filterMcpToolsForPlanner,
    injectRagContextBeforeLatestUser,
    normalizeRegenerateFlag,
    resolveRagQueryContent,
    summarizeRagContextSources
};
