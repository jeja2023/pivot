const { db } = require('../../db');
const { getBeijingTimestamp } = require('../../time');
const { enqueueApiCallLog } = require('../../services/sqlite-write-queue');
const { createVisibleReasoningStreamFilter } = require('../../llm');
const { normalizeTokenUsage } = require('../../services/token-accounting');
const { createSseEventParser } = require('../../streaming');

const COMPLETION_NO_THINK_DIRECTIVE = '/no_think';

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

function createCompletionRequestError(message, param, code = 'invalid_completion_request') {
    const error = new Error(message);
    error.status = 400;
    error.type = 'invalid_request_error';
    error.code = code;
    error.param = param || null;
    return error;
}

function normalizeCompletionRequest(body = {}) {
    const sourceField = ['prompt', 'input', 'prefix'].find(field => body[field] !== undefined);
    const source = sourceField ? body[sourceField] : undefined;
    let prompts;

    if (Array.isArray(source)) {
        if (source.length === 0) {
            throw createCompletionRequestError('prompt must not be an empty array.', sourceField, 'empty_prompt');
        }
        if (source.every(item => typeof item === 'string')) {
            prompts = source.slice();
        } else if (source.every(item => Number.isInteger(item))
            || source.every(item => Array.isArray(item) && item.every(token => Number.isInteger(token)))) {
            throw createCompletionRequestError(
                'Token-array prompts cannot be decoded by a chat-backed completion model. Send text prompts instead.',
                sourceField,
                'token_prompt_not_supported'
            );
        } else {
            throw createCompletionRequestError(
                'prompt must be a string or an array of strings.',
                sourceField,
                'invalid_prompt'
            );
        }
    } else if (source !== undefined) {
        const prompt = normalizeCompletionText(source);
        if (!prompt && source !== '' && source !== null) {
            throw createCompletionRequestError(
                'prompt must be a string or an array of strings.',
                sourceField,
                'invalid_prompt'
            );
        }
        prompts = [prompt];
    } else if (Array.isArray(body.messages) && body.messages.length > 0) {
        prompts = [null];
    } else if (body.suffix !== undefined) {
        prompts = [''];
    } else {
        throw createCompletionRequestError('prompt is required.', 'prompt', 'missing_prompt');
    }

    if (prompts.length > 128) {
        throw createCompletionRequestError(
            'prompt array is too large; maximum is 128 items.',
            sourceField || 'prompt',
            'too_many_prompts'
        );
    }

    const n = body.n === undefined ? 1 : Number(body.n);
    if (!Number.isInteger(n) || n < 1 || n > 128) {
        throw createCompletionRequestError('n must be an integer between 1 and 128.', 'n', 'invalid_n');
    }

    const bestOfSpecified = body.best_of !== undefined;
    const bestOf = bestOfSpecified ? Number(body.best_of) : n;
    if (!Number.isInteger(bestOf) || bestOf < 1 || bestOf > 128) {
        throw createCompletionRequestError('best_of must be an integer between 1 and 128.', 'best_of', 'invalid_best_of');
    }
    if (bestOf < n) {
        throw createCompletionRequestError('best_of must be greater than or equal to n.', 'best_of', 'invalid_best_of');
    }
    if (body.stream && bestOfSpecified) {
        throw createCompletionRequestError('best_of is not supported with stream=true.', 'best_of', 'invalid_best_of');
    }

    if (body.logprobs !== undefined && body.logprobs !== null) {
        const logprobs = Number(body.logprobs);
        if (!Number.isInteger(logprobs) || logprobs < 0 || logprobs > 5) {
            throw createCompletionRequestError('logprobs must be an integer between 0 and 5.', 'logprobs', 'invalid_logprobs');
        }
    }

    return {
        prompts,
        n,
        bestOf,
        bestOfSpecified,
        generationCount: bestOf,
        echo: body.echo === true,
        logprobs: body.logprobs === undefined || body.logprobs === null
            ? null
            : Number(body.logprobs)
    };
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

function isReasoningCompletionModel(modelCfg = {}) {
    const configured = modelCfg.supports_reasoning === true
        || Number(modelCfg.supports_reasoning || 0) === 1;
    if (configured) return true;
    const name = `${modelCfg.model_name || ''} ${modelCfg.name || ''}`;
    return /qwen-?3|qwq|deepseek-?r1/i.test(name);
}

function isQwen3CompletionModel(modelCfg = {}) {
    const name = `${modelCfg.model_name || ''} ${modelCfg.name || ''}`;
    return /qwen-?3/i.test(name);
}

function applyCompletionThinkingControls(payload = {}, modelCfg = {}) {
    if (!isQwen3CompletionModel(modelCfg)) return payload;
    const existingKwargs = payload.chat_template_kwargs
        && typeof payload.chat_template_kwargs === 'object'
        && !Array.isArray(payload.chat_template_kwargs)
        ? payload.chat_template_kwargs
        : {};
    return {
        ...payload,
        chat_template_kwargs: {
            ...existingKwargs,
            enable_thinking: false
        }
    };
}

function appendCompletionNoThinkDirective(content) {
    if (typeof content !== 'string') return content;
    if (/\/no_think\s*$/i.test(content.trimEnd())) return content;
    const trimmed = content.trimEnd();
    return trimmed
        ? `${trimmed}\n${COMPLETION_NO_THINK_DIRECTIVE}`
        : COMPLETION_NO_THINK_DIRECTIVE;
}

function applyCompletionNoThinkSoftSwitch(messages = [], modelCfg = {}) {
    if (!Array.isArray(messages) || !isReasoningCompletionModel(modelCfg)) return messages;

    let lastUserIndex = -1;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        if (messages[index]?.role === 'user') {
            lastUserIndex = index;
            break;
        }
    }
    if (lastUserIndex < 0) return messages;

    return messages.map((message, index) => {
        if (index !== lastUserIndex) return message;
        return {
            ...message,
            content: appendCompletionNoThinkDirective(message.content)
        };
    });
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

function toLegacyCompletionLogprobs(logprobs, textOffset = 0) {
    if (!logprobs) return null;
    if (Array.isArray(logprobs.tokens) && Array.isArray(logprobs.token_logprobs)) {
        return logprobs;
    }

    const content = Array.isArray(logprobs.content) ? logprobs.content : [];
    if (content.length === 0) return null;
    let offset = Math.max(0, Number(textOffset) || 0);
    const result = {
        tokens: [],
        token_logprobs: [],
        top_logprobs: [],
        text_offset: []
    };
    content.forEach(item => {
        const token = String(item?.token || '');
        result.tokens.push(token);
        result.token_logprobs.push(Number.isFinite(item?.logprob) ? item.logprob : null);
        result.top_logprobs.push(Array.isArray(item?.top_logprobs)
            ? Object.fromEntries(item.top_logprobs.map(candidate => [
                String(candidate?.token || ''),
                Number.isFinite(candidate?.logprob) ? candidate.logprob : null
            ]))
            : null);
        result.text_offset.push(offset);
        offset += token.length;
    });
    return result;
}

function getCompletionChoiceScore(choice = {}) {
    const content = Array.isArray(choice.logprobs?.content)
        ? choice.logprobs.content
        : null;
    const values = content
        ? content.map(item => item?.logprob).filter(Number.isFinite)
        : (Array.isArray(choice.logprobs?.token_logprobs)
            ? choice.logprobs.token_logprobs.filter(Number.isFinite)
            : []);
    if (values.length === 0) return null;
    return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function selectCompletionChoices(choices = [], choiceCount = null) {
    const limit = Number.isInteger(choiceCount) && choiceCount > 0
        ? Math.min(choiceCount, choices.length)
        : choices.length;
    if (limit >= choices.length) return choices.slice();
    return choices
        .map((choice, position) => ({ choice, position, score: getCompletionChoiceScore(choice) }))
        .sort((left, right) => {
            if (left.score === null && right.score === null) return left.position - right.position;
            if (left.score === null) return 1;
            if (right.score === null) return -1;
            return right.score - left.score || left.position - right.position;
        })
        .slice(0, limit)
        .map(item => item.choice);
}

function toCompletionResponse(chatResponse = {}, model, {
    echoText = '',
    choiceIndexOffset = 0,
    choiceCount = null,
    includeLogprobs = true
} = {}) {
    const choices = selectCompletionChoices(chatResponse.choices || [], choiceCount);
    return {
        id: String(chatResponse.id || `cmpl-${Date.now().toString(36)}`),
        object: 'text_completion',
        created: chatResponse.created || Math.floor(Date.now() / 1000),
        model: String(chatResponse.model || model || ''),
        choices: choices.map((choice, index) => ({
            text: `${echoText}${extractChatCompletionText(choice)}`,
            index: choiceIndexOffset + index,
            logprobs: includeLogprobs
                ? toLegacyCompletionLogprobs(choice.logprobs, echoText.length)
                : null,
            finish_reason: choice.finish_reason || null
        })),
        usage: chatResponse.usage || undefined
    };
}

function toCompletionStreamFrame(payload, model, textOverrides = null, {
    choiceIndexOffset = 0,
    includeLogprobs = true,
    logprobOffsets = null
} = {}) {
    try {
        const json = typeof payload === 'string' ? JSON.parse(payload) : payload;
        const choices = Array.isArray(json?.choices) ? json.choices : [];
        const convertedChoices = choices.map((choice, position) => {
            const delta = choice.delta || {};
            const originalIndex = Number.isInteger(choice.index) ? choice.index : position;
            const override = textOverrides instanceof Map
                ? textOverrides.get(originalIndex)
                : (typeof textOverrides === 'string' && position === 0 ? textOverrides : undefined);
            const text = typeof override === 'string'
                ? override
                : stripCompletionVisibleReasoning(normalizeCompletionText(delta.content ?? choice.text ?? ''));
            if (!text && choice.finish_reason == null && !choice.logprobs) return null;
            const legacyLogprobs = includeLogprobs
                ? toLegacyCompletionLogprobs(choice.logprobs, logprobOffsets?.get(originalIndex) || 0)
                : null;
            if (legacyLogprobs && logprobOffsets instanceof Map) {
                const consumed = legacyLogprobs.tokens.reduce((total, token) => total + String(token).length, 0);
                logprobOffsets.set(originalIndex, (logprobOffsets.get(originalIndex) || 0) + consumed);
            }
            return {
                text: typeof text === 'string' ? text : '',
                index: choiceIndexOffset + originalIndex,
                logprobs: legacyLogprobs,
                finish_reason: choice.finish_reason || null
            };
        }).filter(Boolean);
        if (convertedChoices.length === 0 && !json?.usage) return null;
        const frame = {
            id: String(json.id || `cmpl-${Date.now().toString(36)}`),
            object: 'text_completion',
            created: json.created || Math.floor(Date.now() / 1000),
            model: String(json.model || model || ''),
            choices: convertedChoices
        };
        if (json.usage) frame.usage = json.usage;
        return frame;
    } catch (e) {
        return null;
    }
}

function createCompletionVisibilityTracker({
    model = '',
    stream = false,
    onEmptyCompletion = null
} = {}) {
    let reported = false;
    let visibleLength = 0;
    let hasReasoningContent = false;
    let finishReason = null;
    let usage = null;
    const streamStates = new Map();

    const getStreamState = (index) => {
        if (!streamStates.has(index)) {
            streamStates.set(index, {
                filter: createVisibleReasoningStreamFilter(),
                finalized: false
            });
        }
        return streamStates.get(index);
    };
    const observeChoiceMetadata = (choice = {}) => {
        const reasoning = normalizeCompletionText(
            choice.message?.reasoning_content ?? choice.delta?.reasoning_content ?? ''
        );
        const rawContent = normalizeCompletionText(
            choice.message?.content ?? choice.delta?.content ?? choice.text ?? ''
        );
        if (reasoning.length > 0 || /<\/?(?:think|thinking|thought)\b/i.test(rawContent)) {
            hasReasoningContent = true;
        }
        if (choice.finish_reason != null && finishReason == null) finishReason = choice.finish_reason;
        return rawContent;
    };
    const report = (details = {}) => {
        if (reported) return null;
        reported = true;
        if (visibleLength > 0 || typeof onEmptyCompletion !== 'function') return null;
        const diagnostic = {
            model: String(model || ''),
            stream,
            hasReasoningContent,
            finishReason,
            usage,
            ...details
        };
        onEmptyCompletion(diagnostic);
        return diagnostic;
    };

    return {
        observeResponse(body = {}) {
            const choices = Array.isArray(body.choices) ? body.choices : [];
            choices.forEach(choice => {
                observeChoiceMetadata(choice);
                visibleLength += extractChatCompletionText(choice).length;
            });
            if (body.usage) usage = body.usage;
            return report();
        },
        observeStreamPayload(payload) {
            let json;
            try {
                json = typeof payload === 'string' ? JSON.parse(payload) : payload;
            } catch (e) {
                return false;
            }
            if (json?.usage) usage = json.usage;
            const choices = Array.isArray(json?.choices) ? json.choices : [];
            choices.forEach((choice, position) => {
                const index = Number.isInteger(choice.index) ? choice.index : position;
                const state = getStreamState(index);
                const rawContent = observeChoiceMetadata(choice);
                if (!state.finalized) {
                    visibleLength += state.filter.push(rawContent).length;
                    if (choice.finish_reason != null) {
                        visibleLength += state.filter.finish().length;
                        state.finalized = true;
                    }
                }
            });
            return true;
        },
        finish(details = {}) {
            streamStates.forEach(state => {
                if (state.finalized) return;
                visibleLength += state.filter.finish().length;
                state.finalized = true;
            });
            return report(details);
        },
        get visibleLength() {
            return visibleLength;
        }
    };
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

function createCompletionResponseProxy(res, {
    model = '',
    stream = false,
    onEmptyCompletion = null,
    onStreamError = null,
    echoText = '',
    choiceIndexOffset = 0,
    choiceCount = null,
    includeLogprobs = true,
    emitUsage = true,
    onUsage = null,
    writeDone = true,
    endResponse = true
} = {}) {
    let completionStreamDone = false;
    let completionStreamErrored = false;
    let completionStreamErrorPayload = null;
    const completionStates = new Map();
    const visibilityTracker = createCompletionVisibilityTracker({ model, stream, onEmptyCompletion });

    const getCompletionState = (index) => {
        if (!completionStates.has(index)) {
            completionStates.set(index, {
                filter: createVisibleReasoningStreamFilter(),
                finalized: false,
                echoWritten: false,
                logprobOffset: echoText.length
            });
        }
        return completionStates.get(index);
    };

    const convertCompletionResponse = (body) => {
        const selectedChoices = selectCompletionChoices(body.choices || [], choiceCount);
        visibilityTracker.observeResponse({
            ...body,
            choices: selectedChoices
        });
        return toCompletionResponse({ ...body, choices: selectedChoices }, model, {
            echoText,
            choiceIndexOffset,
            includeLogprobs
        });
    };

    const completionParser = stream ? createSseEventParser({
        onData(payload) {
            const json = typeof payload === 'string' ? JSON.parse(payload) : payload;
            if (json?.error) {
                writeSseError(json);
                return;
            }
            if (json?.usage && typeof onUsage === 'function') onUsage(json.usage);
            visibilityTracker.observeStreamPayload(json);
            const textOverrides = new Map();
            const logprobOffsets = new Map();
            const choices = Array.isArray(json?.choices) ? json.choices : [];
            choices.forEach((choice, position) => {
                const index = Number.isInteger(choice.index) ? choice.index : position;
                const state = getCompletionState(index);
                const rawText = normalizeCompletionText(choice.delta?.content ?? choice.text ?? '');
                let text = state.finalized ? '' : state.filter.push(rawText);
                if (!state.echoWritten && echoText) {
                    text = `${echoText}${text}`;
                    state.echoWritten = true;
                }
                if (!state.finalized && choice.finish_reason != null) {
                    text += state.filter.finish();
                    state.finalized = true;
                }
                textOverrides.set(index, text);
                logprobOffsets.set(index, state.logprobOffset);
            });
            const framePayload = !emitUsage && json?.usage
                ? { ...json, usage: undefined }
                : json;
            const frame = toCompletionStreamFrame(framePayload, model, textOverrides, {
                choiceIndexOffset,
                includeLogprobs,
                logprobOffsets
            });
            logprobOffsets.forEach((offset, index) => {
                getCompletionState(index).logprobOffset = offset;
            });
            if (frame) {
                res.write(`data: ${JSON.stringify(frame)}\n\n`);
            }
        },
        onDone() {
            if (completionStreamErrored) return;
            completionStates.forEach((state, index) => {
                if (state.finalized) return;
                let tail = state.filter.finish();
                if (!state.echoWritten && echoText) tail = `${echoText}${tail}`;
                state.finalized = true;
                state.echoWritten = true;
                if (!tail) return;
                const frame = {
                    id: `cmpl-${Date.now().toString(36)}`,
                    object: 'text_completion',
                    created: Math.floor(Date.now() / 1000),
                    model: String(model || ''),
                    choices: [{
                        text: tail,
                        index: choiceIndexOffset + index,
                        logprobs: null,
                        finish_reason: null
                    }]
                };
                res.write(`data: ${JSON.stringify(frame)}\n\n`);
            });
            visibilityTracker.finish();
            completionStreamDone = true;
            if (writeDone) res.write('data: [DONE]\n\n');
        }
    }) : null;

    const writeSseError = (error) => {
        if (completionStreamErrored || completionStreamDone) return;
        completionStreamErrored = true;
        completionStreamDone = true;
        const payload = error?.error ? error : {
            error: {
                message: error?.message || String(error || 'Upstream completion stream failed.'),
                type: error?.type || 'api_error',
                code: error?.code || 'upstream_stream_error'
            }
        };
        completionStreamErrorPayload = payload;
        res.write(`event: error\ndata: ${JSON.stringify(payload)}\n\n`);
        if (typeof onStreamError === 'function') onStreamError(payload);
    };

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
        get streamErrored() {
            return completionStreamErrored;
        },
        get streamErrorPayload() {
            return completionStreamErrorPayload;
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
            if (stream && body?.error && res.headersSent) {
                writeSseError(body);
                if (endResponse && !res.writableEnded) res.end();
                return this;
            }
            if (isChatCompletionResponse(body)) {
                return res.json(convertCompletionResponse(body));
            }
            return res.json(body);
        },
        send(body) {
            if (stream && body?.error && res.headersSent) {
                writeSseError(body);
                if (endResponse && !res.writableEnded) res.end();
                return this;
            }
            if (isChatCompletionResponse(body)) {
                return res.json(convertCompletionResponse(body));
            }
            return typeof res.send === 'function' ? res.send(body) : res.end(body);
        },
        write(chunk) {
            if (stream && completionParser && chunk !== undefined && chunk !== null) {
                try {
                    completionParser.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
                } catch (e) {
                    writeSseError({
                        error: {
                            message: `Invalid upstream completion stream: ${e.message}`,
                            type: 'api_error',
                            code: 'invalid_upstream_stream'
                        }
                    });
                }
                return true;
            }
            return typeof res.write === 'function' ? res.write(chunk) : true;
        },
        writeSseError,
        end(chunk) {
            if (stream && completionParser) {
                if (chunk !== undefined && chunk !== null && chunk !== '') {
                    this.write(chunk);
                }
                if (!completionStreamErrored) completionParser.end();
                if (!completionStreamDone && !completionStreamErrored) {
                    visibilityTracker.finish();
                    if (writeDone) res.write('data: [DONE]\n\n');
                    completionStreamDone = true;
                }
                return endResponse ? res.end() : this;
            }
            return endResponse && typeof res.end === 'function' ? res.end(chunk) : this;
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
    normalizeCompletionRequest,
    stripCompletionThoughtContent,
    stripCompletionVisibleReasoning,
    buildPromptStyleCompletionMessage,
    normalizeChatCompletionMessages,
    isReasoningCompletionModel,
    isQwen3CompletionModel,
    applyCompletionNoThinkSoftSwitch,
    applyCompletionThinkingControls,
    updateApiKeyUsage,
    extractChatCompletionText,
    isChatCompletionResponse,
    toCompletionResponse,
    toCompletionStreamFrame,
    createCompletionVisibilityTracker,
    runRouteHandlers,
    createCompletionResponseProxy
};
