/* 内置 MCP 能力 - 局域网消息通知
 *
 * 对接内网即时聊天工具的 Webhook/API，向允许的目标用户或群组发送
 * 文本/Markdown 通知。由 builtin-mcp.js 拆分而来，逻辑保持不变。
 */
const {
    getRequiredBuiltinConfigAsync,
    IM_TIMEOUT_MS
} = require('./builtin-mcp-common');
const {
    assertSafeMcpOutboundUrl,
    createSafeHttpAgentsForUser
} = require('../security');
const { safeJsonRequest } = require('./safe-http-client');

function getPathValue(value, path = []) {
    let current = value;
    for (const part of path) {
        if (current === null || current === undefined) return undefined;
        if (Array.isArray(current) && /^\d+$/.test(part)) {
            current = current[Number(part)];
        } else if (typeof current === 'object' && Object.prototype.hasOwnProperty.call(current, part)) {
            current = current[part];
        } else {
            return undefined;
        }
    }
    return current;
}

function tryParseJson(text) {
    const trimmed = String(text || '').trim();
    if (!trimmed) return null;
    try {
        return JSON.parse(trimmed);
    } catch (_err) {
        return null;
    }
}

function resolveTemplateReference(expression, context) {
    const expr = String(expression || '').trim();
    if (!expr) return undefined;
    const parts = expr.split('.').map(part => part.trim()).filter(Boolean);
    if (!parts.length) return undefined;
    const [head, ...tail] = parts;
    if (head === 'payload' || head === 'input') return getPathValue(context.payload || context.input || {}, tail);
    if (head === 'user') return getPathValue(context.user || {}, tail);
    if (head === 'approval') return getPathValue(context.approval || {}, tail);
    if (head === 'config') return getPathValue(context.config || {}, tail);
    if (head === 'context') return getPathValue(context.context || {}, tail);
    return getPathValue(context, parts);
}

function renderTemplateValue(value, context) {
    if (typeof value === 'string') {
        const exact = value.match(/^\s*\{\{\s*([^{}]+?)\s*\}\}\s*$/);
        if (exact) {
            const resolved = resolveTemplateReference(exact[1], context);
            return resolved === undefined ? value : resolved;
        }
        return value.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (match, expression) => {
            const resolved = resolveTemplateReference(expression, context);
            if (resolved === undefined || resolved === null) return match;
            if (typeof resolved === 'string') return resolved;
            try {
                return JSON.stringify(resolved);
            } catch (_err) {
                return String(resolved);
            }
        });
    }
    if (Array.isArray(value)) return value.map(item => renderTemplateValue(item, context));
    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, renderTemplateValue(item, context)]));
    }
    return value;
}

function listImTools() {
    return [
        {
            name: 'im.list_allowed_targets',
            title: '查看通知目标',
            description: '列出当前允许通知的 LAN IM 目标。',
            inputSchema: { type: 'object', properties: {} }
        },
        {
            name: 'im.send_user_message',
            title: '发送用户消息',
            description: '向一个允许的 LAN IM 用户发送纯文本消息。',
            inputSchema: {
                type: 'object',
                properties: {
                    target: { type: 'string' },
                    title: { type: 'string' },
                    message: { type: 'string' }
                },
                required: ['target', 'message']
            }
        },
        {
            name: 'im.send_group_message',
            title: '发送群组消息',
            description: '向一个允许的 LAN IM 群组发送纯文本消息。',
            inputSchema: {
                type: 'object',
                properties: {
                    target: { type: 'string' },
                    title: { type: 'string' },
                    message: { type: 'string' }
                },
                required: ['target', 'message']
            }
        },
        {
            name: 'im.send_markdown',
            title: '发送 Markdown 消息',
            description: '向一个允许的 LAN IM 目标发送 Markdown 消息。',
            inputSchema: {
                type: 'object',
                properties: {
                    target: { type: 'string' },
                    targetType: { type: 'string', enum: ['user', 'group'] },
                    title: { type: 'string' },
                    markdown: { type: 'string' }
                },
                required: ['target', 'markdown']
            }
        }
    ];
}

