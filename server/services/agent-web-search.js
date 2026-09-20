'use strict';

/*
 * 受控网页检索 Provider 适配层。
 *
 * 不直接抓取任意搜索站点，也不把用户输入拼到 URL 中。管理员配置一个 JSON
 * Search Provider Endpoint；每次调用仍要求运行级 Origin 白名单、SSRF 防护和
 * 可选凭据引用。Provider 返回的数据会收敛为只读搜索结果，页面 URL 只作为
 * 证据引用，后续访问仍需单独走浏览器/HTTP 工具与审批。
 */
const { safeJsonRequest } = require('./safe-http-client');
const { assertNetworkPolicyUrl, normalizeNetworkPolicy } = require('./agent-network-policy');
const { createSafeHttpAgentsForUser } = require('../security');
const { resolveCredentialSecret } = require('./workflow-credentials');

const MAX_QUERY_CHARS = 500;
const MAX_RESULTS = 10;
const MAX_SNIPPET_CHARS = 2000;

function webSearchError(message, code = 'AGENT_WEB_SEARCH_INVALID', status = 400) {
    const error = new Error(message);
    error.code = code;
    error.status = status;
    error.statusCode = status;
    error.category = 'network';
    return error;
}

function providerConfiguration(env = process.env) {
    const endpoint = String(env.AGENT_WEB_SEARCH_ENDPOINT || '').trim();
    const credentialRef = String(env.AGENT_WEB_SEARCH_CREDENTIAL || '').trim().slice(0, 255);
    const apiKey = String(env.AGENT_WEB_SEARCH_API_KEY || '').trim();
    const header = String(env.AGENT_WEB_SEARCH_HEADER || 'Authorization').trim().slice(0, 120);
    const prefixValue = String(env.AGENT_WEB_SEARCH_PREFIX ?? 'Bearer').trim().slice(0, 79);
    const prefix = prefixValue ? `${prefixValue} ` : '';
    return { endpoint, credentialRef, apiKey, header, prefix };
}

function isAgentWebSearchAvailable(env = process.env) {
    return Boolean(providerConfiguration(env).endpoint);
}

function normalizeResultUrl(value) {
    try {
        const url = new URL(String(value || '').trim());
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return '';
        return url.toString();
    } catch (_) {
        return '';
    }
}

function normalizeSearchResults(data, limit) {
    const source = Array.isArray(data)
        ? data
        : Array.isArray(data?.results) ? data.results
            : Array.isArray(data?.items) ? data.items
                : Array.isArray(data?.data) ? data.data : [];
    return source.slice(0, limit).map((item, index) => {
        const sourceItem = item && typeof item === 'object' ? item : {};
        const title = String(sourceItem.title || sourceItem.name || sourceItem.heading || `搜索结果 ${index + 1}`).trim().slice(0, 300);
        const url = normalizeResultUrl(sourceItem.url || sourceItem.link || sourceItem.href || sourceItem.sourceUrl);
        const snippet = String(sourceItem.snippet || sourceItem.description || sourceItem.content || sourceItem.text || '').trim().slice(0, MAX_SNIPPET_CHARS);
        const publishedAt = String(sourceItem.publishedAt || sourceItem.published_at || sourceItem.date || '').trim().slice(0, 80);
        const sourceName = String(sourceItem.source || sourceItem.domain || '').trim().slice(0, 160);
        return { rank: index + 1, title, url, snippet, publishedAt, source: sourceName };
    }).filter(item => item.url || item.snippet || item.title);
}

async function resolveProviderCredential(config, user) {
    if (config.credentialRef) {
        const stored = await resolveCredentialSecret(config.credentialRef, user);
        if (!stored?.value) throw webSearchError('网页检索凭据引用不可用。', 'AGENT_WEB_SEARCH_CREDENTIAL_UNAVAILABLE', 503);
        return stored.value;
    }
    return config.apiKey || '';
}

async function executeAgentWebSearch(input = {}, user, context = {}, options = {}) {
    const config = providerConfiguration(options.env || process.env);
    if (!config.endpoint) throw webSearchError('尚未配置网页检索 Provider；请由管理员设置 AGENT_WEB_SEARCH_ENDPOINT。', 'AGENT_WEB_SEARCH_UNAVAILABLE', 503);
    const query = String(input.query || input.q || '').trim().slice(0, MAX_QUERY_CHARS);
    if (!query) throw webSearchError('请填写网页检索关键词。');
    const limit = Math.max(1, Math.min(Number.parseInt(input.limit ?? input.maxResults, 10) || 5, MAX_RESULTS));
    let networkPolicy = context.run?.network_policy || context.run?.networkPolicy || input.networkPolicy || input.network_policy;
    if (typeof networkPolicy === 'string') {
        try { networkPolicy = JSON.parse(networkPolicy); } catch (_) { networkPolicy = null; }
    }
    if (!networkPolicy || typeof networkPolicy !== 'object') {
        throw webSearchError('网页检索必须绑定任务级网络白名单。', 'AGENT_WEB_SEARCH_NETWORK_POLICY_REQUIRED', 403);
    }
    const policy = normalizeNetworkPolicy(networkPolicy);
    await assertNetworkPolicyUrl(config.endpoint, policy, { requireAllowlist: true });
    const credential = await resolveProviderCredential(config, user);
    const headers = credential ? { [config.header]: `${config.prefix}${credential}` } : {};
    let response;
    try {
        response = await safeJsonRequest({
            method: 'post',
            url: config.endpoint,
            data: { query, limit, locale: String(input.locale || 'zh-CN').slice(0, 24), safeSearch: input.safeSearch !== false },
            headers,
            user,
            assertUrl: target => assertNetworkPolicyUrl(target, policy, { requireAllowlist: true }),
            createAgents: targetUser => createSafeHttpAgentsForUser(targetUser, { allowPrivateEnv: 'ALLOW_PRIVATE_MCP_URLS', allowExplicitLoopbackForAdmin: false }),
            timeout: Math.min(Math.max(Number.parseInt(input.timeoutMs ?? input.timeout_ms, 10) || 15000, 1000), 30000),
            validateStatus: status => status >= 200 && status < 300,
            signal: context.signal || null,
            maxContentLength: 2 * 1024 * 1024,
            maxBodyLength: 128 * 1024
        });
    } catch (error) {
        throw webSearchError(`网页检索 Provider 请求失败：${error.message}`, 'AGENT_WEB_SEARCH_PROVIDER_FAILED', 502);
    }
    const results = normalizeSearchResults(response.data, limit);
    return {
        query,
        provider: new URL(config.endpoint).origin,
        results,
        resultCount: results.length,
        text: results.map(item => [`${item.rank}. ${item.title}`, item.url, item.snippet].filter(Boolean).join('\n')).join('\n\n')
    };
}

module.exports = {
    executeAgentWebSearch,
    isAgentWebSearchAvailable,
    normalizeSearchResults,
    providerConfiguration
};
