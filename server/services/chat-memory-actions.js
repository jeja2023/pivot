'use strict';

const { applyMemoryIntent, previewMemoryIntent } = require('./agent-memory-intents');
const { getAgentLearningSettings } = require('./agent-learning');
const { getMemoryPolicy } = require('./memory-governance');
const { isLongTermMemoryEnabled, listMemories, updateMemory } = require('./long-term-memory');

function normalizeChatMemoryRequest(prompt) {
    const text = String(prompt || '').trim().replace(/^不对[，,。 ]*/, '').replace(/^(?:请|帮我)/, '');
    const scoped = /(?:只|仅)(?:用于|在|限于)(?:当前|这个|本)(?:项目|会话)/.test(text);
    const content = text.replace(/(?:[，,。；;]?)(?:这个口径)?(?:只|仅)(?:用于|在|限于)(?:当前|这个|本)(?:项目|会话)[。！!]?$/, '').trim();
    if (/^(?:以后|今后|下次)(?!记住|按)/.test(content)) return { text: `记住用户偏好：${content.replace(/^(?:以后|今后|下次)/, '')}`, scoped };
    return { text: content.replace(/^忘掉/, '忘记'), scoped };
}

async function handleChatMemoryRequest({ prompt, user, sessionId, userMessageId, projectId = `session:${sessionId}` }, deps = {}) {
    const normalized = normalizeChatMemoryRequest(prompt);
    const forget = /^(?:请)?(?:忘记|不要再用|不再记住)/.test(normalized.text);
    const settings = await (deps.getAgentLearningSettings || getAgentLearningSettings)(user.id);
    const policy = await (deps.getMemoryPolicy || getMemoryPolicy)(user.id);
    if (!forget && (!settings.autoLearning || !policy.autoCapture || !await (deps.isLongTermMemoryEnabled || isLongTermMemoryEnabled)(user.id))) {
        return { content: '本轮会按你的要求调整。持续学习或自动记忆目前已关闭，因此这次没有保存长期偏好。', stored: false };
    }
    const subject = /报告/.test(prompt) ? 'report' : 'answer';
    const dimension = /中文|英文|语言/.test(prompt) ? 'language' : /表格|列表|格式/.test(prompt) ? 'format' : /先|开头|顺序/.test(prompt) ? 'order' : '';
    const options = { sourceSessionId: sessionId, sourceMessageIds: [userMessageId], scope: normalized.scoped ? 'project' : 'user', projectId, sessionId,
        factKey: dimension ? `preference:${subject}:${dimension}` : '' };
    if (/^这个口径只用于当前项目[。！!]?$/u.test(prompt.trim())) {
        const list = await (deps.listMemories || listMemories)(user.id, { status: 'active', search: sessionId, limit: 50 });
        const latest = list.memories.filter(item => item.type === 'preference').sort((left, right) => Number(right.id) - Number(left.id))[0];
        if (!latest) return { content: '当前会话没有找到需要收窄范围的偏好，请说明具体口径。', stored: false };
        await (deps.updateMemory || updateMemory)(user.id, latest.id, { scope: 'project', projectId, scopeReference: projectId }, { user });
        return { content: '已将刚才的偏好收窄到当前项目，其他项目不会再使用。', stored: true };
    }
    let memoryId;
    if (/^忘记(?:刚才|刚刚|上一个)(?:那个|的|这个)?(?:偏好|记忆)[。！!]?$/u.test(normalized.text)) {
        const list = await (deps.listMemories || listMemories)(user.id, { status: 'active', search: sessionId, limit: 20 });
        const latest = list.memories.filter(item => item.type === 'preference').sort((left, right) => Number(right.id) - Number(left.id))[0];
        if (!latest) return { content: '当前会话没有找到可明确对应的偏好，请说明要忘记的内容。', stored: false };
        memoryId = latest.id;
    }
    const preview = await (deps.previewMemoryIntent || previewMemoryIntent)(user, normalized.text, { ...options, memoryId });
    if (preview.requiresSelection && !memoryId) return { content: preview.candidates.length ? '有多条偏好与该描述相符，请具体说明要更正或忘记哪一条。' : '没有找到可对应的偏好，请具体说明内容。', stored: false };
    const result = await (deps.applyMemoryIntent || applyMemoryIntent)(user, { ...options, text: normalized.text, memoryId });
    return { content: `${result.message}${normalized.scoped ? '适用范围仅限当前项目。' : ''}`, stored: true, action: result.action, memoryId: result.memoryId || result.result?.id };
}

module.exports = { handleChatMemoryRequest, normalizeChatMemoryRequest };
