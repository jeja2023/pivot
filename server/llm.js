const fs = require('fs');
const { db } = require('./db');
const { getBeijingTimestamp } = require('./time');
const { extractDocumentText, truncateExtractedText } = require('./document-text');
const { imageFileToDataUrl, getMaxImagesPerMessage } = require('./image-safety');
const { resolveUploadUrlPath, toProjectRelativePath } = require('./security');
const { withTimeout, KeyedConcurrencyGuard } = require('./services/concurrency');
const {
    buildChatCompletionsUrl,
    buildModelHeaders
} = require('./services/model-adapter');
const {
    DEFAULT_MEMORY_THRESHOLD,
    MEMORY_CONFIG_KEYS,
    normalizeMemoryThreshold
} = require('./services/memory-config');
const { getBackgroundRuntimeConfig, getGlobalContextRuntimeConfig } = require('./services/runtime-settings');
const { forwardChatCompletion } = require('./services/model-forwarder');
const { getAppSettingValue } = require('./services/app-settings');
const { getAttachmentContextLimit } = require('./services/resource-limits');

const THRESHOLD = DEFAULT_MEMORY_THRESHOLD;
const SUMMARY_KEEP_COUNT = Math.max(1, parseInt(process.env.MEMORY_SUMMARY_KEEP_COUNT, 10) || 6);
const MIN_MESSAGES_TO_COMPRESS = Math.max(1, parseInt(process.env.MEMORY_MIN_MESSAGES_TO_COMPRESS, 10) || 1);
const MEMORY_COMPRESSION_TIMEOUT_MS = Math.max(15000, parseInt(process.env.MEMORY_COMPRESSION_TIMEOUT_MS, 10) || 180000);
// 同会话同时只触发一次后台压缩，全局并发上限可在环境变量调整
const memoryCompressionGuard = new KeyedConcurrencyGuard({
    maxConcurrent: getBackgroundRuntimeConfig().memoryCompressionMaxConcurrent
});

function syncMemoryCompressionConcurrency() {
    return memoryCompressionGuard.updateMaxConcurrent(getBackgroundRuntimeConfig().memoryCompressionMaxConcurrent);
}

function loadSessionMessages(sessionId, userId) {
    return db.prepare(`
        SELECT * FROM messages
        WHERE session_id = ? AND user_id = ?
          AND deleted_at IS NULL
        ORDER BY id ASC
    `).all(sessionId, userId);
}

function unwrapGuardedCompressionResult(guardedResult) {
    return guardedResult?.skipped ? guardedResult : (guardedResult?.value || guardedResult || {});
}

async function runGuardedCompression(sessionId, userId, messages, modelCfg) {
    syncMemoryCompressionConcurrency();
    const guardedResult = await memoryCompressionGuard.run(`mem:${sessionId}`, () =>
        withTimeout(
            (signal) => compressMemory(sessionId, userId, messages, modelCfg, { signal }),
            MEMORY_COMPRESSION_TIMEOUT_MS,
            '记忆压缩'
        )
    );
    return unwrapGuardedCompressionResult(guardedResult);
}

function orderMessagesForContext(messages = []) {
    const summaryMessages = messages.filter(m => Number(m.is_summary) && !Number(m.context_archived));
    const activeMessages = messages.filter(m => !Number(m.context_archived) && !Number(m.is_summary));
    return [...summaryMessages, ...activeMessages];
}

function estimateTokens(text) {
    if (!text) return 0;
    const chineseChars = (text.match(/[\u4e00-\u9fa5]/g) || []).length;
    const otherChars = text.length - chineseChars;
    return Math.ceil(chineseChars * 2 + otherChars * 0.5);
}

const THOUGHT_BLOCK_PATTERNS = [
    /<thought\b[^>]*>[\s\S]*?<\/thought>/gi,
    /<thought\b[^>]*>[\s\S]*$/gi,
    /<thinking\b[^>]*>[\s\S]*?<\/thinking>/gi,
    /<thinking\b[^>]*>[\s\S]*$/gi,
    /<think\b[^>]*>[\s\S]*?<\/think>/gi,
    /<think\b[^>]*>[\s\S]*$/gi
];

