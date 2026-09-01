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
const { createProviderEventStateMachine, createSseEventParser, createStreamAccumulator, splitStreamTextForDisplay } = require('../../streaming');
const { createSseResponseWriter } = require('../../services/sse-response');
const { createStreamIdleWatchdog } = require('../../services/stream-idle-watchdog');
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
    normalizeChatError,
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
const { createAgentRun } = require('../../services/agent-runtime');
const { AGENT_DEFAULT_TIMEOUT_MS, AGENT_TOOL_TIMEOUT_MS } = require('../../services/agent-runtime/runtime-env');
const {
    buildChatAgentMetadata,
    normalizeChatHistory,
    prepareChatAgentContext
} = require('../../services/chat-agent-bridge');
const { MAX_CHAT_AGENT_GOAL_LENGTH } = require('../../services/agent-validators');
const sessionsRepository = require('../../repositories/sessions');

const MAX_STREAM_FALLBACK_CAPTURE_CHARS = 2_000_000;
const SLOW_CHAT_TRACE_MS = Math.max(Number.parseInt(process.env.PIVOT_SLOW_CHAT_MS || '45000', 10) || 45000, 1000);
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
    // 本机执行器 v2 由桌面主进程凭设备私钥直接登记；聊天请求中自报的 deviceId/grants
    // 不再参与设备注册或任务路由，防止网页输入伪造本机授权。
    return null;
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
    publicUrl = '',
    agentExecutionEnabled = undefined,
    autoAgent = undefined,
    agentRunFactory = createAgentRun
}) {
    const router = express.Router();

    const readAgentExecutionEnabled = () => {
        if (typeof agentExecutionEnabled === 'function') return agentExecutionEnabled() === true;
        if (agentExecutionEnabled !== undefined && agentExecutionEnabled !== null) return agentExecutionEnabled === true;
        return typeof autoAgent === 'function' ? autoAgent() === true : autoAgent === true;
    };

    router.get('/chat/capabilities', authMiddleware, (_req, res) => {
        const enabled = readAgentExecutionEnabled();
        res.json({ success: true, defaultMode: 'normal', modes: enabled ? ['normal', 'agent'] : ['normal'], agentExecutionEnabled: enabled });
    });

    router.post('/chat/stats', authMiddleware, asyncHandler(async (req, res) => {
        const { sessionId, costTime, tps } = req.body;
        await updateLastAssistantStats({ sessionId, userId: req.user.id, costTime, tps });
        res.json({ success: true });
    }));

    router.post('/chat', authMiddleware, chatLimiter, asyncHandler(async (req, res) => {
        const chatState = buildChatRequestState(req);
        let {
            regenerate,
            mcpEnabled,
            ragEnabled,
            sessionId,
            modelId,
            userId,
            modelContent,
            visibleContent,
            mcpToolAllowlist,
            ragScope,
            chatMode
        } = chatState;
        const agentExecutionAllowed = readAgentExecutionEnabled();
        let regenerationMessages = null;
        let regenerationUserMessageId = null;
        let userMessagePersisted = false;
        const chatTrace = createObservabilityTrace({
            type: 'chat',
            source: 'api.chat',
            thresholdMs: SLOW_CHAT_TRACE_MS,
            message: 'Chat generation trace',
            details: { sessionId, userId, modelId, regenerate, mcpEnabled, ragEnabled, chatMode }
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
        const abortController = new AbortController();
        const onClientDisconnect = () => {
            try { abortController.abort(); } catch (_) {}
        };
        req.once('aborted', onClientDisconnect);
        res.once('close', () => {
            onClientDisconnect();
            finishChatTrace(
                chatTraceStatus === 'open' ? 'closed' : chatTraceStatus,
                { writableEnded: res.writableEnded }
            );
        });

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

        // 重新生成请求不会再次提交 user content。先从当前用户自己的会话
        // 中解析最近一条用户消息，使它与普通发送拥有相同的 Agent 上下文。
        if (regenerate && sessionId) {
            try {
                regenerationMessages = await sessionsRepository.listMessages(sessionId, userId);
                const sourceMessage = [...regenerationMessages].reverse().find(message => message?.role === 'user');
                if (sourceMessage) {
                    regenerationUserMessageId = Number(sourceMessage.id || 0) || null;
                    modelContent = typeof sourceMessage.content === 'string'
                        ? sourceMessage.content.trim()
                        : String(sourceMessage.content || '').trim();
                    visibleContent = modelContent;
                    chatState.content = modelContent;
                    chatState.displayContent = visibleContent;
                    chatState.modelContent = modelContent;
                    chatState.visibleContent = visibleContent;
                }
            } catch (error) {
                req.log.error({ sessionId, userId, err: error.message }, '重新生成读取原用户消息失败');
                writeSse(JSON.stringify({ error: '无法读取待重新生成的用户消息', code: 'REGENERATE_SOURCE_UNAVAILABLE' }));
                return res.end();
            }
        }

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

        if (chatMode === 'agent' && !agentExecutionAllowed) {
            writeSse(JSON.stringify({
                error: '管理员已暂时关闭聊天 Agent 执行模式，请切换为普通回答。',
                code: 'AGENT_EXECUTION_DISABLED',
                chatMode: 'normal'
            }));
            finishChatTrace('completed', { mode: 'agent_disabled' });
            return res.end();
        }

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
        if (regenerate && !regenerationUserMessageId) {
            writeSse(JSON.stringify({ error: '没有可重新生成的用户消息', code: 'REGENERATE_SOURCE_NOT_FOUND' }));
            return res.end();
        }
        const { modelCfg } = preflight;
        if (chatMode === 'agent' && (modelContent.length < 4 || modelContent.length > MAX_CHAT_AGENT_GOAL_LENGTH)) {
            writeSse(JSON.stringify({
                error: modelContent.length > MAX_CHAT_AGENT_GOAL_LENGTH
                    ? `Agent 执行消息不能超过 ${MAX_CHAT_AGENT_GOAL_LENGTH} 个字符，请拆分任务后重试。`
                    : 'Agent 执行需要至少 4 个字符的明确目标。',
                code: modelContent.length > MAX_CHAT_AGENT_GOAL_LENGTH ? 'AGENT_GOAL_TOO_LONG' : 'AGENT_GOAL_TOO_SHORT',
                chatMode: 'agent'
            }));
            finishChatTrace('completed', { mode: 'agent_validation' });
            return res.end();
        }
        if (mcpEnabled) {
            const localBridgeDevice = registerChatRequestLocalBridge(req);
            if (localBridgeDevice) {
                req.log.info({ deviceId: localBridgeDevice.deviceId, grants: localBridgeDevice.grants }, '聊天请求已同步桌面端本机执行器');
            }
        }

        let userMessageId = regenerationUserMessageId;
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

        // The user explicitly chooses Agent mode. Ordinary chat never creates
        // a persistent run, regardless of message length or wording.
        if (chatMode === 'agent' && modelContent.length <= MAX_CHAT_AGENT_GOAL_LENGTH) {
            try {
                const sessionMessages = regenerationMessages || await sessionsRepository.listMessages(sessionId, userId);
                const chatHistory = normalizeChatHistory(sessionMessages.filter(message => (
                    !userMessageId || Number(message?.id || 0) !== userMessageId
                )));
                const agentContext = await prepareChatAgentContext({
                    userId,
                    user: req.user,
                    modelCfg,
                    modelContent,
                    ragEnabled,
                    ragScope,
                    retrieveContext,
                    isRagEnabled
                });
                if (agentContext.memoryCount > 0) {
                    writeSse(JSON.stringify({
                        type: 'memory',
                        status: 'hit',
                        message: `已检索到 ${agentContext.memoryCount} 条相关长期记忆`,
                        memoryCount: agentContext.memoryCount
                    }));
                }
                if (ragEnabled) {
                    const sourceCount = Number(agentContext.ragSummary?.sourceCount || 0);
                    const citationCount = Number(agentContext.ragSummary?.citationCount || 0);
                    writeSse(JSON.stringify({
                        type: 'rag',
                        status: agentContext.ragContext ? 'hit' : 'empty',
                        message: agentContext.ragContext
                            ? `知识库已找到 ${sourceCount || citationCount || 1} 条相关资料，正在基于来源执行任务`
                            : '知识库未检索到足够相关内容，将按普通上下文继续',
                        sourceCount,
                        citationCount,
                        sources: agentContext.ragSummary?.sources || []
                    }));
                }
                const run = await agentRunFactory({
                    user: req.user,
                    chatAgent: true,
                    goal: modelContent,
                    modelId: modelCfg.id,
                    sessionId,
                    title: visibleContent || modelContent,
                    maxSteps: 30,
                    runMode: 'standard',
                    toolPolicy: mcpEnabled ? 'all' : 'builtin_only',
                    // 普通聊天的 MCP 白名单只约束 MCP 工具，内置能力仍由 Agent 策略提供。
                    toolAllowlist: [],
                    approvalPolicy: 'safe_mcp_auto',
                    timeoutMs: AGENT_DEFAULT_TIMEOUT_MS,
                    toolTimeoutMs: AGENT_TOOL_TIMEOUT_MS,
                    retryLimit: 1,
                    contextConfig: {
                        mode: 'recent',
                        notes: mcpEnabled
                            ? '这是用户主动选择的聊天 Agent 执行模式。遵守当前会话的 MCP 授权和工具白名单。'
                            : '这是用户主动选择的聊天 Agent 执行模式。当前会话未授权外部 MCP，只能使用内置安全能力。'
                    },
                    networkPolicy: { enabled: true },
                    metadata: buildChatAgentMetadata({
                        sessionId,
                        userMessageId,
                        visibleContent,
                        history: chatHistory,
                        systemPrompt: preflight.session?.system_prompt || '',
                        mcpEnabled,
                        mcpToolAllowlist,
                        ragEnabled,
                        ragScope,
                        currentContent: modelContent,
                        memoryContext: agentContext.memoryContext,
                        ragContext: agentContext.ragContext
                    })
                });
                finishChatTrace('completed', { mode: 'agent_handoff', runId: run.id, modelId: modelCfg.id });
                writeSse(JSON.stringify({
                    type: 'agent_handoff',
                    runId: run.id,
                    status: run.status,
                    message: '已切换为连续 Agent，任务会在后台继续执行。'
                }));
                writeSse('[DONE]');
                return res.end();
            } catch (error) {
                if (error?.code === 'AGENT_GOAL_TOO_LONG') {
                    req.log.warn({ sessionId, userId, contentLength: modelContent.length }, '普通聊天 Agent 目标超长，回退普通模型流');
                } else {
                    req.log.error({ sessionId, userId, err: error.message }, '普通聊天 Agent 接管失败');
                    await writeChatErrorSse({
                        writeSse,
                        sessionId,
                        userId,
                        modelId: modelCfg.id,
                        error: '连续 Agent 启动失败',
                        detail: error.message,
                        code: error.code || 'AGENT_HANDOFF_FAILED',
                        persist: userMessagePersisted || regenerate,
                        log: req.log
                    });
                    finishChatTrace('error', { mode: 'agent_handoff', error: error.message });
                    return res.end();
                }
            }
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
            persistOnError: userMessagePersisted || regenerate,
            signal: abortController.signal
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
                userId,
                signal: abortController.signal
            }), { modelId: modelCfg.id, messageCount: visionHistory.length });

            const writeContentSse = (content) => {
                splitStreamTextForDisplay(content).forEach(chunk => {
                    writeSse(JSON.stringify({ content: chunk }));
                });
            };
            const visibleReasoningFilter = disableChatThinking ? createVisibleReasoningStreamFilter() : null;
            const providerState = createProviderEventStateMachine({ maxRecentEvents: 128 });
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
                    try {
                        const frame = JSON.parse(payload);
                        providerState.ingest(frame);
                    } catch (_) {}
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

            // 上游把响应头发完之后再静默挂住时，axios 的 timeout 已经不起作用了——它只覆盖
            // 「发出请求到收到响应头」这一段，不覆盖流体传输。此时既不会有 'end' 也不会有
            // 'error'，于是 aiSemaphore 许可、模型端点许可和客户端 socket 会被永久持有，
            // 只能靠重启进程释放。看门狗在「多久没收到任何字节」这个维度补上超时。
            let streamIdleAborted = false;
            const streamIdleWatchdog = createStreamIdleWatchdog({
                onIdle: (idleMs) => {
                    streamIdleAborted = true;
                    const idleError = new Error(`上游模型流式响应空闲超过 ${Math.round(idleMs / 1000)} 秒`);
                    idleError.code = 'MODEL_STREAM_IDLE_TIMEOUT';
                    req.log.error({ sessionId, userId, modelId: modelCfg.id, idleMs }, '上游模型流长时间无数据，已主动中止');
                    recordModelFailure(modelCfg, idleError);
                    finishChatTrace('error', { phase: 'stream', error: idleError.message, code: idleError.code });
                    // 不带参数 destroy：只触发 'close' 而不再触发 'error'，避免与下面的
                    // 'error' 处理器重复给客户端写错误帧。
                    try { response.data?.destroy?.(); } catch (_) {}
                    try { abortController.abort(); } catch (_) {}
                    if (!res.writableEnded) {
                        writeChatErrorSse({
                            writeSse,
                            sessionId,
                            userId,
                            modelId: modelCfg.id,
                            error: '模型响应超时中断',
                            detail: idleError.message,
                            code: idleError.code,
                            retryable: true,
                            persist: userMessagePersisted || regenerate,
                            log: req.log
                        }).then(() => res.end()).catch(() => res.end());
                    }
                    releaseSemaphore();
                }
            });

            response.data.on('data', chunk => {
                streamIdleWatchdog.touch();
                captureRawStreamChunk(chunk);
                parser.write(chunk);
            });

            response.data.on('end', async () => {
                streamIdleWatchdog.stop();
                try {
                    parser.end();
                    accumulator.finish();
                    const providerSnapshot = providerState.finalize();

                    let assistantContent = accumulator.getContent();
                    let apiUsage = accumulator.getUsage() || providerSnapshot.usage?.raw || null;
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
                        tps: tokensPerSec,
                        provider: {
                            status: providerSnapshot.status,
                            protocol: providerSnapshot.protocol,
                            responseId: providerSnapshot.responseId,
                            eventCount: providerSnapshot.eventCount,
                            finishReason: providerSnapshot.finishReason,
                            usage: providerSnapshot.usage
                        }
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
                streamIdleWatchdog.stop();
                // 空闲看门狗已经中止上游并回过错误帧，这里不再重复通知客户端
                if (streamIdleAborted) {
                    releaseSemaphore();
                    return;
                }
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

            response.data.on('close', () => {
                streamIdleWatchdog.stop();
                releaseSemaphore();
            });

            req.on('close', () => {
                streamIdleWatchdog.stop();
                onClientDisconnect();
                if (response.data && typeof response.data.destroy === 'function') response.data.destroy();
                releaseSemaphore(); // 客户端主动断开释放
            });
        } catch (e) {
            if (abortController.signal.aborted || e.name === 'AbortError' || e.name === 'CanceledError' || e.code === 'ERR_CANCELED') {
                req.log.warn({ sessionId }, '客户端主动断开连接，已中止上游模型生成');
                finishChatTrace('closed', { aborted: true });
                releaseSemaphore();
                if (!res.writableEnded) res.end();
                return;
            }
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
    normalizeChatError,
    normalizeRegenerateFlag,
    resolveRagQueryContent,
    summarizeRagContextSources
};
