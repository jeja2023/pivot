const axios = require('axios');
const fs = require('fs');
const { db } = require('./db');
const { getBeijingTimestamp } = require('./time');
const { extractDocumentText, truncateExtractedText } = require('./document-text');
const { imageFileToDataUrl, MAX_IMAGES_PER_MESSAGE } = require('./image-safety');
const { resolveUploadUrlPath, toProjectRelativePath } = require('./security');

const THRESHOLD = parseInt(process.env.MEMORY_THRESHOLD, 10) || 12000;
const SUMMARY_KEEP_COUNT = 6;
const MIN_MESSAGES_TO_COMPRESS = 4;

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
    const summaryMessages = messages.filter(m => Number(m.is_summary));
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
    const imgRegex = /!\[.*?\]\((\/uploads\/[^)\s]+)\)/g;
    const fileRegex = /\[附件:\s*([^\]]+)\]\((\/uploads\/[^)\s]+)\)/g;
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
    const messages = db.prepare(`
        SELECT * FROM messages
        WHERE session_id = ? AND user_id = ?
          AND deleted_at IS NULL
        ORDER BY id ASC
    `).all(sessionId, userId);

    const { logger } = require('./logger');
    const contextMeta = buildContextMeta(messages);
    logger.info({ sessionId, messageCount: messages.length, contextMeta }, '检索会话历史');

    if (contextMeta.activeTokens > THRESHOLD && contextMeta.activeCount > SUMMARY_KEEP_COUNT + MIN_MESSAGES_TO_COMPRESS) {
        compressMemory(sessionId, userId, messages, modelCfg).catch(err => {
            logger.error({ sessionId, err: err.message }, '异步记忆压缩失败');
        });
    }

    const totalImageCounter = { count: 0 };
    const contextMessages = messages.filter(m => Number(m.is_summary) || !Number(m.context_archived));
    const history = await Promise.all(contextMessages.map(async m => ({
        role: m.role,
        content: await hydrateMessageContent(m, userId, sessionId, totalImageCounter, logger)
    })));

    if (session && session.system_prompt) {
        history.unshift({ role: 'system', content: session.system_prompt });
    }

    return history;
}

async function compressMemory(sessionId, userId, messages, modelCfg) {
    const activeMessages = messages.filter(m => !Number(m.context_archived) && !Number(m.is_summary));
    const toSummarize = activeMessages.slice(0, -SUMMARY_KEEP_COUNT);
    if (toSummarize.length < MIN_MESSAGES_TO_COMPRESS) return;

    const summaryPrompt = '你是一个记忆压缩专家。请将以下对话内容提炼为一段极简的摘要（300字以内），保留所有关键事实、决定和背景信息。输出必须直接开始摘要内容：\n\n'
        + toSummarize.map(m => `${m.role}: ${m.content}`).join('\n');

    try {
        const response = await axios.post(modelCfg.url, {
            model: modelCfg.model_name,
            messages: [
                { role: 'system', content: '你负责将冗长的对话历史压缩为关键记忆片段。' },
                { role: 'user', content: summaryPrompt }
            ],
            stream: false
        }, {
            headers: { 'Authorization': modelCfg.api_key ? `Bearer ${modelCfg.api_key}` : undefined }
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
    } catch (e) {
        const { logger } = require('./logger');
        logger.error({ err: e.message }, '记忆压缩失败');
    }
}

module.exports = { estimateTokens, getContext, THRESHOLD, buildContextMeta };
