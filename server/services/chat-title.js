const { db } = require('../db');
const { logger } = require('../logger');
const {
    buildChatCompletionsUrl,
    buildModelHeaders
} = require('./model-adapter');
const { countVisibleConversationMessages } = require('./chat-messages');
const { forwardChatCompletion } = require('./model-forwarder');

function normalizeTitleText(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
}

function stripTitleSourceText(value) {
    return String(value || '')
        .replace(/<thought>[\s\S]*?<\/thought>/gi, ' ')
        .replace(/\n{0,2}---\n【参考文档[^\n]*】\n[\s\S]*?\n---/g, ' ')
        .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1 图片')
        .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
        .replace(/https?:\/\/\S+/g, ' ')
        .replace(/[`*_#>|~]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function truncateTitle(value, maxLength = 24) {
    const chars = Array.from(normalizeTitleText(value));
    return chars.length > maxLength ? chars.slice(0, maxLength).join('') : chars.join('');
}

function buildFallbackTitle(userMsg, aiMsg = '') {
    const userText = stripTitleSourceText(userMsg);
    if (userText) return truncateTitle(userText);

    const aiText = stripTitleSourceText(aiMsg);
    if (aiText) return truncateTitle(aiText);

    return '新对话';
}

function sanitizeGeneratedTitle(value, fallbackTitle) {
    let title = normalizeTitleText(value)
        .replace(/^#+\s*/, '')
        .replace(/^(会话)?标题\s*[:：]\s*/i, '')
        .replace(/^["'“”‘’《》【】「」\[\]\s]+|["'“”‘’《》【】「」\[\]\s]+$/g, '')
        .replace(/[。?!？！；;:：，,\s]+$/g, '')
        .replace(/^["'“”‘’《》【】「」\[\]\s]+|["'“”‘’《》【】「」\[\]\s]+$/g, '');

    title = title.split(/\n/)[0] || '';
    title = truncateTitle(title);

    if (!title || /^新对话/i.test(title) || /^untitled$/i.test(title)) {
        return fallbackTitle;
    }
    return title;
}

function buildInitialAutoTitles(userMsg) {
    const raw = String(userMsg || '').trim();
    const cleaned = stripTitleSourceText(userMsg);
    return new Set([
        '新对话',
        raw ? raw.slice(0, 15) + '...' : '',
        cleaned ? cleaned.slice(0, 15) + '...' : ''
    ].filter(Boolean).map(normalizeTitleText));
}

function shouldReplaceAutoTitle(currentTitle, userMsg) {
    const normalized = normalizeTitleText(currentTitle);
    if (!normalized) return true;
    return buildInitialAutoTitles(userMsg).has(normalized);
}

async function generateTitle(sessionId, userId, userMsg, aiMsg, modelCfg, user = null) {
    const fallbackTitle = buildFallbackTitle(userMsg, aiMsg);
    let newTitle = fallbackTitle;

    try {
        logger.info({ sessionId }, '正在生成会话标题');
        const targetUrl = buildChatCompletionsUrl(modelCfg.url, { appendV1ForLocal: false });
        const response = await forwardChatCompletion({
            modelCfg,
            user,
            url: targetUrl,
            headers: buildModelHeaders(modelCfg),
            data: {
                model: modelCfg.model_name,
                messages: [
                    {
                        role: 'user',
                        content: [
                            'Generate a short, natural Chinese title for the dialogue below.',
                            'Requirements: 4-12 Chinese characters, no quotes, no explanation, and no generic titles like new chat or chat log.',
                            '',
                            `User: ${stripTitleSourceText(userMsg).slice(0, 600)}`,
                            `Assistant: ${stripTitleSourceText(aiMsg).slice(0, 600)}`
                        ].join('\n')
                    }
                ],
                max_tokens: 32,
                temperature: 0.2
            },
            timeout: 60000
        });
        newTitle = sanitizeGeneratedTitle(response.data.choices[0]?.message?.content, fallbackTitle);
    } catch (e) {
        logger.warn({ sessionId, err: e.message, fallbackTitle }, '会话标题生成失败，已使用本地兜底标题');
    }

    const session = db.prepare('SELECT title FROM sessions WHERE id = ? AND user_id = ? AND deleted_at IS NULL').get(sessionId, userId);
    if (!session) return;

    if (!shouldReplaceAutoTitle(session.title, userMsg)) {
        logger.info({ sessionId, currentTitle: session.title }, '跳过标题更新：当前标题疑似已被用户修改');
        return;
    }

    db.prepare('UPDATE sessions SET title = ? WHERE id = ? AND user_id = ?').run(newTitle, sessionId, userId);
    logger.info({ sessionId, newTitle }, '会话标题已更新');
}

function maybeGenerateTitle(sessionId, userId, userMsg, assistantContent, modelCfg, user = null) {
    const msgCount = countVisibleConversationMessages(sessionId, userId);
    if (msgCount <= 2) {
        generateTitle(sessionId, userId, userMsg, assistantContent, modelCfg, user);
    }
}

module.exports = {
    buildFallbackTitle,
    generateTitle,
    maybeGenerateTitle,
    sanitizeGeneratedTitle,
    shouldReplaceAutoTitle,
    stripTitleSourceText,
    truncateTitle
};
