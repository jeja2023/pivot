const { estimateTokens } = require('../llm');
const { saveAssistantMessage, touchSession } = require('./chat-messages');

function compactText(value, maxLength = 12000) {
    const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
    if (!text) return '';
    return text.length > maxLength ? `${text.slice(0, maxLength)}\n...内容已截断...` : text;
}

function buildPersistedChatErrorContent({ error, detail, statusCode, code } = {}) {
    const title = String(error || '模型响应异常').trim();
    const detailText = compactText(String(detail || '').trim(), 4000);
    const lines = [`生成失败：${title}`];

    if (code) lines.push(`错误代码：${code}`);
    if (statusCode) lines.push(`HTTP 状态：${statusCode}`);
    if (detailText && detailText !== title) {
        lines.push('', '错误详情：', detailText);
    }
    return lines.join('\n');
}

function persistAssistantErrorMessage({ sessionId, userId, modelId, error, detail, statusCode, code, log }) {
    if (!sessionId || !userId) return null;
    const content = buildPersistedChatErrorContent({ error, detail, statusCode, code });
    const tokenCount = estimateTokens(content);
    try {
        const result = saveAssistantMessage({
            sessionId,
            userId,
            content,
            tokenCount,
            modelId
        });
        touchSession(sessionId);
        return { content, messageId: result.lastInsertRowid, tokenCount };
    } catch (err) {
        log?.error?.({ sessionId, err: err.message }, '保存模型错误消息失败');
        return null;
    }
}

function writeChatErrorSse({
    writeSse,
    sessionId,
    userId,
    modelId,
    error,
    detail,
    statusCode,
    code,
    retryable,
    persist,
    log
}) {
    const payload = { error, detail, statusCode, code };
    if (retryable !== undefined) payload.retryable = retryable;
    if (persist) {
        const saved = persistAssistantErrorMessage({
            sessionId,
            userId,
            modelId,
            error,
            detail,
            statusCode,
            code,
            log
        });
        if (saved) {
            payload.type = 'assistant_error';
            payload.content = saved.content;
            payload.messageId = saved.messageId;
            payload.tokenCount = saved.tokenCount;
        }
    }
    writeSse(JSON.stringify(payload));
}

function readStreamErrorDetail(stream, { maxLength = 4000, timeoutMs = 1000 } = {}) {
    if (!stream || typeof stream.on !== 'function') return Promise.resolve('');
    return new Promise(resolve => {
        let settled = false;
        let text = '';
        const cleanup = () => {
            stream.off?.('data', onData);
            stream.off?.('end', onEnd);
            stream.off?.('error', onError);
            clearTimeout(timer);
        };
        const finish = () => {
            if (settled) return;
            settled = true;
            cleanup();
            resolve(text.trim());
        };
        const onData = chunk => {
            text += chunk?.toString?.('utf8') || String(chunk || '');
            if (text.length >= maxLength) {
                text = `${text.slice(0, maxLength)}\n...内容已截断...`;
                stream.destroy?.();
                finish();
            }
        };
        const onEnd = () => finish();
        const onError = err => {
            if (!text) text = err?.message || '';
            finish();
        };
        const timer = setTimeout(finish, timeoutMs);
        stream.on('data', onData);
        stream.on('end', onEnd);
        stream.on('error', onError);
    });
}

module.exports = {
    buildPersistedChatErrorContent,
    readStreamErrorDetail,
    writeChatErrorSse
};
