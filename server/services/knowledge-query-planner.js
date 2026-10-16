'use strict';

const { buildRagRequiredTerms } = require('./rag-tokenizer');

const FOLLOW_UP_RE = /^(?:那|那这个|这个|这个流程|这个规则|该规则|该流程|上述|上面|其|它|他们|这个期限|具体呢|然后|还要|还包括|是否)(?:[^\n]{0,32})[？?！!。]?$|^(?:期限|条件|材料|流程|责任|处罚|例外|标准|范围|时间|要求)(?:呢|是什么|如何|有哪些)?[？?！!。]?$/u;

function normalizeKnowledgeQuestion(value, maxLength = 4000) {
    return String(value || '').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function isLikelyKnowledgeFollowUp(value) {
    const text = normalizeKnowledgeQuestion(value, 160).replace(/\s+/g, '');
    return text.length > 0 && (text.length <= 18 || FOLLOW_UP_RE.test(text));
}

function getPreviousUserQuestion(history = []) {
    const messages = Array.isArray(history) ? history : [];
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index];
        if (message?.role !== 'user') continue;
        const text = normalizeKnowledgeQuestion(message.content, 1200);
        if (!text || text.includes('PIVOT_RAG_CONTEXT_BEGIN') || text.includes('PIVOT_RAG_INSUFFICIENT_BEGIN')) continue;
        return text;
    }
    return '';
}

function buildKnowledgeRetrievalPlan({ question = '', history = [] } = {}) {
    const currentQuestion = normalizeKnowledgeQuestion(question);
    const previousQuestion = getPreviousUserQuestion(history);
    const followUp = isLikelyKnowledgeFollowUp(currentQuestion) && Boolean(previousQuestion);
    const rewrittenQuery = followUp
        ? normalizeKnowledgeQuestion(`${previousQuestion}；追问：${currentQuestion}`, 4000)
        : currentQuestion;
    const subQueries = rewrittenQuery
        .split(/[；;。]|(?:并且|以及|分别)/u)
        .map(item => normalizeKnowledgeQuestion(item, 800))
        .filter(item => item.length >= 6);
    const requiredTerms = buildRagRequiredTerms(rewrittenQuery);
    const retrievalQueries = [...new Set([rewrittenQuery, ...requiredTerms, ...subQueries].filter(Boolean))].slice(0, 3);
    return {
        originalQuery: currentQuestion,
        rewrittenQuery,
        previousQuestion,
        followUpResolved: followUp,
        requiredTerms,
        retrievalQueries
    };
}

module.exports = {
    buildKnowledgeRetrievalPlan
};