function stripThoughtContent(text = '') {
    let value = String(text || '');
    THOUGHT_BLOCK_PATTERNS.forEach(pattern => {
        value = value.replace(pattern, '\n');
    });
    return value.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

function stripVisibleReasoningScaffold(text = '') {
    let value = stripThoughtContent(text);
    const hasScaffold = [
        /^Analyze User Input:\s*$/gim,
        /^Key constraints from system prompt:\s*$/gim,
        /^Formulate Response\b.*:\s*$/gim,
        /^Draft:\s*$/gim,
        /^Check Constraints:\s*$/gim,
        /^All good\. Proceed\.\s*$/gim,
        /^Output matches the draft\.[\s\S]*$/gim
    ].some(pattern => pattern.test(value));
    if (!hasScaffold) return value;

    const lines = value.split(/\r?\n/);
    const draftIndex = lines.findIndex(line => /^Draft:\s*$/i.test(line.trim()));
    if (draftIndex >= 0) {
        const answerLines = [];
        for (let i = draftIndex + 1; i < lines.length; i += 1) {
            const line = lines[i];
            if (/^Check Constraints:\s*$/i.test(line.trim())) break;
            answerLines.push(line);
        }
        const answer = answerLines.join('\n').trim();
        if (answer) return answer;
    }

    return value
        .replace(/^[\s\S]*?(?:Draft:\s*)/i, '')
        .replace(/(?:Check Constraints:|All good\. Proceed\.|Output matches the draft\.)[\s\S]*$/i, '')
        .trim();
}

const VISIBLE_REASONING_PREFIXES = [
    'analyze user input:',
    'key constraints from system prompt:',
    'formulate response',
    'draft:',
    'check constraints:',
    'user says:'
];

const VISIBLE_REASONING_START_PATTERN = /^(?:Analyze User Input:|Key constraints from system prompt:|Formulate Response\b.*:|Draft:|Check Constraints:|User says:)/im;
const VISIBLE_REASONING_DRAFT_PATTERN = /^Draft:\s*/im;
const VISIBLE_REASONING_STOP_PATTERN = /(?:^|\r?\n)(?:Check Constraints:|All good\. Proceed\.|Output matches the draft\.)/i;
const LEADING_THOUGHT_OPEN_PATTERN = /^\s*<(think|thought|thinking)\b[^>]*>/i;
const STREAM_FILTER_HOLD_CHARS = 32;

function isPotentialVisibleReasoningPrefix(text = '') {
    const value = String(text || '').trimStart().toLowerCase();
    if (!value) return true;
    return VISIBLE_REASONING_PREFIXES.some(prefix => prefix.startsWith(value) || value.startsWith(prefix));
}

function createVisibleReasoningStreamFilter() {
    let buffer = '';
    let mode = 'probe';
    let answerStarted = false;
    let stopped = false;
    let seenContentChunk = false;

    const consumeLeadingThoughtTag = () => {
        const open = buffer.match(LEADING_THOUGHT_OPEN_PATTERN);
        if (!open) return false;
        const tag = open[1].toLowerCase();
        const closePattern = new RegExp(`</${tag}>`, 'i');
        const rest = buffer.slice(open.index + open[0].length);
        const close = rest.search(closePattern);
        if (close === -1) {
            buffer = '';
            mode = `drop-${tag}`;
            return true;
        }
        const closeTag = rest.match(closePattern)?.[0] || '';
        buffer = rest.slice(close + closeTag.length);
        return true;
    };

    const consumeDroppedThoughtTag = () => {
        const tag = mode.replace(/^drop-/, '');
        const closePattern = new RegExp(`</${tag}>`, 'i');
        const close = buffer.search(closePattern);
        if (close === -1) {
            buffer = '';
            return '';
        }
        const closeTag = buffer.match(closePattern)?.[0] || '';
        buffer = buffer.slice(close + closeTag.length);
        mode = 'probe';
        return drain(false);
    };

    const drainScaffold = (final = false) => {
        if (stopped) {
            buffer = '';
            return '';
        }

        if (!answerStarted) {
            const draft = buffer.match(VISIBLE_REASONING_DRAFT_PATTERN);
            if (!draft) {
                if (!final) return '';
                const clean = stripVisibleReasoningScaffold(buffer);
                buffer = '';
                stopped = true;
                return clean;
            }
            buffer = buffer.slice(draft.index + draft[0].length);
            answerStarted = true;
        }

        const stop = buffer.search(VISIBLE_REASONING_STOP_PATTERN);
        if (stop !== -1) {
            const output = buffer.slice(0, stop).trimEnd();
            buffer = '';
            stopped = true;
            return output;
        }

        if (final) {
            const output = buffer.trimEnd();
            buffer = '';
            return output;
        }

        if (buffer.length <= STREAM_FILTER_HOLD_CHARS) return '';
        const output = buffer.slice(0, -STREAM_FILTER_HOLD_CHARS);
        buffer = buffer.slice(-STREAM_FILTER_HOLD_CHARS);
        return output;
    };

    function drain(final = false) {
        let output = '';
        let progressed = true;

        while (progressed) {
            progressed = false;
            if (mode.startsWith('drop-')) {
                output += consumeDroppedThoughtTag();
                progressed = mode === 'probe' && buffer.length > 0;
            } else if (mode === 'probe') {
                if (consumeLeadingThoughtTag()) {
                    progressed = mode === 'probe' && buffer.length > 0;
                    continue;
                }
                if (VISIBLE_REASONING_START_PATTERN.test(buffer)) {
                    mode = 'scaffold';
                    output += drainScaffold(final);
                    progressed = false;
                } else if (!isPotentialVisibleReasoningPrefix(buffer) || final) {
                    mode = 'plain';
                    output += buffer;
                    buffer = '';
                }
            } else if (mode === 'scaffold') {
                output += drainScaffold(final);
            } else if (mode === 'plain') {
                output += buffer;
                buffer = '';
            }
        }

        return output;
    }

    return {
        push(chunk = '') {
            const value = String(chunk || '');
            if (!value || stopped) return '';
            seenContentChunk = true;
            buffer += value;
            return drain(false);
        },
        finish(fallbackText = '') {
            const output = drain(true);
            if (output) return output;
            if (!seenContentChunk && fallbackText) return stripVisibleReasoningScaffold(fallbackText);
            return '';
        }
    };
}

function stripThoughtContentFromContent(content) {
    if (typeof content === 'string') return stripThoughtContent(content);
    if (Array.isArray(content)) {
        return content
            .map(part => {
                if (typeof part === 'string') return stripThoughtContent(part);
                if (!part || typeof part !== 'object') return part;
                const next = { ...part };
                if (typeof next.text === 'string') {
                    next.text = stripThoughtContent(next.text);
                }
                if (typeof next.content === 'string') {
                    next.content = stripThoughtContent(next.content);
                } else if (Array.isArray(next.content)) {
                    next.content = stripThoughtContentFromContent(next.content);
                }
                return next;
            })
            .filter(part => {
                if (typeof part === 'string') return part.trim().length > 0;
                if (!part || typeof part !== 'object') return true;
                if (part.type === 'text' && typeof part.text === 'string') {
                    return part.text.trim().length > 0;
                }
                return true;
            });
    }
    if (content && typeof content === 'object') {
        const next = { ...content };
        if (typeof next.text === 'string') {
            next.text = stripThoughtContent(next.text);
        }
        if (typeof next.content === 'string') {
            next.content = stripThoughtContent(next.content);
        } else if (Array.isArray(next.content)) {
            next.content = stripThoughtContentFromContent(next.content);
        }
        return next;
    }
    return content;
}

function contentHasContextValue(content) {
    if (typeof content === 'string') return content.trim().length > 0;
    if (Array.isArray(content)) {
        return content.some(part => {
            if (typeof part === 'string') return part.trim().length > 0;
            if (!part || typeof part !== 'object') return false;
            if (typeof part.text === 'string' && part.text.trim()) return true;
            if (typeof part.content === 'string' && part.content.trim()) return true;
            if (Array.isArray(part.content)) return contentHasContextValue(part.content);
            return Boolean(part.image_url || part.type === 'image_url' || part.type === 'input_image');
        });
    }
    if (content && typeof content === 'object') {
        if (typeof content.text === 'string') return content.text.trim().length > 0;
        if (typeof content.content === 'string') return content.content.trim().length > 0;
        if (Array.isArray(content.content)) return contentHasContextValue(content.content);
        return Boolean(content.image_url || content.type === 'image_url' || content.type === 'input_image');
    }
    return false;
}

function getMessageContentForContext(message = {}) {
    const content = message.content ?? '';
    return message.role === 'assistant' ? stripThoughtContentFromContent(content) : content;
}

function getMessageTextForContext(message = {}) {
    const content = getMessageContentForContext(message);
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
        return content
            .map(part => {
                if (typeof part === 'string') return part;
                if (!part || typeof part !== 'object') return '';
                if (typeof part.text === 'string') return part.text;
                if (typeof part.content === 'string') return part.content;
                if (Array.isArray(part.content)) return getMessageTextForContext({ ...message, content: part.content });
                return '';
            })
            .filter(Boolean)
            .join('\n');
    }
    return content ? JSON.stringify(content) : '';
}

