'use strict';

const { query, queryOne } = require('../../db/client');
const { getBeijingTimestamp } = require('../../time');

function feedbackError(message, code = 'OCR_FEEDBACK_INVALID', status = 400) {
    const error = new Error(message);
    error.code = code;
    error.status = status;
    return error;
}

function createOcrFeedbackService({ canAccessDocumentJob }) {
    async function submitFeedback({ userId, pageId, correctedText, feedbackType = 'correction', consented = false }) {
        if (consented !== true) throw feedbackError('提交纠错反馈前需要明确授权该页文本用于改进评测。', 'OCR_FEEDBACK_CONSENT_REQUIRED');
        const page = await queryOne('SELECT * FROM document_pages WHERE id = ?', [Number(pageId)]);
        if (!page || !await canAccessDocumentJob({ userId, jobId: page.job_id, sourceModule: 'ocr_app' })) return null;
        const corrected = String(correctedText || '').slice(0, 1_000_000);
        if (!corrected.trim() || corrected === String(page.raw_text || page.text || '')) throw feedbackError('请先保存或输入与原始识别不同的修订文本，再提交纠错反馈。', 'OCR_FEEDBACK_NO_CHANGE');
        const now = getBeijingTimestamp();
        const row = await queryOne(`
            INSERT INTO document_ocr_feedback (user_id, job_id, page_id, content_revision, feedback_type, original_text, corrected_text, consented, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?) RETURNING *
        `, [userId, page.job_id, page.id, Math.max(Number(page.content_revision || 1), 1), String(feedbackType || 'correction').slice(0, 40), String(page.raw_text || page.text || ''), corrected, now, now]);
        return serializeFeedback(row);
    }

    async function listFeedback({ status = 'pending', limit = 50 }) {
        const normalized = ['pending', 'approved', 'rejected'].includes(String(status)) ? String(status) : 'pending';
        const rows = await query('SELECT * FROM document_ocr_feedback WHERE status = ? ORDER BY created_at ASC LIMIT ?', [normalized, Math.min(Math.max(Number(limit) || 50, 1), 200)]);
        return rows.map(serializeFeedback);
    }

    async function reviewFeedback({ reviewerUserId, feedbackId, status, reviewNote = '' }) {
        const normalized = ['approved', 'rejected'].includes(String(status)) ? String(status) : '';
        if (!normalized) throw feedbackError('反馈审核状态只能是通过或拒绝。', 'OCR_FEEDBACK_STATUS_INVALID');
        const row = await queryOne(`
            UPDATE document_ocr_feedback SET status = ?, review_note = ?, reviewed_by = ?, reviewed_at = ?, updated_at = ?
            WHERE id = ? AND status = 'pending' RETURNING *
        `, [normalized, String(reviewNote || '').slice(0, 1000), reviewerUserId, getBeijingTimestamp(), getBeijingTimestamp(), Number(feedbackId)]);
        if (!row) throw feedbackError('反馈不存在或已审核。', 'OCR_FEEDBACK_NOT_PENDING', 409);
        return serializeFeedback(row);
    }

    function serializeFeedback(row) {
        return { id: row.id, jobId: row.job_id, pageId: row.page_id, contentRevision: Number(row.content_revision || 1), feedbackType: row.feedback_type, status: row.status, consented: Boolean(row.consented), reviewNote: row.review_note || '', createdAt: row.created_at, reviewedAt: row.reviewed_at || '' };
    }

    return { listFeedback, reviewFeedback, submitFeedback };
}

module.exports = { createOcrFeedbackService };
