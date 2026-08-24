const test = require('node:test');
const assert = require('node:assert/strict');
const {
    normalizeChatError,
    buildPersistedChatErrorContent
} = require('../server/services/chat-errors');

test('normalizeChatError 能够识别 vLLM/llama.cpp 的 exceed_context_size_error 并在详情中提取精确数字和友好中文建议', () => {
    const rawError = JSON.stringify({
        error: {
            code: 400,
            message: 'request (132085 tokens) exceeds the available context size (131072 tokens), try increasing it',
            type: 'exceed_context_size_error',
            n_prompt_tokens: 132085,
            n_ctx: 131072
        }
    });

    const normalized = normalizeChatError({
        error: '模型响应异常',
        detail: rawError,
        statusCode: 400
    });

    assert.equal(normalized.title, '对话上下文超出模型限制');
    assert.equal(normalized.code, 'CONTEXT_LENGTH_EXCEEDED');
    assert.equal(normalized.statusCode, 400);
    assert.match(normalized.detailText, /132,085/);
    assert.match(normalized.detailText, /131,072/);
    assert.match(normalized.detailText, /开启新会话/);

    const persistedContent = buildPersistedChatErrorContent({
        error: '模型响应异常',
        detail: rawError,
        statusCode: 400
    });
    assert.match(persistedContent, /生成失败：对话上下文超出模型限制/);
    assert.match(persistedContent, /错误代码：CONTEXT_LENGTH_EXCEEDED/);
    assert.match(persistedContent, /HTTP 状态：400/);
    assert.match(persistedContent, /132,085/);
});

test('normalizeChatError 能够识别 OpenAI 风格的 context_length_exceeded 错误', () => {
    const rawError = JSON.stringify({
        error: {
            message: "This model's maximum context length is 128000 tokens. However, your messages resulted in 130000 tokens.",
            type: 'invalid_request_error',
            param: 'messages',
            code: 'context_length_exceeded'
        }
    });

    const normalized = normalizeChatError({
        error: '模型响应异常',
        detail: rawError,
        statusCode: 400
    });

    assert.equal(normalized.title, '对话上下文超出模型限制');
    assert.equal(normalized.code, 'CONTEXT_LENGTH_EXCEEDED');
    assert.match(normalized.detailText, /130,000/);
    assert.match(normalized.detailText, /128,000/);
});

test('normalizeChatError 能够识别 401 API Key 错误', () => {
    const rawError = JSON.stringify({
        error: {
            message: 'Incorrect API key provided: sk-xxxx...',
            type: 'invalid_request_error',
            code: 'invalid_api_key'
        }
    });

    const normalized = normalizeChatError({
        error: '模型响应异常',
        detail: rawError,
        statusCode: 401
    });

    assert.equal(normalized.title, 'API Key 无效或未授权');
    assert.equal(normalized.code, 'INVALID_API_KEY');
    assert.match(normalized.detailText, /模型管理/);
});

test('normalizeChatError 能够识别 429 余额不足或额度耗尽错误', () => {
    const rawError = JSON.stringify({
        error: {
            message: 'You exceeded your current quota, please check your plan and billing details.',
            type: 'insufficient_quota',
            code: 'insufficient_quota'
        }
    });

    const normalized = normalizeChatError({
        error: '模型响应异常',
        detail: rawError,
        statusCode: 429
    });

    assert.equal(normalized.title, '模型服务余额不足或额度耗尽');
    assert.equal(normalized.code, 'INSUFFICIENT_QUOTA');
});

test('normalizeChatError 能够识别 ECONNREFUSED 网络连接失败', () => {
    const normalized = normalizeChatError({
        error: 'connect ECONNREFUSED 127.0.0.1:11434',
        detail: 'connect ECONNREFUSED 127.0.0.1:11434'
    });

    assert.equal(normalized.title, '无法连接到模型服务');
    assert.equal(normalized.code, 'UPSTREAM_UNAVAILABLE');
    assert.match(normalized.detailText, /Ollama/);
});

test('normalizeChatError 对未匹配的普通错误保留原有 title 和 detail', () => {
    const normalized = normalizeChatError({
        error: '模型响应异常',
        detail: 'upstream exploded',
        statusCode: 500
    });

    assert.equal(normalized.title, '模型响应异常');
    assert.equal(normalized.detailText, 'upstream exploded');
    assert.equal(normalized.statusCode, 500);
});
