'use strict';

const { normalizeRetrievalScope } = require('./rag-index/retrieval-scope-builder');

async function resolveChatKnowledgeSelection(state, user, messageId, deps = {}) {
    const overrides = state.routeOverrides || {};
    if (overrides.excludeRag === true) return { scope: { collectionIds: [], tagNames: [], cleared: true }, explicit: true };
    const selected = overrides.collections?.length || overrides.tagNames?.length || state.ragScope?.collectionIds?.length || state.ragScope?.collectionId || state.ragScope?.tagNames?.length;
    let scope = selected ? normalizeRetrievalScope({ ...state.ragScope,
        ...(overrides.collections?.length ? { collectionIds: overrides.collections } : {}), ...(overrides.tagNames?.length ? { tagNames: overrides.tagNames } : {}) }) : null;
    const followUp = /(?:这个|该|上述|上面|当前|此)(?:的)?(?:知识库|专题库|专题|资料库)/u.test(state.modelContent || '');
    if (!scope && followUp) scope = await (deps.latestKnowledgeScope || require('../repositories/chat-conversation-turns').latestKnowledgeScope)(state.sessionId, user.id, messageId);
    if (!scope) return null;
    if (scope.cleared) throw Object.assign(new Error('本会话已清除资料范围，请重新选择专题。'), { code: 'KNOWLEDGE_SCOPE_DENIED', status: 403 });
    const get = deps.getCollectionForUser || require('../repositories/knowledge').getCollectionForUser;
    for (const id of scope.collectionIds || []) if (!await get(id, user)) throw Object.assign(new Error('所选资料范围已不可用，请重新选择。'), { code: 'KNOWLEDGE_SCOPE_DENIED', status: 403 });
    return { scope, explicit: Boolean(selected), inherited: !selected };
}

module.exports = { resolveChatKnowledgeSelection };
