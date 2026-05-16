/* 对话接口路由 Chat API Routes */
const axios = require('axios');
const http = require('http');
const https = require('https');
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
const { imageFileToDataUrl, MAX_IMAGES_PER_MESSAGE } = require('../image-safety');
const { resolveUploadUrlPath, toProjectRelativePath } = require('../security');
const { createSseEventParser, createStreamAccumulator } = require('../streaming');
const {
    buildModelHeaders,
    buildResponsesUrl,
    buildChatCompletionsUrl,
    convertChatMessagesToResponsesInput,
    normalizeModelBaseUrl,
    shouldUseResponsesApi
} = require('../services/model-adapter');
const {
    saveAssistantMessage,
    saveUserMessage,
    touchSession,
    updateLastAssistantStats
} = require('../services/chat-messages');
const { maybeGenerateTitle } = require('../services/chat-title');
const { executeMcpTool, listCachedMcpTools } = require('../services/mcp-client');

const httpAgent = new http.Agent({ keepAlive: true });
const httpsAgent = new https.Agent({ keepAlive: true });

function getRequestOrigin(req, publicUrl = '') {
    if (publicUrl) return publicUrl;
    const proto = req.headers['x-forwarded-proto'] || req.protocol || 'http';
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    return host ? `${proto}://${host}` : '';
}

function getImageDataUrl(uploadUrl, userId, sessionId) {
    const target = resolveUploadUrlPath(uploadUrl);
    const filePath = target ? toProjectRelativePath(target) : '';
    if (!filePath) return null;
    const attachment = db.prepare(`
        SELECT id FROM attachments
        WHERE user_id = ? AND session_id = ? AND file_path = ?
          AND deleted_at IS NULL
    `).get(userId, sessionId, filePath);
    if (!attachment) return null;
    return imageFileToDataUrl(target);
}

function buildVisionHistory(history, origin, userId, sessionId) {
    if (!origin) return history;
    const imageMarkdown = /!\[([^\]]*)\]\((\/uploads\/[^)\s]+)\)/g;
    return history.map(message => {
        if (message.role !== 'user' || typeof message.content !== 'string' || !message.content.includes('/uploads/')) {
            return message;
        }

        const imageParts = [];
        const text = message.content.replace(imageMarkdown, (match, alt, url) => {
            if (imageParts.length >= MAX_IMAGES_PER_MESSAGE) {
                return alt ? `[图片已跳过: ${alt}]` : '[图片已跳过]';
            }
            const imageUrl = getImageDataUrl(url, userId, sessionId);
            if (!imageUrl) {
                return alt ? `[图片不可用: ${alt}]` : '[图片不可用]';
            }
            imageParts.push({
                type: 'image_url',
                image_url: {
                    url: imageUrl
                }
            });
            return alt ? `[图片: ${alt}]` : '[图片]';
        }).trim();

        if (imageParts.length === 0) return message;
        return {
            ...message,
            content: [
                { type: 'text', text: text || '请分析这张图片。' },
                ...imageParts
            ]
        };
    });
}

function limitVisionImages(history) {
    let usedImages = 0;
    return history.map(message => {
        if (!Array.isArray(message.content)) return message;
        const content = [];
        for (const part of message.content) {
            if (part?.type === 'image_url') {
                if (usedImages >= MAX_IMAGES_PER_MESSAGE) {
                    content.push({ type: 'text', text: '[图片已跳过：当前模型一次只支持解析 1 张图片]' });
                    continue;
                }
                usedImages += 1;
            }
            content.push(part);
        }
        return { ...message, content };
    });
}

function buildVisionUnsupportedMessage(modelCfg) {
    const name = modelCfg?.name || modelCfg?.model_name || '当前模型';
    return `${name} 未配置视觉输入能力，不能处理图片或扫描件内容。请切换到已开启“视觉输入（图片/扫描件）”的模型，或联系管理员在模型配置中启用该能力。普通文档会先抽取文本，不受此限制。`;
}

function compactText(value, maxLength = 12000) {
    const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
    if (!text) return '';
    return text.length > maxLength ? `${text.slice(0, maxLength)}\n...内容已截断...` : text;
}

function extractModelText(data) {
    const choiceContent = data?.choices?.[0]?.message?.content;
    if (typeof choiceContent === 'string') return choiceContent;
    if (Array.isArray(choiceContent)) {
        return choiceContent.map(part => part?.text || part?.content || '').filter(Boolean).join('\n');
    }
    if (typeof data?.output_text === 'string') return data.output_text;
    if (Array.isArray(data?.output)) {
        return data.output.map(item => {
            if (typeof item?.content === 'string') return item.content;
            if (Array.isArray(item?.content)) {
                return item.content.map(part => part?.text || part?.content || '').filter(Boolean).join('\n');
            }
            return '';
        }).filter(Boolean).join('\n');
    }
    return '';
}

