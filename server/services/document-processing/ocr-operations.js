'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { PDFDocument } = require('pdf-lib');

function createOcrOperations(deps) {
    const {
        createJobFromUpload, execute, queryOne, getBeijingTimestamp, isImageExtension, isPdfExtension,
        JOB_STATUSES, normalizeConfig, parsePageSelection, sanitizeErrorMessage
    } = deps;

    async function refreshOcrBatch(batchId, userId) {
        const summary = await queryOne(`
            SELECT COUNT(*) AS total,
                COUNT(*) FILTER (WHERE status IN (?, ?, ?, ?)) AS completed,
                COUNT(*) FILTER (WHERE status = ?) AS failed,
                COUNT(*) FILTER (WHERE status IN (?, ?)) AS active
            FROM document_batch_items WHERE batch_id = ? AND user_id = ?
        `, [JOB_STATUSES.SUCCEEDED, JOB_STATUSES.PARTIAL_SUCCESS, JOB_STATUSES.NEEDS_REVIEW, JOB_STATUSES.CANCELLED, JOB_STATUSES.FAILED, JOB_STATUSES.QUEUED, JOB_STATUSES.PROCESSING, batchId, userId]);
        const total = Number(summary?.total || 0);
        const completed = Number(summary?.completed || 0);
        const failed = Number(summary?.failed || 0);
        const active = Number(summary?.active || 0);
        const status = active ? JOB_STATUSES.PROCESSING : (failed && completed ? JOB_STATUSES.PARTIAL_SUCCESS : (failed ? JOB_STATUSES.FAILED : JOB_STATUSES.SUCCEEDED));
        await execute(`UPDATE document_batches SET status = ?, total_files = ?, completed_files = ?, failed_files = ?, updated_at = ? WHERE id = ? AND user_id = ?`, [status, total, completed, failed, getBeijingTimestamp(), batchId, userId]);
    }

    async function preflightOcrUploads({ files = [], config = {} } = {}) {
        const safeConfig = normalizeConfig(config);
        const uploads = Array.isArray(files) ? files.filter(Boolean).slice(0, 20) : [];
        if (!uploads.length) {
            const error = new Error('请至少选择一个图片或 PDF 文件。');
            error.status = 400;
            throw error;
        }
        const entries = [];
        for (const file of uploads) {
            const name = String(file.originalname || file.filename || '未命名文件');
            const ext = path.extname(name).toLowerCase();
            const item = { originalName: name.slice(0, 255), fileSize: Number(file.size || 0), pageCount: 0, supported: false, warnings: [], selectedPages: [] };
            try {
                if (isImageExtension(ext)) {
                    const metadata = await sharp(file.path).metadata();
                    item.pageCount = 1;
                    item.pixelWidth = Number(metadata.width || 0);
                    item.pixelHeight = Number(metadata.height || 0);
                    item.supported = Boolean(item.pixelWidth && item.pixelHeight);
                    item.selectedPages = [1];
                } else if (isPdfExtension(ext)) {
                    const pdf = await PDFDocument.load(await fs.promises.readFile(file.path), { ignoreEncryption: false, password: safeConfig.password || undefined });
                    item.pageCount = pdf.getPageCount();
                    item.selectedPages = parsePageSelection(safeConfig.pages || safeConfig.pageRanges, item.pageCount, { defaultAll: true, limit: Math.min(safeConfig.maxRenderPages, safeConfig.maxOcrPages) }).map(index => index + 1);
                    item.supported = true;
                    if (item.selectedPages.length !== item.pageCount) item.warnings.push(`本次只处理第 ${item.selectedPages.join(', ')} 页，原文件共 ${item.pageCount} 页。`);
                } else {
                    item.code = 'UNSUPPORTED_FILE_TYPE';
                    item.warnings.push('仅支持 PDF、PNG、JPG、GIF、WebP 或 BMP 文件。');
                }
            } catch (error) {
                item.code = error.code || 'PREFLIGHT_FAILED';
                item.warnings.push(sanitizeErrorMessage(error));
            }
            entries.push(item);
        }
        return { limits: { maxRenderPages: safeConfig.maxRenderPages, maxOcrPages: safeConfig.maxOcrPages, maxFiles: 20 }, files: entries, accepted: entries.filter(item => item.supported).length, rejected: entries.filter(item => !item.supported).length };
    }

    async function createOcrBatchFromUploads({ user, files = [], sourceRef = '', config = {} }) {
        const uploads = Array.isArray(files) ? files.filter(Boolean).slice(0, 20) : [];
        if (!uploads.length) {
            const error = new Error('请至少上传一个图片或 PDF 文件。');
            error.status = 400;
            throw error;
        }
        const batchId = crypto.randomUUID();
        const now = getBeijingTimestamp();
        await execute(`INSERT INTO document_batches (id, user_id, source_module, status, total_files, config_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [batchId, user.id, 'ocr_app', 'queued', uploads.length, JSON.stringify(normalizeConfig(config)), now, now]);
        const jobs = [];
        for (let index = 0; index < uploads.length; index += 1) {
            const upload = uploads[index];
            try {
                const detail = await createJobFromUpload({ user, file: upload, jobType: 'ocr', sourceModule: 'ocr_app', sourceRef: sourceRef || batchId, config });
                jobs.push(detail);
                await execute(`INSERT INTO document_batch_items (batch_id, user_id, job_id, item_order, original_name, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [batchId, user.id, detail.job.id, index, detail.file?.originalName || upload.originalname || '', detail.job.status, now, now]);
            } catch (error) {
                await execute(`INSERT INTO document_batch_items (batch_id, user_id, item_order, original_name, status, error_message, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [batchId, user.id, index, String(upload.originalname || '').slice(0, 255), JOB_STATUSES.FAILED, sanitizeErrorMessage(error), now, now]);
            }
        }
        await refreshOcrBatch(batchId, user.id);
        const summary = await queryOne('SELECT status, total_files, completed_files, failed_files FROM document_batches WHERE id = ? AND user_id = ?', [batchId, user.id]);
        return { batch: { id: batchId, status: summary?.status || JOB_STATUSES.FAILED, totalFiles: Number(summary?.total_files || uploads.length), acceptedFiles: jobs.length, completedFiles: Number(summary?.completed_files || 0), failedFiles: Number(summary?.failed_files || 0) }, jobs };
    }

    return { createOcrBatchFromUploads, preflightOcrUploads, refreshOcrBatch };
}

module.exports = { createOcrOperations };
