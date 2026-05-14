const { db } = require('../db');
const { logger } = require('../logger');
const { removeAttachmentFiles } = require('../security');

function normalizeRetentionDays(days) {
    const value = Number.parseInt(days, 10);
    return Number.isFinite(value) && value >= 1 ? value : 30;
}

function normalizeBatchSize(limit) {
    const value = Number.parseInt(limit, 10);
    if (!Number.isFinite(value) || value < 1) return 100;
    return Math.min(value, 1000);
}

function cleanupPurgedAttachmentRows(rows) {
    if (rows.length === 0) return 0;
    const clearAttachment = db.prepare(`
        UPDATE attachments
        SET file_path = '',
            file_size = 0,
            access_token = NULL,
            expires_at = NULL
        WHERE id = ?
    `);
    const tx = db.transaction((items) => {
        for (const item of items) clearAttachment.run(item.id);
    });
    tx(rows);
    return rows.length;
}

function cleanupPurgedKnowledgeDocs(rows) {
    if (rows.length === 0) return 0;
    const deleteChunks = db.prepare('DELETE FROM knowledge_chunks WHERE doc_id = ?');
    const clearDoc = db.prepare(`
        UPDATE knowledge_docs
        SET status = 'purged',
            is_enabled = 0,
            chunk_count = 0,
            indexed_chunks = 0,
            progress = 0,
            source_path = '',
            source_size = 0,
            error_message = ''
        WHERE id = ?
    `);
    const tx = db.transaction((items) => {
        for (const item of items) {
            deleteChunks.run(item.id);
            clearDoc.run(item.id);
        }
    });
    tx(rows);
    return rows.length;
}

function cleanupPurgedMessages(rows) {
    if (rows.length === 0) return 0;
    const deleteMessage = db.prepare('DELETE FROM messages WHERE id = ?');
    const tx = db.transaction((items) => {
        for (const item of items) deleteMessage.run(item.id);
    });
    tx(rows);
    return rows.length;
}

function filterRowsWithRemovedFiles(rows, cleanupResults) {
    const failedIds = new Set(
        cleanupResults
            .filter(result => result.ok === false)
            .map(result => result.id)
    );
    return rows.filter(row => !failedIds.has(row.id));
}

function cleanupSoftDeletedStorage({ retentionDays, limit } = {}) {
    const safeRetentionDays = normalizeRetentionDays(retentionDays ?? process.env.STORAGE_GC_RETENTION_DAYS);
    const safeLimit = normalizeBatchSize(limit ?? process.env.STORAGE_GC_BATCH_SIZE);
    const cutoffModifier = `-${safeRetentionDays} days`;

    const attachments = db.prepare(`
        SELECT id, file_path
        FROM attachments
        WHERE deleted_at IS NOT NULL
          AND deleted_at < datetime('now', '+8 hours', ?)
          AND file_path IS NOT NULL
          AND file_path != ''
        ORDER BY deleted_at ASC
        LIMIT ?
    `).all(cutoffModifier, safeLimit);

    const knowledgeDocs = db.prepare(`
        SELECT id, source_path AS file_path
        FROM knowledge_docs
        WHERE deleted_at IS NOT NULL
          AND deleted_at < datetime('now', '+8 hours', ?)
          AND (
              source_path IS NOT NULL AND source_path != ''
              OR EXISTS (SELECT 1 FROM knowledge_chunks c WHERE c.doc_id = knowledge_docs.id)
          )
        ORDER BY deleted_at ASC
        LIMIT ?
    `).all(cutoffModifier, safeLimit);

    const messages = db.prepare(`
        SELECT id
        FROM messages
        WHERE deleted_at IS NOT NULL
          AND deleted_at < datetime('now', '+8 hours', ?)
        ORDER BY deleted_at ASC
        LIMIT ?
    `).all(cutoffModifier, safeLimit);

    const attachmentCleanupResults = removeAttachmentFiles(attachments);
    const knowledgeDocCleanupResults = removeAttachmentFiles(knowledgeDocs);
    const purgeableAttachments = filterRowsWithRemovedFiles(attachments, attachmentCleanupResults);
    const purgeableKnowledgeDocs = filterRowsWithRemovedFiles(knowledgeDocs, knowledgeDocCleanupResults);

    const attachmentRows = cleanupPurgedAttachmentRows(purgeableAttachments);
    const knowledgeDocRows = cleanupPurgedKnowledgeDocs(purgeableKnowledgeDocs);
    const messageRows = cleanupPurgedMessages(messages);

    if (attachmentRows > 0 || knowledgeDocRows > 0 || messageRows > 0) {
        logger.info({
            retentionDays: safeRetentionDays,
            attachmentRows,
            knowledgeDocRows,
            messageRows
        }, 'Soft-deleted storage purged');
    }

    return {
        retentionDays: safeRetentionDays,
        attachmentRows,
        knowledgeDocRows,
        messageRows
    };
}

module.exports = {
    cleanupSoftDeletedStorage,
    normalizeRetentionDays,
    normalizeBatchSize
};