function parsePlannerJson(text) {
    const raw = String(text || '').trim();
    if (!raw) return null;
    const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const candidate = fenced ? fenced[1].trim() : raw;
    try {
        return JSON.parse(candidate);
    } catch (e) {
        const start = candidate.indexOf('{');
        const end = candidate.lastIndexOf('}');
        if (start >= 0 && end > start) {
            try {
                return JSON.parse(candidate.slice(start, end + 1));
            } catch (inner) {}
        }
    }
    return null;
}

function formatMcpToolsForPlanner(tools) {
    return tools.slice(0, 40).map(tool => ({
        name: tool.fullName,
        server: tool.serverName,
        tool: tool.name,
        description: tool.description || '',
        input_schema: tool.input_schema || { type: 'object' }
    }));
}

function buildChatMcpPlannerMessages(history, userPrompt, tools) {
    const recentMessages = history
        .filter(message => ['user', 'assistant'].includes(message.role) && typeof message.content === 'string')
        .slice(-8)
        .map(message => ({ role: message.role, content: compactText(message.content, 1200) }));
    return [
        {
            role: 'system',
            content: [
                '你是 Pivot 普通对话里的 MCP 工具调度器。',
                '你只能返回严格 JSON，不要返回 Markdown、解释或多余文本。',
                'Schema: {"action":"none|tool","tool":"mcp.server.tool","input":{},"reason":"简短中文原因"}',
                '只有当用户问题明确需要访问已保存 MCP 服务中的外部数据、数据库结构或数据库查询结果时，才选择 action=tool。',
                '一轮最多选择一个工具。数据库查询必须保持只读，只生成 SELECT/WITH/SHOW/DESCRIBE/EXPLAIN 等读取类输入。',
                '如果用户只是闲聊、写作、总结当前上下文或知识库足够回答，返回 {"action":"none","reason":"不需要 MCP"}。',
                '可用 MCP 工具:',
                compactText(formatMcpToolsForPlanner(tools), 18000)
            ].join('\n')
        },
        {
            role: 'user',
            content: [
                '最近对话:',
                compactText(recentMessages, 6000),
                '',
                '用户本轮问题:',
                userPrompt
            ].join('\n')
        }
    ];
}

async function callChatMcpPlanner(modelCfg, messages) {
    const modelName = modelCfg.model_name || modelCfg.name || 'default';
    const headers = buildModelHeaders(modelCfg, { acceptJson: true });
    if (shouldUseResponsesApi(modelName)) {
        try {
            const response = await axios({
                method: 'post',
                url: buildResponsesUrl(modelCfg.url, { appendV1ForLocal: false }),
                headers,
                data: {
                    model: modelName,
                    input: convertChatMessagesToResponsesInput(messages),
                    stream: false,
                    temperature: 0,
                    max_output_tokens: 600
                },
                responseType: 'json',
                timeout: 120000,
                proxy: false,
                httpAgent,
                httpsAgent
            });
            return extractModelText(response.data);
        } catch (e) {
            if (![404, 405, 502, 503].includes(e.response?.status)) throw e;
        }
    }
    const response = await axios({
        method: 'post',
        url: buildChatCompletionsUrl(modelCfg.url, { appendV1ForLocal: false }),
        headers,
        data: {
            model: modelName,
            messages,
            stream: false,
            temperature: 0,
            max_tokens: 600
        },
        responseType: 'json',
        timeout: 120000,
        proxy: false,
        httpAgent,
        httpsAgent
    });
    return extractModelText(response.data);
}

function extractMcpResultText(result) {
    if (Array.isArray(result?.content)) {
        const text = result.content
            .map(item => item?.text || item?.content || '')
            .filter(Boolean)
            .join('\n');
        if (text) return text;
    }
    if (result?.structuredContent !== undefined) return JSON.stringify(result.structuredContent, null, 2);
    return typeof result === 'string' ? result : JSON.stringify(result, null, 2);
}

