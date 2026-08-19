const axios = require('axios');
const { assertJsonOnlyPayload } = require('./safe-http-client');
const {
    assertSafeModelRuntimeUrl,
    createSafeModelHttpAgents
} = require('./model-adapter');

// 模型补全转发的默认超时（毫秒）。聊天链路对常规补全使用更长超时，按需在调用处覆盖。
const DEFAULT_FORWARD_TIMEOUT_MS = 180000;

// 统一的上游模型补全转发：先做 SSRF/出网主机安全校验，再用受限 HTTP agent 发起 axios POST。
// 聊天（/api/chat）、OpenAI 兼容（/v1/chat/completions）与应用中心（公文写作）三处共用，
// 确保安全校验不会被遗漏、超时与禁用系统代理（proxy:false）等出站口径保持一致。
// 仅负责“发起请求并返回 axios 响应”；URL 构建、payload 组装、流式/非流式的响应消费由调用方处理。
async function forwardChatCompletion({
    modelCfg,
    user = null,
    url,
    data,
    headers,
    stream = false,
    timeout = DEFAULT_FORWARD_TIMEOUT_MS,
    signal = null
} = {}) {
    if (!modelCfg) throw new Error('模型转发失败：缺少必需的 modelCfg 配置');
    if (!url) throw new Error('模型转发失败：缺少必需的 url 地址');
    await assertSafeModelRuntimeUrl(modelCfg, url, user);
    assertJsonOnlyPayload(data);
    const agents = createSafeModelHttpAgents(modelCfg, user);
    return axios.post(url, data, {
        headers,
        responseType: stream ? 'stream' : 'json',
        timeout,
        proxy: false,
        signal,
        ...agents
    });
}

module.exports = { forwardChatCompletion, DEFAULT_FORWARD_TIMEOUT_MS };
