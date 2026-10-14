'use strict';

const { execute, query, queryOne } = require('../../db/client');
const { getBeijingTimestamp } = require('../../time');

function reviewError(message, code = 'OCR_REVIEW_ASSIGNMENT_INVALID', status = 400) {
    const error = new Error(message);
    error.code = code;
    error.status = status;
    return error;
}

async function canAccessDocumentJob({ userId, jobId, sourceModule = '' }) {
    const ownerJob = await queryOne(`
        SELECT j.*
        FROM document_jobs j
        WHERE j.id = ?
          AND (${sourceModule ? 'j.source_module = ? AND ' : ''}j.user_id = ?)
    `, sourceModule ? [Number(jobId), sourceModule, userId] : [Number(jobId), userId]);
    if (ownerJob) return ownerJob;

    try {
        const assignedJob = await queryOne(`
            SELECT j.*
            FROM document_jobs j
            WHERE j.id = ?
              AND (${sourceModule ? 'j.source_module = ? AND ' : ''}EXISTS (
                SELECT 1 FROM document_review_assignments a
                WHERE a.job_id = j.id AND a.reviewer_user_id = ? AND a.status IN ('assigned', 'in_review')
              ))
        `, sourceModule ? [Number(jobId), sourceModule, userId] : [Number(jobId), userId]);
        return assignedJob || null;
    } catch (_error) {
        return null;
    }
}

async function assignReviewers({ ownerUserId, jobId, reviewerUserIds = [], note = '' }) {
    const job = await queryOne(`SELECT j.*, u.unit FROM document_jobs j JOIN users u ON u.id = j.user_id WHERE j.id = ? AND j.user_id = ? AND j.source_module = 'ocr_app'`, [Number(jobId), ownerUserId]);
    if (!job) return null;
    const ids = [...new Set((Array.isArray(reviewerUserIds) ? reviewerUserIds : [reviewerUserIds]).map(value => Number.parseInt(value, 10)).filter(value => Number.isSafeInteger(value) && value > 0 && value !== Number(ownerUserId)))].slice(0, 20);
    if (!ids.length) throw reviewError('请至少选择一位其他用户作为复核人。', 'OCR_REVIEWER_REQUIRED');
    if (!String(job.unit || '').trim()) throw reviewError('任务所有者未设置单位，不能分派组织复核人。', 'OCR_REVIEWER_UNIT_REQUIRED');
    const reviewers = await query(`SELECT id FROM users WHERE id = ANY(?) AND deleted_at IS NULL AND COALESCE(status, 'active') != 'disabled' AND unit = ?`, [ids, job.unit]);
    if (reviewers.length !== ids.length) throw reviewError('存在不可用的复核用户。', 'OCR_REVIEWER_UNAVAILABLE');
    const now = getBeijingTimestamp();
    for (const reviewerId of ids) {
        await execute(`
            INSERT INTO document_review_assignments (job_id, owner_user_id, reviewer_user_id, status, assigned_by, note, created_at, updated_at)
            VALUES (?, ?, ?, 'assigned', ?, ?, ?, ?)
            ON CONFLICT (job_id, reviewer_user_id) DO UPDATE
            SET status = 'assigned', assigned_by = EXCLUDED.assigned_by, note = EXCLUDED.note, updated_at = EXCLUDED.updated_at
        `, [job.id, ownerUserId, reviewerId, ownerUserId, String(note || '').slice(0, 1000), now, now]);
    }
    return listReviewAssignments({ userId: ownerUserId, jobId: job.id, ownerOnly: true });
}

async function listReviewAssignments({ userId, jobId, ownerOnly = false }) {
    const job = ownerOnly
        ? await queryOne('SELECT * FROM document_jobs WHERE id = ? AND user_id = ?', [Number(jobId), userId])
        : await canAccessDocumentJob({ userId, jobId, sourceModule: 'ocr_app' });
    if (!job) return null;
    const rows = await query(`
        SELECT a.*, u.username, u.nickname, u.unit
        FROM document_review_assignments a
        JOIN users u ON u.id = a.reviewer_user_id
        WHERE a.job_id = ? ORDER BY a.updated_at DESC, a.id DESC
    `, [job.id]);
    return rows.map(row => ({ id: row.id, reviewerUserId: row.reviewer_user_id, username: row.username, nickname: row.nickname || '', unit: row.unit || '', status: row.status, note: row.note || '', assignedAt: row.created_at, updatedAt: row.updated_at }));
}

async function listReviewCandidates({ ownerUserId, jobId }) {
    const job = await queryOne('SELECT j.*, u.unit FROM document_jobs j JOIN users u ON u.id = j.user_id WHERE j.id = ? AND j.user_id = ? AND j.source_module = ?', [Number(jobId), ownerUserId, 'ocr_app']);
    if (!job) return null;
    const rows = await query(`
        SELECT id, username, nickname, unit
        FROM users
        WHERE id <> ? AND deleted_at IS NULL AND COALESCE(status, 'active') != 'disabled'
          AND unit = ?
        ORDER BY username ASC LIMIT 100
    `, [ownerUserId, job.unit || '']);
    return rows.map(row => ({ id: row.id, username: row.username, nickname: row.nickname || '', unit: row.unit || '' }));
}

async function markReviewInProgress({ userId, jobId }) {
    await execute(`UPDATE document_review_assignments SET status = 'in_review', updated_at = ? WHERE job_id = ? AND reviewer_user_id = ? AND status = 'assigned'`, [getBeijingTimestamp(), Number(jobId), userId]);
}

async function completeReview({ userId, jobId }) {
    const assignment = await queryOne(`
        SELECT a.*, j.coverage_complete, j.status
        FROM document_review_assignments a
        JOIN document_jobs j ON j.id = a.job_id
        WHERE a.job_id = ? AND a.reviewer_user_id = ? AND a.status IN ('assigned', 'in_review')
    `, [Number(jobId), userId]);
    if (!assignment) throw reviewError('当前用户没有可完成的复核分派。', 'OCR_REVIEW_ASSIGNMENT_REQUIRED', 403);
    const reviewedPages = await queryOne('SELECT COUNT(*) AS count FROM document_reviews WHERE job_id = ? AND user_id = ? AND review_status = ?', [assignment.job_id, userId, 'reviewed']);
    if (Number(reviewedPages?.count || 0) < 1) throw reviewError('请至少保存一页复核内容后再完成复核。', 'OCR_REVIEW_NO_PAGE_CHANGES');
    const now = getBeijingTimestamp();
    await execute(`UPDATE document_review_assignments SET status = 'approved', updated_at = ? WHERE id = ?`, [now, assignment.id]);
    const approved = await queryOne(`SELECT COUNT(*) AS count FROM document_review_assignments WHERE job_id = ? AND status = 'approved'`, [assignment.job_id]);
    const approvals = Number(approved?.count || 0);
    if (approvals >= 2 && Boolean(assignment.coverage_complete)) {
        await execute(`
            UPDATE document_jobs
            SET review_state = 'reviewed', status = CASE WHEN status = 'needs_review' THEN 'succeeded' ELSE status END,
                completed_at = CASE WHEN status = 'needs_review' THEN ? ELSE completed_at END, updated_at = ?
            WHERE id = ?
        `, [now, now, assignment.job_id]);
    }
    return { approvals, doubleConfirmed: approvals >= 2, status: approvals >= 2 ? 'reviewed' : 'awaiting_second_reviewer' };
}

module.exports = { assignReviewers, canAccessDocumentJob, completeReview, listReviewAssignments, listReviewCandidates, markReviewInProgress };
