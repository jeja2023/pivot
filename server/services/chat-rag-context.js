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

function summarizeRagContextSources(ragContext, limit = 3) {
    const text = String(ragContext || '');
    const seen = new Set();
    const sources = [];
    const citationPattern = /\[引用\s+(\d+)\s*\|\s*来源:\s*([^\]\n]+)\]/g;
    let match = null;
    while ((match = citationPattern.exec(text)) !== null) {
        const source = String(match[2] || '').trim();
        if (!source || seen.has(source)) continue;
        seen.add(source);
        sources.push(source);
    }

    return {
        citationCount: (text.match(/\[引用\s+\d+/g) || []).length,
        sourceCount: seen.size,
        sources: sources.slice(0, Math.max(1, Number(limit) || 3))
    };
}

module.exports = {
    buildRagContextMessage,
    injectRagContextBeforeLatestUser,
    summarizeRagContextSources
};
