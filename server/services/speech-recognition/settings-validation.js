'use strict';

const { providerRequestOptions } = require('./provider');
const { speechError } = require('./audio');

const invalid = message => speechError(message, 'VOICE_SETTINGS_INVALID', 400);
const PROVIDERS = new Set(['embedded', 'local', 'gateway', 'openai', 'qwen']);
const LIMITS = { maxConcurrent: [1, 32, true], timeoutMs: [3000, 60000, true], endSilenceMs: [500, 2000, true],
    minConfidence: [0, 1, false], cpuThreads: [1, 16, true] };
const TEXT_LIMITS = { endpoint: 2048, streamEndpoint: 2048, model: 200, hotwords: 4100, apiKey: 4096 };

async function validateSpeechSettings(patch, previous, { checkEndpoint = providerRequestOptions } = {}) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw invalid('语音配置必须是对象。');
    const values = Object.fromEntries(Object.entries(previous).filter(([key]) => !['revision', 'source'].includes(key)));
    const allowed = new Set(['revision', 'clearApiKey', 'provider', 'enabled', 'allowExternal', ...Object.keys(LIMITS), ...Object.keys(TEXT_LIMITS)]);
    if (Object.keys(patch).some(key => !allowed.has(key))) throw invalid('语音配置包含不支持的字段。');
    for (const name of ['enabled', 'allowExternal', 'clearApiKey']) {
        if (Object.hasOwn(patch, name) && typeof patch[name] !== 'boolean') throw invalid('语音开关必须为布尔值。');
        if (name !== 'clearApiKey' && Object.hasOwn(patch, name)) values[name] = patch[name];
    }
    if (Object.hasOwn(patch, 'provider')) {
        if (!PROVIDERS.has(patch.provider)) throw invalid('请选择有效的语音识别方式。');
        values.provider = patch.provider;
    }
    for (const [name, limit] of Object.entries(TEXT_LIMITS)) {
        if (!Object.hasOwn(patch, name)) continue;
        if (typeof patch[name] !== 'string' || patch[name].length > limit || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(patch[name]) || name !== 'hotwords' && /[\r\n\t]/.test(patch[name])) throw invalid('语音文本配置过长或包含无效字符。');
        if (name !== 'apiKey') values[name] = patch[name].trim();
    }
    for (const [name, [min, max, integer]] of Object.entries(LIMITS)) {
        if (!Object.hasOwn(patch, name)) continue;
        const value = patch[name];
        if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || integer && !Number.isInteger(value)) throw invalid('语音数值配置超出允许范围。');
        values[name] = value;
    }
    if (patch.clearApiKey && patch.apiKey?.trim()) throw invalid('不能同时填写新密钥和清除密钥。');
    if (patch.clearApiKey) values.apiKey = '';
    else if (patch.apiKey?.trim()) values.apiKey = patch.apiKey.trim();
    else if (previous.apiKey && (values.endpoint !== previous.endpoint || values.streamEndpoint !== previous.streamEndpoint || values.provider !== previous.provider && !['embedded', 'local'].includes(values.provider))) throw invalid('切换语音服务地址或协议时，请填写新密钥或显式清除原密钥。');
    const words = values.hotwords.split(/[,，\n]/).map(word => word.trim()).filter(Boolean);
    if (words.length > 100 || words.some(word => word.length > 40)) throw invalid('业务热词最多 100 个，每个不超过 40 字。');
    values.hotwords = [...new Set(words)].join(',');
    if (values.endpoint) {
        let target;
        try { target = new URL(values.endpoint); } catch (_) { throw invalid('请填写有效的完整 HTTP/HTTPS 语音转写地址。'); }
        if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password || target.hash || [...target.searchParams.keys()].some(key => /key|token|secret|password/i.test(key))) throw invalid('语音地址须为 HTTP/HTTPS，不能包含凭据、密钥或片段。');
    }
    let stream;
    if (values.streamEndpoint) {
        try { stream = new URL(values.streamEndpoint); } catch (_) { throw invalid('请填写有效的完整 WS/WSS 流式地址。'); }
        if (!['ws:', 'wss:'].includes(stream.protocol) || stream.username || stream.password || stream.hash || stream.search) throw invalid('流式地址须为不含凭据或查询参数的 WS/WSS 地址。');
        stream.protocol = stream.protocol === 'ws:' ? 'http:' : 'https:';
    }
    if (values.enabled && !['embedded', 'local'].includes(values.provider)) {
        if (!values.endpoint) throw invalid('请填写完整的语音转写地址。');
        if (values.provider !== 'gateway' && !values.model) throw invalid('兼容语音 API 需要填写模型名称。');
        const endpoint = new URL(values.endpoint);
        if (endpoint.hash || [...endpoint.searchParams.keys()].some(key => /key|token|secret|password/i.test(key))) throw invalid('地址中不能包含密钥或片段，请使用密钥输入框。');
        const options = await checkEndpoint(values.endpoint, values.allowExternal);
        options.httpAgent?.destroy(); options.httpsAgent?.destroy();
        if (values.provider === 'gateway' && stream && stream.origin !== endpoint.origin) throw invalid('转写和流式地址必须使用同一主机、端口及匹配的 HTTP/WS 或 HTTPS/WSS 协议。');
    }
    return values;
}

module.exports = { validateSpeechSettings };
