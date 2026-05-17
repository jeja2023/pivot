const fs = require('fs');
const path = require('path');
const pdf = require('pdf-parse');
const { db } = require('../db');
const { logger } = require('../logger');
const { getBeijingTimestamp } = require('../time');
const { clearRagCacheForUser } = require('./rag-cache');
const { indexDocumentChunks } = require('./rag-index');
const { getRagConfig } = require('./rag-config');

const uploadRoot = path.resolve(__dirname, '../../uploads');
const knowledgeSourceRoot = path.join(uploadRoot, 'knowledge_docs');
const allowedExtensions = new Set(['.txt', '.md', '.pdf']);
const maxConcurrentIndexes = Math.max(Number.parseInt(process.env.RAG_INDEX_MAX_CONCURRENT || '1', 10) || 1, 1);
const activeIndexes = new Set();
const pendingIndexes = new Map();
let runningIndexCount = 0;

function ensureKnowledgeSourceRoot() {
    fs.mkdirSync(knowledgeSourceRoot, { recursive: true });
}

function normalizeKnowledgeDocId(value) {
    const id = Number.parseInt(value, 10);
    return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function getSafeKnowledgeExtension(filename) {
    const ext = path.extname(String(filename || '')).toLowerCase();
    return allowedExtensions.has(ext) ? ext : '.txt';
}

function getKnowledgeSourcePath(relativePath) {
    if (!relativePath) return null;
    const normalized = String(relativePath).replace(/\\/g, '/');
    if (normalized.includes('%')) return null;
    if (!normalized.startsWith('uploads/knowledge_docs/') || normalized.includes('\0')) return null;
    const target = path.resolve(__dirname, '../..', normalized);
    if (target !== knowledgeSourceRoot && !target.startsWith(knowledgeSourceRoot + path.sep)) return null;
    return target;
}

function toProjectRelativePath(filePath) {
    return path.relative(path.resolve(__dirname, '../..'), filePath).replace(/\\/g, '/');
}

function persistUploadedKnowledgeFile(file, userId, docId) {
    ensureKnowledgeSourceRoot();
    const safeUserId = String(normalizeKnowledgeDocId(userId) || 'unknown');
    const ext = getSafeKnowledgeExtension(file.originalname);
    const targetDir = path.join(knowledgeSourceRoot, safeUserId);
    const targetPath = path.join(targetDir, `${docId}${ext}`);
    fs.mkdirSync(targetDir, { recursive: true });
    fs.renameSync(file.path, targetPath);
    return {
        sourcePath: toProjectRelativePath(targetPath),
        sourceSize: fs.statSync(targetPath).size
    };
}

async function readKnowledgeDocumentFromPath(filePath, originalName = '') {
    const ext = getSafeKnowledgeExtension(originalName || filePath);
    if (ext === '.pdf') {
        const dataBuffer = fs.readFileSync(filePath);
        const data = await pdf(dataBuffer);
        return data.text;
    }
    return fs.readFileSync(filePath, 'utf8');
}

function createKnowledgeDocumentFromUpload({ userId, file }) {
    const now = getBeijingTimestamp();
    const fileInfo = db.prepare(`
        INSERT INTO knowledge_docs (
            user_id, name, status, chunk_count, indexed_chunks, progress, error_message, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(userId, file.originalname, 'processing', 0, 0, 0, '', now, now);
    const docId = fileInfo.lastInsertRowid;

    try {
        const savedFile = persistUploadedKnowledgeFile(file, userId, docId);
        db.prepare(`
            UPDATE knowledge_docs
            SET source_path = ?, source_size = ?, updated_at = ?
            WHERE id = ? AND user_id = ?
        `).run(savedFile.sourcePath, savedFile.sourceSize, getBeijingTimestamp(), docId, userId);
        clearRagCacheForUser(userId);
        return { docId, ...savedFile };
    } catch (e) {
        markKnowledgeDocumentError({ docId, userId, error: e });
        throw e;
    }
}

function getKnowledgeDocumentForUser(docId, userId, { includeDeleted = false } = {}) {
    const deletedFilter = includeDeleted ? '' : ' AND deleted_at IS NULL';
    return db.prepare(`SELECT * FROM knowledge_docs WHERE id = ? AND user_id = ?${deletedFilter}`).get(docId, userId);
}

function getKnowledgeDocumentAuditList({ limit = 100, offset = 0, includeActive = false } = {}) {
    const safeLimit = Math.min(Math.max(Number.parseInt(limit, 10) || 100, 1), 500);
    const safeOffset = Math.max(Number.parseInt(offset, 10) || 0, 0);
    const deletedFilter = includeActive ? '' : 'WHERE d.deleted_at IS NOT NULL';
    const data = db.prepare(`
        SELECT
            d.id,
            d.user_id,
            u.username,
            u.nickname,
            d.name,
            d.status,
            d.is_enabled,
            d.chunk_count,
            d.indexed_chunks,
            d.progress,
            d.error_message,
            d.source_path,
            d.source_size,
            d.created_at,
            d.updated_at,
            d.processed_at,
            d.deleted_at,
            d.deleted_by_user
        FROM knowledge_docs d
        LEFT JOIN users u ON u.id = d.user_id
        ${deletedFilter}
        ORDER BY COALESCE(d.deleted_at, d.updated_at, d.created_at) DESC
        LIMIT ? OFFSET ?
    `).all(safeLimit, safeOffset);
    const total = db.prepare(`SELECT COUNT(*) AS count FROM knowledge_docs d ${deletedFilter}`).get().count;
    return { data, total, limit: safeLimit, offset: safeOffset };
}

function markKnowledgeDocumentProcessing({ docId, userId }) {
    const now = getBeijingTimestamp();
    return db.prepare(`
        UPDATE knowledge_docs
        SET status = ?, chunk_count = 0, indexed_chunks = 0, progress = 0, error_message = '', updated_at = ?
        WHERE id = ? AND user_id = ? AND deleted_at IS NULL
    `).run('processing', now, docId, userId).changes > 0;
}

function markKnowledgeDocumentReady({ docId, userId, chunkCount }) {
    const now = getBeijingTimestamp();
    return db.prepare(`
        UPDATE knowledge_docs
        SET status = ?, chunk_count = ?, indexed_chunks = ?, progress = 100, error_message = '', processed_at = ?, updated_at = ?
        WHERE id = ? AND user_id = ? AND deleted_at IS NULL
    `).run('ready', chunkCount, chunkCount, now, now, docId, userId).changes > 0;
}

function markKnowledgeDocumentError({ docId, userId, error }) {
    const now = getBeijingTimestamp();
    return db.prepare(`
        UPDATE knowledge_docs
        SET status = ?, progress = 0, error_message = ?, processed_at = ?, updated_at = ?
        WHERE id = ? AND user_id = ? AND deleted_at IS NULL
    `).run('error', String(error?.message || error || 'RAG indexing failed').slice(0, 1000), now, now, docId, userId).changes > 0;
}

async function processKnowledgeDocument({ docId, userId }) {
    const normalizedDocId = normalizeKnowledgeDocId(docId);
    const doc = normalizedDocId ? getKnowledgeDocumentForUser(normalizedDocId, userId) : null;
    if (!doc) {
        const error = new Error('Knowledge document not found');
        error.statusCode = 404;
        throw error;
    }

    const sourcePath = getKnowledgeSourcePath(doc.source_path);
    if (!sourcePath || !fs.existsSync(sourcePath)) {
        const error = new Error('原始文件不存在，无法重新索引，请重新上传文档');
        markKnowledgeDocumentError({ docId: normalizedDocId, userId, error });
        throw error;
    }

    markKnowledgeDocumentProcessing({ docId: normalizedDocId, userId });
    clearRagCacheForUser(userId);
    db.prepare('DELETE FROM knowledge_chunks WHERE doc_id = ?').run(normalizedDocId);

    try {
        const text = await readKnowledgeDocumentFromPath(sourcePath, doc.name);
        const chunkCount = await indexDocumentChunks(normalizedDocId, text, {
            userId,
            onProgress: ({ indexed, total }) => {
                const now = getBeijingTimestamp();
                const progress = total > 0 ? Math.min(Math.floor((indexed / total) * 100), 99) : 0;
                db.prepare(`
                    UPDATE knowledge_docs
                    SET indexed_chunks = ?, chunk_count = ?, progress = ?, updated_at = ?
                    WHERE id = ? AND user_id = ? AND deleted_at IS NULL
                `).run(indexed, total, progress, now, normalizedDocId, userId);
            }
        });
        markKnowledgeDocumentReady({ docId: normalizedDocId, userId, chunkCount });
        clearRagCacheForUser(userId);
        return { docId: normalizedDocId, chunkCount };
    } catch (e) {
        db.prepare('DELETE FROM knowledge_chunks WHERE doc_id = ?').run(normalizedDocId);
        markKnowledgeDocumentError({ docId: normalizedDocId, userId, error: e });
        clearRagCacheForUser(userId);
        throw e;
    }
}

function getKnowledgeDocumentDetail({ docId, userId, limit = 20, offset = 0 }) {
    const normalizedDocId = normalizeKnowledgeDocId(docId);
    if (!normalizedDocId) return null;
    const doc = getKnowledgeDocumentForUser(normalizedDocId, userId);
    if (!doc) return null;
    const safeLimit = Math.min(Math.max(Number.parseInt(limit, 10) || 20, 1), 100);
    const safeOffset = Math.max(Number.parseInt(offset, 10) || 0, 0);
    const chunks = db.prepare(`
        SELECT id, content, LENGTH(content) AS length
        FROM knowledge_chunks
        WHERE doc_id = ?
        ORDER BY id ASC
        LIMIT ? OFFSET ?
    `).all(normalizedDocId, safeLimit, safeOffset);
    const totalChunks = db.prepare('SELECT COUNT(*) AS count FROM knowledge_chunks WHERE doc_id = ?')
        .get(normalizedDocId).count;
    return { doc, chunks, totalChunks, limit: safeLimit, offset: safeOffset };
}

function setKnowledgeDocumentEnabled({ docId, userId, enabled }) {
    const normalizedDocId = normalizeKnowledgeDocId(docId);
    if (!normalizedDocId) return false;
    const changed = db.prepare(`
        UPDATE knowledge_docs
        SET is_enabled = ?, updated_at = ?
        WHERE id = ? AND user_id = ? AND deleted_at IS NULL
    `).run(enabled ? 1 : 0, getBeijingTimestamp(), normalizedDocId, userId).changes > 0;
    if (changed) clearRagCacheForUser(userId);
    return changed;
}

function normalizeDocIds(docIds) {
    if (!Array.isArray(docIds)) return [];
    return [...new Set(docIds.map(normalizeKnowledgeDocId).filter(Boolean))].slice(0, 100);
}

function batchDeleteKnowledgeDocuments({ userId, docIds }) {
    const ids = normalizeDocIds(docIds);
    let deleted = 0;
    for (const id of ids) {
        if (deleteKnowledgeDocument({ docId: id, userId })) deleted += 1;
    }
    return { requested: ids.length, deleted };
}

function batchReindexKnowledgeDocuments({ userId, docIds }) {
    const ids = normalizeDocIds(docIds);
    let scheduled = 0;
    let skipped = 0;
    for (const id of ids) {
        const doc = getKnowledgeDocumentForUser(id, userId);
        if (!doc || !doc.source_path) {
            skipped += 1;
            continue;
        }
        const result = scheduleKnowledgeDocumentIndexing({ docId: id, userId });
        if (result.started) scheduled += 1;
        else skipped += 1;
    }
    if (scheduled > 0) clearRagCacheForUser(userId);
    return { requested: ids.length, scheduled, skipped };
}

function recordRagFeedback({ userId, query, chunkId, docName, score, helpful, note }) {
    const safeQuery = String(query || '').trim().slice(0, 1000);
    if (!safeQuery) return null;
    const safeChunkId = normalizeKnowledgeDocId(chunkId);
    const info = db.prepare(`
        INSERT INTO rag_feedback (user_id, query, chunk_id, doc_name, score, helpful, note, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        userId,
        safeQuery,
        safeChunkId,
        String(docName || '').slice(0, 255),
        Number.isFinite(Number(score)) ? Number(score) : null,
        helpful ? 1 : 0,
        String(note || '').slice(0, 1000),
        getBeijingTimestamp()
    );
    return { id: info.lastInsertRowid };
}

function getRagFeedbackSummary(userId) {
    const rows = db.prepare(`
        SELECT doc_name, helpful, COUNT(*) AS count
        FROM rag_feedback
        WHERE user_id = ?
        GROUP BY doc_name, helpful
    `).all(userId);
    const summary = { helpful: 0, unhelpful: 0, byDoc: [] };
    const byDoc = new Map();
    for (const row of rows) {
        const count = Number(row.count || 0);
        if (row.helpful) summary.helpful += count;
        else summary.unhelpful += count;
        const name = row.doc_name || '未知文档';
        const item = byDoc.get(name) || { docName: name, helpful: 0, unhelpful: 0 };
        if (row.helpful) item.helpful += count;
        else item.unhelpful += count;
        byDoc.set(name, item);
    }
    summary.byDoc = Array.from(byDoc.values()).sort((a, b) => b.unhelpful - a.unhelpful).slice(0, 10);
    return summary;
}

function getKnowledgeQualityReport(userId) {
    const overview = db.prepare(`
        SELECT
            COUNT(*) AS total,
            SUM(CASE WHEN status = 'ready' THEN 1 ELSE 0 END) AS ready,
            SUM(CASE WHEN status = 'processing' THEN 1 ELSE 0 END) AS processing,
            SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS error,
            SUM(CASE WHEN COALESCE(is_enabled, 1) = 0 THEN 1 ELSE 0 END) AS disabled,
            SUM(CASE WHEN status = 'ready' AND COALESCE(chunk_count, 0) = 0 THEN 1 ELSE 0 END) AS emptyReady,
            COALESCE(SUM(chunk_count), 0) AS chunks,
            COALESCE(SUM(source_size), 0) AS sourceSize
        FROM knowledge_docs
        WHERE user_id = ? AND deleted_at IS NULL
    `).get(userId);
    const problemDocs = db.prepare(`
        SELECT d.id, d.name, d.status, d.is_enabled, d.chunk_count, d.indexed_chunks,
               d.progress, d.error_message, d.updated_at,
               COALESCE(SUM(CASE WHEN f.helpful = 0 THEN 1 ELSE 0 END), 0) AS unhelpful,
               COALESCE(SUM(CASE WHEN f.helpful = 1 THEN 1 ELSE 0 END), 0) AS helpful
        FROM knowledge_docs d
        LEFT JOIN rag_feedback f ON f.user_id = d.user_id AND f.doc_name = d.name
        WHERE d.user_id = ? AND d.deleted_at IS NULL
        GROUP BY d.id
        HAVING d.status = 'error'
            OR COALESCE(d.is_enabled, 1) = 0
            OR (d.status = 'ready' AND COALESCE(d.chunk_count, 0) = 0)
            OR unhelpful > helpful
        ORDER BY
            CASE
                WHEN d.status = 'error' THEN 0
                WHEN COALESCE(d.is_enabled, 1) = 0 THEN 1
                WHEN COALESCE(d.chunk_count, 0) = 0 THEN 2
                ELSE 3
            END,
            COALESCE(d.updated_at, d.created_at) DESC
        LIMIT 12
    `).all(userId);
    const recommendations = [];
    if (Number(overview.error || 0) > 0) recommendations.push('存在索引失败文档，建议先使用“重试失败”恢复可用资料。');
    if (Number(overview.disabled || 0) > 0) recommendations.push('存在停用文档，确认是否需要重新启用或移出知识库。');
    if (Number(overview.emptyReady || 0) > 0) recommendations.push('存在已就绪但无分块文档，建议重新上传或重建索引。');
    if (problemDocs.some(doc => Number(doc.unhelpful || 0) > Number(doc.helpful || 0))) {
        recommendations.push('部分文档收到较多负反馈，建议检查内容时效性、命名和切片质量。');
    }
    if (recommendations.length === 0) recommendations.push('知识库质量状态正常，可以通过召回测试持续观察命中效果。');
    return {
        overview: {
            total: Number(overview.total || 0),
            ready: Number(overview.ready || 0),
            processing: Number(overview.processing || 0),
            error: Number(overview.error || 0),
            disabled: Number(overview.disabled || 0),
            emptyReady: Number(overview.emptyReady || 0),
            chunks: Number(overview.chunks || 0),
            sourceSize: Number(overview.sourceSize || 0)
        },
        problemDocs,
        recommendations,
        queue: {
            running: runningIndexCount,
            pending: pendingIndexes.size,
            maxConcurrent: maxConcurrentIndexes
        }
    };
}

function drainKnowledgeDocumentIndexQueue() {
    while (runningIndexCount < maxConcurrentIndexes && pendingIndexes.size > 0) {
        const [key, job] = pendingIndexes.entries().next().value;
        pendingIndexes.delete(key);
        runningIndexCount += 1;

        setImmediate(async () => {
            try {
                await processKnowledgeDocument(job);
            } catch (e) {
                if (e.statusCode !== 404) {
                    logger.error({ err: e.message, docId: job.docId }, 'RAG 文档索引失败');
                }
            } finally {
                activeIndexes.delete(key);
                runningIndexCount = Math.max(runningIndexCount - 1, 0);
                drainKnowledgeDocumentIndexQueue();
            }
        });
    }
}

function scheduleKnowledgeDocumentIndexing({ docId, userId }) {
    const normalizedDocId = normalizeKnowledgeDocId(docId);
    if (!normalizedDocId) return { started: false, reason: 'invalid_doc_id' };
    const key = `${userId}:${normalizedDocId}`;
    if (activeIndexes.has(key)) return { started: false, reason: 'already_processing' };

    activeIndexes.add(key);
    pendingIndexes.set(key, { docId: normalizedDocId, userId });
    drainKnowledgeDocumentIndexQueue();
    return { started: true };
}

function getKnowledgeDocumentSummaryForUser(userId) {
    const rows = db.prepare(`
        SELECT
            status,
            COUNT(*) AS count,
            COALESCE(SUM(chunk_count), 0) AS chunks,
            COALESCE(SUM(source_size), 0) AS source_size
        FROM knowledge_docs
        WHERE user_id = ?
          AND deleted_at IS NULL
        GROUP BY status
    `).all(userId);
    const retryableErrors = db.prepare(`
        SELECT COUNT(*) AS count
        FROM knowledge_docs
        WHERE user_id = ?
          AND deleted_at IS NULL
          AND status = 'error'
          AND source_path IS NOT NULL
          AND source_path != ''
    `).get(userId).count;
    const lastError = db.prepare(`
        SELECT id, name, error_message, updated_at
        FROM knowledge_docs
        WHERE user_id = ?
          AND deleted_at IS NULL
          AND status = 'error'
          AND error_message IS NOT NULL
          AND error_message != ''
        ORDER BY COALESCE(updated_at, processed_at, created_at) DESC
        LIMIT 1
    `).get(userId) || null;

    const summary = {
        total: 0,
        ready: 0,
        processing: 0,
        error: 0,
        chunks: 0,
        sourceSize: 0,
        retryableErrors,
        lastError,
        config: getRagConfig(),
        queue: {
            running: runningIndexCount,
            pending: pendingIndexes.size,
            maxConcurrent: maxConcurrentIndexes
        }
    };

    for (const row of rows) {
        const count = Number(row.count || 0);
        summary.total += count;
        if (row.status === 'ready') summary.ready = count;
        if (row.status === 'processing') summary.processing = count;
        if (row.status === 'error') summary.error = count;
        summary.chunks += Number(row.chunks || 0);
        summary.sourceSize += Number(row.source_size || 0);
    }
    return summary;
}

function scheduleFailedKnowledgeDocumentsForUser({ userId, limit = 20 }) {
    const rows = db.prepare(`
        SELECT id
        FROM knowledge_docs
        WHERE user_id = ?
          AND deleted_at IS NULL
          AND status = 'error'
          AND source_path IS NOT NULL
          AND source_path != ''
        ORDER BY COALESCE(updated_at, processed_at, created_at) DESC
        LIMIT ?
    `).all(userId, Math.max(Number.parseInt(limit, 10) || 20, 1));

    let scheduled = 0;
    let alreadyProcessing = 0;
    for (const row of rows) {
        const result = scheduleKnowledgeDocumentIndexing({ docId: row.id, userId });
        if (result.started) scheduled += 1;
        if (result.reason === 'already_processing') alreadyProcessing += 1;
    }

    return {
        total: rows.length,
        scheduled,
        alreadyProcessing
    };
}

function recoverStaleKnowledgeDocumentIndexes({ limit = 50 } = {}) {
    const rows = db.prepare(`
        SELECT id, user_id, source_path
        FROM knowledge_docs
        WHERE status = 'processing'
          AND deleted_at IS NULL
        ORDER BY COALESCE(updated_at, created_at) ASC
        LIMIT ?
    `).all(Math.max(Number.parseInt(limit, 10) || 50, 1));
    let scheduled = 0;
    let failed = 0;

    for (const row of rows) {
        if (!row.source_path) {
            markKnowledgeDocumentError({
                docId: row.id,
                userId: row.user_id,
                error: new Error('索引任务中断，原始文件缺失，请重新上传文档')
            });
            failed += 1;
            continue;
        }
        const result = scheduleKnowledgeDocumentIndexing({ docId: row.id, userId: row.user_id });
        if (result.started) scheduled += 1;
    }

    if (rows.length > 0) {
        logger.info({ total: rows.length, scheduled, failed }, 'RAG 索引恢复扫描完成');
    }
    return { total: rows.length, scheduled, failed };
}

function deleteKnowledgeDocument({ docId, userId }) {
    const normalizedDocId = normalizeKnowledgeDocId(docId);
    if (!normalizedDocId) return false;
    const doc = getKnowledgeDocumentForUser(normalizedDocId, userId);
    if (!doc) return false;

    const queueKey = `${userId}:${normalizedDocId}`;
    if (pendingIndexes.delete(queueKey)) activeIndexes.delete(queueKey);
    const now = getBeijingTimestamp();
    const changed = db.prepare(`
        UPDATE knowledge_docs
        SET deleted_at = ?, deleted_by_user = ?, is_enabled = 0, updated_at = ?
        WHERE id = ? AND user_id = ? AND deleted_at IS NULL
    `).run(now, userId, now, normalizedDocId, userId).changes > 0;
    if (changed) clearRagCacheForUser(userId);
    return changed;
}
module.exports = {
    createKnowledgeDocumentFromUpload,
    deleteKnowledgeDocument,
    getKnowledgeDocumentAuditList,
    getKnowledgeDocumentForUser,
    getKnowledgeDocumentDetail,
    getKnowledgeSourcePath,
    getKnowledgeDocumentSummaryForUser,
    getKnowledgeQualityReport,
    getRagFeedbackSummary,
    markKnowledgeDocumentError,
    markKnowledgeDocumentProcessing,
    markKnowledgeDocumentReady,
    processKnowledgeDocument,
    readKnowledgeDocumentFromPath,
    recoverStaleKnowledgeDocumentIndexes,
    batchDeleteKnowledgeDocuments,
    batchReindexKnowledgeDocuments,
    recordRagFeedback,
    scheduleFailedKnowledgeDocumentsForUser,
    setKnowledgeDocumentEnabled,
    scheduleKnowledgeDocumentIndexing
};
