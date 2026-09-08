const { query, execute } = require('../db/client');
const { logger } = require('../logger');
const { removeAttachmentFilesAsync } = require('../security');
const fs = require('fs');
const path = require('path');

const uploadRoot = process.env.PIVOT_UPLOAD_DIR || process.env.UPLOAD_DIR
    ? path.resolve(process.env.PIVOT_UPLOAD_DIR || process.env.UPLOAD_DIR)
    : path.resolve(__dirname, '../../uploads');

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

function isInside(parent, target) {
    const relative = path.relative(path.resolve(parent), path.resolve(target));
    return relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

function storagePathKey(filePath) {
    const resolved = path.resolve(filePath);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function resolveStoredUploadPath(value, root = uploadRoot) {
    const raw = String(value || '').trim();
    if (!raw || raw.includes('\0')) return '';
    const candidate = path.isAbsolute(raw)
        ? path.resolve(raw)
        : raw.replace(/\\/g, '/').startsWith('uploads/')
            ? path.resolve(path.dirname(root), raw)
            : path.resolve(root, raw);
    return isInside(root, candidate) ? candidate : '';
}

async function listReferencedUploadPaths(queryFn = query, root = uploadRoot) {
    const sqls = [
        "SELECT file_path AS path FROM attachments WHERE file_path IS NOT NULL AND file_path != ''",
        "SELECT source_path AS path FROM knowledge_docs WHERE source_path IS NOT NULL AND source_path != ''",
        "SELECT source_path AS path FROM regulation_versions WHERE source_path IS NOT NULL AND source_path != ''",
        "SELECT file_path AS path FROM document_files WHERE file_path IS NOT NULL AND file_path != ''",
        "SELECT image_path AS path FROM document_pages WHERE image_path IS NOT NULL AND image_path != ''",
        "SELECT file_path AS path FROM document_outputs WHERE file_path IS NOT NULL AND file_path != ''"
    ];
    const rows = (await Promise.all(sqls.map(sql => queryFn(sql).catch(error => {
        logger.warn({ err: error.message }, '存储孤儿对账读取引用路径失败');
        return [];
    })))).flat();
    return new Set(rows.map(row => resolveStoredUploadPath(row.path, root)).filter(Boolean).map(storagePathKey));
}

async function listFilesRecursively(root, maxFiles = 10000) {
    const files = [];
    async function visit(directory) {
        if (files.length >= maxFiles) return;
        let entries = [];
        try { entries = await fs.promises.readdir(directory, { withFileTypes: true }); } catch (_) { return; }
        for (const entry of entries) {
            if (files.length >= maxFiles || entry.isSymbolicLink()) continue;
            const target = path.join(directory, entry.name);
            if (entry.isDirectory()) await visit(target);
            else if (entry.isFile()) files.push(target);
        }
    }
    await visit(root);
    return files;
}

async function reconcileUploadStorage(options = {}) {
    const root = path.resolve(options.uploadDirectory || uploadRoot);
    const retentionDays = normalizeRetentionDays(options.retentionDays ?? process.env.STORAGE_GC_RETENTION_DAYS);
    const limit = normalizeBatchSize(options.limit ?? process.env.STORAGE_GC_ORPHAN_BATCH_SIZE);
    const nowMs = Number(options.nowMs || Date.now());
    const cutoffMs = nowMs - retentionDays * 24 * 60 * 60 * 1000;
    const referenced = options.referencedPaths
        ? new Set([...options.referencedPaths].map(item => resolveStoredUploadPath(item, root)).filter(Boolean).map(storagePathKey))
        : await listReferencedUploadPaths(options.queryFn || query, root);
    const files = await listFilesRecursively(root, Math.max(limit * 10, 1000));
    const candidates = [];
    for (const filePath of files) {
        if (candidates.length >= limit || referenced.has(storagePathKey(filePath))) continue;
        try {
            const stat = await fs.promises.stat(filePath);
            if (stat.mtimeMs < cutoffMs) candidates.push({ path: filePath, bytes: stat.size });
        } catch (_) {}
    }
    let deletedFiles = 0;
    let deletedBytes = 0;
    if (options.remove !== false) {
        for (const candidate of candidates) {
            if (!isInside(root, candidate.path)) continue;
            try {
                await fs.promises.unlink(candidate.path);
                deletedFiles += 1;
                deletedBytes += candidate.bytes;
            } catch (error) {
                logger.warn({ err: error.message, filePath: candidate.path }, '存储孤儿文件清理失败');
            }
        }
    }
    if (deletedFiles) logger.info({ root, deletedFiles, deletedBytes, retentionDays }, '上传目录孤儿文件已清理');
    return { root, retentionDays, referenced: referenced.size, candidates: candidates.length, deletedFiles, deletedBytes };
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

    const [attachmentCleanupResults, knowledgeDocCleanupResults] = await Promise.all([
        removeAttachmentFilesAsync(attachments || []),
        removeAttachmentFilesAsync(knowledgeDocs || [])
    ]);
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
    reconcileUploadStorage,
    normalizeRetentionDays,
    normalizeBatchSize
};
