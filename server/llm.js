const axios = require('axios');
const fs = require('fs');
const { db } = require('./db');
const { getBeijingTimestamp } = require('./time');
const { extractDocumentText, truncateExtractedText } = require('./document-text');
const { imageFileToDataUrl, MAX_IMAGES_PER_MESSAGE } = require('./image-safety');
const { resolveUploadUrlPath, toProjectRelativePath } = require('./security');
const { withTimeout, KeyedConcurrencyGuard } = require('./services/concurrency');
const {
    buildChatCompletionsUrl,
    buildModelHeaders
} = require('./services/model-adapter');

const THRESHOLD = parseInt(process.env.MEMORY_THRESHOLD, 10) || 12000;
const SUMMARY_KEEP_COUNT = Math.max(1, parseInt(process.env.MEMORY_SUMMARY_KEEP_COUNT, 10) || 6);
const MIN_MESSAGES_TO_COMPRESS = Math.max(1, parseInt(process.env.MEMORY_MIN_MESSAGES_TO_COMPRESS, 10) || 1);
const MEMORY_COMPRESSION_TIMEOUT_MS = Math.max(15000, parseInt(process.env.MEMORY_COMPRESSION_TIMEOUT_MS, 10) || 180000);
// 同会话同时只触发一次后台压缩，全局并发上限可在环境变量调整
const memoryCompressionGuard = new KeyedConcurrencyGuard({
    maxConcurrent: Math.max(1, parseInt(process.env.MEMORY_COMPRESSION_MAX_CONCURRENT, 10) || 2)
});

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
    const activeTokens = activeMessages.reduce((sum, m) => sum + Number(m.token_count || 0), 0);
    const summaryTokens = summaryMessages.reduce((sum, m) => sum + Number(m.token_count || 0), 0);
    const ratio = THRESHOLD > 0 ? activeTokens / THRESHOLD : 0;

    return {
        threshold: THRESHOLD,
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
        if (imageCount >= MAX_IMAGES_PER_MESSAGE) {
            finalContent.push({ type: 'text', text: '[图片已跳过：数量超过限制]' });
            lastIndex = imgRegex.lastIndex;
            continue;
        }

        const localPath = resolveOwnedAttachmentPath(match[1], userId, sessionId);
        if (localPath) {
            const imageUrl = imageFileToDataUrl(localPath);
            if (imageUrl && totalImageCounter.count < MAX_IMAGES_PER_MESSAGE) {
                finalContent.push({ type: 'image_url', image_url: { url: imageUrl } });
                imageCount += 1;
                totalImageCounter.count += 1;
            } else {
                finalContent.push({
                    type: 'text',
                    text: totalImageCounter.count >= MAX_IMAGES_PER_MESSAGE
                        ? '[图片已跳过：当前模型一次只支持解析 1 张图片]'
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
                    const text = truncateExtractedText(await extractDocumentText(localPath, '', fileName), 20000);
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
        return finalContent[0].text;
    }
    return finalContent.length > 0 ? finalContent : content;
}

async function getContext(sessionId, userId, modelCfg) {
    const session = db.prepare('SELECT system_prompt FROM sessions WHERE id = ? AND deleted_at IS NULL').get(sessionId);
    let messages = loadSessionMessages(sessionId, userId);

    const { logger } = require('./logger');
    let contextMeta = buildContextMeta(messages);
    logger.info({ sessionId, messageCount: messages.length, contextMeta }, '检索会话历史');

    if (contextMeta.activeTokens > THRESHOLD && contextMeta.activeCount > MIN_MESSAGES_TO_COMPRESS) {
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
    const history = await Promise.all(contextMessages.map(async m => ({
        role: m.role,
        content: await hydrateMessageContent(m, userId, sessionId, totalImageCounter, logger)
    })));

    if (session && session.system_prompt) {
        history.unshift({ role: 'system', content: session.system_prompt });
    }

    return history;
}

async function compactSessionMemory(sessionId, userId, modelCfg, options = {}) {
    const messages = loadSessionMessages(sessionId, userId);
    const before = buildContextMeta(messages);
    if (!options.force && (before.activeTokens <= THRESHOLD || before.activeCount <= MIN_MESSAGES_TO_COMPRESS)) {
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

    const summaryPrompt = '你是一个记忆压缩专家。请将以下对话内容提炼为一段极简的摘要（300字以内），保留所有关键事实、决定和背景信息。输出必须直接开始摘要内容：\n\n'
        + toSummarize.map(m => `${m.role}: ${m.content}`).join('\n');

    try {
        const response = await axios.post(buildChatCompletionsUrl(modelCfg.url, { appendV1ForLocal: false }), {
            model: modelCfg.model_name,
            messages: [
                { role: 'system', content: '你负责将冗长的对话历史压缩为关键记忆片段。' },
                { role: 'user', content: summaryPrompt }
            ],
            stream: false
        }, {
            headers: buildModelHeaders(modelCfg, { acceptJson: true }),
            signal: options.signal,
            timeout: MEMORY_COMPRESSION_TIMEOUT_MS,
            proxy: false
        });

        const summaryText = `【长期记忆摘要】： ${response.data.choices[0].message.content}`;
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

module.exports = { compactSessionMemory, estimateTokens, getContext, THRESHOLD, buildContextMeta };
