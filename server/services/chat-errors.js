const { estimateTokens } = require('../llm');
const { saveAssistantMessage, touchSession } = require('./chat-messages');

function compactText(value, maxLength = 12000) {
    const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
    if (!text) return '';
    return text.length > maxLength ? `${text.slice(0, maxLength)}\n...内容已截断...` : text;
}

function parseErrorObject(detail) {
    if (!detail) return null;
    if (typeof detail === 'object') return detail;
    if (typeof detail === 'string') {
        const trimmed = detail.trim();
        if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
            try {
                return JSON.parse(trimmed);
            } catch (_) {
                return null;
            }
        }
    }
    return null;
}

function formatTokens(num) {
    const parsed = Number(num);
    return Number.isFinite(parsed) ? parsed.toLocaleString() : String(num);
}

function normalizeChatError({ error, detail, statusCode, code } = {}) {
    let title = String(error || '模型响应异常').trim();
    let detailText = typeof detail === 'string' ? detail.trim() : (detail ? JSON.stringify(detail) : '');
    let finalCode = code || '';
    let finalStatusCode = statusCode;

    const parsedObj = parseErrorObject(detail);
    const rawErrorObj = parsedObj?.error && typeof parsedObj.error === 'object' ? parsedObj.error : parsedObj;

    const candidateMessages = [
        rawErrorObj?.message,
        typeof rawErrorObj === 'string' ? rawErrorObj : null,
        parsedObj?.message,
        parsedObj?.detail,
        detailText,
        error
    ].filter(Boolean).map(String);
    const combinedText = candidateMessages.join(' ');
    const errorType = String(rawErrorObj?.type || parsedObj?.type || '');
    const errorCode = String(rawErrorObj?.code || parsedObj?.code || '');

    // 1. 上下文超限检测 (Context Size / Window / Tokens Exceeded)
    const isContextExceeded =
        errorType === 'exceed_context_size_error' ||
        errorCode === 'context_length_exceeded' ||
        finalCode === 'CONTEXT_LENGTH_EXCEEDED' ||
        /exceeds? (?:the )?available context size/i.test(combinedText) ||
        /context_length_exceeded/i.test(combinedText) ||
        /maximum context length/i.test(combinedText) ||
        /context window is \d+/i.test(combinedText) ||
        /exceed_context_size_error/i.test(combinedText) ||
        /prompt.*(?:too long|exceeds?.*limit)/i.test(combinedText);

    if (isContextExceeded) {
        title = '对话上下文超出模型限制';
        finalCode = 'CONTEXT_LENGTH_EXCEEDED';

        let promptTokens = rawErrorObj?.n_prompt_tokens ?? parsedObj?.n_prompt_tokens;
        let ctxTokens = rawErrorObj?.n_ctx ?? parsedObj?.n_ctx;

        if (!promptTokens || !ctxTokens) {
            const match1 = combinedText.match(/request \((\d+) tokens?\).*?context size \((\d+) tokens?\)/i);
            if (match1) {
                promptTokens = match1[1];
                ctxTokens = match1[2];
            }
        }
        if (!promptTokens || !ctxTokens) {
            const match2 = combinedText.match(/maximum context length is (\d+) tokens.*?(?:resulted in|prompt had|have) (\d+) tokens/i);
            if (match2) {
                ctxTokens = match2[1];
                promptTokens = match2[2];
            }
        }
        if (!promptTokens || !ctxTokens) {
            const match3 = combinedText.match(/context window is (\d+).*?prompt had (\d+) tokens/i);
            if (match3) {
                ctxTokens = match3[1];
                promptTokens = match3[2];
            }
        }

        if (promptTokens && ctxTokens) {
            detailText = `当前请求的总 Token 数（约 ${formatTokens(promptTokens)}）超出了模型支持的最大上下文窗口（${formatTokens(ctxTokens)}）。\n\n💡 建议解决方案：\n1. 点击左侧开启新会话，避免长历史对话累积；\n2. 缩短当前提问或减少单次上传的参考文档内容；\n3. 如果是私有部署模型，可在【模型管理】或模型服务参数中调大 Context Size（上下文窗口大小）。`;
        } else {
            detailText = `当前请求的输入内容超出了模型支持的最大上下文长度。\n\n💡 建议解决方案：\n1. 点击左侧开启新会话，避免长历史对话累积；\n2. 缩短当前提问或减少单次上传的参考文档内容；\n3. 如果是私有部署模型，可在【模型管理】或模型服务参数中调大 Context Size（上下文窗口大小）。`;
        }

        return {
            title,
            detailText,
            statusCode: finalStatusCode,
            code: finalCode
        };
    }

    // 2. API Key / 未授权检测 (401 / invalid_api_key)
    if (finalStatusCode === 401 || /invalid_api_key|incorrect api key|unauthorized|invalid authentication/i.test(combinedText)) {
        title = 'API Key 无效或未授权';
        finalCode = finalCode || 'INVALID_API_KEY';
        detailText = '模型服务的 API Key 校验失败、已过期或未配置正确的调用权限。\n\n💡 建议解决方案：请在【模型管理】中检查并更新该模型的 API Key 与权限。';
        return { title, detailText, statusCode: finalStatusCode, code: finalCode };
    }

    // 3. 余额不足 / 额度耗尽检测 (402 / 429 insufficient_quota)
    if (finalStatusCode === 402 || /insufficient_quota|quota_exceeded|exceeded your current quota|credit balance/i.test(combinedText)) {
        title = '模型服务余额不足或额度耗尽';
        finalCode = finalCode || 'INSUFFICIENT_QUOTA';
        detailText = '上游模型服务账户余额不足或已超出当前套餐用量限额。\n\n💡 建议解决方案：请前往模型供应商控制台检查账户额度或进行充值。';
        return { title, detailText, statusCode: finalStatusCode, code: finalCode };
    }

    // 4. 上游限流检测 (429 rate_limit_exceeded / TPM / RPM)
    if (finalStatusCode === 429 && /rate_limit|too many requests|rate limit reached|tpm|rpm/i.test(combinedText)) {
        title = '模型服务请求过于频繁（触发限流）';
        finalCode = finalCode || 'RATE_LIMIT_EXCEEDED';
        detailText = '当前请求触发了上游模型服务商的并发或调用频率限制（RPM/TPM）。\n\n💡 建议解决方案：请稍候片刻后重试，或在模型管理中配置备用模型。';
        return { title, detailText, statusCode: finalStatusCode, code: finalCode };
    }

    // 5. 模型不存在 / 模型名称有误 (404 model_not_found)
    if (finalStatusCode === 404 && /model_not_found|does not exist|model not found/i.test(combinedText)) {
        title = '模型不存在或名称配置有误';
        finalCode = finalCode || 'MODEL_NOT_FOUND';
        detailText = '上游模型服务未找到指定的模型。\n\n💡 建议解决方案：请在【模型管理】中核对该模型的【模型名称（Model Name）】是否与服务商要求完全一致。';
        return { title, detailText, statusCode: finalStatusCode, code: finalCode };
    }

    // 6. 网络连接失败 (ECONNREFUSED / ETIMEDOUT / ENOTFOUND)
    if (/ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EHOSTUNREACH/i.test(combinedText)) {
        title = '无法连接到模型服务';
        finalCode = finalCode || 'UPSTREAM_UNAVAILABLE';
        detailText = '无法建立与上游模型服务的网络连接（连接超时或服务未启动）。\n\n💡 建议解决方案：请检查模型服务地址是否可达、本地 Ollama / vLLM 进程是否正常运行。';
        return { title, detailText, statusCode: finalStatusCode, code: finalCode };
    }

    return {
        title,
        detailText: compactText(detailText, 4000),
        statusCode: finalStatusCode,
        code: finalCode
    };
}

