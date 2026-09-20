'use strict';

/*
 * 项目上下文包不是新的资料副本：它只是一次 Run 对用户已授权知识库集合的
 * 显式选择和可审计快照。检索时仍由 RAG ACL 二次判断，因此共享权限回收会
 * 立即生效，不会因旧任务快照扩大访问范围。
 */
const { listKnowledgeCollections } = require('./rag-documents');
const { normalizeContextConfig } = require('./agent-validators');

async function resolveAgentContextPack(user, rawContextConfig = {}) {
    const contextConfig = normalizeContextConfig(rawContextConfig);
    if (!contextConfig.collectionIds.length) return { contextConfig, pack: null };
    const accessible = await listKnowledgeCollections(user);
    const availableById = new Map(accessible.map(collection => [Number(collection.id), collection]));
    const missing = contextConfig.collectionIds.filter(id => !availableById.has(id));
    if (missing.length) {
        const error = new Error('选择的项目资料包不存在、已撤销授权或不再可用。');
        error.code = 'AGENT_CONTEXT_PACK_ACCESS_DENIED';
        error.status = 403;
        throw error;
    }
    const collections = contextConfig.collectionIds.map(id => availableById.get(id)).map(collection => ({
        id: Number(collection.id),
        name: String(collection.name || '').slice(0, 180),
        updatedAt: collection.updated_at || null,
        documentCount: Number(collection.doc_count || 0),
        readyCount: Number(collection.ready_count || 0),
        chunkCount: Number(collection.chunk_count || 0)
    }));
    return {
        contextConfig,
        pack: {
            version: 1,
            collectionIds: contextConfig.collectionIds,
            collections,
            snapshotAt: new Date().toISOString()
        }
    };
}

module.exports = { resolveAgentContextPack };
