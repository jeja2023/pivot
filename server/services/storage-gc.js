const { query, execute } = require('../db/client');
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

async function cleanupPurgedAttachmentRows(rows) {
    if (rows.length === 0) return 0;
    const ids = rows.map(r => r.id);
    const placeholders = ids.map(() => '?').join(',');
    await execute(`
        UPDATE attachments
        SET file_path = '',
            file_size = 0,
            access_token = NULL,
            expires_at = NULL
        WHERE id IN (${placeholders})
    `, ids);
    return rows.length;
}

async function cleanupPurgedKnowledgeDocs(rows) {
    if (rows.length === 0) return 0;
    const ids = rows.map(r => r.id);
    const placeholders = ids.map(() => '?').join(',');
    await execute(`DELETE FROM knowledge_chunks WHERE doc_id IN (${placeholders})`, ids);
    await execute(`
        UPDATE knowledge_docs
        SET status = 'purged',
            is_enabled = 0,
            chunk_count = 0,
            indexed_chunks = 0,
            progress = 0,
            source_path = '',
            source_size = 0,
            error_message = ''
        WHERE id IN (${placeholders})
    `, ids);
    return rows.length;
}

async function cleanupPurgedMessages(rows) {
    if (rows.length === 0) return 0;
    const ids = rows.map(r => r.id);
    const placeholders = ids.map(() => '?').join(',');
    await execute(`DELETE FROM messages WHERE id IN (${placeholders})`, ids);
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

async function cleanupSoftDeletedStorage({ retentionDays, limit } = {}) {
    const safeRetentionDays = normalizeRetentionDays(retentionDays ?? process.env.STORAGE_GC_RETENTION_DAYS);
    const safeLimit = normalizeBatchSize(limit ?? process.env.STORAGE_GC_BATCH_SIZE);

    const attachments = await query(`
        SELECT id, file_path
        FROM attachments
        WHERE deleted_at IS NOT NULL
          AND deleted_at < (now() AT TIME ZONE 'Asia/Shanghai' - (? || ' days')::interval)
          AND file_path IS NOT NULL
          AND file_path != ''
        ORDER BY deleted_at ASC
        LIMIT ?
    `, [String(safeRetentionDays), safeLimit]);

    const knowledgeDocs = await query(`
        SELECT id, source_path AS file_path
        FROM knowledge_docs
        WHERE deleted_at IS NOT NULL
          AND deleted_at < (now() AT TIME ZONE 'Asia/Shanghai' - (? || ' days')::interval)
          AND (
              source_path IS NOT NULL AND source_path != ''
              OR EXISTS (SELECT 1 FROM knowledge_chunks c WHERE c.doc_id = knowledge_docs.id)
          )
        ORDER BY deleted_at ASC
        LIMIT ?
    `, [String(safeRetentionDays), safeLimit]);

    const messages = await query(`
        SELECT id
        FROM messages
        WHERE deleted_at IS NOT NULL
          AND deleted_at < (now() AT TIME ZONE 'Asia/Shanghai' - (? || ' days')::interval)
        ORDER BY deleted_at ASC
        LIMIT ?
    `, [String(safeRetentionDays), safeLimit]);

    const attachmentCleanupResults = removeAttachmentFiles(attachments || []);
    const knowledgeDocCleanupResults = removeAttachmentFiles(knowledgeDocs || []);
    const purgeableAttachments = filterRowsWithRemovedFiles(attachments || [], attachmentCleanupResults);
    const purgeableKnowledgeDocs = filterRowsWithRemovedFiles(knowledgeDocs || [], knowledgeDocCleanupResults);

    const attachmentRows = await cleanupPurgedAttachmentRows(purgeableAttachments);
    const knowledgeDocRows = await cleanupPurgedKnowledgeDocs(purgeableKnowledgeDocs);
    const messageRows = await cleanupPurgedMessages(messages || []);

    if (attachmentRows > 0 || knowledgeDocRows > 0 || messageRows > 0) {
        logger.info({
            retentionDays: safeRetentionDays,
            attachmentRows,
            knowledgeDocRows,
            messageRows
        }, '软删除存储已清理');
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
