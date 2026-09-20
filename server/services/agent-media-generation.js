'use strict';

/*
 * 受控图片与语音生成 Provider 适配层。
 *
 * Provider 只接收受限的 JSON 请求，并且入口、生成后媒体 URL 都必须位于该
 * Agent Run 的显式网络白名单中。这样既允许私有化部署，也不会把 Provider
 * 的密钥、任意 URL 或二进制媒体直接带进数据库和提示词。
 */
const { safeJsonRequest } = require('./safe-http-client');
const { assertNetworkPolicyUrl, normalizeNetworkPolicy } = require('./agent-network-policy');
const { createSafeHttpAgentsForUser } = require('../security');
const { resolveCredentialSecret } = require('./workflow-credentials');

const MEDIA_KINDS = Object.freeze({ image: 'image', speech: 'speech' });
const MAX_IMAGE_PROMPT_CHARS = 2400;
const MAX_SPEECH_TEXT_CHARS = 12000;

function mediaError(message, code = 'AGENT_MEDIA_INVALID', status = 400) {
    const error = new Error(message);
    error.code = code;
    error.status = status;
    error.statusCode = status;
    error.category = 'network';
    return error;
}

function mediaEnvPrefix(kind) {
    if (kind === MEDIA_KINDS.image) return 'AGENT_IMAGE_GENERATION';
    if (kind === MEDIA_KINDS.speech) return 'AGENT_TTS';
    throw mediaError('未知的媒体生成类型。');
}

function providerConfiguration(kind, env = process.env) {
    const prefix = mediaEnvPrefix(kind);
    const prefixValue = String(env[`${prefix}_PREFIX`] ?? 'Bearer').trim().slice(0, 79);
    return {
        endpoint: String(env[`${prefix}_ENDPOINT`] || '').trim(),
        credentialRef: String(env[`${prefix}_CREDENTIAL`] || '').trim().slice(0, 255),
        apiKey: String(env[`${prefix}_API_KEY`] || '').trim(),
        header: String(env[`${prefix}_HEADER`] || 'Authorization').trim().slice(0, 120),
        prefix: prefixValue ? `${prefixValue} ` : ''
    };
}

function isAgentImageGenerationAvailable(env = process.env) {
    return Boolean(providerConfiguration(MEDIA_KINDS.image, env).endpoint);
}

function isAgentTextToSpeechAvailable(env = process.env) {
    return Boolean(providerConfiguration(MEDIA_KINDS.speech, env).endpoint);
}

function normalizeMediaUrl(value) {
    try {
        const url = new URL(String(value || '').trim());
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return '';
        return url.toString();
    } catch (_) {
        return '';
    }
}

function extractMediaUrl(data, kind) {
    const primaryKeys = kind === MEDIA_KINDS.image
        ? ['url', 'imageUrl', 'image_url', 'outputUrl', 'output_url']
        : ['url', 'audioUrl', 'audio_url', 'outputUrl', 'output_url'];
    const candidates = [];
    const collect = value => {
        if (!value || typeof value !== 'object') return;
        primaryKeys.forEach(key => candidates.push(value[key]));
        if (kind === MEDIA_KINDS.image) {
            candidates.push(value.image?.url, value.images?.[0]?.url, value.data?.[0]?.url, value.result?.url);
        } else {
            candidates.push(value.audio?.url, value.data?.url, value.result?.url, value.outputs?.[0]?.url);
        }
    };
    collect(data);
    if (Array.isArray(data)) data.slice(0, 1).forEach(collect);
    return candidates.map(normalizeMediaUrl).find(Boolean) || '';
}

async function resolveProviderCredential(config, user) {
    if (config.credentialRef) {
        const stored = await resolveCredentialSecret(config.credentialRef, user);
        if (!stored?.value) throw mediaError('媒体生成 Provider 的凭据引用不可用。', 'AGENT_MEDIA_CREDENTIAL_UNAVAILABLE', 503);
        return stored.value;
    }
    return config.apiKey || '';
}

function resolveRunNetworkPolicy(context = {}, input = {}) {
    let raw = context.run?.network_policy || context.run?.networkPolicy || input.networkPolicy || input.network_policy;
    if (typeof raw === 'string') {
        try { raw = JSON.parse(raw); } catch (_) { raw = null; }
    }
    if (!raw || typeof raw !== 'object') {
        throw mediaError('媒体生成必须绑定任务级网络白名单。', 'AGENT_MEDIA_NETWORK_POLICY_REQUIRED', 403);
    }
    return normalizeNetworkPolicy(raw);
}

