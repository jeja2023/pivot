const { queryOne, execute, transaction } = require('../db/client');
const { logger } = require('../logger');
const { getBeijingTimestamp } = require('../time');
const { clearKnowledgeGraphForDocument } = require('./knowledge-graph');

async function createKnowledgeIndexStage({ doc, userId }) {
    const now = getBeijingTimestamp();
    return await queryOne(`
        INSERT INTO knowledge_docs (
            user_id, collection_id, name, status, is_enabled, chunk_count, indexed_chunks, progress,
            error_message, source_path, source_size, source_hash, created_at, updated_at
        ) VALUES (?, ?, ?, 'processing', 0, 0, 0, 0, '', ?, ?, ?, ?, ?)
        RETURNING id
    `, [userId, doc.collection_id || null, doc.name, doc.source_path || '', Number(doc.source_size || 0), doc.source_hash || '', now, now]);
}

async function discardKnowledgeIndexStage(stageId) {
    if (!stageId) return;
    try { await clearKnowledgeGraphForDocument(stageId); } catch (error) {
        logger.warn({ err: error.message, docId: stageId }, '清理知识库暂存图谱失败');
    }
    await execute('DELETE FROM knowledge_docs WHERE id = ?', [stageId]);
}

async function swapKnowledgeIndexStage({ docId, stageId, userId, chunkCount, sourceHash }) {
    const now = getBeijingTimestamp();
    await transaction(async trx => {
        const oldChunks = await trx.query('SELECT id FROM knowledge_chunks WHERE doc_id = ?', [docId]);
        const oldIds = oldChunks.map(row => row.id).filter(Boolean);
        if (oldIds.length) {
            const placeholders = oldIds.map(() => '?').join(',');
            await trx.execute(`DELETE FROM knowledge_relations WHERE source_chunk_id IN (${placeholders})`, oldIds);
            await trx.execute(`DELETE FROM knowledge_entity_mentions WHERE chunk_id IN (${placeholders})`, oldIds);
        }
        await trx.execute('DELETE FROM knowledge_chunks WHERE doc_id = ?', [docId]);
        await trx.execute('UPDATE knowledge_chunks SET doc_id = ? WHERE doc_id = ?', [docId, stageId]);
        await trx.execute('UPDATE knowledge_entity_mentions SET doc_id = ? WHERE doc_id = ?', [docId, stageId]);
        await trx.execute('UPDATE knowledge_relations SET source_doc_id = ? WHERE source_doc_id = ?', [docId, stageId]);
        await trx.execute('UPDATE knowledge_entities SET source_doc_id = ? WHERE source_doc_id = ?', [docId, stageId]);
        await trx.execute(`
            UPDATE knowledge_docs
            SET status = 'ready', is_enabled = 1, chunk_count = ?, indexed_chunks = ?, progress = 100,
                error_message = '', source_hash = ?, processed_at = ?, updated_at = ?
            WHERE id = ? AND user_id = ? AND deleted_at IS NULL
        `, [chunkCount, chunkCount, sourceHash || '', now, now, docId, userId]);
        await trx.execute('DELETE FROM knowledge_docs WHERE id = ?', [stageId]);
    });
}

module.exports = { createKnowledgeIndexStage, discardKnowledgeIndexStage, swapKnowledgeIndexStage };