async function maybeBuildMcpChatContext({ modelCfg, history, userPrompt, tools, user, writeSse, log }) {
    if (!tools.length) {
        writeSse(JSON.stringify({ type: 'mcp', status: 'empty', message: '没有可用的 MCP 工具缓存' }));
        return '';
    }
    try {
        writeSse(JSON.stringify({ type: 'mcp', status: 'planning', message: '正在判断是否需要调用 MCP 工具' }));
        const plannerText = await callChatMcpPlanner(modelCfg, buildChatMcpPlannerMessages(history, userPrompt, tools));
        const plan = parsePlannerJson(plannerText);
        const toolNames = new Set(tools.map(tool => tool.fullName));
        if (!plan || plan.action !== 'tool' || !toolNames.has(plan.tool)) {
            writeSse(JSON.stringify({ type: 'mcp', status: 'skipped', message: '本轮不需要调用 MCP 工具' }));
            return '';
        }

        const selected = tools.find(tool => tool.fullName === plan.tool);
        writeSse(JSON.stringify({
            type: 'mcp',
            status: 'running',
            tool: plan.tool,
            serverName: selected?.serverName || '',
            message: `正在调用 MCP 工具：${selected?.serverName || 'MCP'} / ${selected?.name || plan.tool}`
        }));
        const result = await executeMcpTool(plan.tool, plan.input || {}, user);
        const resultText = compactText(extractMcpResultText(result), 18000);
        writeSse(JSON.stringify({
            type: 'mcp',
            status: 'done',
            tool: plan.tool,
            message: 'MCP 工具调用完成，正在生成回答'
        }));
        return [
            '以下是本轮普通对话启用 MCP 后取得的工具结果。请基于结果回答用户；如果结果不足，请说明不足。',
            `工具: ${plan.tool}`,
            `调用原因: ${plan.reason || ''}`,
            '结果:',
            resultText
        ].join('\n');
    } catch (e) {
        log?.warn?.({ err: e.message }, '普通对话 MCP 调用失败');
        writeSse(JSON.stringify({
            type: 'mcp',
            status: 'error',
            message: `MCP 工具调用失败：${e.message}`
        }));
        return `本轮尝试调用 MCP 工具失败：${e.message}`;
    }
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
        const { content, displayContent, regenerate } = req.body;
        const mcpEnabled = Boolean(req.body.mcpEnabled) && Boolean(req.body.mcpConfirmed);
        const ragEnabled = req.body.ragEnabled !== false;
        const sessionId = String(req.body.sessionId || '').trim();
        const modelId = req.body.modelId ? parseInt(req.body.modelId) : null;
        const userId = req.user.id;
        const modelContent = String(content || '').trim();
        const visibleContent = String(displayContent || modelContent).trim();

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

        const writeSse = (payload) => {
            if (res.writableEnded) return;
            res.write(`data: ${payload}\n\n`);
            res.flush?.();
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
                saveUserMessage({ sessionId, userId, content: modelContent, modelId: modelCfg.id });
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
            saveAssistantMessage({ sessionId, userId, content: assistantContent, tokenCount: assistantTokens, modelId: modelCfg.id });

            maybeGenerateTitle(sessionId, userId, visibleContent, assistantContent, modelCfg);
            logAction(req, '模型多模态能力拦截', `模型: ${modelCfg.name}, 会话: ${sessionId}`);

            writeSse(JSON.stringify({
                unsupportedCapability: 'vision_input',
                content: assistantContent
            }));
            writeSse('[DONE]');
            return res.end();
        }

        const unsupportedCapability = detectUnsupportedCapability(modelContent);
        if (unsupportedCapability) {
            const assistantContent = buildCapabilityFallbackMessage(unsupportedCapability);
            const assistantTokens = estimateTokens(assistantContent);
            saveAssistantMessage({ sessionId, userId, content: assistantContent, tokenCount: assistantTokens, modelId: modelCfg.id });

            maybeGenerateTitle(sessionId, userId, visibleContent, assistantContent, modelCfg);
            logAction(req, '能力不支持提示', `能力: ${unsupportedCapability.code}, 会话: ${sessionId}`);
            
            writeSse(JSON.stringify({
                unsupportedCapability: unsupportedCapability.code,
                content: assistantContent
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
            writeSse(JSON.stringify({
                error: message,
                code: e.code || 'AI_OVERLOADED',
                retryable: true
            }));
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
            writeSse(JSON.stringify({
                error: message,
                code: e.code || 'AI_ENDPOINT_OVERLOADED',
                retryable: true
            }));
            return res.end();
        }

        let history = await getContext(sessionId, userId, modelCfg);
        if (ragEnabled && typeof retrieveContext === 'function' && typeof isRagEnabled === 'function' && isRagEnabled()) {
            const ragContext = await retrieveContext(userId, modelContent);
            if (ragContext) {
                history.push({ role: 'system', content: ragContext });
            }
        }
        let visionHistory = limitVisionImages(buildVisionHistory(history, getRequestOrigin(req, publicUrl), userId, sessionId));
        
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
                const rescuedHistory = limitVisionImages(buildVisionHistory([{ role: 'user', content: modelContent }], getRequestOrigin(req, publicUrl), userId, sessionId));
                visionHistory.push(...rescuedHistory);
            } else {
                releaseSemaphore();
                writeSse(JSON.stringify({ error: '对话内容不能为空', code: 'EMPTY_MESSAGE' }));
                return res.end();
            }
        }

        if (mcpEnabled) {
            const mcpTools = listCachedMcpTools(null, req.user);
            const mcpContext = await maybeBuildMcpChatContext({
                modelCfg,
                history: visionHistory,
                userPrompt: modelContent,
                tools: mcpTools,
                user: req.user,
                writeSse,
                log: req.log
            });
            if (mcpContext) {
                visionHistory.push({ role: 'system', content: mcpContext });
            }
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
                    response = await axios({
                        method: 'post', url: targetUrl, headers,
                        data: requestData,
                        responseType: 'stream', timeout: 180000, proxy: false
                    });
                    req.log.info('连接成功 (Responses API)');
                } catch (err) {
                    const status = err.response?.status;
                    if ([404, 405, 502, 503].includes(status)) {
                        req.log.warn({ status }, 'Responses API 暂不可用，正在自动回退到常规接口');
                        targetUrl = buildChatCompletionsUrl(baseUrl, { appendV1ForLocal: false });
                        
                        delete requestData.input;
                        requestData.messages = visionHistory;
                        
                        response = await axios({
                            method: 'post', url: targetUrl, headers,
                            data: requestData,
                            responseType: 'stream', timeout: 300000, proxy: false,
                            httpAgent, httpsAgent
                        });
                        req.log.info('降级连接成功 (Chat Completions)');
                    } else {
                        throw err;
                    }
                }
            } else {
                req.log.info('正在建立连接 (Chat Completions API, 流式)');
                requestData.messages = visionHistory;
                response = await axios({
                    method: 'post', url: targetUrl, headers,
                    data: requestData,
                    responseType: 'stream', timeout: 300000, proxy: false,
                    httpAgent, httpsAgent
                });
                req.log.info('连接成功');
            }

            const accumulator = createStreamAccumulator({
                includeThoughtTags: true,
                onContent(sendContent) {
                    writeSse(JSON.stringify({ content: sendContent }));
                }
            });
            const parser = createSseEventParser({
                onData(payload) {
                    accumulator.pushPayload(payload);
                },
                onDone() {}
            });

            response.data.on('data', chunk => parser.write(chunk));

            response.data.on('end', async () => {
                try {
                    parser.end();
                    accumulator.finish();

                    const assistantContent = accumulator.getContent();
                    const apiUsage = accumulator.getUsage();
                    const assistantTokens = (apiUsage && apiUsage.completion_tokens) 
                        ? apiUsage.completion_tokens 
                        : estimateTokens(assistantContent);
                    saveAssistantMessage({ sessionId, userId, content: assistantContent, tokenCount: assistantTokens, modelId: modelCfg.id });

                    maybeGenerateTitle(sessionId, userId, visibleContent, assistantContent, modelCfg);

                    req.log.info({ length: assistantContent.length }, '生成结束');
                    recordModelSuccess(modelCfg, Date.now() - requestStartedAt);
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
                    writeSse(JSON.stringify({ error: '流传输中断', detail: err.message }));
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
            if (errorData) {
                if (typeof errorData.on === 'function') {
                    errorData.on('data', d => {
                        req.log.error({ streamError: d.toString() }, '模型流式报错详情');
                    });
                } else {
                    req.log.error({ errorData }, '模型报错详情');
                }
            }

            let safeDetail = e.message;
            if (errorData) {
                if (typeof errorData === 'string') {
                    safeDetail = errorData;
                } else if (typeof errorData.on === 'function') {
                    safeDetail = '上游服务返回了流式错误，请检查 API 配置或余额';
                } else {
                    try {
                        safeDetail = JSON.stringify(errorData);
                    } catch (jsonErr) {
                        safeDetail = '无法解析的错误对象';
                    }
                }
            }

            writeSse(JSON.stringify({
                error: '模型响应异常',
                detail: safeDetail,
                statusCode: statusCode
            }));
            res.end();
            releaseSemaphore(); // 捕获异常释放
        }
    }));

    return router;
}

module.exports = {
    createChatRouter
};
