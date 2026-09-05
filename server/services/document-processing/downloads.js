const fs = require('fs');
const path = require('path');

const { query, queryOne } = require('../../db/client');
const { createZip } = require('./exporters');
const { resolveStoredDocumentPath } = require('./paths');

const MAX_OUTPUT_ARCHIVE_BYTES = Math.min(Math.max(Number.parseInt(process.env.DOCUMENT_PROCESSING_MAX_ARCHIVE_BYTES || String(256 * 1024 * 1024), 10) || 256 * 1024 * 1024, 8 * 1024 * 1024), 1024 * 1024 * 1024);

function sanitizeArchiveFileName(value, fallback = 'output') {
    const clean = path.basename(String(value || fallback))
        .replace(/[\\/:*?"<>|\0\r\n\t]/g, '-')
        .replace(/\s+/g, ' ')
        .replace(/-+/g, '-')
        .trim()
        .slice(0, 120);
    return clean || fallback;
}

function uniqueArchiveFileName(value, seen, fallback) {
    const clean = sanitizeArchiveFileName(value, fallback);
    const ext = path.extname(clean);
    const base = path.basename(clean, ext) || fallback;
    let name = clean;
    let index = 2;
    while (seen.has(name.toLowerCase())) name = `${base}-${index++}${ext}`;
    seen.add(name.toLowerCase());
    return name;
}

async function getJobOutputsArchive({ userId, jobId, sourceModule = '' }) {
    const job = await queryOne('SELECT * FROM document_jobs WHERE id = ? AND user_id = ?', [Number.parseInt(jobId, 10), userId]);
    if (!job || (sourceModule && job.source_module !== sourceModule)) return null;
    const outputs = await query('SELECT * FROM document_outputs WHERE job_id = ? AND user_id = ? AND status = ? ORDER BY created_at DESC, id DESC', [job.id, userId, 'ready']);
    if (!outputs.length) return null;
    const seen = new Set();
    let totalBytes = 0;
    const entries = [];
    for (const output of outputs) {
        const filePath = resolveStoredDocumentPath(output.file_path);
        if (!filePath) continue;
        let stat;
        try { stat = await fs.promises.stat(filePath); } catch (_) { continue; }
        totalBytes += stat.size;
        if (totalBytes > MAX_OUTPUT_ARCHIVE_BYTES) {
            const error = new Error(`输出归档超过 ${Math.round(MAX_OUTPUT_ARCHIVE_BYTES / 1024 / 1024)}MB 限制，请分批下载。`);
            error.status = 413;
            error.code = 'DOCUMENT_OUTPUT_ARCHIVE_TOO_LARGE';
            throw error;
        }
        entries.push({
            name: uniqueArchiveFileName(output.file_name || `output-${output.id}`, seen, `output-${output.id}`),
            data: await fs.promises.readFile(filePath)
        });
    }
    if (!entries.length) return null;
    const file = await queryOne('SELECT original_name FROM document_files WHERE id = ? AND user_id = ?', [job.file_id, userId]);
    const originalName = String(file?.original_name || `pdf-job-${job.id}`);
    const base = sanitizeArchiveFileName(path.basename(originalName, path.extname(originalName)), `pdf-job-${job.id}`);
    return { buffer: createZip(entries), fileName: `${base}-全部输出.zip`, mimeType: 'application/zip', count: entries.length };
}

async function getOutputDownload({ userId, outputId }) {
    const output = await queryOne('SELECT * FROM document_outputs WHERE id = ? AND user_id = ? AND status = ?', [Number.parseInt(outputId, 10), userId, 'ready']);
    if (!output) return null;
    const filePath = resolveStoredDocumentPath(output.file_path);
    if (!filePath || !await fs.promises.access(filePath, fs.constants.R_OK).then(() => true).catch(() => false)) return null;
    return { filePath, fileName: output.file_name || `document-output-${output.id}`, mimeType: output.mime_type || 'application/octet-stream' };
}

async function getPageImage({ userId, pageId }) {
    const page = await queryOne('SELECT * FROM document_pages WHERE id = ? AND user_id = ?', [Number.parseInt(pageId, 10), userId]);
    if (!page?.image_path) return null;
    const filePath = resolveStoredDocumentPath(page.image_path);
    if (!filePath || !await fs.promises.access(filePath, fs.constants.R_OK).then(() => true).catch(() => false)) return null;
    return { filePath, page };
}

module.exports = { getJobOutputsArchive, getOutputDownload, getPageImage };
