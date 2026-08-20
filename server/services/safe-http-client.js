const axios = require('axios');
const { assertSafeOutboundUrl, createSafeHttpAgentsForUser } = require('../security');

function hasHeader(headers = {}, name) {
    const target = String(name || '').toLowerCase();
    return Object.keys(headers || {}).some(key => key.toLowerCase() === target);
}

function cleanHeaders(headers = {}) {
    return Object.fromEntries(
        Object.entries(headers || {}).filter(([, value]) => value !== undefined && value !== null)
    );
}

function looksLikeMultipartPayload(data) {
    if (!data || typeof data !== 'object') return false;
    const ctorName = data.constructor?.name || '';
    return ctorName === 'FormData'
        || typeof data.getBoundary === 'function'
        || typeof data.getHeaders === 'function';
}

function assertJsonOnlyPayload(data, options = {}) {
    if (options.allowMultipart === true) return;
    if (looksLikeMultipartPayload(data)) {
        const err = new Error('Multipart 上传请求必须使用专门的上传客户端，不可使用普通 JSON HTTP 请求封装。');
        err.code = 'MULTIPART_PAYLOAD_REJECTED';
        throw err;
    }
}

async function buildSafeAxiosOptions(url, options = {}) {
    const user = options.user || {};
    const assertUrl = options.assertUrl || ((targetUrl, targetUser) => assertSafeOutboundUrl(targetUrl, targetUser));
    const createAgents = options.createAgents || ((targetUser) => createSafeHttpAgentsForUser(targetUser, options.agentOptions || {}));
    if (assertUrl) await assertUrl(url, user);
    const agents = createAgents ? createAgents(user) : {};
    const headers = cleanHeaders(options.headers || {});
    if (options.hasJsonBody && !hasHeader(headers, 'Content-Type')) {
        headers['Content-Type'] = 'application/json';
    }
    if (!hasHeader(headers, 'Accept')) {
        headers.Accept = 'application/json';
    }
    return {
        headers,
        timeout: options.timeout,
        proxy: false,
        responseType: options.responseType || 'json',
        // 外部工具/Webhook 返回体必须有硬上限，避免恶意或异常服务造成内存和上下文耗尽。
        maxContentLength: Number.isFinite(Number(options.maxContentLength))
            ? Math.max(1024, Number(options.maxContentLength))
            : 4 * 1024 * 1024,
        maxBodyLength: Number.isFinite(Number(options.maxBodyLength))
            ? Math.max(1024, Number(options.maxBodyLength))
            : 4 * 1024 * 1024,
        validateStatus: options.validateStatus,
        signal: options.signal,
        ...agents
    };
}

async function safeJsonGet(url, options = {}) {
    const axiosOptions = await buildSafeAxiosOptions(url, options);
    return axios.get(url, axiosOptions);
}

async function safeJsonPost(url, data, options = {}) {
    assertJsonOnlyPayload(data, options);
    const axiosOptions = await buildSafeAxiosOptions(url, { ...options, hasJsonBody: true });
    return axios.post(url, data, axiosOptions);
}

async function safeJsonRequest(config = {}) {
    const method = String(config.method || 'get').toLowerCase();
    if (method === 'get') return safeJsonGet(config.url, config);
    if (method === 'post') return safeJsonPost(config.url, config.data, config);
    assertJsonOnlyPayload(config.data, config);
    const axiosOptions = await buildSafeAxiosOptions(config.url, {
        ...config,
        hasJsonBody: config.data !== undefined
    });
    return axios({
        method,
        url: config.url,
        data: config.data,
        ...axiosOptions
    });
}

module.exports = {
    assertJsonOnlyPayload,
    safeJsonGet,
    safeJsonPost,
    safeJsonRequest
};