function getStoredMessageContextTokens(message = {}) {
    if (message.role === 'assistant') {
        return estimateTokens(getMessageTextForContext(message));
    }
    const storedTokens = Number(message.token_count || 0);
    return storedTokens > 0 ? storedTokens : estimateTokens(String(message.content || ''));
}

function getMemoryThreshold() {
    try {
        const runtimeThreshold = getGlobalContextRuntimeConfig().memoryThreshold;
        if (runtimeThreshold > 0) return runtimeThreshold;
        return normalizeMemoryThreshold(getAppSettingValue(MEMORY_CONFIG_KEYS.threshold), DEFAULT_MEMORY_THRESHOLD);
    } catch (_err) {
        return DEFAULT_MEMORY_THRESHOLD;
    }
}

function resolveOwnedAttachmentPath(uploadUrl, userId, sessionId) {
    const targetPath = resolveUploadUrlPath(uploadUrl);
    if (!targetPath) return null;
    const filePath = toProjectRelativePath(targetPath);
    if (!filePath) return null;
    const attachment = db.prepare(`
        SELECT id FROM attachments
        WHERE user_id = ? AND session_id = ? AND file_path = ?
          AND deleted_at IS NULL
    `).get(userId, sessionId, filePath);
    if (!attachment || !fs.existsSync(targetPath)) return null;
    return targetPath;
}

