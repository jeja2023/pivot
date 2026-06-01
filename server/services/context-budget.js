const { estimateTokens } = require('../llm');

const DEFAULT_RESERVED_OUTPUT_TOKENS = 2048;
const MIN_RESERVED_OUTPUT_TOKENS = 512;
const SAFETY_MARGIN_TOKENS = 256;
const IMAGE_INPUT_TOKEN_ESTIMATE = 1024;
const UNBOUNDED_CONTEXT_BUDGET = Number.MAX_SAFE_INTEGER;

class ContextLengthExceededError extends Error {
    constructor(message, metadata = {}) {
        super(message);
        this.name = 'ContextLengthExceededError';
        this.code = 'CONTEXT_LENGTH_EXCEEDED';
        this.statusCode = 400;
        this.metadata = metadata;
    }
}

function toPositiveInt(value, fallback = 0) {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function getModelContextBudget(modelCfg = {}, options = {}) {
    const explicitContextWindow = options.contextWindowTokens
        ?? modelCfg.context_window_tokens
        ?? process.env.MODEL_CONTEXT_WINDOW_TOKENS
        ?? process.env.CONTEXT_WINDOW_TOKENS;
    const explicitContextWindowTokens = toPositiveInt(explicitContextWindow, 0);
    const configuredInputLimit = toPositiveInt(modelCfg.max_input_tokens, 0);
    const requestedOutput = toPositiveInt(
        options.maxOutputTokens
            ?? modelCfg.max_tokens
            ?? process.env.CONTEXT_RESERVED_OUTPUT_TOKENS,
        DEFAULT_RESERVED_OUTPUT_TOKENS
    );
    const requestedReservedOutput = Math.max(requestedOutput, MIN_RESERVED_OUTPUT_TOKENS);

    if (configuredInputLimit <= 0 && explicitContextWindowTokens <= 0) {
        return {
            contextWindow: 0,
            configuredInputLimit,
            reservedOutputTokens: requestedReservedOutput,
            inputBudget: UNBOUNDED_CONTEXT_BUDGET,
            unbounded: true
        };
    }

    const contextWindow = explicitContextWindowTokens > 0
        ? explicitContextWindowTokens
        : configuredInputLimit + requestedReservedOutput + SAFETY_MARGIN_TOKENS;
    const reservedOutputTokens = Math.min(
        requestedReservedOutput,
        Math.max(MIN_RESERVED_OUTPUT_TOKENS, Math.floor(contextWindow * 0.75))
    );
    const derivedInputBudget = Math.max(
        MIN_RESERVED_OUTPUT_TOKENS,
        contextWindow - reservedOutputTokens - SAFETY_MARGIN_TOKENS
    );
    const inputBudget = configuredInputLimit > 0
        ? Math.min(configuredInputLimit, derivedInputBudget)
        : derivedInputBudget;

    return {
        contextWindow,
        configuredInputLimit,
        reservedOutputTokens,
        inputBudget,
        unbounded: false
    };
}

function estimateContentTokens(content) {
    if (Array.isArray(content)) {
        return content.reduce((sum, part) => {
            if (!part || typeof part !== 'object') return sum + estimateTokens(String(part || ''));
            if (part.type === 'image_url' || part.type === 'input_image' || part.image_url) {
                return sum + IMAGE_INPUT_TOKEN_ESTIMATE;
            }
            return sum + estimateContentTokens(part.text ?? part.content ?? '');
        }, 0);
    }
    if (content && typeof content === 'object') {
        return estimateTokens(JSON.stringify(content));
    }
    return estimateTokens(String(content || ''));
}

function estimateMessageTokens(message) {
    return 4 + estimateContentTokens(message?.content);
}

function estimateMessagesTokens(messages = []) {
    return messages.reduce((sum, message) => sum + estimateMessageTokens(message), 0);
}

function contentText(content) {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
        return content
            .map(part => {
                if (typeof part === 'string') return part;
                if (!part || typeof part !== 'object') return '';
                return part.text || part.content || '';
            })
            .filter(Boolean)
            .join('\n');
    }
    return content ? JSON.stringify(content) : '';
}

function isRagMessage(message) {
    const text = contentText(message.content);
    if (text.includes('PIVOT_RAG_CONTEXT_BEGIN') || text.includes('PIVOT_RAG_CONTEXT_END')) return true;
    if (message?.role !== 'system') return false;
    return text.includes('参考内部知识库')
        || text.includes('[引用 ')
        || text.includes('知识库信息');
}

function isMcpMessage(message) {
    if (message?.role !== 'system') return false;
    const text = contentText(message.content);
    return text.includes('MCP') || text.includes('工具:');
}

function truncateTextToTokens(text, maxTokens, suffix) {
    const source = String(text || '');
    if (maxTokens <= 0) return '';
    if (estimateTokens(source) <= maxTokens) return source;

    let low = 0;
    let high = source.length;
    while (low < high) {
        const mid = Math.ceil((low + high) / 2);
        if (estimateTokens(source.slice(0, mid) + suffix) <= maxTokens) {
            low = mid;
        } else {
            high = mid - 1;
        }
    }
    return `${source.slice(0, low).trimEnd()}${suffix}`;
}

function truncateContentToTokens(content, maxTokens, suffix) {
    if (typeof content === 'string') return truncateTextToTokens(content, maxTokens, suffix);
    if (!Array.isArray(content)) {
        return truncateTextToTokens(contentText(content), maxTokens, suffix);
    }

    let remaining = maxTokens;
    let truncated = false;
    const nextContent = [];
    for (const part of content) {
        const partTokens = estimateContentTokens(part);
        if (partTokens <= remaining) {
            nextContent.push(part);
            remaining -= partTokens;
            continue;
        }
        if (part?.type === 'text' && remaining > estimateTokens(suffix) + 16) {
            nextContent.push({
                ...part,
                text: truncateTextToTokens(part.text || '', remaining, suffix)
            });
        } else if (remaining > estimateTokens(suffix) + 16) {
            nextContent.push({ type: 'text', text: suffix.trim() });
        }
        truncated = true;
        break;
    }
    return truncated ? nextContent : content;
}

