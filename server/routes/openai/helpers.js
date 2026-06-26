const { db } = require('../../db');
const { getBeijingTimestamp } = require('../../time');
const { enqueueApiCallLog } = require('../../services/sqlite-write-queue');
const { createVisibleReasoningStreamFilter } = require('../../llm');
const { normalizeTokenUsage } = require('../../services/token-accounting');
const { createSseEventParser } = require('../../streaming');
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


module.exports = {
    stringifyForAudit,
    recordApiCallLog,
    normalizeEmbeddingInputItem,
    normalizeEmbeddingInputs,
    buildEmbeddingResponse,
    buildEmbeddingModelItem,
    normalizeCompletionText,
    stripCompletionThoughtContent,
    stripCompletionVisibleReasoning,
    buildPromptStyleCompletionMessage,
    normalizeChatCompletionMessages,
    updateApiKeyUsage,
    extractChatCompletionText,
    isChatCompletionResponse,
    toCompletionResponse,
    toCompletionStreamFrame,
    runRouteHandlers,
    createCompletionResponseProxy
};