function buildContextMeta(messages = []) {
    const activeMessages = messages.filter(m => !Number(m.context_archived) && !Number(m.is_summary));
    const summaryMessages = messages.filter(m => Number(m.is_summary) && !Number(m.context_archived));
    const archivedCount = messages.filter(m => Number(m.context_archived)).length;
    const activeTokens = activeMessages.reduce((sum, m) => sum + getStoredMessageContextTokens(m), 0);
    const summaryTokens = summaryMessages.reduce((sum, m) => sum + getStoredMessageContextTokens(m), 0);
    const threshold = getMemoryThreshold();
    const ratio = threshold > 0 ? activeTokens / threshold : 0;

    return {
        threshold,
        activeTokens,
        summaryTokens,
        totalTokens: activeTokens + summaryTokens,
        archivedCount,
        summaryCount: summaryMessages.length,
        activeCount: activeMessages.length,
        ratio: Math.max(0, Math.min(1, ratio)),
        percent: Math.min(999, Math.round(ratio * 100)),
        status: ratio >= 0.9 ? 'critical' : ratio >= 0.7 ? 'warn' : 'ok'
    };
}

async function hydrateMessageContent(message, userId, sessionId, totalImageCounter, logger) {
    const content = String(message.content || '');
    const maxImagesPerMessage = Math.max(1, Number.parseInt(getMaxImagesPerMessage(), 10) || 1);
    const attachmentContextMaxChars = Math.max(1, Number.parseInt(getAttachmentContextLimit(), 10) || 80000);
    const uploadUrlPattern = String.raw`\/uploads\/(?:[^()]|\([^)]*\))+`;
    const imgRegex = new RegExp(String.raw`!\[.*?\]\((${uploadUrlPattern})\)`, 'g');
    const fileRegex = new RegExp(String.raw`\[附件:\s*([^\]]+)\]\((${uploadUrlPattern})\)`, 'g');
    let match;
    let finalContent = [];
    let lastIndex = 0;
    let imageCount = 0;

    while ((match = imgRegex.exec(content)) !== null) {
        if (match.index > lastIndex) {
            finalContent.push({ type: 'text', text: content.slice(lastIndex, match.index) });
        }
        if (imageCount >= maxImagesPerMessage) {
            finalContent.push({ type: 'text', text: '[图片已跳过：数量超过限制]' });
            lastIndex = imgRegex.lastIndex;
            continue;
        }

        const localPath = resolveOwnedAttachmentPath(match[1], userId, sessionId);
        if (localPath) {
            const imageUrl = await imageFileToDataUrl(localPath);
            if (imageUrl && totalImageCounter.count < maxImagesPerMessage) {
                finalContent.push({ type: 'image_url', image_url: { url: imageUrl } });
                imageCount += 1;
                totalImageCounter.count += 1;
            } else {
                finalContent.push({
                    type: 'text',
                    text: totalImageCounter.count >= maxImagesPerMessage
                        ? `[图片已跳过：当前单次最多解析 ${maxImagesPerMessage} 张图片]`
                        : '[图片已跳过：文件过大或格式不支持]'
                });
            }
        } else {
            finalContent.push({ type: 'text', text: match[0] });
        }
        lastIndex = imgRegex.lastIndex;
    }

    if (lastIndex === 0) {
        let fileMatch;
        let fileFinalContent = [];
        let fileLastIndex = 0;

        while ((fileMatch = fileRegex.exec(content)) !== null) {
            if (fileMatch.index > fileLastIndex) {
                fileFinalContent.push({ type: 'text', text: content.slice(fileLastIndex, fileMatch.index) });
            }
            const fileName = fileMatch[1];
            const localPath = resolveOwnedAttachmentPath(fileMatch[2], userId, sessionId);

            if (localPath) {
                try {
                    const text = truncateExtractedText(await extractDocumentText(localPath, '', fileName), attachmentContextMaxChars);
                    fileFinalContent.push({
                        type: 'text',
                        text: text
                            ? `\n\n--- 附件内容 (${fileName}) ---\n${text}\n--- 结束 ---\n\n`
                            : fileMatch[0]
                    });
                } catch (err) {
                    logger.error({ err: err.message, localPath }, '读取附件内容失败');
                    fileFinalContent.push({ type: 'text', text: fileMatch[0] });
                }
            } else {
                fileFinalContent.push({ type: 'text', text: fileMatch[0] });
            }
            fileLastIndex = fileRegex.lastIndex;
        }

        if (fileLastIndex < content.length) {
            fileFinalContent.push({ type: 'text', text: content.slice(fileLastIndex) });
        }
        if (fileFinalContent.length > 0) {
            finalContent = fileFinalContent;
            lastIndex = content.length;
        }
    }

    if (lastIndex < content.length) {
        finalContent.push({ type: 'text', text: content.slice(lastIndex) });
    }
    if (finalContent.length === 1 && finalContent[0].type === 'text') {
        return getMessageContentForContext({ ...message, content: finalContent[0].text });
    }
    return getMessageContentForContext({ ...message, content: finalContent.length > 0 ? finalContent : content });
}

