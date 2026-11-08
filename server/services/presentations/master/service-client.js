'use strict';

const crypto = require('node:crypto');
const { readTypedEnv } = require('../../../config/env-registry');
const { pptMasterSettings } = require('./settings');
const { safeJsonRequest } = require('../../safe-http-client');
const { assertSafeMcpOutboundUrl, createSafeHttpAgents, isLoopbackHost } = require('../../../security');
const sessions = new Map();
let cached = null;
const error = (message, code = 'PPT_SERVICE_UNAVAILABLE', status = 503) => Object.assign(new Error(message), { code, status, statusCode: status, expose: true });
function config(env = process.env) {
    const endpoint = readTypedEnv('PIVOT_PPT_MASTER_SERVICE_URL', env).replace(/\/+$/, ''), token = String(env.PIVOT_PPT_MASTER_SERVICE_TOKEN || '').trim();
    if (!endpoint) return null;
    let url;
    try { url = new URL(endpoint); } catch (_) { throw error('PPT制作服务地址无效，请检查配置。'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw error('PPT制作服务地址只支持HTTP/HTTPS服务根地址。');
    if (!/^[A-Za-z0-9_-]{32,256}$/.test(token)) throw error('PPT制作服务密钥未配置或格式无效，请检查服务连接。');
    return { endpoint, token };
}
async function connection(env = process.env) {
    if (env !== process.env) return { selected: Boolean(String(env.PIVOT_PPT_MASTER_SERVICE_URL || '').trim()), settings: config(env) };
    const value = await pptMasterSettings.effective();
    return { selected: value.source === 'settings' || Boolean(value.endpoint), settings: value.enabled ? config({ PIVOT_PPT_MASTER_SERVICE_URL: value.endpoint, PIVOT_PPT_MASTER_SERVICE_TOKEN: value.token }) : null };
}
async function configured(env = process.env) { return (await connection(env)).selected; }
async function bytes(response, maximum) {
    if (Number(response.headers['content-length'] || 0) > maximum) { response.data?.destroy(); throw error('PPT制作服务响应超过大小上限。', 'PPT_SERVICE_RESPONSE_TOO_LARGE', 502); }
    const chunks = []; let size = 0;
    if (response.data) for await (const chunk of response.data) { size += chunk.length; if (size > maximum) throw error('PPT制作服务响应超过大小上限。', 'PPT_SERVICE_RESPONSE_TOO_LARGE', 502); chunks.push(Buffer.from(chunk)); }
    return Buffer.concat(chunks, size);
}
async function request(settings, route, { method = 'GET', body, signal, timeout = 125000, maximum = 1024 * 1024, binary = false } = {}) {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(error('PPT制作服务请求超时，请稍后重试。', 'PPT_SERVICE_TIMEOUT', 504)), timeout);
    const abort = () => controller.abort(signal.reason); signal?.addEventListener('abort', abort, { once: true });
    let agents;
    try {
        signal?.throwIfAborted();
        if (!settings) throw error('PPT制作服务已停用，标准PPT功能继续可用。');
        const target = settings.endpoint + route;
        // 服务地址仅由最高管理员配置；执行时仍固定DNS并阻止敏感目标及重定向。
        await assertSafeMcpOutboundUrl(target, { role: 'admin', username: 'admin' });
        agents = createSafeHttpAgents({ blockPrivate: process.env.ALLOW_PRIVATE_MCP_URLS === 'false', allowExplicitLoopback: isLoopbackHost(new URL(target).hostname), failClosedDns: true });
        const headers = { Authorization: 'Bearer ' + settings.token, ...(body ? { 'Content-Type': Buffer.isBuffer(body) ? 'application/octet-stream' : 'application/json' } : {}) };
        const response = await safeJsonRequest({ method, url: target, headers, data: body && (Buffer.isBuffer(body) ? body : JSON.stringify(body)), signal: controller.signal, timeout,
            responseType: 'stream', maxContentLength: maximum, maxBodyLength: 50 * 1024 * 1024, validateStatus: () => true,
            assertUrl: candidate => { if (candidate !== target) throw error('PPT服务目标发生变化。'); }, createAgents: () => agents });
        if (response.status < 200 || response.status >= 300) {
            const parsed = JSON.parse((await bytes(response, 16384)).toString('utf8'));
            throw error(parsed.error?.message || 'PPT制作服务未完成请求，请重试。', parsed.error?.code || 'PPT_SERVICE_UNAVAILABLE', response.status);
        }
        const buffer = await bytes(response, maximum);
        if (!binary) return JSON.parse(buffer.toString('utf8'));
        const digest = response.headers['x-content-sha256'];
        if (!digest || crypto.createHash('sha256').update(buffer).digest('hex') !== digest) throw error('PPT服务文件传输校验失败，请重新下载。', 'PPT_SERVICE_FILE_CHANGED', 502);
        return buffer;
    } catch (cause) {
        if (signal?.aborted) throw signal.reason || cause;
        if (controller.signal.aborted) throw controller.signal.reason;
        if (cause?.expose) throw cause;
        throw error('PPT制作服务暂时不可用，标准PPT创建、编辑和导出仍可使用。');
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); agents?.httpAgent?.destroy(); agents?.httpsAgent?.destroy(); }
}
function compatible(health) {
    if (health?.serviceProtocol !== 1 || health.status !== 'ready' || !/^sha256:[a-f0-9]{64}$/.test(health.runtimeId || '') || !health.revision || !Array.isArray(health.capabilities)
        || ['files', 'operations', 'cancel', 'native', 'templates'].some(capability => !health.capabilities.includes(capability))) throw error('PPT服务协议不兼容，请使用支持服务协议1的镜像。', 'PPT_SERVICE_PROTOCOL_MISMATCH');
    return health;
}
async function info({ force = false, env = process.env } = {}) {
    const { settings } = await connection(env); if (!settings) return null;
    const signature = crypto.createHash('sha256').update(settings.endpoint + settings.token).digest('hex');
    if (!force && cached?.signature === signature && Date.now() - cached.at < 2000) return cached.value;
    const value = compatible(await request(settings, '/v1/info', { timeout: 1800 }));
    cached = { signature, at: Date.now(), value }; return value;
}
function jobKey(user, id, settings) {
    if (!Number.isSafeInteger(Number(user?.id)) || Number(user.id) <= 0 || !/^tooltask_[A-Za-z0-9_-]{24,80}$/.test(String(id))) throw error('制作任务标识无效。', 'PPT_SERVICE_JOB_INVALID', 400);
    return crypto.createHmac('sha256', settings.token).update(String(user.id) + ':' + id).digest('hex');
}
async function session(user, id, env = process.env) {
    const { settings } = await connection(env); if (!settings) throw error('PPT制作服务已停用，标准PPT功能继续可用。');
    const key = jobKey(user, id, settings), cacheKey = settings.endpoint + ':' + key;
    const previous = sessions.get(cacheKey);
    if (previous) return { settings, key, health: previous };
    const health = await info({ env });
    await request(settings, '/v1/jobs/' + key, { method: 'POST', body: { runtimeId: health.runtimeId }, timeout: 10000 });
    if (sessions.size >= 400) sessions.delete(sessions.keys().next().value);
    sessions.set(cacheKey, health); return { settings, key, health };
}
async function execute(user, id, operation, { signal, env = process.env } = {}) {
    const { settings, key, health } = await session(user, id, env), requestId = crypto.randomBytes(16).toString('hex');
    let cancellation;
    const cancel = () => cancellation ||= request(settings, '/v1/jobs/' + key + '/operations/' + requestId + '/cancel', { method: 'POST', body: {}, timeout: 4000 }).catch(() => {});
    signal?.addEventListener('abort', cancel, { once: true });
    try {
        signal?.throwIfAborted();
        let output;
        try { output = await request(settings, '/v1/jobs/' + key + '/operations/' + requestId, { method: 'POST', body: { runtimeId: health.runtimeId, operation }, signal }); }
        catch (cause) { await cancel(); throw cause; }
        if (output.serviceProtocol !== 1 || output.runtimeId !== health.runtimeId) throw error('制作服务在任务中发生变化，请重新创建任务。', 'PPT_SERVICE_RUNTIME_CHANGED', 409);
        return output;
    } finally { signal?.removeEventListener('abort', cancel); }
}
async function inputFile(user, id, name, buffer, env = process.env) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,120}$/.test(name) || !Buffer.isBuffer(buffer) || buffer.length > 50 * 1024 * 1024) throw error('PPT输入文件名或大小无效。', 'PPT_SERVICE_INPUT_INVALID', 400);
    const { settings, key } = await session(user, id, env);
    const result = await request(settings, '/v1/jobs/' + key + '/inputs/' + name, { method: 'PUT', body: buffer });
    if (result.sha256 !== crypto.createHash('sha256').update(buffer).digest('hex')) throw error('PPT输入文件校验失败。', 'PPT_SERVICE_INPUT_CHANGED', 502);
    return result.path;
}
async function file(user, id, kind, name, maximum, env = process.env) {
    if (!['inputs', 'outputs'].includes(kind) || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,120}$/.test(name)) throw error('PPT文件请求范围无效。', 'PPT_SERVICE_FILE_INVALID', 400);
    const { settings, key } = await session(user, id, env);
    return request(settings, '/v1/jobs/' + key + '/' + kind + '/' + name, { binary: true, maximum });
}
async function cleanup(user, id, env = process.env) {
    const { settings } = await connection(env); if (!settings) return;
    const key = jobKey(user, id, settings);
    await request(settings, '/v1/jobs/' + key, { method: 'DELETE', timeout: 5000 }); sessions.delete(settings.endpoint + ':' + key);
}
async function identity(env = process.env) {
    const { settings } = await connection(env); if (!settings) return '';
    const health = await info({ env });
    return 'service:' + crypto.createHmac('sha256', settings.token).update(settings.endpoint).digest('hex') + ':' + health.runtimeId;
}
function reset() { cached = null; sessions.clear(); }
module.exports = { config, configured, compatible, info, execute, inputFile, file, cleanup, request, identity, reset };
