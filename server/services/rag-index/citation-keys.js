'use strict';

async function attachCitationKeys(chunks = [], { knowledgeRepository, logger }) {
    const list = Array.isArray(chunks) ? chunks : [];
    const ids = list.map(item => Number.parseInt(item?.chunkId, 10)).filter(id => Number.isSafeInteger(id) && id > 0);
    if (!ids.length || typeof knowledgeRepository.listCitationKeysByChunkIds !== 'function') return list;
    try {
        const rows = await knowledgeRepository.listCitationKeysByChunkIds(ids);
        const byChunkId = new Map();
        for (const row of rows || []) {
            const chunkId = Number.parseInt(row.legacy_chunk_id, 10);
            if (Number.isSafeInteger(chunkId) && !byChunkId.has(chunkId)) byChunkId.set(chunkId, String(row.citation_key || ''));
        }
        return list.map(item => ({ ...item, citationKey: byChunkId.get(Number(item.chunkId)) || '' }));
    } catch (error) {
        logger.warn({ err: error.message }, 'RAG citation key 映射失败，继续使用兼容来源文本');
        return list;
    }
}

module.exports = { attachCitationKeys };
