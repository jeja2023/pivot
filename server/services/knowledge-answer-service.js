'use strict';

const { debugRetrieveContext } = require('./rag-index');
const { buildKnowledgeRetrievalPlan } = require('./knowledge-query-planner');
const { mergeRagContexts } = require('./chat-rag-context');

function mergeKnowledgeMatches(retrievals = []) {
    const merged = new Map();
    (Array.isArray(retrievals) ? retrievals : []).forEach((retrieval, queryIndex) => {
        (Array.isArray(retrieval?.matches) ? retrieval.matches : []).forEach((match, rank) => {
            const chunkId = Number.parseInt(match?.chunkId, 10);
            if (!Number.isSafeInteger(chunkId) || chunkId <= 0) return;
            const current = merged.get(chunkId) || {
                ...match,
                retrievalQueryIndexes: [],
                multiQueryScore: 0
            };
            current.multiQueryScore += 1 / (20 + rank + 1) + (match.selected ? 0.1 : 0);
            if (!current.retrievalQueryIndexes.includes(queryIndex)) current.retrievalQueryIndexes.push(queryIndex);
            current.selected = current.selected || match.selected === true;
            merged.set(chunkId, current);
        });
    });
    return [...merged.values()].sort((left, right) => (
        Number(right.selected) - Number(left.selected)
        || Number(right.multiQueryScore || 0) - Number(left.multiQueryScore || 0)
        || Number(left.rank || 9999) - Number(right.rank || 9999)
        || Number(left.chunkId) - Number(right.chunkId)
    ));
}

// 正式问答与检索诊断共享规划结果，但正式问答只消费通过门控的 selected 证据。
async function retrieveKnowledgeEvidence({
    user,
    query = '',
    scope = {},
    topK = null,
    candidateLimit = null,
    scoreThreshold = null,
    retrieve = debugRetrieveContext
} = {}) {
    const plan = buildKnowledgeRetrievalPlan({ question: query });
    const retrievals = await Promise.all(plan.retrievalQueries.slice(0, 3).map(retrievalQuery => retrieve(user?.id, retrievalQuery, {
        topK,
        candidateLimit,
        scoreThreshold,
        scope,
        user
    })));
    const matches = mergeKnowledgeMatches(retrievals);
    const injectedContext = mergeRagContexts(retrievals.map(result => result?.injectedContext || ''), { maxCitations: 12 });
    const selected = matches.filter(match => match.selected);
    return {
        plan,
        matches,
        selected,
        injectedContext,
        candidateCount: new Set(matches.map(match => match.chunkId)).size,
        retrievalModes: [...new Set(retrievals.map(result => result?.ranking?.mode || 'unknown'))],
        scope: retrievals[0]?.scope || scope,
        retrievals
    };
}

module.exports = {
    retrieveKnowledgeEvidence
};