function buildProviderPayload(kind, input = {}) {
    if (kind === MEDIA_KINDS.image) {
        const prompt = String(input.prompt || input.text || '').trim().slice(0, MAX_IMAGE_PROMPT_CHARS);
        if (!prompt) throw mediaError('请填写图片生成提示词。');
        return {
            prompt,
            size: String(input.size || '1024x1024').trim().slice(0, 32),
            style: String(input.style || '').trim().slice(0, 120),
            count: 1,
            responseFormat: 'url'
        };
    }
    const text = String(input.text || input.prompt || '').trim().slice(0, MAX_SPEECH_TEXT_CHARS);
    if (!text) throw mediaError('请填写要朗读的文本。');
    return {
        text,
        voice: String(input.voice || '').trim().slice(0, 120),
        format: String(input.format || 'mp3').trim().slice(0, 20),
        speed: Math.max(0.5, Math.min(Number(input.speed ?? 1) || 1, 2))
    };
}

async function executeAgentMediaGeneration(kind, input = {}, user, context = {}, options = {}) {
    const config = providerConfiguration(kind, options.env || process.env);
    if (!config.endpoint) {
        const label = kind === MEDIA_KINDS.image ? '图片生成' : '语音合成';
        throw mediaError(`尚未配置${label} Provider。`, 'AGENT_MEDIA_UNAVAILABLE', 503);
    }
    const policy = resolveRunNetworkPolicy(context, input);
    await assertNetworkPolicyUrl(config.endpoint, policy, { requireAllowlist: true });
    const credential = await resolveProviderCredential(config, user);
    const headers = credential ? { [config.header]: `${config.prefix}${credential}` } : {};
    const payload = buildProviderPayload(kind, input);
    let response;
    try {
        response = await safeJsonRequest({
            method: 'post',
            url: config.endpoint,
            data: payload,
            headers,
            user,
            assertUrl: target => assertNetworkPolicyUrl(target, policy, { requireAllowlist: true }),
            createAgents: targetUser => createSafeHttpAgentsForUser(targetUser, { allowPrivateEnv: 'ALLOW_PRIVATE_MCP_URLS', allowExplicitLoopbackForAdmin: false }),
            timeout: Math.min(Math.max(Number.parseInt(input.timeoutMs ?? input.timeout_ms, 10) || 30000, 1000), 120000),
            validateStatus: status => status >= 200 && status < 300,
            signal: context.signal || null,
            maxContentLength: 2 * 1024 * 1024,
            maxBodyLength: Math.max(Buffer.byteLength(JSON.stringify(payload)), 1024 * 8)
        });
    } catch (error) {
        throw mediaError(`媒体生成 Provider 请求失败：${error.message}`, 'AGENT_MEDIA_PROVIDER_FAILED', 502);
    }
    const url = extractMediaUrl(response.data, kind);
    if (!url) throw mediaError('媒体生成 Provider 没有返回可用的 HTTPS/HTTP 媒体地址。', 'AGENT_MEDIA_RESULT_INVALID', 502);
    // 生成结果也可能指向 CDN；它必须被任务白名单明确批准，不能把任意 URL 交给浏览器渲染。
    await assertNetworkPolicyUrl(url, policy, { requireAllowlist: true });
    const provider = new URL(config.endpoint).origin;
    if (kind === MEDIA_KINDS.image) {
        return {
            type: 'embedded_image',
            url,
            alt: String(input.alt || input.title || payload.prompt).trim().slice(0, 160) || '已生成图片',
            provider,
            prompt: payload.prompt,
            text: '已生成图片。'
        };
    }
    return {
        type: 'embedded_audio',
        url,
        title: String(input.title || '已合成语音').trim().slice(0, 120) || '已合成语音',
        provider,
        textLength: payload.text.length,
        text: '已合成语音。'
    };
}

function executeAgentImageGeneration(input, user, context, options) {
    return executeAgentMediaGeneration(MEDIA_KINDS.image, input, user, context, options);
}

function executeAgentTextToSpeech(input, user, context, options) {
    return executeAgentMediaGeneration(MEDIA_KINDS.speech, input, user, context, options);
}

module.exports = {
    executeAgentImageGeneration,
    executeAgentTextToSpeech,
    extractMediaUrl,
    isAgentImageGenerationAvailable,
    isAgentTextToSpeechAvailable,
    providerConfiguration
};