async function getContext(sessionId, userId, modelCfg) {
    const session = db.prepare('SELECT system_prompt FROM sessions WHERE id = ? AND deleted_at IS NULL').get(sessionId);
    let messages = loadSessionMessages(sessionId, userId);

    const { logger } = require('./logger');
    let contextMeta = buildContextMeta(messages);
    logger.info({ sessionId, messageCount: messages.length, contextMeta }, '检索会话历史');

    // 压缩触发阈值按模型上下文收紧（仅下调、不上调）：当模型配置的输入预算小于全局阈值时，
    // 提前压缩，避免请求时上下文预算只能硬丢历史。未配置上下文的模型预算无界，此处不改变行为。
    let compactionThreshold = contextMeta.threshold;
    try {
        const { getModelContextBudget } = require('./services/context-budget');
        const budget = getModelContextBudget(modelCfg);
        if (!budget.unbounded && budget.inputBudget > 0) {
            compactionThreshold = Math.min(compactionThreshold, budget.inputBudget);
        }
    } catch (_err) {
        // 预算计算不可用时退回全局阈值
    }

    if (contextMeta.activeTokens > compactionThreshold && contextMeta.activeCount > MIN_MESSAGES_TO_COMPRESS) {
        try {
            const result = await runGuardedCompression(sessionId, userId, messages, modelCfg);
            if (result?.skipped) {
                logger.info({ sessionId, reason: result.reason }, '记忆压缩已跳过');
            } else if (result?.compressed) {
                messages = loadSessionMessages(sessionId, userId);
                contextMeta = buildContextMeta(messages);
                logger.info({ sessionId, contextMeta, summarizedCount: result.summarizedCount }, '记忆压缩完成，当前请求将使用压缩后上下文');
            }
        } catch (err) {
            logger.error({ sessionId, err: err.message }, '记忆压缩失败，当前请求将继续使用原始上下文');
        }
    }

    const totalImageCounter = { count: 0 };
    const contextMessages = orderMessagesForContext(messages);
    const hydratedHistory = await Promise.all(contextMessages.map(async m => ({
        role: m.role,
        content: await hydrateMessageContent(m, userId, sessionId, totalImageCounter, logger)
    })));
    const history = hydratedHistory.filter(message => {
        if (message.role !== 'assistant') return true;
        return contentHasContextValue(message.content);
    });

    if (session && session.system_prompt) {
        history.unshift({ role: 'system', content: session.system_prompt });
    }

    return history;
}

