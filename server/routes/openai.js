const express = require('express');
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
const { estimateTokens, createVisibleReasoningStreamFilter } = require('../llm');
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
const { createSseEventParser, createStreamAccumulator } = require('../streaming');
const { getBeijingTimestamp } = require('../time');
const {
    buildChatCompletionsUrl,
    buildModelHeaders
} = require('../services/model-adapter');
const { getGlobalSamplingRuntimeConfig } = require('../services/runtime-settings');
const { forwardChatCompletion } = require('../services/model-forwarder');
const { createApiAccessGuard } = require('../services/api-access-settings');
const { getEmbeddingConfig } = require('../services/rag-config');
const { requestEmbeddings, getEmbeddingRuntimeGuardUser } = require('../services/rag-index');
const { executeBuiltInTool, getBuiltInToolDefinitions } = require('../services/agent-tools');
const {
    estimateEmbeddingTokens,
    normalizeTokenUsage
} = require('../services/token-accounting');
const {
    enqueueApiCallLog
} = require('../services/sqlite-write-queue');
const {
    ContextLengthExceededError,
    estimateMessagesTokens,
    fitMessagesToContextBudget
} = require('../services/context-budget');

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
    enqueueApiCallLog({
        userId: req.user?.id || null,
        apiKeyId: req.apiKeyId,
        modelId: modelCfg?.id || null,
        modelName: modelCfg?.name || modelCfg?.model_name || null,
        requestMessages: stringifyForAudit(messages),
        responseText: data.responseText ? String(data.responseText).slice(0, 200000) : '',
        status: data.status || 'success',
        errorMessage: data.errorMessage ? String(data.errorMessage).slice(0, 4000) : '',
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        totalTokens: usage.totalTokens,
        stream: data.stream ? 1 : 0,
        ipAddress: req.ip,
        createdAt: getBeijingTimestamp()
    });
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

function normalizeCompletionText(value) {
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) {
        return value.map(normalizeCompletionText).filter(Boolean).join('\n');
    }
    if (value && typeof value === 'object') {
        if (typeof value.text === 'string') return value.text;
        if (typeof value.content === 'string') return value.content;
    }
    return '';
}

const COMPLETION_THOUGHT_BLOCK_PATTERNS = [
    /<thought\b[^>]*>[\s\S]*?<\/thought>/gi,
    /<thought\b[^>]*>[\s\S]*$/gi,
    /<thinking\b[^>]*>[\s\S]*?<\/thinking>/gi,
    /<thinking\b[^>]*>[\s\S]*$/gi,
    /<think\b[^>]*>[\s\S]*?<\/think>/gi,
    /<think\b[^>]*>[\s\S]*$/gi
];
const COMPLETION_VISIBLE_REASONING_START_PATTERN = /^(?:Analyze User Input:|Key constraints from system prompt:|Formulate Response\b.*:|Draft:|Check Constraints:|User says:)/im;
const COMPLETION_VISIBLE_REASONING_DRAFT_PATTERN = /^Draft:\s*$/im;
const COMPLETION_VISIBLE_REASONING_STOP_PATTERN = /(?:^|\r?\n)(?:Check Constraints:|All good\. Proceed\.|Output matches the draft\.)/i;

function stripCompletionThoughtContent(text = '') {
    let value = String(text || '');
    COMPLETION_THOUGHT_BLOCK_PATTERNS.forEach(pattern => {
        value = value.replace(pattern, '');
    });
    return value;
}

function stripCompletionVisibleReasoning(text = '') {
    const value = stripCompletionThoughtContent(text);
    if (!COMPLETION_VISIBLE_REASONING_START_PATTERN.test(value)) return value;

    const lines = value.split(/\r?\n/);
    const draftIndex = lines.findIndex(line => COMPLETION_VISIBLE_REASONING_DRAFT_PATTERN.test(line.trim()));
    if (draftIndex >= 0) {
        const answerLines = [];
        for (let i = draftIndex + 1; i < lines.length; i += 1) {
            const line = lines[i];
            if (COMPLETION_VISIBLE_REASONING_STOP_PATTERN.test(line)) break;
            answerLines.push(line);
        }
        const answer = answerLines.join('\n');
        if (answer.replace(/\s+/g, '').length > 0) return answer;
    }

    return value
        .replace(/^[\s\S]*?(?:Draft:\s*)/i, '')
        .replace(/(?:Check Constraints:|All good\. Proceed\.|Output matches the draft\.)[\s\S]*$/i, '');
}

function buildPromptStyleCompletionMessage(body = {}) {
    const beforeCursor = normalizeCompletionText(body.prompt ?? body.input ?? body.prefix).trimEnd();
    const afterCursor = normalizeCompletionText(body.suffix).trimStart();
    const language = String(body.language || '').trim();
    const filePath = String(body.filepath || body.filePath || body.filename || '').trim();

    if (!beforeCursor && !afterCursor) return '';

    const sections = [
        'Complete the code at the cursor. Return only the code that should be inserted, without markdown fences or explanations.'
    ];
    if (language) sections.push(`Language: ${language}`);
    if (filePath) sections.push(`File path: ${filePath}`);
    if (beforeCursor) sections.push(`Code before cursor:\n${beforeCursor}`);
    if (afterCursor) sections.push(`Code after cursor:\n${afterCursor}`);
    return sections.join('\n\n');
}

