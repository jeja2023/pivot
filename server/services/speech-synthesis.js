'use strict';
const { safeJsonRequest } = require('./safe-http-client');
const { assertSafeOutboundHost, createSafeLookup, isPrivateHost } = require('../security');
const { resolveCredentialSecret } = require('./workflow-credentials');
const { readTypedEnv } = require('../config/env-registry');

function ttsAgents() {
    const safe = createSafeLookup({ blockPrivate: false, failClosedDns: true });
    const lookup = (hostname, options, callback) => safe(hostname, options, (error, address, family) => {
        if (error) return callback(error);
        const addresses = Array.isArray(address) ? address : [{ address, family }];
        if (addresses.some(item => !isPrivateHost(item.address))) return callback(new Error('离线朗读仅允许内网地址。'));
        callback(null, address, family);
    });
    return { httpAgent: new (require('http').Agent)({ lookup }), httpsAgent: new (require('https').Agent)({ lookup }) };
}

async function synthesizeSpeech(user, input, { signal, method = 'post' } = {}) {
    const endpoint = readTypedEnv('PIVOT_TTS_ENDPOINT');
    const credentialRef = readTypedEnv('PIVOT_TTS_CREDENTIAL');
    if (!endpoint || !credentialRef) throw Object.assign(new Error('管理员尚未配置统一离线朗读服务。'), { status: 503 });
    const url = new URL(endpoint);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('语音服务端点配置无效。');
    if (require('net').isIP(url.hostname) && !isPrivateHost(url.hostname)) throw new Error('离线朗读仅允许内网地址。');
    const credential = await resolveCredentialSecret(credentialRef, user);
    if (!credential?.value) throw Object.assign(new Error('当前账号无权使用朗读凭据。'), { status: 403 });
    const text = input?.text;
    if (method === 'post' && (typeof text !== 'string' || !text.trim() || text.length > 2000)) throw Object.assign(new Error('每段朗读文本需要 1 到 2000 个字符。'), { status: 413 });
    const response = await safeJsonRequest({ url: url.href, method, data: method === 'post' ? { text, voice: String(input.voice || ''), speed: Number(input.speed) || 1 } : undefined,
        user, headers: { Authorization: `Bearer ${credential.value}` }, assertUrl: target => {
            if (new URL(target).href !== url.href) throw new Error('朗读服务不能重定向。');
            return assertSafeOutboundHost(url.hostname, { blockPrivate: false, failClosedDns: true });
        }, createAgents: ttsAgents,
        responseType: method === 'post' ? 'arraybuffer' : 'json', timeout: 65000, signal, maxContentLength: 9 * 1024 * 1024 });
    if (method === 'post' && (!String(response.headers['content-type']).startsWith('audio/wav') || response.data.subarray(0, 4).toString() !== 'RIFF')) throw new Error('朗读服务返回的音频格式无效。');
    return response.data;
}
module.exports = { synthesizeSpeech };
