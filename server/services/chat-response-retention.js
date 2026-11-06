'use strict';

const { estimateTokens, sanitizeUserVisibleText } = require('../llm');

// 只保留已通过公开输出链路的正文；未核验的知识库回答、内部状态和工具参数不进入中止记录。
function createRetainedChatResponse({ res, enabled = true, options, persist, log }) {
    let chunks = [];
    let closed = false;
    let persistence = null;
    const write = input => {
        if (!persistence) { chunks = []; persistence = Promise.resolve().then(() => persist(input)); }
        return persistence;
    };
    const capture = payload => {
        if (!enabled || closed || persistence || typeof payload !== 'string' || !payload.startsWith('{')) return;
        try {
            const event = JSON.parse(payload);
            if (!event.type && !event.error && typeof event.content === 'string') chunks.push(event.content);
        } catch (_) { /* 非正文协议帧不参与部分回复恢复。 */ }
    };
    const close = () => {
        closed = true;
        res.removeListener('finish', finish);
        if (!enabled || res.writableEnded || persistence) { chunks = []; return; }
        const content = sanitizeUserVisibleText(chunks.join('')).trim();
        chunks = [];
        if (!content) return;
        const context = options();
        const assistantContent = `${content}\n\n[生成已中止，以上为未完成回复]`;
        write({ ...context, assistantContent, assistantTokens: estimateTokens(assistantContent), interrupted: true,
            skipMemoryExtraction: true, skipTitleGeneration: true, routeMetadata: { generation: { status: 'interrupted', partial: true } } })
            .catch(error => log?.warn?.({ sessionId: context.sessionId, userId: context.userId, code: error.code }, '中止回复保存失败，用户已收到的正文暂未写入历史'));
    };
    const finish = () => { closed = true; chunks = []; res.removeListener('close', close); };
    res.once('close', close);
    res.once('finish', finish);
    write.capture = capture;
    return write;
}

module.exports = { createRetainedChatResponse };
