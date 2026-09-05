// 知识库文档质量辅助：只读取文档元数据，不参与检索或模型调用。
const { query, queryOne } = require('../db/client');

async function listDuplicateKnowledgeDocuments(userId, { limit = 20 } = {}) {
    const normalizedUserId = Number.parseInt(userId, 10);
    if (!Number.isSafeInteger(normalizedUserId) || normalizedUserId <= 0) {
        return { groups: [], unhashedReady: 0 };
    }
    const safeLimit = Math.min(Math.max(Number.parseInt(limit, 10) || 20, 1), 50);
    const duplicateHashes = await query(`
        SELECT source_hash, COUNT(*) AS count
        FROM knowledge_docs
        WHERE user_id = ?
          AND deleted_at IS NULL
          AND status = 'ready'
          AND source_hash IS NOT NULL
          AND source_hash != ''
        GROUP BY source_hash
        HAVING COUNT(*) > 1
        ORDER BY COUNT(*) DESC, source_hash ASC
        LIMIT ?
    `, [normalizedUserId, safeLimit]);
    const hashes = (duplicateHashes || []).map(row => String(row.source_hash || '')).filter(Boolean);
    let documents = [];
    if (hashes.length) {
        documents = await query(`
            SELECT id, name, source_hash, source_size, collection_id, updated_at
            FROM knowledge_docs
            WHERE user_id = ? AND deleted_at IS NULL AND source_hash IN (${hashes.map(() => '?').join(',')})
            ORDER BY source_hash ASC, updated_at DESC, id DESC
        `, [normalizedUserId, ...hashes]);
    }
    const grouped = new Map(hashes.map(hash => [hash, []]));
    for (const document of documents || []) grouped.get(String(document.source_hash))?.push({
        id: document.id,
        name: document.name,
        sourceSize: Number(document.source_size || 0),
        collectionId: document.collection_id || null,
        updatedAt: document.updated_at
    });
    const unhashedRow = await queryOne(`
        SELECT COUNT(*) AS count
        FROM knowledge_docs
        WHERE user_id = ? AND deleted_at IS NULL AND status = 'ready'
          AND (source_hash IS NULL OR source_hash = '')
    `, [normalizedUserId]);
    return {
        groups: [...grouped.entries()].map(([sourceHash, docs]) => ({
            sourceHash,
            count: docs.length,
            documents: docs
        })).filter(group => group.count > 1),
        unhashedReady: Number(unhashedRow?.count || 0)
    };
}

module.exports = { listDuplicateKnowledgeDocuments };
