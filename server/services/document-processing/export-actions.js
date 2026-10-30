const crypto = require('crypto');

const { execute, query, queryOne } = require('../../db/client');
const { getBeijingTimestamp } = require('../../time');
const { OUTPUT_TYPES } = require('./constants');
const { createTextOutputs } = require('./exporters');
const { createSearchablePdfOutput } = require('./pdf');
const { getDocumentFileForUser } = require('./files');
const { withDocumentJobLock } = require('../../repositories/document-job-lock');

function exportError(message, code = 'EXPORT_NOT_READY', status = 409) {
    const error = new Error(message);
    error.code = code;
    error.status = status;
    return error;
}

function parseJson(value, fallback = {}) {
    try { return value ? JSON.parse(value) : fallback; } catch (_error) { return fallback; }
}

function serializeExport(row) {
    if (!row) return null;
    return {
        id: row.id,
        jobId: Number(row.job_id),
        contentRevision: Math.max(Number(row.content_revision || 1), 1),
        format: row.output_format,
        status: row.status,
        outputId: row.output_id ? Number(row.output_id) : null,
        errorMessage: row.error_message || '',
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        completedAt: row.completed_at || null
    };
}

function createDocumentExportActions({ getJobRow, getPages, getBlocks }) {
    function normalizedFormat(format) {
        return Object.values(OUTPUT_TYPES).includes(format) ? format : OUTPUT_TYPES.TEXT;
    }

    async function getStableJob({ userId, jobId, sourceModule = '' }) {
        const job = await getJobRow(jobId, userId);
        if (!job || (sourceModule && job.source_module !== sourceModule)) return null;
        if (!['succeeded', 'partial_success', 'needs_review'].includes(job.status)) {
            throw exportError('任务尚未产生可导出的稳定结果，请等待处理结束或先完成必要复核。');
        }
        return job;
    }

    async function createOutput({ userId, job, file, pages, blocks, format }) {
        if (format === OUTPUT_TYPES.SEARCHABLE_PDF) {
            return createSearchablePdfOutput({ userId, file, job, pages, blocks });
        }
        const outputs = await createTextOutputs({ userId, file, job, pages, blocks, formats: [format] });
        return outputs[0] || null;
    }

    async function createJobExport({ userId, jobId, format = OUTPUT_TYPES.TEXT, sourceModule = '' }) {
        // 先验证归属，避免向无权访问的用户暴露任务是否正在持锁。
        if (!await getStableJob({ userId, jobId, sourceModule })) return null;
        const result = await withDocumentJobLock(jobId, async () => {
            const job = await getStableJob({ userId, jobId, sourceModule });
            if (!job) return { output: null };
            const file = await getDocumentFileForUser(job.file_id, userId);
            const [pages, blocks] = await Promise.all([getPages(job.id), getBlocks(job.id)]);
            return { output: await createOutput({ userId, job, file, pages, blocks, format: normalizedFormat(format) }) };
        });
        if (!result) throw exportError('任务正在处理或清理，请稍后重试。', 'DOCUMENT_JOB_BUSY');
        return result.output;
    }

    async function requestJobExport({ userId, jobId, format = OUTPUT_TYPES.TEXT, sourceModule = '' }) {
        const job = await getStableJob({ userId, jobId, sourceModule });
        if (!job) return null;
        const outputFormat = normalizedFormat(format);
        const contentRevision = Math.max(Number(job.content_revision || 1), 1);
        let existing = await queryOne(`
            SELECT * FROM document_exports
            WHERE user_id = ? AND job_id = ? AND content_revision = ? AND output_format = ?
        `, [userId, job.id, contentRevision, outputFormat]);
        if (existing?.status === 'ready' || existing?.status === 'queued' || existing?.status === 'processing') return serializeExport(existing);

        const file = await getDocumentFileForUser(job.file_id, userId);
        const [pages, blocks] = await Promise.all([getPages(job.id), getBlocks(job.id)]);
        const now = getBeijingTimestamp();
        const snapshot = JSON.stringify({ job, file, pages, blocks });
        if (existing?.id) {
            await execute(`
                UPDATE document_exports
                SET status = 'queued', snapshot_json = ?, output_id = NULL, error_message = '', updated_at = ?, completed_at = NULL
                WHERE id = ? AND user_id = ?
            `, [snapshot, now, existing.id, userId]);
        } else {
            const id = crypto.randomUUID();
            await execute(`
                INSERT INTO document_exports (id, user_id, job_id, content_revision, output_format, status, snapshot_json, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, ?)
                ON CONFLICT (user_id, job_id, content_revision, output_format) DO NOTHING
            `, [id, userId, job.id, contentRevision, outputFormat, snapshot, now, now]);
        }
        existing = await queryOne(`
            SELECT * FROM document_exports
            WHERE user_id = ? AND job_id = ? AND content_revision = ? AND output_format = ?
        `, [userId, job.id, contentRevision, outputFormat]);
        if (existing?.status === 'queued') setImmediate(() => processExportRequest(existing.id).catch(() => {}));
        return serializeExport(existing);
    }

    async function processExportRequest(exportId) {
        const request = await queryOne(`SELECT * FROM document_exports WHERE id = ? AND status = 'queued'`, [String(exportId)]);
        if (!request) return null;
        const claimed = await execute(`UPDATE document_exports SET status = 'processing', updated_at = ? WHERE id = ? AND status = 'queued'`, [getBeijingTimestamp(), request.id]);
        if (claimed !== 1) return null;
        try {
            const snapshot = parseJson(request.snapshot_json);
            if (!snapshot?.job || !snapshot?.file || !Array.isArray(snapshot.pages)) throw exportError('导出快照不完整，请重新创建导出。', 'EXPORT_SNAPSHOT_INVALID');
            const output = await createOutput({
                userId: request.user_id,
                job: snapshot.job,
                file: snapshot.file,
                pages: snapshot.pages,
                blocks: Array.isArray(snapshot.blocks) ? snapshot.blocks : [],
                format: request.output_format
            });
            if (!output?.id) throw exportError('导出文件未能生成。', 'EXPORT_OUTPUT_MISSING', 500);
            const now = getBeijingTimestamp();
            await execute(`UPDATE document_exports SET status = 'ready', output_id = ?, error_message = '', updated_at = ?, completed_at = ? WHERE id = ?`, [output.id, now, now, request.id]);
        } catch (error) {
            const now = getBeijingTimestamp();
            await execute(`UPDATE document_exports SET status = 'failed', error_message = ?, updated_at = ?, completed_at = ? WHERE id = ?`, [String(error.message || '导出失败').slice(0, 500), now, now, request.id]);
        }
        return getExportRequest({ userId: request.user_id, exportId: request.id });
    }

    async function getExportRequest({ userId, exportId, sourceModule = '' }) {
        const row = await queryOne(`
            SELECT e.* FROM document_exports e
            JOIN document_jobs j ON j.id = e.job_id AND j.user_id = e.user_id
            WHERE e.id = ? AND e.user_id = ? ${sourceModule ? 'AND j.source_module = ?' : ''}
        `, sourceModule ? [String(exportId), userId, sourceModule] : [String(exportId), userId]);
        return serializeExport(row);
    }

    async function recoverPendingExports({ limit = 100 } = {}) {
        const rows = await query(`SELECT id FROM document_exports WHERE status IN ('queued', 'processing') ORDER BY updated_at ASC LIMIT ?`, [Math.min(Math.max(Number.parseInt(limit, 10) || 100, 1), 500)]);
        for (const row of rows) {
            await execute(`UPDATE document_exports SET status = 'queued', updated_at = ? WHERE id = ? AND status = 'processing'`, [getBeijingTimestamp(), row.id]);
            setImmediate(() => processExportRequest(row.id).catch(() => {}));
        }
        return { recovered: rows.length };
    }

    return { createJobExport, getExportRequest, recoverPendingExports, requestJobExport };
}

module.exports = { createDocumentExportActions };
