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
    extractCompletionContent,
    stripThinkTags,
    shouldDisableThinking
};
