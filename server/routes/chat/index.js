/* 对话接口路由 */
const express = require('express');
const { asyncHandler } = require('../../http');
const {
    detectUnsupportedCapability,
    buildCapabilityFallbackMessage
} = require('../../capabilities');
const { createVisibleReasoningStreamFilter, estimateTokens, stripVisibleReasoningScaffold } = require('../../llm');
const {
    modelSupportsVision,
    contentContainsVisionInput
} = require('../../services/models');
const { aiSemaphore } = require('../../services/concurrency');
const {
    acquireModelSlot,
    recordModelSuccess,
    recordModelFailure
} = require('../../services/model-runtime');
const { createSseEventParser, createStreamAccumulator, splitStreamTextForDisplay } = require('../../streaming');
const { createSseResponseWriter } = require('../../services/sse-response');
const { openChatModelStream } = require('../../services/model-stream-service');
const {
    extractModelTextFromRawResponse,
    normalizeRegenerateFlag,
    resolveRagQueryContent
} = require('../../services/chat-route-helpers');
const {
    buildRagContextMessage,
    injectRagContextBeforeLatestUser,
    summarizeRagContextSources
} = require('../../services/chat-rag-context');
const {
    saveUserMessage,
    touchSession,
    updateLastAssistantStats
} = require('../../services/chat-messages');
const {
    buildPersistedChatErrorContent,
    readStreamErrorDetail,
    writeChatErrorSse
} = require('../../services/chat-errors');
const {
    buildVisionUnsupportedMessage
} = require('../../services/chat-vision');
const {
    buildFallbackDataQueryInput,
    detectStrongDataQueryIntent,
    filterMcpToolsForChatIntent,
    filterMcpToolsForPlanner
} = require('../../services/chat-mcp-context');
const { createObservabilityTrace, withObservabilitySpan } = require('../../services/observability');
const { buildChatRequestState, validateChatPreflight } = require('../../services/chat-preflight');
const { assembleChatContext } = require('../../services/chat-context-assembler');
const { persistAssistantTurn } = require('../../services/chat-persistence');
const { registerLocalBridgeDevice } = require('../../services/local-device-bridge');

const MAX_STREAM_FALLBACK_CAPTURE_CHARS = 2_000_000;
const SLOW_CHAT_TRACE_MS = Math.max(Number.parseInt(process.env.PIVOT_SLOW_CHAT_MS || '45000', 10) || 45000, 1000);

function hasAuthorizedLocalBridgeGrant(payload) {
    const grants = payload && typeof payload.grants === 'object' && payload.grants ? payload.grants : {};
    return Object.values(grants).some(grant => grant && grant.authorized === true);
}

function normalizeChatLocalBridgeDebug(payload) {
    if (!payload || typeof payload !== 'object') return null;
    const grants = payload.grants && typeof payload.grants === 'object' ? payload.grants : {};
    return {
        page: String(payload.page || '').slice(0, 40),
        status: String(payload.status || '').slice(0, 80),
        reason: String(payload.reason || '').slice(0, 300),
        hasDesktopBridge: payload.hasDesktopBridge === true,
        hasStatusBridge: payload.hasStatusBridge === true,
        hasExecuteBridge: payload.hasExecuteBridge === true,
        statusAvailable: payload.statusAvailable === true,
        mode: String(payload.mode || '').slice(0, 40),
        deviceName: String(payload.deviceName || '').slice(0, 120),
        toolCount: Number.isFinite(Number(payload.toolCount)) ? Number(payload.toolCount) : null,
        grants: {
            local_database: grants.local_database === true,
            local_report_dir: grants.local_report_dir === true
        }
    };
}

