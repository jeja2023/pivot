const assert = require('node:assert/strict');
const test = require('node:test');
const {
    buildPlannerMessages,
    chatHistoryMessages
} = require('../server/services/agent-runtime/planner');
const {
    buildChatAgentMetadata,
    normalizeChatHistory
} = require('../server/services/chat-agent-bridge');

test('普通聊天 Agent 规划器携带最近会话历史并保留工具观察', () => {
    const history = chatHistoryMessages({
        chatHistory: [
            { role: 'system', content: '不要带入系统消息' },
            { role: 'user', content: '上一个问题' },
            { role: 'assistant', content: '上一个回答' }
        ]
    });
    assert.deepEqual(history, [
        { role: 'user', content: '上一个问题' },
        { role: 'assistant', content: '上一个回答' }
    ]);

    const messages = buildPlannerMessages(
        '继续完成当前任务',
        [{ name: 'agent.http', description: 'HTTP' }],
        [{ step: 1, tool: 'agent.http', output: { ok: true } }],
        'standard',
        { mode: 'recent', chatHistory: history }
    );
    assert.equal(messages[1].content, '上一个问题');
    assert.equal(messages[2].content, '上一个回答');
    assert.match(messages[3].content, /PIVOT_MCP_TOOL_RESULT_BEGIN/);
    assert.equal(messages.at(-1).role, 'user');
});

test('普通聊天 Agent 桥接保留图片消息、当前消息和记忆/RAG上下文', () => {
    const metadata = buildChatAgentMetadata({
        sessionId: 'session-1',
        userMessageId: 12,
        currentContent: '请分析附件 ![图](/uploads/image.png)',
        history: [{ role: 'user', content: '历史问题' }],
        memoryContext: 'PIVOT_LONG_TERM_MEMORY_BEGIN\n偏好：中文\nPIVOT_LONG_TERM_MEMORY_END',
        ragContext: 'PIVOT_RAG_CONTEXT_BEGIN\n资料：内部规范\nPIVOT_RAG_CONTEXT_END',
        ragEnabled: true
    });
    assert.equal(metadata.chatBridge.sessionId, 'session-1');
    assert.equal(metadata.chatBridge.currentMessage.content, '请分析附件 ![图](/uploads/image.png)');
    assert.match(metadata.chatBridge.memoryContext, /偏好/);
    assert.match(metadata.chatBridge.ragContext, /内部规范/);

    const multimodal = normalizeChatHistory([
        { role: 'user', content: [{ type: 'text', text: '看图' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,abc' } }] }
    ]);
    assert.equal(multimodal[0].content[1].type, 'image_url');
    const messages = buildPlannerMessages('分析图片', [], [], 'standard', {
        chatHistory: multimodal,
        chatAgent: {
            ...metadata.chatBridge,
            currentMessage: { role: 'user', content: [{ type: 'text', text: '请分析附件' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,abc' } }] }
        }
    });
    assert.equal(messages[1].content[0].text, '看图');
    assert.match(messages.at(-1).content[0].text, /分析图片/);
    assert.match(messages.map(message => JSON.stringify(message.content)).join('\n'), /PIVOT_RAG_CONTEXT_BEGIN/);
});
