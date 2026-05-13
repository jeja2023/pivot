function isLocalDevUrl(url) {
    const text = String(url || '').toLowerCase();
    return text.includes('localhost') || text.includes('127.0.0.1');
}

function normalizeModelBaseUrl(url, options = {}) {
    const { appendV1 = true, appendV1ForLocal = true } = options;
    let baseUrl = String(url || '').trim().replace(/\/+$/, '').replace(/\/chat\/completions$/, '');
    if (appendV1 && !baseUrl.includes('/v1') && (appendV1ForLocal || !isLocalDevUrl(baseUrl))) {
        baseUrl += '/v1';
    }
    return baseUrl;
}

function buildChatCompletionsUrl(url, options = {}) {
    const baseUrl = normalizeModelBaseUrl(url, options).replace(/\/+$/, '');
    return baseUrl.endsWith('/chat/completions') ? baseUrl : `${baseUrl}/chat/completions`;
}

function buildResponsesUrl(url, options = {}) {
    return `${normalizeModelBaseUrl(url, options).replace(/\/chat\/completions$/, '').replace(/\/+$/, '')}/responses`;
}

function shouldUseResponsesApi(modelName) {
    const name = String(modelName || '');
    return name.includes('gpt-5') || name.includes('o1') || name.includes('o3') || name.includes('o4');
}

function buildModelHeaders(modelCfg, options = {}) {
    const headers = {
        'Authorization': modelCfg?.api_key ? `Bearer ${modelCfg.api_key}` : undefined,
        'x-api-key': modelCfg?.api_key || undefined,
        'Content-Type': 'application/json',
        'User-Agent': 'Pivot-AI-Client/1.0'
    };
    if (options.acceptJson) headers.Accept = 'application/json';
    return headers;
}

function convertChatMessagesToResponsesInput(messages = []) {
    return messages.map(message => {
        let role = message.role;
        let content = message.content;

        if (role === 'system') {
            role = 'user';
            if (typeof content === 'string') {
                content = `[系统设定]: ${content}`;
            }
        }

        if (Array.isArray(content)) {
            content = content.map(part => {
                if (part?.type === 'image_url' && part.image_url?.url) {
                    return {
                        type: 'input_image',
                        image_url: part.image_url.url
                    };
                }
                return part;
            });
        }

        return { role, content };
    });
}

module.exports = {
    buildChatCompletionsUrl,
    buildModelHeaders,
    buildResponsesUrl,
    convertChatMessagesToResponsesInput,
    isLocalDevUrl,
    normalizeModelBaseUrl,
    shouldUseResponsesApi
};
