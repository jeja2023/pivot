'use strict';

const { execute, transaction } = require('../db/client');
const { getBeijingTimestamp } = require('../time');
const { lockCurrentKnowledgeLease } = require('./knowledge-ingestion-lease');

async function applyStatus({ docId, userId, lease }, change) {
    if (!lease) return change({ execute });
    return transaction(async trx => {
        const held = await lockCurrentKnowledgeLease(trx, { ...lease, docId, userId });
        if (!held) throw Object.assign(new Error('知识库索引任务租约已失效，不能修改文档状态。'), { code: 'KNOWLEDGE_JOB_LEASE_LOST' });
        return change(trx);
    });
}

async function markKnowledgeDocumentError({ docId, userId, error, lease = null }) {
    const now = getBeijingTimestamp();
    const result = await applyStatus({ docId, userId, lease }, trx => trx.execute(`
        UPDATE knowledge_docs SET status = ?, progress = 0, error_message = ?, processed_at = ?, updated_at = ?
        WHERE id = ? AND user_id = ? AND deleted_at IS NULL
    `, ['error', String(error?.message || error || '知识库索引失败').slice(0, 1000), now, now, docId, userId]));
    return Number(result || 0) > 0;
}

async function markKnowledgeDocumentRebuildError({ docId, userId, error, lease = null }) {
    const now = getBeijingTimestamp();
    const result = await applyStatus({ docId, userId, lease }, trx => trx.execute(`
        UPDATE knowledge_docs SET status = CASE WHEN status = 'lexical_ready' THEN 'lexical_ready' ELSE 'ready' END,
            error_message = ?, processed_at = COALESCE(processed_at, ?), updated_at = ?
        WHERE id = ? AND user_id = ? AND deleted_at IS NULL
    `, [`重建失败，继续使用旧索引：${String(error?.message || error || '知识库索引失败').slice(0, 900)}`, now, now, docId, userId]));
    return Number(result || 0) > 0;
}

module.exports = { markKnowledgeDocumentError, markKnowledgeDocumentRebuildError };