function registerChatRequestLocalBridge(req) {
    req.localMcpBridgeDebug = normalizeChatLocalBridgeDebug(req.body?.localMcpBridgeDebug);
    const payload = req.body?.localMcpBridge;
    if (!payload || typeof payload !== 'object' || !hasAuthorizedLocalBridgeGrant(payload)) return null;
    try {
        return registerLocalBridgeDevice(req.user, payload);
    } catch (error) {
        req.log?.warn?.({ err: error.message }, '聊天请求携带的本机执行器快照注册失败');
        return null;
    }
}


const {
    appendStreamedChartsToAssistantContent,
    buildAssistantSpeedStats,
    createChartSseCapture,
    applyChatLanguageInstruction,
    applyChatNoThinkSoftSwitch
} = require('./helpers');

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
        const chatState = buildChatRequestState(req);
        const {
            regenerate,
            mcpEnabled,
            ragEnabled,
            sessionId,
            modelId,
            userId,
            modelContent,
            visibleContent
        } = chatState;
        let userMessagePersisted = false;
        const chatTrace = createObservabilityTrace({
            type: 'chat',
            source: 'api.chat',
            thresholdMs: SLOW_CHAT_TRACE_MS,
            message: 'Chat generation trace',
            details: { sessionId, userId, modelId, regenerate, mcpEnabled, ragEnabled }
        });
        let chatTraceStatus = 'open';
        const finishChatTrace = (status = 'closed', details = {}) => {
            chatTraceStatus = status;
            return chatTrace.finish({
                status,
                severity: status === 'error' ? 'warning' : 'info',
                message: status === 'error' ? 'Chat generation failed' : 'Chat generation completed',
                details
            });
        };
        res.once('close', () => finishChatTrace(
            chatTraceStatus === 'open' ? 'closed' : chatTraceStatus,
            { writableEnded: res.writableEnded }
        ));

        req.log.info({ sessionId, userId, modelId, regenerate, contentLength: modelContent.length }, '处理对话请求');

        // --- 立即建立 SSE 连接 ---
        const sse = createSseResponseWriter(res);

        const chartSseCapture = createChartSseCapture((payload) => {
            sse.writeData(payload);
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

        sse.writeComment('stream-ready');

        // --- 业务逻辑检查 ---
        const preflight = await validateChatPreflight({
            state: chatState,
            user: req.user,
            req,
            logAction
        });
        if (preflight.error) {
            writeSse(JSON.stringify(preflight.error));
            return res.end();
        }
        const { modelCfg } = preflight;
        if (mcpEnabled) {
            const localBridgeDevice = registerChatRequestLocalBridge(req);
            if (localBridgeDevice) {
                req.log.info({ deviceId: localBridgeDevice.deviceId, grants: localBridgeDevice.grants }, '聊天请求已同步桌面端本机执行器');
            }
        }

        let userMessageId = null;
        if (!regenerate) {
            try {
                const userMessageResult = await saveUserMessage({ sessionId, userId, content: modelContent, modelId: modelCfg.id });
                userMessagePersisted = true;
                userMessageId = Number(userMessageResult.lastInsertRowid || 0) || null;
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

        await touchSession(sessionId);
        logAction(req, regenerate ? '重新生成回答' : '发送消息', `${regenerate ? '重新生成' : '发送消息到'}会话: ${sessionId}`);

        chatTrace.addSpan('preflight', { modelId: modelCfg.id });

        if (contentContainsVisionInput(modelContent) && !modelSupportsVision(modelCfg)) {
            const assistantContent = buildVisionUnsupportedMessage(modelCfg);
            const assistantTokens = estimateTokens(assistantContent);
            const { assistantMessageResult } = await persistAssistantTurn({
                sessionId,
                userId,
                userMessageId,
                user: req.user,
                modelCfg,
                visibleContent,
                assistantContent,
                assistantTokens
            });
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
            const { assistantMessageResult } = persistAssistantTurn({
                sessionId,
                userId,
                userMessageId,
                user: req.user,
                modelCfg,
                visibleContent,
                assistantContent,
                assistantTokens
            });
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
            await writeChatErrorSse({
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
            await writeChatErrorSse({
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

        const contextResult = await withObservabilitySpan(chatTrace, 'context_assembly', () => assembleChatContext({
            req,
            state: chatState,
            modelCfg,
            retrieveContext,
            isRagEnabled,
            publicUrl,
            writeSse,
            releaseSemaphore,
            writeChatErrorSse,
            persistOnError: userMessagePersisted || regenerate
        }), { ragEnabled, mcpEnabled });
        if (contextResult.errorEnded) return res.end();
        let { visionHistory, disableChatThinking } = contextResult;

        try {
            const { response } = await withObservabilitySpan(chatTrace, 'model_stream_open', () => openChatModelStream({
                modelCfg,
                user: req.user,
                visionHistory,
                log: req.log,
                sessionId,
                userId
            }), { modelId: modelCfg.id, messageCount: visionHistory.length });

            const writeContentSse = (content) => {
                splitStreamTextForDisplay(content).forEach(chunk => {
                    writeSse(JSON.stringify({ content: chunk }));
                });
            };
            const visibleReasoningFilter = disableChatThinking ? createVisibleReasoningStreamFilter() : null;
            const accumulator = createStreamAccumulator({
                includeThoughtTags: !disableChatThinking,
                includeThoughtContent: !disableChatThinking,
                onContent(sendContent, _meta = {}) {
                    if (disableChatThinking) {
                        const filteredContent = visibleReasoningFilter.push(sendContent);
                        if (filteredContent) writeContentSse(filteredContent);
                        return;
                    }
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
                            if (disableChatThinking) assistantContent = stripVisibleReasoningScaffold(assistantContent);
                            apiUsage = fallback.usage || apiUsage;
                            if (!disableChatThinking) writeContentSse(assistantContent);
                            req.log.warn({
                                sessionId,
                                rawStreamCaptureTruncated
                            }, '上游未按 SSE 流式返回，已按完整 JSON 内容回放');
                        }
                    }
                    if (disableChatThinking) {
                        const filteredContent = visibleReasoningFilter.finish(assistantContent);
                        if (filteredContent) {
                            writeContentSse(filteredContent);
                        }
                        assistantContent = stripVisibleReasoningScaffold(assistantContent);
                    }
                    const endedAt = Date.now();
                    const stats = buildAssistantSpeedStats({
                        assistantContent,
                        streamedChartSpecs,
                        apiUsage,
                        requestStartedAt,
                        endedAt
                    });
                    assistantContent = stats.assistantContent;
                    const assistantTokens = stats.assistantTokens;
                    const costTime = stats.costTime;
                    const tokensPerSec = stats.tokensPerSec;
                    const { assistantMessageResult } = await persistAssistantTurn({
                        sessionId,
                        userId,
                        userMessageId,
                        user: req.user,
                        modelCfg,
                        visibleContent,
                        assistantContent,
                        assistantTokens,
                        costTime,
                        tps: tokensPerSec
                    });

                    req.log.info({ length: assistantContent.length }, '生成结束');
                    recordModelSuccess(modelCfg, endedAt - requestStartedAt);
                    finishChatTrace('completed', {
                        modelId: modelCfg.id,
                        assistantTokens,
                        costTime,
                        tps: tokensPerSec
                    });
                    writeSse(JSON.stringify({
                        type: 'message_saved',
                        role: 'assistant',
                        messageId: assistantMessageResult.lastInsertRowid,
                        modelName: modelCfg.name || modelCfg.model_name || '',
                        tokenCount: assistantTokens,
                        costTime,
                        tps: tokensPerSec,
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
                    }).then(() => res.end()).catch(() => res.end());
                }
                recordModelFailure(modelCfg, err);
                finishChatTrace('error', { phase: 'stream', error: err.message });
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

            finishChatTrace('error', { phase: 'model_request', error: e.message, statusCode });
            await writeChatErrorSse({
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
    applyChatNoThinkSoftSwitch,
    buildAssistantSpeedStats,
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
