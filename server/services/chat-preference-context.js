'use strict';

const crypto = require('crypto');
const { listKnowledgeCollections } = require('./rag-documents');

async function resolveChatProject(user, sessionId, ragScope = {}) {
    const ids = [...new Set([...(Array.isArray(ragScope.collectionIds) ? ragScope.collectionIds : []), ragScope.collectionId].map(Number).filter(id => Number.isSafeInteger(id) && id > 0))].sort((left, right) => left - right);
    if (!ids.length) return { projectId: `session:${sessionId}`, label: '当前会话项目' };
    const visible = new Set((await listKnowledgeCollections(user)).map(item => Number(item.id)));
    if (ids.some(id => !visible.has(id))) throw Object.assign(new Error('项目资料范围已撤销或无权访问，请重新选择资料。'), { code: 'CHAT_PROJECT_SCOPE_DENIED' });
    const digest = crypto.createHash('sha256').update(ids.join(',')).digest('hex').slice(0, 32);
    return { projectId: `collections:${digest}`, label: '当前资料项目' };
}

module.exports = { resolveChatProject };