function normalizeChatCompletionMessages(body = {}) {
    if (Array.isArray(body.messages) && body.messages.length > 0) {
        return body.messages;
    }

    const prompt = buildPromptStyleCompletionMessage(body);
    if (!prompt) return [];
    return [{ role: 'user', content: prompt }];
}

function updateApiKeyUsage(req, { inputTokens = 0, outputTokens = 0, totalTokens = 0 } = {}) {
    const usage = normalizeTokenUsage({ inputTokens, outputTokens, totalTokens });
    if (!req.isApiKey || !req.apiKeyId || usage.totalTokens <= 0) return;
    db.prepare('UPDATE api_keys SET usage_tokens = usage_tokens + ?, input_tokens = input_tokens + ?, output_tokens = output_tokens + ? WHERE id = ?')
      .run(usage.totalTokens, usage.inputTokens, usage.outputTokens, req.apiKeyId);
}

function extractChatCompletionText(choice = {}) {
    const content = normalizeCompletionText(choice.message?.content ?? choice.text ?? '');
    return stripCompletionVisibleReasoning(content);
}

function isChatCompletionResponse(body) {
    return body && typeof body === 'object' && Array.isArray(body.choices);
}

function toCompletionResponse(chatResponse = {}, model) {
    return {
        id: String(chatResponse.id || `cmpl-${Date.now().toString(36)}`),
        object: 'text_completion',
        created: chatResponse.created || Math.floor(Date.now() / 1000),
        model: String(chatResponse.model || model || ''),
        choices: chatResponse.choices.map((choice, index) => ({
            text: extractChatCompletionText(choice),
            index: Number.isInteger(choice.index) ? choice.index : index,
            logprobs: choice.logprobs || null,
            finish_reason: choice.finish_reason || null
        })),
        usage: chatResponse.usage || undefined
    };
}

function toCompletionStreamFrame(payload, model, textOverride) {
    try {
        const json = typeof payload === 'string' ? JSON.parse(payload) : payload;
        const choice = Array.isArray(json?.choices) ? json.choices[0] : null;
        if (!choice) return null;
        const delta = choice.delta || {};
        const text = typeof textOverride === 'string'
            ? textOverride
            : stripCompletionVisibleReasoning(normalizeCompletionText(delta.content ?? choice.text ?? ''));
        if (!text && choice.finish_reason == null && !json.usage) return null;
        const frame = {
            id: String(json.id || `cmpl-${Date.now().toString(36)}`),
            object: 'text_completion',
            created: json.created || Math.floor(Date.now() / 1000),
            model: String(json.model || model || ''),
            choices: [{
                text: typeof text === 'string' ? text : '',
                index: Number.isInteger(choice.index) ? choice.index : 0,
                logprobs: choice.logprobs || null,
                finish_reason: choice.finish_reason || null
            }]
        };
        if (json.usage) frame.usage = json.usage;
        return frame;
    } catch (e) {
        return null;
    }
}

function runRouteHandlers(handlers, req, res) {
    return new Promise((resolve, reject) => {
        let index = 0;
        let settled = false;
        const settle = () => {
            if (!settled) {
                settled = true;
                resolve();
            }
        };
        ['json', 'send', 'end'].forEach(method => {
            if (typeof res[method] !== 'function') return;
            const original = res[method].bind(res);
            res[method] = (...args) => {
                const result = original(...args);
                settle();
                return result;
            };
        });
        const next = (err) => {
            if (settled) return;
            if (err) {
                settled = true;
                return reject(err);
            }
            const handler = handlers[index];
            index += 1;
            if (!handler) return settle();
            try {
                const result = handler(req, res, next);
                if (result && typeof result.then === 'function') result.catch(reject);
            } catch (e) {
                settled = true;
                reject(e);
            }
        };
        next();
    });
}