function validateImTarget(config, target, targetType) {
    const value = String(target || config.defaultTarget || '').trim();
    if (!value) {
        const err = new Error('消息接收目标 IM target 为必填项。');
        err.status = 400;
        throw err;
    }
    const lower = value.toLowerCase();
    if (!config.allowAtAll && ['*', 'all', '@all', 'everyone', '所有人', '全员'].includes(lower)) {
        const err = new Error('当前 IM 通知能力未启用广播/全员通知。');
        err.status = 403;
        throw err;
    }
    if (config.allowedTargets.length) {
        const allowed = new Set(config.allowedTargets.map(item => item.toLowerCase()));
        if (!allowed.has(lower) && !allowed.has(`${targetType}:${lower}`)) {
            const err = new Error('目标地址不在允许的通知目标白名单中。');
            err.status = 403;
            throw err;
        }
    }
    return value;
}

function buildImPayload(config, payload, user = null, extra = {}) {
    const basePayload = payload && typeof payload === 'object' && !Array.isArray(payload)
        ? { ...payload }
        : { message: String(payload || '') };
    const template = String(config?.payloadTemplate || '').trim();
    if (!template) return basePayload;
    const context = {
        payload: basePayload,
        input: basePayload,
        user: user && typeof user === 'object' ? user : {},
        approval: extra.approval && typeof extra.approval === 'object' ? extra.approval : {},
        context: extra
    };
    const rendered = renderTemplateValue(template, context);
    if (rendered && typeof rendered === 'object' && !Array.isArray(rendered)) {
        return rendered;
    }
    if (typeof rendered === 'string') {
        const parsed = tryParseJson(rendered);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
        return { ...basePayload, message: rendered };
    }
    return basePayload;
}

async function sendIm(config, secret, payload, user = null, options = {}) {
    const headers = {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'User-Agent': 'Pivot-IM-MCP/1.0'
    };
    if (secret && config.authHeader) headers[config.authHeader] = secret;
    const response = await safeJsonRequest({
        url: config.endpointUrl,
        method: config.method,
        user,
        assertUrl: (targetUrl, targetUser) => assertSafeMcpOutboundUrl(targetUrl, targetUser),
        createAgents: (targetUser) => createSafeHttpAgentsForUser(targetUser, {
            allowPrivateEnv: 'ALLOW_PRIVATE_MCP_URLS',
            allowExplicitLoopbackForAdmin: true
        }),
        headers,
        data: payload,
        timeout: IM_TIMEOUT_MS,
        signal: options.signal || null,
        validateStatus: status => status >= 200 && status < 300
    });
    return {
        ok: true,
        status: response.status,
        response: typeof response.data === 'object' ? response.data : String(response.data || '').slice(0, 2000)
    };
}

async function executeImTool(server, name, input = {}, user = null, options = {}) {
    const { config, secret } = await getRequiredBuiltinConfigAsync(server, 'im');
    if (name === 'im.list_allowed_targets') {
        return {
            allowedTargets: config.allowedTargets,
            defaultTarget: config.defaultTarget,
            allowAtAll: config.allowAtAll,
            endpointHost: new URL(config.endpointUrl).host
        };
    }
    const targetType = name === 'im.send_user_message'
        ? 'user'
        : name === 'im.send_group_message'
            ? 'group'
            : String(input.targetType || 'group').toLowerCase() === 'user' ? 'user' : 'group';
    const target = validateImTarget(config, input.target, targetType);
    const rawMessage = name === 'im.send_markdown' ? input.markdown : input.message;
    const message = String(rawMessage || '').slice(0, config.maxMessageLength);
    if (!message.trim()) {
        const err = new Error('消息内容不能为空。');
        err.status = 400;
        throw err;
    }
    if (!['im.send_user_message', 'im.send_group_message', 'im.send_markdown'].includes(name)) {
        throw new Error(`不支持的即时消息工具操作: ${name}`);
    }
    const renderedPayload = buildImPayload(config, {
        source: 'pivot-mcp',
        target,
        targetType,
        title: String(input.title || '').slice(0, 120),
        message,
        format: name === 'im.send_markdown' ? 'markdown' : 'text',
        timestamp: new Date().toISOString()
    }, user);
    return sendIm(config, secret, renderedPayload, user, options);
}

module.exports = {
    buildImPayload,
    renderTemplateValue,
    listImTools,
    sendIm,
    executeImTool,
    validateImTarget
};
