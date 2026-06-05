/* 内置 MCP 能力 - 局域网消息通知 Built-in IM MCP
 *
 * 对接内网即时聊天工具的 Webhook/API，向允许的目标用户或群组发送
 * 文本/Markdown 通知。由 builtin-mcp.js 拆分而来，逻辑保持不变。
 */
const axios = require('axios');
const {
    getRequiredBuiltinConfig,
    IM_TIMEOUT_MS
} = require('./builtin-mcp-common');
const {
    assertSafeMcpOutboundUrl,
    createSafeHttpAgentsForUser
} = require('../security');

function listImTools() {
    return [
        {
            name: 'im.list_allowed_targets',
            description: '列出当前允许通知的 LAN IM 目标。',
            inputSchema: { type: 'object', properties: {} }
        },
        {
            name: 'im.send_user_message',
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
        const err = new Error('IM target is required.');
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
            const err = new Error('IM target is not in the allowed target list.');
            err.status = 403;
            throw err;
        }
    }
    return value;
}

async function sendIm(config, secret, payload, user = null) {
    const headers = {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'User-Agent': 'Pivot-IM-MCP/1.0'
    };
    if (secret && config.authHeader) headers[config.authHeader] = secret;
    await assertSafeMcpOutboundUrl(config.endpointUrl, user);
    const agents = createSafeHttpAgentsForUser(user, {
        allowPrivateEnv: 'ALLOW_PRIVATE_MCP_URLS',
        allowExplicitLoopbackForAdmin: true
    });
    const response = await axios({
        url: config.endpointUrl,
        method: config.method,
        headers,
        data: payload,
        timeout: IM_TIMEOUT_MS,
        proxy: false,
        ...agents,
        validateStatus: status => status >= 200 && status < 300
    });
    return {
        ok: true,
        status: response.status,
        response: typeof response.data === 'object' ? response.data : String(response.data || '').slice(0, 2000)
    };
}

async function executeImTool(server, name, input = {}, user = null) {
    const { config, secret } = getRequiredBuiltinConfig(server, 'im');
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
        const err = new Error('IM message content is required.');
        err.status = 400;
        throw err;
    }
    if (!['im.send_user_message', 'im.send_group_message', 'im.send_markdown'].includes(name)) {
        throw new Error(`Unsupported IM MCP tool: ${name}`);
    }
    return sendIm(config, secret, {
        source: 'pivot-mcp',
        target,
        targetType,
        title: String(input.title || '').slice(0, 120),
        message,
        format: name === 'im.send_markdown' ? 'markdown' : 'text',
        timestamp: new Date().toISOString()
    }, user);
}

module.exports = {
    listImTools,
    sendIm,
    executeImTool
};