function trimGeneratedContextMessages(messages, predicate, maxTokensPerMessage, metadataKey, metadata) {
    let changed = false;
    for (const message of messages) {
        if (!predicate(message)) continue;
        const currentTokens = estimateContentTokens(message.content);
        if (currentTokens <= maxTokensPerMessage) continue;
        message.content = truncateContentToTokens(
            message.content,
            maxTokensPerMessage,
            '\n\n[系统提示：为避免超过模型上下文长度，以上内容已自动截断。]'
        );
        metadata[metadataKey] += 1;
        changed = true;
    }
    return changed;
}

function getLastUserOriginIndex(messages) {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
        if (messages[i]?.role === 'user') return i;
    }
    return -1;
}

function fitMessagesToContextBudget(messages = [], modelCfg = {}, options = {}) {
    const budget = getModelContextBudget(modelCfg, options);
    const originalMessages = Array.isArray(messages) ? messages : [];
    const working = originalMessages.map((message, index) => ({ ...message, __originIndex: index }));
    const metadata = {
        adjusted: false,
        inputTokensBefore: estimateMessagesTokens(working),
        inputTokensAfter: 0,
        droppedMessages: 0,
        droppedRagContexts: 0,
        droppedMcpContexts: 0,
        trimmedRagContexts: 0,
        trimmedMcpContexts: 0,
        budget
    };

    const lastUserOriginIndex = getLastUserOriginIndex(working);
    const firstSystemOriginIndex = working[0]?.role === 'system' ? working[0].__originIndex : -1;
    const currentUserTokens = lastUserOriginIndex >= 0
        ? estimateMessageTokens(working.find(message => message.__originIndex === lastUserOriginIndex))
        : 0;

    if (currentUserTokens > Math.max(0, budget.inputBudget - SAFETY_MARGIN_TOKENS)) {
        throw new ContextLengthExceededError(
            '本次输入内容过长，已超过当前模型一次可处理的上下文长度。请缩短输入内容，或拆分为多次提问后重试。',
            {
                ...metadata,
                inputTokensAfter: metadata.inputTokensBefore,
                currentUserTokens
            }
        );
    }

    let total = metadata.inputTokensBefore;
    if (total <= budget.inputBudget) {
        metadata.inputTokensAfter = total;
        return {
            messages: working.map(({ __originIndex, ...message }) => message),
            metadata
        };
    }

    const ragCap = Math.max(512, Math.floor(budget.inputBudget * 0.18));
    const mcpCap = Math.max(768, Math.floor(budget.inputBudget * 0.20));
    if (trimGeneratedContextMessages(working, isRagMessage, ragCap, 'trimmedRagContexts', metadata)) {
        total = estimateMessagesTokens(working);
    }
    if (total > budget.inputBudget && trimGeneratedContextMessages(working, isMcpMessage, mcpCap, 'trimmedMcpContexts', metadata)) {
        total = estimateMessagesTokens(working);
    }

    for (let i = 0; i < working.length && total > budget.inputBudget;) {
        const message = working[i];
        const pinned = message.__originIndex === lastUserOriginIndex
            || message.__originIndex === firstSystemOriginIndex
            || isRagMessage(message)
            || isMcpMessage(message);
        if (pinned) {
            i += 1;
            continue;
        }
        working.splice(i, 1);
        metadata.droppedMessages += 1;
        total = estimateMessagesTokens(working);
    }

    for (let i = 0; i < working.length && total > budget.inputBudget;) {
        if (!isRagMessage(working[i])) {
            i += 1;
            continue;
        }
        working.splice(i, 1);
        metadata.droppedRagContexts += 1;
        total = estimateMessagesTokens(working);
    }

    for (let i = 0; i < working.length && total > budget.inputBudget;) {
        if (!isMcpMessage(working[i])) {
            i += 1;
            continue;
        }
        working.splice(i, 1);
        metadata.droppedMcpContexts += 1;
        total = estimateMessagesTokens(working);
    }

    if (total > budget.inputBudget) {
        throw new ContextLengthExceededError(
            '本次请求包含的系统提示、历史会话、知识库内容和当前输入合计过长，已超过当前模型上下文长度。请缩短输入内容，或新建会话后重试。',
            {
                ...metadata,
                inputTokensAfter: total,
                currentUserTokens
            }
        );
    }

    metadata.inputTokensAfter = total;
    metadata.adjusted = metadata.droppedMessages > 0
        || metadata.droppedRagContexts > 0
        || metadata.droppedMcpContexts > 0
        || metadata.trimmedRagContexts > 0
        || metadata.trimmedMcpContexts > 0;

    return {
        messages: working.map(({ __originIndex, ...message }) => message),
        metadata
    };
}

function buildContextLengthExceededPayload(error) {
    const metadata = error?.metadata || {};
    return {
        error: error?.message || '本次输入内容过长，已超过当前模型一次可处理的上下文长度。',
        detail: error?.message || '',
        code: 'CONTEXT_LENGTH_EXCEEDED',
        retryable: false,
        contextBudget: metadata
    };
}

module.exports = {
    ContextLengthExceededError,
    buildContextLengthExceededPayload,
    estimateContentTokens,
    estimateMessageTokens,
    estimateMessagesTokens,
    fitMessagesToContextBudget,
    getModelContextBudget
};
