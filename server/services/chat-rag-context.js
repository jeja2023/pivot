function buildRagContextMessage(ragContext) {
    return [
        'PIVOT_RAG_CONTEXT_BEGIN',
        '【知识库检索结果】',
        String(ragContext || '').trim(),
        '',
        '【回答要求】',
        '1. 本轮必须优先依据以上知识库检索结果回答。',
        '2. 如果知识库内容与通用知识、历史会话或模型记忆冲突，以知识库内容为准。',
        '3. 如果知识库内容不足以回答，请明确说明“知识库中未找到足够依据”，不要自行编造。',
        '4. 回答中尽量标注引用来源，例如“引用 1 / 来源: 文件名”。',
        'PIVOT_RAG_CONTEXT_END'
    ].join('\n');
}

function injectRagContextBeforeLatestUser(history, ragContext) {
    if (!ragContext) return history;
    const nextHistory = Array.isArray(history) ? history.slice() : [];
    const ragMessage = { role: 'user', content: buildRagContextMessage(ragContext) };
    for (let i = nextHistory.length - 1; i >= 0; i -= 1) {
        if (nextHistory[i]?.role === 'user') {
            nextHistory.splice(i, 0, ragMessage);
            return nextHistory;
        }
    }
    nextHistory.push(ragMessage);
    return nextHistory;
}

module.exports = {
    buildRagContextMessage,
    injectRagContextBeforeLatestUser
};