function buildPersistedChatErrorContent({ error, detail, statusCode, code } = {}) {
    const normalized = normalizeChatError({ error, detail, statusCode, code });
    const lines = [`生成失败：${normalized.title}`];

    if (normalized.code) lines.push(`错误代码：${normalized.code}`);
    if (normalized.statusCode) lines.push(`HTTP 状态：${normalized.statusCode}`);
    if (normalized.detailText && normalized.detailText !== normalized.title) {
        lines.push('', '错误详情：', normalized.detailText);
    }
    return lines.join('\n');
}

async function persistAssistantErrorMessage({ sessionId, userId, modelId, error, detail, statusCode, code, log }) {
    if (!sessionId || !userId) return null;
    const content = buildPersistedChatErrorContent({ error, detail, statusCode, code });
    const tokenCount = estimateTokens(content);
    try {
        const result = await saveAssistantMessage({
            sessionId,
            userId,
            content,
            tokenCount,
            modelId
        });
        await touchSession(sessionId);
        return { content, messageId: result.lastInsertRowid, tokenCount };
    } catch (err) {
        log?.error?.({ sessionId, err: err.message }, '保存模型错误消息失败');
        return null;
    }
}

async function writeChatErrorSse({
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
    const normalized = normalizeChatError({ error, detail, statusCode, code });
    const payload = {
        error: normalized.title,
        detail: normalized.detailText,
        statusCode: normalized.statusCode,
        code: normalized.code
    };
    if (retryable !== undefined) payload.retryable = retryable;
    if (persist) {
        const saved = await persistAssistantErrorMessage({
            sessionId,
            userId,
            modelId,
            error: normalized.title,
            detail: normalized.detailText,
            statusCode: normalized.statusCode,
            code: normalized.code,
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
    normalizeChatError,
    readStreamErrorDetail,
    writeChatErrorSse
};
