const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { query, queryOne, execute } = require('../../db/client');
const { getBeijingTimestamp } = require('../../time');
const { createKnowledgeDocumentFromUpload, scheduleKnowledgeDocumentIndexing } = require('../rag-documents');
const { createRegulationDocumentFromUpload } = require('../regulations');
const { buildManagedPath, resolveStoredDocumentPath, tempRoot } = require('./paths');

function sanitizeShareFileName(value) {
    const base = path.basename(String(value || 'ocr-result'), path.extname(String(value || ''))).trim() || 'ocr-result';
    return base.replace(/[\\/:*?"<>|\0\r\n\t]/g, ' ').replace(/\s+/g, ' ').slice(0, 80) || 'ocr-result';
}

function buildJobShareText(detail) {
    const pages = Array.isArray(detail?.pages) ? detail.pages : [];
    return pages.map((page, index) => {
        const text = String(page.text || '').trim();
        if (!text) return '';
        const pageNumber = Number(page.pageNumber || page.page_number || index + 1);
        const confidence = page.confidence === null || page.confidence === undefined ? '-' : `${Math.round(Number(page.confidence || 0) * 100)}%`;
        return [`[第 ${pageNumber} 页 | 置信度 ${confidence}]`, text].join('\n');
    }).filter(Boolean).join('\n\n').trim();
}

function buildOcrSource(detail) {
    return {
        jobId: detail?.job?.id || null,
        contentRevision: Number(detail?.job?.contentRevision || 1),
        fileId: detail?.file?.id || null,
        pages: (detail?.pages || []).map(page => ({
            pageId: page.id,
            pageNumber: Number(page.pageNumber || 0),
            alignmentStatus: page.alignmentStatus || 'aligned'
        }))
    };
}

function stableJson(value) {
    if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
    if (value && typeof value === 'object') {
        return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
    }
    return JSON.stringify(value ?? null);
}

function parseJson(value, fallback = {}) {
    try { return value ? JSON.parse(value) : fallback; } catch (_error) { return fallback; }
}

async function cleanupTempUpload(upload) {
    if (!upload?.path) return;
    await fs.promises.rm(upload.path, { force: true, maxRetries: 3, retryDelay: 60 }).catch(() => {});
}

async function createTempTextUpload({ userId, originalName, text }) {
    const diskName = `${Date.now()}-${crypto.randomUUID()}.txt`;
    const targetPath = await buildManagedPath(tempRoot, userId, diskName);
    await fs.promises.writeFile(targetPath, String(text || ''), 'utf8');
    const stat = await fs.promises.stat(targetPath);
    return { path: targetPath, originalname: `${sanitizeShareFileName(originalName)}-ocr.txt`, mimetype: 'text/plain', size: stat.size };
}

async function createTempOutputUpload({ userId, output }) {
    const sourcePath = resolveStoredDocumentPath(output?.file_path);
    if (!sourcePath || !await fs.promises.access(sourcePath, fs.constants.R_OK).then(() => true).catch(() => false)) {
        const error = new Error('待分发的输出文件不存在或已过期。');
        error.status = 404;
        throw error;
    }
    const extension = path.extname(output.file_name || output.file_path || '') || '.bin';
    const targetPath = await buildManagedPath(tempRoot, userId, `${Date.now()}-${crypto.randomUUID()}${extension}`);
    await fs.promises.copyFile(sourcePath, targetPath);
    const stat = await fs.promises.stat(targetPath);
    return { path: targetPath, originalname: output.file_name || `PDF处理结果${extension}`, mimetype: output.mime_type || 'application/octet-stream', size: stat.size };
}

async function getJobOutputForDispatch({ userId, jobId, outputId = null, sourceModule = '' }) {
    const filters = ['o.user_id = ?', 'o.job_id = ?', "o.status = 'ready'"];
    const params = [userId, Number.parseInt(jobId, 10)];
    if (sourceModule) {
        filters.push('j.source_module = ?');
        params.push(sourceModule);
    }
    if (outputId) {
        filters.push('o.id = ?');
        params.push(Number.parseInt(outputId, 10));
    }
    const outputs = await query(`
        SELECT o.*
        FROM document_outputs o
        JOIN document_jobs j ON j.id = o.job_id AND j.user_id = o.user_id
        WHERE ${filters.join(' AND ')}
        ORDER BY o.created_at DESC, o.id DESC
        LIMIT 2
    `, params);
    if (!outputs.length) return null;
    if (!outputId && outputs.length > 1) {
        const error = new Error('该任务有多个输出文件，请先选择要分发的文件。');
        error.status = 400;
        error.code = 'OUTPUT_SELECTION_REQUIRED';
        throw error;
    }
    return outputs[0];
}

async function recordArtifactReference({ userId, outputId, target, referenceId }) {
    if (!outputId || !referenceId) return;
    await execute(`
        INSERT INTO document_artifact_refs (user_id, output_id, ref_type, ref_id, created_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT (output_id, ref_type, ref_id) DO NOTHING
    `, [userId, outputId, String(target || '').slice(0, 40), String(referenceId).slice(0, 120), getBeijingTimestamp()]);
}

function createDocumentDistributionService({ getJobDetail }) {
    async function sendTextToTarget({ user, detail, target, options = {} }) {
        const userId = user?.id;
        const text = buildJobShareText(detail);
        if (!text) {
            const error = new Error('暂无可分发的 OCR 文本。');
            error.status = 400;
            throw error;
        }
        const normalizedTarget = String(target || '').trim().toLowerCase().replace(/_/g, '-');
        const originalName = detail.file?.originalName || `ocr-job-${detail.job.id}`;
        const upload = await createTempTextUpload({ userId, originalName, text });
        if (normalizedTarget === 'knowledge' || normalizedTarget === 'knowledge-base' || normalizedTarget === 'rag') {
            let created;
            try {
                const tags = Array.isArray(options.tags) ? options.tags : String(options.tags || 'ocr').split(/[;,\s]+/);
                created = await createKnowledgeDocumentFromUpload({ userId, file: upload, collectionId: options.collectionId, tags: tags.filter(Boolean) });
            } finally {
                await cleanupTempUpload(upload);
            }
            const scheduled = await scheduleKnowledgeDocumentIndexing({ docId: created.docId, userId, user });
            return { target: 'knowledge', documentId: created.docId, collectionId: created.collectionId || null, scheduled: Boolean(scheduled.started), textLength: text.length, source: buildOcrSource(detail) };
        }
        if (normalizedTarget === 'regulations' || normalizedTarget === 'regulation') {
            let created;
            try {
                created = await createRegulationDocumentFromUpload({
                    userId,
                    file: upload,
                    metadata: {
                        title: String(options.title || `${sanitizeShareFileName(originalName)} OCR`).slice(0, 120),
                        category: options.category || 'OCR',
                        jurisdiction: options.jurisdiction || '',
                        summary: options.summary || `来自文字识别任务 ${detail.job.id}`
                    },
                    preloadedText: text
                });
            } finally {
                await cleanupTempUpload(upload);
            }
            return { target: 'regulations', documentId: created.document?.id || null, versionId: created.version?.id || null, articleCount: Array.isArray(created.articles) ? created.articles.length : 0, textLength: text.length, source: buildOcrSource(detail) };
        }
        return { target: normalizedTarget || 'text', textLength: text.length, source: buildOcrSource(detail) };
    }

    async function shareJobResult({ user, jobId, target, options = {}, sourceModule = '' }) {
        const detail = await getJobDetail({ userId: user?.id, jobId, sourceModule });
        if (!detail) return null;
        const userId = user?.id;
        const normalizedTarget = String(target || '').trim().toLowerCase().replace(/_/g, '-').slice(0, 40) || 'text';
        const contentRevision = Math.max(Number(detail.job?.contentRevision || 1), 1);
        const optionsHash = crypto.createHash('sha256').update(stableJson(options && typeof options === 'object' ? options : {})).digest('hex');
        let record = await queryOne(`
            SELECT * FROM document_distributions
            WHERE user_id = ? AND job_id = ? AND target = ? AND content_revision = ? AND options_hash = ?
        `, [userId, detail.job.id, normalizedTarget, contentRevision, optionsHash]);
        if (record?.status === 'ready') return { ...parseJson(record.result_json, {}), idempotent: true };
        if (record?.status === 'processing') {
            const error = new Error('相同版本正在分发，请勿重复提交。');
            error.code = 'DISTRIBUTION_IN_PROGRESS';
            error.status = 409;
            throw error;
        }
        const now = getBeijingTimestamp();
        if (record?.id) {
            await execute(`UPDATE document_distributions SET status = 'processing', error_message = '', updated_at = ?, completed_at = NULL WHERE id = ?`, [now, record.id]);
        } else {
            const id = crypto.randomUUID();
            await execute(`
                INSERT INTO document_distributions (id, user_id, job_id, target, content_revision, options_hash, status, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, 'processing', ?, ?)
                ON CONFLICT (user_id, job_id, target, content_revision, options_hash) DO NOTHING
            `, [id, userId, detail.job.id, normalizedTarget, contentRevision, optionsHash, now, now]);
        }
        record = await queryOne(`
            SELECT * FROM document_distributions
            WHERE user_id = ? AND job_id = ? AND target = ? AND content_revision = ? AND options_hash = ?
        `, [userId, detail.job.id, normalizedTarget, contentRevision, optionsHash]);
        if (!record || record.status !== 'processing') {
            if (record?.status === 'ready') return { ...parseJson(record.result_json, {}), idempotent: true };
            const error = new Error('相同版本正在分发，请勿重复提交。');
            error.code = 'DISTRIBUTION_IN_PROGRESS';
            error.status = 409;
            throw error;
        }
        try {
            const result = await sendTextToTarget({ user, detail, target: normalizedTarget, options });
            const completedAt = getBeijingTimestamp();
            await execute(`UPDATE document_distributions SET status = 'ready', result_json = ?, error_message = '', updated_at = ?, completed_at = ? WHERE id = ?`, [JSON.stringify(result), completedAt, completedAt, record.id]);
            return { ...result, distributionId: record.id, idempotent: false };
        } catch (error) {
            const completedAt = getBeijingTimestamp();
            await execute(`UPDATE document_distributions SET status = 'failed', error_message = ?, updated_at = ?, completed_at = ? WHERE id = ?`, [String(error.message || '分发失败').slice(0, 500), completedAt, completedAt, record.id]);
            throw error;
        }
    }

    async function dispatchPdfJobResult({ user, jobId, target, options = {} }) {
        const userId = user?.id;
        const detail = await getJobDetail({ userId, jobId, sourceModule: 'pdf_tools' });
        if (!detail) return null;
        const normalizedTarget = String(target || '').trim().toLowerCase().replace(/_/g, '-');
        const output = await getJobOutputForDispatch({ userId, jobId, outputId: options.outputId, sourceModule: 'pdf_tools' });
        if (!output) return null;
        const upload = await createTempOutputUpload({ userId, output });
        if (normalizedTarget === 'knowledge' || normalizedTarget === 'knowledge-base' || normalizedTarget === 'rag') {
            let created;
            try {
                const tags = Array.isArray(options.tags) ? options.tags : String(options.tags || 'pdf').split(/[;,\s]+/);
                created = await createKnowledgeDocumentFromUpload({ userId, file: upload, collectionId: options.collectionId, tags: tags.filter(Boolean) });
            } finally {
                await cleanupTempUpload(upload);
            }
            const scheduled = await scheduleKnowledgeDocumentIndexing({ docId: created.docId, userId, user });
            await recordArtifactReference({ userId, outputId: output.id, target: 'knowledge', referenceId: created.docId });
            return { target: 'knowledge', outputId: output.id, documentId: created.docId, collectionId: created.collectionId || null, scheduled: Boolean(scheduled.started), source: { jobId: detail.job.id, outputId: output.id, pageCount: output.page_count || 0, sha256: output.sha256 || '' } };
        }
        if (normalizedTarget === 'regulations' || normalizedTarget === 'regulation') {
            let created;
            try {
                created = await createRegulationDocumentFromUpload({
                    userId,
                    file: upload,
                    metadata: {
                        title: String(options.title || sanitizeShareFileName(output.file_name) || 'PDF 导入').slice(0, 120),
                        category: options.category || '待审核 PDF',
                        jurisdiction: options.jurisdiction || '',
                        summary: options.summary || `来自 PDF 工具任务 ${detail.job.id} 的输出 ${output.id}，导入后需人工确认文本、来源和效力信息。`
                    }
                });
            } finally {
                await cleanupTempUpload(upload);
            }
            await recordArtifactReference({ userId, outputId: output.id, target: 'regulations', referenceId: created.document?.id });
            return { target: 'regulations', outputId: output.id, documentId: created.document?.id || null, versionId: created.version?.id || null, articleCount: Array.isArray(created.articles) ? created.articles.length : 0, source: { jobId: detail.job.id, outputId: output.id, pageCount: output.page_count || 0, sha256: output.sha256 || '' } };
        }
        const error = new Error('不支持的 PDF 结果分发目标。');
        error.status = 400;
        throw error;
    }

    return { dispatchPdfJobResult, shareJobResult };
}

module.exports = { createDocumentDistributionService };
