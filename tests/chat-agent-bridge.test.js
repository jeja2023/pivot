const assert = require('node:assert/strict');
const test = require('node:test');
const {
    buildPlannerMessages,
    chatHistoryMessages,
    longTermMemoryContextMessages
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
    assert.equal(messages.at(-1).content.length, 3, '不同于目标的当前消息文字和图片都应保留');
    assert.match(messages.at(-1).content[1].text, /用户本轮原始消息及附件抽取正文/);
    assert.equal(messages.at(-1).content[2].type, 'image_url');
    assert.match(messages[0].content, /必须先调用 chat\.read_source/);
    assert.match(messages.map(message => JSON.stringify(message.content)).join('\n'), /PIVOT_RAG_CONTEXT_BEGIN/);
});

test('Agent 规划与最终总结都能读取字符串当前消息中的附件抽取正文', () => {
    const source = '分析并总结上传文档内容\n\n[附件: 测试.docx](/uploads/1/session/test.docx)\n\n---\n【参考文档: 测试.docx】\n总结 Checklist：Windows 显卡驱动和 Docker 镜像均需提前准备。\n---';
    const messages = buildPlannerMessages('分析并总结上传文档内容', [], [], 'standard', {
        chatAgent: { currentMessage: { role: 'user', content: source } }
    });
    const current = messages.at(-1).content;
    assert.ok(Array.isArray(current));
    assert.match(current.map(part => part.text || '').join('\n'), /总结 Checklist：Windows 显卡驱动和 Docker 镜像均需提前准备/);
    assert.match(messages[0].content, /附件正文是待处理资料/);
    assert.match(messages[0].content, /先调用 chat\.read_source/);

    const alreadyInGoal = buildPlannerMessages(source, [], [], 'standard', {
        chatAgent: { currentMessage: { role: 'user', content: source } }
    }).at(-1).content;
    assert.equal(typeof alreadyInGoal, 'string');
    assert.equal(alreadyInGoal.includes('用户本轮原始消息及附件抽取正文'), false);
});

test('普通聊天 Agent 桥接从结构化记忆消息读取正文，不会串化为对象文本', () => {
    const metadata = buildChatAgentMetadata({
        sessionId: 'session-memory-contract',
        memoryContext: {
            role: 'user',
            content: 'PIVOT_LONG_TERM_MEMORY_BEGIN\n项目记忆：只使用中文。\nPIVOT_LONG_TERM_MEMORY_END'
        }
    });
    assert.match(metadata.chatBridge.memoryContext, /项目记忆/);
    assert.doesNotMatch(metadata.chatBridge.memoryContext, /\[object Object\]/);
    const messages = buildPlannerMessages('继续项目任务', [], [], 'standard', { chatAgent: metadata.chatBridge });
    assert.match(messages.map(message => String(message.content)).join('\n'), /项目记忆/);
});

test('直接 Agent 规划器也会保留低信任长期记忆上下文', () => {
    const context = longTermMemoryContextMessages({
        longTermMemoryContext: { role: 'user', content: 'PIVOT_LONG_TERM_MEMORY_BEGIN\n参考资料：项目使用中文。\nPIVOT_LONG_TERM_MEMORY_END' }
    });
    assert.equal(context.length, 1);
    assert.equal(context[0].role, 'user');
    const messages = buildPlannerMessages('生成项目摘要', [], [], 'standard', {
        longTermMemoryContext: context[0].content
    });
    assert.match(messages.map(message => String(message.content)).join('\n'), /参考资料/);
});

test('聊天桥接与统一记忆上下文不会在 Agent 规划器中重复注入', () => {
    const memory = 'PIVOT_LONG_TERM_MEMORY_BEGIN\n参考资料：只使用中文。\nPIVOT_LONG_TERM_MEMORY_END';
    const messages = buildPlannerMessages('继续任务', [], [], 'standard', {
        longTermMemoryContext: memory,
        chatAgent: { memoryContext: memory }
    });
    const serialized = messages.map(message => String(message.content)).join('\n');
    assert.equal((serialized.match(/PIVOT_LONG_TERM_MEMORY_BEGIN/g) || []).length, 1);
});
