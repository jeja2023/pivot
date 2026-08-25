const { estimateTokens } = require('../../llm');
const { buildKeywordCandidates } = require('../rag-index');
const {
    MEMORY_TYPE_LABELS,
    DEFAULT_RETRIEVAL_BUDGET_RATIO,
    MIN_RETRIEVAL_BUDGET_RATIO,
    MAX_RETRIEVAL_BUDGET_RATIO,
    clamp,
    normalizeMemoryType
} = require('./memory-utils');

function parseEmbedding(raw) {
    if (!raw) return null;
    try {
        const vector = JSON.parse(raw);
        return Array.isArray(vector) ? vector.map(Number).filter(Number.isFinite) : null;
    } catch (_err) {
        return null;
    }
}

function keywordScore(memory, query) {
    const terms = buildKeywordCandidates(query, 24);
    if (terms.length === 0) return 0;
    const haystack = `${memory.content || ''} ${memory.type || ''}`.toLowerCase();
    let matched = 0;
    let total = 0;
    terms.forEach(term => {
        const text = String(term || '').toLowerCase();
        const weight = Math.min(text.length, 8) || 1;
        total += weight;
        if (text && haystack.includes(text)) matched += weight;
    });
    return total > 0 ? matched / total : 0;
}

function recencyScore(memory) {
    const raw = memory.last_used_at || memory.updated_at || memory.created_at;
    const time = raw ? Date.parse(String(raw).replace(' ', 'T')) : 0;
    if (!Number.isFinite(time) || time <= 0) return 0.2;
    const ageDays = Math.max(0, (Date.now() - time) / 86400000);
    return 1 / (1 + ageDays / 30);
}

function buildLongTermMemoryContextMessage(memories = [], options = {}) {
    if (!Array.isArray(memories) || memories.length === 0) return null;
    const ratio = clamp(
        options.budgetRatio,
        MIN_RETRIEVAL_BUDGET_RATIO,
        MAX_RETRIEVAL_BUDGET_RATIO,
        DEFAULT_RETRIEVAL_BUDGET_RATIO
    );
    const inputBudget = Math.max(0, Number(options.inputBudget || 0));
    const maxTokens = inputBudget > 0
        ? Math.max(256, Math.floor(inputBudget * ratio))
        : Math.max(512, Number(options.maxTokens || 1200));
    const header = [
        'PIVOT_LONG_TERM_MEMORY_BEGIN',
        '以下为跨会话长期记忆，按相关性、近期性和重要性排序；仅在与当前问题相关时使用，不要向用户暴露记忆编号或内部字段。'
    ];
    const lines = [];
    let used = estimateTokens(header.join('\n') + '\nPIVOT_LONG_TERM_MEMORY_END');
    for (const memory of memories) {
        const label = MEMORY_TYPE_LABELS[normalizeMemoryType(memory.type)] || '历史片段';
        const reason = String(memory.usageReason || memory.usage_reason || '').trim();
        const line = `- [${label} | 重要度 ${Number(memory.salience || 0).toFixed(2)} | 置信度 ${Number(memory.confidence || 0).toFixed(2)}${reason ? ` | 使用原因：${reason}` : ''}] ${memory.content}`;
        const next = estimateTokens(`${line}\n`);
        if (used + next > maxTokens) break;
        lines.push(line);
        used += next;
    }
    if (lines.length === 0) return null;
    return {
        role: 'system',
        content: [...header, ...lines, 'PIVOT_LONG_TERM_MEMORY_END'].join('\n'),
        metadata: {
            type: 'long_term_memory',
            memoryCount: lines.length,
            budgetTokens: maxTokens,
            usageReasons: memories.slice(0, lines.length).map(memory => ({ id: memory.id || null, reason: memory.usageReason || memory.usage_reason || '与当前任务语义相关' }))
        }
    };
}

function injectLongTermMemoryBeforeLatestUser(messages = [], memoryMessage = null) {
    if (!memoryMessage) return messages;
    const output = Array.isArray(messages) ? messages.slice() : [];
    for (let i = output.length - 1; i >= 0; i -= 1) {
        if (output[i]?.role === 'user') {
            output.splice(i, 0, memoryMessage);
            return output;
        }
    }
    output.push(memoryMessage);
    return output;
}

module.exports = {
    parseEmbedding,
    keywordScore,
    recencyScore,
    buildLongTermMemoryContextMessage,
    injectLongTermMemoryBeforeLatestUser
};
