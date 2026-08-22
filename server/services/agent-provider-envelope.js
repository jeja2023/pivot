const PRIVATE_KEY_RE = /^(?:metadata|context|policy|approval|sandbox|lease|credential|credentials|secret|token|authorization|headers|user|run|internal|trace)$/i;

const MESSAGE_KEYS = new Set([
    'role', 'content', 'name', 'tool_call_id', 'tool_calls', 'function_call',
    'audio', 'refusal', 'prefix', 'type', 'id', 'call_id', 'name', 'arguments',
    'output', 'status', 'summary'
]);

function sanitizeContentPart(part) {
    if (!part || typeof part !== 'object') return part;
    const result = {};
    if (part.type !== undefined) result.type = part.type;
    if (part.text !== undefined) result.text = part.text;
    if (part.refusal !== undefined) result.refusal = part.refusal;
    if (part.image_url && typeof part.image_url === 'object') {
        result.image_url = {
            url: part.image_url.url,
            ...(part.image_url.detail ? { detail: part.image_url.detail } : {})
        };
    }
    if (part.input_audio && typeof part.input_audio === 'object') {
        result.input_audio = {
            data: part.input_audio.data,
            format: part.input_audio.format
        };
    }
    return result;
}

function sanitizeToolCall(call) {
    if (!call || typeof call !== 'object') return call;
    const result = {};
    if (call.id !== undefined) result.id = call.id;
    if (call.type !== undefined) result.type = call.type;
    if (call.function && typeof call.function === 'object') {
        result.function = {
            name: call.function.name,
            arguments: call.function.arguments
        };
    }
    return result;
}

function sanitizeProviderMessage(message) {
    const item = message?.item && typeof message.item === 'object' ? message.item : message;
    if (!item || typeof item !== 'object') return item;
    const result = {};
    for (const key of MESSAGE_KEYS) {
        if (item[key] === undefined) continue;
        if (key === 'content' && Array.isArray(item.content)) result.content = item.content.map(sanitizeContentPart);
        else if (key === 'tool_calls' && Array.isArray(item.tool_calls)) result.tool_calls = item.tool_calls.map(sanitizeToolCall);
        else if (key === 'function_call' && item.function_call && typeof item.function_call === 'object') {
            result.function_call = {
                name: item.function_call.name,
                arguments: item.function_call.arguments
            };
        } else result[key] = item[key];
    }
    return result;
}

function toProviderInput(items = []) {
    return (Array.isArray(items) ? items : []).map(sanitizeProviderMessage);
}

function sanitizeProviderTool(tool) {
    if (!tool || typeof tool !== 'object') return tool;
    const result = {};
    if (tool.type !== undefined) result.type = tool.type;
    if (tool.name !== undefined) result.name = tool.name;
    if (tool.description !== undefined) result.description = tool.description;
    if (tool.strict !== undefined) result.strict = Boolean(tool.strict);
    if (tool.parameters !== undefined) result.parameters = tool.parameters;
    if (tool.function && typeof tool.function === 'object') {
        result.function = {
            name: tool.function.name,
            description: tool.function.description,
            parameters: tool.function.parameters,
            ...(tool.function.strict === undefined ? {} : { strict: Boolean(tool.function.strict) })
        };
    }
    return result;
}

function normalizeProviderRequestData(data = {}) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) return data;
    const normalized = { ...data };
    if (Array.isArray(data.messages)) normalized.messages = toProviderInput(data.messages);
    if (Array.isArray(data.input)) normalized.input = toProviderInput(data.input);
    if (Array.isArray(data.tools)) normalized.tools = data.tools.map(sanitizeProviderTool);
    return normalized;
}

function createModelItemEnvelope(item, metadata = {}) {
    return Object.freeze({ item, metadata: Object.freeze({ ...metadata }) });
}

function assertProviderSafe(value, path = '') {
    if (!value || typeof value !== 'object') return true;
    if (Array.isArray(value)) return value.forEach((item, index) => assertProviderSafe(item, `${path}[${index}]`));
    for (const [key, child] of Object.entries(value)) {
        if (PRIVATE_KEY_RE.test(key)) throw new Error(`Provider payload 包含内部字段：${path ? `${path}.` : ''}${key}`);
        assertProviderSafe(child, `${path ? `${path}.` : ''}${key}`);
    }
    return true;
}

module.exports = {
    assertProviderSafe,
    createModelItemEnvelope,
    normalizeProviderRequestData,
    sanitizeProviderMessage,
    sanitizeProviderTool,
    toProviderInput
};
