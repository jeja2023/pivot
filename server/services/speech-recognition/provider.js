'use strict';

const dns = require('node:dns/promises');
const { safeJsonRequest } = require('../safe-http-client');
const { assertSafeOutboundHost, createSafeHttpAgents, isPrivateHost, isLoopbackHost } = require('../../security');
const { speechError } = require('./audio');

function normalizeHotwords(value = '') {
    return [...new Set(String(value).split(/[,，\n]/).map(word => word.trim()).filter(word => word && word.length <= 40))].slice(0, 100);
}

async function providerRequestOptions(endpoint, allowExternal, deps = {}) {
    let url;
    try { url = new URL(endpoint); } catch (_) { throw speechError('请管理员配置有效的语音服务地址。', 'VOICE_PROVIDER_CONFIG', 503); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash || url.search) {
        throw speechError('语音服务地址必须是无凭据及查询参数的 HTTP 或 HTTPS 地址。', 'VOICE_PROVIDER_CONFIG', 503);
    }
    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    const addresses = await (deps.lookup || dns.lookup)(hostname, { all: true });
    if (!addresses.length) throw speechError('语音服务地址无法解析，请联系管理员。', 'VOICE_PROVIDER_UNAVAILABLE', 503);
    const internal = addresses.every(item => isPrivateHost(item.address));
    if (!internal && (!allowExternal || url.protocol !== 'https:')) {
        throw speechError('当前语音策略仅允许内网服务；外部服务需要管理员显式启用并使用 HTTPS。', 'VOICE_EXTERNAL_DISABLED', 503);
    }
    const policy = { blockPrivate: !internal, allowExplicitLoopback: isLoopbackHost(hostname), failClosedDns: true };
    for (const item of addresses) await assertSafeOutboundHost(item.address, { ...policy, allowExplicitLoopback: policy.allowExplicitLoopback && isLoopbackHost(item.address) });
    // 复用 DNS 固定与敏感地址拦截；下游不会重定向到未校验的目标。
    const agents = createSafeHttpAgents(policy);
    const pinnedLookup = (_host, lookupOptions, callback) => {
        if (typeof lookupOptions === 'function') { callback = lookupOptions; lookupOptions = {}; }
        const family = Number(lookupOptions?.family) || 0;
        const candidates = addresses.map(item => ({ address: item.address, family: Number(item.family) || (item.address.includes(':') ? 6 : 4) }))
            .filter(item => !family || item.family === family);
        if (!candidates.length) return callback(Object.assign(new Error('语音服务地址族不可用'), { code: 'ENOTFOUND' }));
        return lookupOptions?.all ? callback(null, candidates) : callback(null, candidates[0].address, candidates[0].family);
    };
    agents.httpAgent.options.lookup = pinnedLookup;
    agents.httpsAgent.options.lookup = pinnedLookup;
    return { ...agents, internal, url: url.href };
}

function normalizeProviderResult(data, kind, threshold) {
    let text = kind === 'qwen' ? data?.choices?.[0]?.message?.content : data?.text;
    if (typeof text !== 'string' || text.length > 16000) throw speechError('语音服务返回了无效结果，请联系管理员。', 'VOICE_RESULT_INVALID', 502);
    // Qwen 官方服务可能使用带语言标签的识别协议。
    if (kind === 'qwen' && text.includes('<asr_text>')) text = text.split('<asr_text>').slice(1).join('<asr_text>');
    text = text.replace(/<\|(?:endoftext|im_end)\|>/g, '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim();
    if (text.length > 4000) throw speechError('识别结果过长，请分段重试。', 'VOICE_RESULT_INVALID', 502);
    const score = data?.confidence;
    const confidence = typeof score === 'number' && Number.isFinite(score) && score >= 0 && score <= 1 ? score : null;
    const noSpeech = data?.noSpeech === true;
    return { text: noSpeech ? '' : text, confidence, noSpeech, requiresReview: data?.requiresReview === true || confidence !== null && confidence < threshold,
        warnings: Array.isArray(data?.warnings) ? data.warnings.filter(item => ['low_volume', 'clipping', 'noisy', 'low_confidence'].includes(item)).slice(0, 4) : [] };
}

async function transcribeWithProvider({ audio, language, config, signal }, deps = {}) {
    const options = await (deps.providerRequestOptions || providerRequestOptions)(config.endpoint, config.allowExternal);
    const headers = config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {};
    let data;
    let multipart = false;
    if (config.kind === 'gateway') data = { audioBase64: audio.toString('base64'), language, hotwords: config.hotwords };
    if (config.kind === 'qwen') {
        data = { model: config.model, stream: false, temperature: 0, max_tokens: 1024, messages: [
            ...(config.hotwords.length ? [{ role: 'system', content: `以下词语仅供识别参考：${config.hotwords.join('、')}` }] : []),
            { role: 'user', content: [{ type: 'audio_url', audio_url: { url: `data:audio/wav;base64,${audio.toString('base64')}` } }] }
        ] };
    }
    if (config.kind === 'openai') {
        multipart = true;
        headers['Content-Type'] = 'multipart/form-data';
        data = new globalThis.FormData(); data.append('file', new globalThis.Blob([audio], { type: 'audio/wav' }), 'speech.wav');
        data.append('model', config.model); data.append('language', language.split('-')[0]); data.append('response_format', 'json');
        if (config.hotwords.length) data.append('prompt', config.hotwords.join('、'));
    }
    try {
        const response = await (deps.request || safeJsonRequest)({ method: 'post', url: options.url, data, headers, signal,
            allowMultipart: multipart, timeout: config.timeoutMs, maxContentLength: 65536, maxBodyLength: 1000000,
            assertUrl: target => { if (target !== options.url) throw speechError('语音服务目标发生变化。', 'VOICE_PROVIDER_CONFIG', 503); },
            createAgents: () => options, validateStatus: status => status >= 200 && status < 300 });
        return { ...normalizeProviderResult(response.data, config.kind, config.minConfidence), thirdPartyForwarding: !options.internal };
    } catch (error) {
        if (signal?.aborted) throw speechError('语音请求已取消。', 'VOICE_ABORTED', 499);
        if (error.code === 'VOICE_RESULT_INVALID') throw error;
        if (error.response?.status === 429) throw speechError('语音服务繁忙，请稍后重试。', 'VOICE_BUSY', 429);
        throw speechError(/TIMEOUT|ECONNABORTED|ETIMEDOUT/.test(error.code || '') ? '语音服务识别超时，请稍后重试。' : '语音服务暂时不可用，请联系管理员检查连接和模型。', 'VOICE_PROVIDER_UNAVAILABLE', 503);
    } finally {
        options.httpAgent?.destroy(); options.httpsAgent?.destroy();
        data = null;
    }
}

async function probeGateway(config) {
    const endpoint = new URL('/health', config.endpoint).href;
    const options = await providerRequestOptions(endpoint, config.allowExternal);
    try {
        const result = await safeJsonRequest({ method: 'get', url: endpoint, headers: { Authorization: `Bearer ${config.apiKey}` },
            timeout: 3000, maxContentLength: 8192, assertUrl: () => {}, createAgents: () => options,
            validateStatus: status => status === 200 });
        if (result.data?.ready !== true) throw speechError('语音模型尚未就绪。', 'VOICE_PROVIDER_UNAVAILABLE', 503);
        return { streaming: result.data.streaming === true };
    } finally { options.httpAgent?.destroy(); options.httpsAgent?.destroy(); }
}

module.exports = { normalizeHotwords, providerRequestOptions, normalizeProviderResult, transcribeWithProvider, probeGateway };