function createCompletionResponseProxy(res, { model = '', stream = false } = {}) {
    let completionStreamDone = false;
    let completionFinalized = false;
    const completionVisibleReasoningFilter = stream ? createVisibleReasoningStreamFilter() : null;
    const completionParser = stream ? createSseEventParser({
        onData(payload) {
            const json = typeof payload === 'string' ? JSON.parse(payload) : payload;
            const choice = Array.isArray(json?.choices) ? json.choices[0] : null;
            if (!choice) return;
            const rawText = normalizeCompletionText(choice.delta?.content ?? choice.text ?? '');
            let text = completionVisibleReasoningFilter
                ? completionVisibleReasoningFilter.push(rawText)
                : stripCompletionVisibleReasoning(rawText);
            const isFinalChunk = completionVisibleReasoningFilter && (choice.finish_reason != null || json.usage);
            if (isFinalChunk) {
                text += completionVisibleReasoningFilter.finish();
                completionFinalized = true;
            }
            const frame = toCompletionStreamFrame(json, model, text);
            if (frame) {
                res.write(`data: ${JSON.stringify(frame)}\n\n`);
            }
        },
        onDone() {
            if (completionVisibleReasoningFilter && !completionFinalized) {
                const tail = completionVisibleReasoningFilter.finish();
                if (tail) {
                    const frame = {
                        id: `cmpl-${Date.now().toString(36)}`,
                        object: 'text_completion',
                        created: Math.floor(Date.now() / 1000),
                        model: String(model || ''),
                        choices: [{
                            text: tail,
                            index: 0,
                            logprobs: null,
                            finish_reason: null
                        }]
                    };
                    res.write(`data: ${JSON.stringify(frame)}\n\n`);
                }
            }
            completionStreamDone = true;
            res.write('data: [DONE]\n\n');
        }
    }) : null;

    return {
        get statusCode() {
            return res.statusCode;
        },
        set statusCode(value) {
            res.statusCode = value;
        },
        get headersSent() {
            return Boolean(res.headersSent);
        },
        get writableEnded() {
            return Boolean(res.writableEnded);
        },
        status(code) {
            res.status(code);
            return this;
        },
        setHeader(name, value) {
            res.setHeader(name, value);
            return this;
        },
        getHeader(name) {
            return typeof res.getHeader === 'function' ? res.getHeader(name) : undefined;
        },
        flushHeaders() {
            if (typeof res.flushHeaders === 'function') res.flushHeaders();
            return this;
        },
        json(body) {
            if (isChatCompletionResponse(body)) {
                return res.json(toCompletionResponse(body, model));
            }
            return res.json(body);
        },
        send(body) {
            if (isChatCompletionResponse(body)) {
                return res.json(toCompletionResponse(body, model));
            }
            return typeof res.send === 'function' ? res.send(body) : res.end(body);
        },
        write(chunk) {
            if (stream && completionParser && chunk !== undefined && chunk !== null) {
                completionParser.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
                return true;
            }
            return typeof res.write === 'function' ? res.write(chunk) : true;
        },
        end(chunk) {
            if (stream && completionParser) {
                if (chunk !== undefined && chunk !== null && chunk !== '') {
                    this.write(chunk);
                }
                completionParser.end();
                if (!completionStreamDone) {
                    res.write('data: [DONE]\n\n');
                    completionStreamDone = true;
                }
                return res.end();
            }
            return typeof res.end === 'function' ? res.end(chunk) : undefined;
        },
        on(event, handler) {
            if (typeof res.on === 'function') res.on(event, handler);
            return this;
        },
        once(event, handler) {
            if (typeof res.once === 'function') res.once(event, handler);
            return this;
        }
    };
}

function createOpenAIRouter({ authMiddleware, logAction, embeddingLimiter = (_req, _res, next) => next() }) {
    const router = express.Router();
    router.use(createApiAccessGuard({ logAction }));

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
            const vectors = await requestEmbeddings(inputs, config.http, {
                model: configuredModel,
                user: getEmbeddingRuntimeGuardUser(config, req.user)
            });
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
            logger.error({ err: errorMsg, model: configuredModel }, 'OpenAI 嵌入转发失败');
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
    router.post('/completions', authMiddleware, asyncHandler(async (req, res) => {
        const chatRoute = router.stack.find(layer => layer.route?.path === '/chat/completions');
        if (!chatRoute) {
            return res.status(500).json({ error: { message: 'Chat completions route is not available.', type: 'api_error' } });
        }
        req.body = {
            ...req.body,
            stream: !!req.body?.stream
        };
        const proxyRes = createCompletionResponseProxy(res, {
            model: req.body?.model,
            stream: !!req.body?.stream
        });
        return runRouteHandlers(chatRoute.route.stack.map(layer => layer.handle), req, proxyRes);
    }));

    router.post('/chat/completions', authMiddleware, asyncHandler(async (req, res) => {
        const {
            model,
            stream,
            temperature,
            max_tokens,
            max_completion_tokens,
            tool_choice,
            stop,
            top_p,
            presence_penalty,
            frequency_penalty
        } = req.body;
        const messages = normalizeChatCompletionMessages(req.body);
        const userId = req.user.id;
        const requestedMaxTokens = max_tokens ?? max_completion_tokens;

        if (messages.length === 0) {
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
        const runtimeSampling = getGlobalSamplingRuntimeConfig();

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
                maxOutputTokens: requestedMaxTokens ?? modelCfg.max_tokens ?? 2000
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
            temperature: temperature ?? modelCfg.temperature ?? runtimeSampling.temperature,
            max_tokens: requestedMaxTokens ?? modelCfg.max_tokens ?? 2000
        };
        if (stop !== undefined) payload.stop = stop;
        payload.top_p = top_p ?? runtimeSampling.topP;
        payload.presence_penalty = presence_penalty ?? runtimeSampling.presencePenalty;
        payload.frequency_penalty = frequency_penalty ?? runtimeSampling.frequencyPenalty;
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
                stream: !!stream
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
