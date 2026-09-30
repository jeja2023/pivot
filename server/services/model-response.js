const { extractModelText } = require('./chat-route-helpers');
const { modelSupportsReasoning, buildThinkingControlPayload } = require('./models');

function stripThinkTags(text) {
    return String(text || '')
        .replace(/<think>[\s\S]*?<\/think>/gi, '')
        .replace(/<think>[\s\S]*$/i, '')
        .trim();
}

function extractCompletionContent(data) {
    return stripThinkTags(extractModelText(data));
}

function shouldDisableThinking(modelCfg) {
    if (modelSupportsReasoning(modelCfg)) return true;
    const name = String(modelCfg?.model_name || modelCfg?.name || '');
    return /qwen-?3|qwq|deepseek-?r1/i.test(name);
}

function requiresSingleLeadingSystemMessage(modelCfg = {}) {
    const name = `${modelCfg?.model_name || ''} ${modelCfg?.name || ''}`.toLowerCase();
    // 仅 Qwen3.8 的官方模板已确认把非首位（包括第二条连续）的 system
    // 消息作为模板错误。不要将这一约束泛化到其他供应商，保留其原有分段语义。
    return /(?:^|[^a-z0-9])qwen[-_ ]?3[._-]?8(?:[^0-9]|$)/i.test(name);
}

function systemContentToText(content) {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
        return content.map(part => {
            if (typeof part === 'string') return part;
            if (!part || typeof part !== 'object') return '';
            return String(part.text ?? part.content ?? '');
        }).filter(Boolean).join('\n');
    }
    if (content === null || content === undefined) return '';
    return String(content);
}

/**
 * Qwen3.8 的官方 chat template 要求仅有一条 system 消息且必须位于第一位。
 * 资料检索、工具和后台编译常在组装时各自附加 system 指令；将它们稳定合并到
 * 首条，不改变 user/assistant/tool 的相对顺序，也避免本地模型拒绝整个请求。
 */
function coalesceSystemMessages(messages = []) {
    const source = Array.isArray(messages) ? messages.filter(Boolean) : [];
    const systems = source.filter(message => message?.role === 'system');
    if (!systems.length) return source;
    const first = systems[0];
    const content = systems.map(message => systemContentToText(message.content).trim()).filter(Boolean).join('\n\n');
    return [
        { ...first, role: 'system', content },
        ...source.filter(message => message?.role !== 'system')
    ];
}

function applyNoThinkSoftSwitch(messages) {
    const lastUserIndex = messages.map(message => message.role).lastIndexOf('user');
    if (lastUserIndex < 0) return messages;
    return messages.map((message, index) => {
        if (index !== lastUserIndex || typeof message.content !== 'string') return message;
        return { ...message, content: `${message.content}\n/no_think` };
    });
}

module.exports = {
    applyNoThinkSoftSwitch,
    buildThinkingControlPayload,
    coalesceSystemMessages,
    extractCompletionContent,
    requiresSingleLeadingSystemMessage,
    stripThinkTags,
    shouldDisableThinking
};
