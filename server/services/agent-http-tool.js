const { parsePositiveInt } = require('../number');
const { safeJsonRequest } = require('./safe-http-client');
const { resolveCredentialSecret } = require('./workflow-credentials');
const { assertNetworkPolicyUrl, normalizeNetworkPolicy } = require('./agent-network-policy');

function clampHttpText(value, max = 8000) {
    const text = String(value || '');
    return text.length > max ? `${text.slice(0, max)}\n...[truncated]` : text;
}

/** 受网络策略和凭据引用治理的 HTTP 工具执行器。 */
async function executeAgentHttp(input = {}, user, context = {}) {
    const url = String(input.url || '').trim();
    if (!url) throw new Error('HTTP 节点需要填写请求 URL。');
    let networkPolicy = context.run?.network_policy || context.run?.networkPolicy;
    if (typeof networkPolicy === 'string') {
        try { networkPolicy = JSON.parse(networkPolicy); } catch (_) { networkPolicy = null; }
    }
    if (context.autonomous === true && (!networkPolicy || typeof networkPolicy !== 'object')) {
        const error = new Error('自主 Agent 网络请求必须绑定任务级网络白名单。');
        error.code = 'AGENT_NETWORK_POLICY_REQUIRED';
        error.category = 'policy';
        throw error;
    }
    if (networkPolicy || input.networkPolicy || input.network_policy) {
        await assertNetworkPolicyUrl(url, normalizeNetworkPolicy(networkPolicy || input.networkPolicy || input.network_policy), {
            requireAllowlist: context.autonomous === true
        });
    }
    const method = String(input.method || 'GET').trim().toLowerCase();
    if (!['get', 'post', 'put', 'delete', 'patch'].includes(method)) {
        throw new Error(`HTTP 节点不支持该方法：${method}，允许的方法为 GET/POST/PUT/DELETE/PATCH。`);
    }
    const rawHeaders = input.headers && typeof input.headers === 'object' && !Array.isArray(input.headers) ? input.headers : {};
    const headers = Object.fromEntries(Object.entries(rawHeaders).map(([key, value]) => [String(key).trim(), String(value ?? '').trim()]).filter(([key]) => key));
    const credentialSecret = String(input.credentialSecret || input.credential_secret || '').trim();
    if (credentialSecret) {
        if (!/^[A-Za-z0-9_]+$/.test(credentialSecret)) throw new Error('HTTP 凭据引用只能包含字母、数字和下划线。');
        const envName = `PIVOT_WORKFLOW_SECRET_${credentialSecret.toUpperCase()}`;
        const stored = await resolveCredentialSecret(credentialSecret, user);
        const secret = stored?.value || process.env[envName];
        if (!secret) throw new Error(`未找到 HTTP 凭据「${credentialSecret}」，请在凭据库创建，或配置环境变量 ${envName}。`);
        const header = String(input.credentialHeader || input.credential_header || 'Authorization').trim();
        if (!header || /[\r\n:]/.test(header)) throw new Error('HTTP 凭据请求头名称无效。');
        headers[header] = `${String(input.credentialPrefix ?? input.credential_prefix ?? 'Bearer ')}${secret}`;
    }
    const hasBody = ['post', 'put', 'patch'].includes(method);
    const bodyRaw = hasBody ? (input.body ?? input.data ?? null) : undefined;
    const body = bodyRaw !== undefined && bodyRaw !== null && typeof bodyRaw !== 'object' ? { value: bodyRaw } : bodyRaw;
    let response;
    try {
        response = await safeJsonRequest({
            method, url, data: body, headers, user,
            timeout: Math.min(parsePositiveInt(input.timeoutMs ?? input.timeout_ms, 10000, 30000), 30000),
            signal: context.signal || null, validateStatus: () => true
        });
    } catch (error) {
        throw new Error(`HTTP 请求失败：${error.message}`);
    }
    const responseData = response.data;
    const responseText = typeof responseData === 'string'
        ? responseData
        : (responseData !== null && responseData !== undefined ? JSON.stringify(responseData) : '');
    return {
        statusCode: response.status, ok: response.status >= 200 && response.status < 300,
        headers: response.headers || {}, data: responseData, text: clampHttpText(responseText)
    };
}

module.exports = { executeAgentHttp };