async function compactSessionMemory(sessionId, userId, modelCfg, options = {}) {
    const messages = loadSessionMessages(sessionId, userId);
    const before = buildContextMeta(messages);
    if (!options.force && (before.activeTokens <= before.threshold || before.activeCount <= MIN_MESSAGES_TO_COMPRESS)) {
        return {
            skipped: true,
            reason: 'threshold_not_reached',
            before,
            after: before
        };
    }

    const result = await runGuardedCompression(sessionId, userId, messages, modelCfg);
    const afterMessages = loadSessionMessages(sessionId, userId);
    const after = buildContextMeta(afterMessages);
    return {
        ...(result || {}),
        before,
        after,
        compressed: after.archivedCount > before.archivedCount || after.summaryCount > before.summaryCount
    };
}

async function compressMemory(sessionId, userId, messages, modelCfg, options = {}) {
    const activeMessages = messages.filter(m => !Number(m.context_archived) && !Number(m.is_summary));
    const keepCount = Math.min(SUMMARY_KEEP_COUNT, Math.max(1, activeMessages.length - MIN_MESSAGES_TO_COMPRESS));
    const toSummarize = activeMessages.slice(0, -keepCount);
    if (toSummarize.length < MIN_MESSAGES_TO_COMPRESS) {
        return { skipped: true, reason: 'not_enough_messages' };
    }

    const summaryPrompt = '你是一个短期会话记忆压缩专家。请将以下同一会话内的对话内容提炼为一段极简摘要（300字以内），用于当前会话后续上下文续接；保留关键事实、决定和背景信息，但不要把它当作跨会话长期记忆。输出必须直接开始摘要内容：\n\n'
        + toSummarize.map(m => `${m.role}: ${getMessageTextForContext(m)}`).join('\n');

    try {
        const targetUrl = buildChatCompletionsUrl(modelCfg.url, { appendV1ForLocal: false });
        // 调用时校验出站地址（含 DNS 解析），与其它模型出站点一致，阻断 SSRF / DNS rebinding
        const response = await forwardChatCompletion({
            modelCfg,
            user: options.user || null,
            url: targetUrl,
            headers: buildModelHeaders(modelCfg, { acceptJson: true }),
            data: {
                model: modelCfg.model_name,
                messages: [
                    { role: 'system', content: 'Compress the long conversation history into concise key memory fragments.' },
                    { role: 'user', content: summaryPrompt }
                ],
                stream: false
            },
            signal: options.signal,
            timeout: MEMORY_COMPRESSION_TIMEOUT_MS
        });
        const summaryText = `【短期会话记忆摘要】： ${response.data.choices[0].message.content}`;
        const now = getBeijingTimestamp();
        const transaction = db.transaction(() => {
            const ids = toSummarize.map(m => m.id);
            if (ids.length > 0) {
                const placeholders = ids.map(() => '?').join(',');
                db.prepare(`UPDATE messages SET context_archived = 1, compressed_at = ? WHERE id IN (${placeholders})`).run(now, ...ids);
            }
            db.prepare(`
                INSERT INTO messages (session_id, user_id, role, content, token_count, is_summary, context_archived, model_id, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            `).run(sessionId, userId, 'system', summaryText, estimateTokens(summaryText), 1, 0, modelCfg.id, now);
        });
        transaction();
        return { compressed: true, summarizedCount: toSummarize.length, summaryTokens: estimateTokens(summaryText) };
    } catch (e) {
        const { logger } = require('./logger');
        logger.error({ err: e.message }, '记忆压缩失败');
        throw e;
    }
}

module.exports = {
    buildContextMeta,
    compactSessionMemory,
    estimateTokens,
    getContext,
    getMemoryThreshold,
    createVisibleReasoningStreamFilter,
    syncMemoryCompressionConcurrency,
    stripThoughtContent,
    stripVisibleReasoningScaffold,
    THRESHOLD
};
