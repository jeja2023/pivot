'use strict';
const { transaction } = require('../db/client');

// 锁与任务行一直保持到回调结束，防止清理期间执行器或导出开始使用同一任务。
async function withDocumentOrphanGuard({ jobId, userId, cutoff, name }, inspect) {
    return transaction(async trx => {
        const lock = await trx.queryOne("SELECT pg_try_advisory_xact_lock(hashtext('pivot_document_job'), hashtext(?::text)) AS locked", [String(jobId)]);
        if (!lock?.locked) return 'busy';
        const job = await trx.queryOne(`SELECT id FROM document_jobs WHERE id = ? AND user_id = ?
            AND status IN ('succeeded', 'partial_success', 'needs_review', 'failed', 'cancelled')
            AND updated_at < ? FOR UPDATE`, [jobId, userId, cutoff]);
        if (!job) return 'active_or_missing';
        const exports = await trx.queryOne("SELECT id FROM document_exports WHERE job_id = ? AND status IN ('queued', 'processing') LIMIT 1", [jobId]);
        if (exports) return 'busy';
        const needle = String(name).toLowerCase();
        const refs = await trx.query(`SELECT image_path AS stored_path FROM document_pages WHERE POSITION(? IN LOWER(REPLACE(image_path, chr(92), '/'))) > 0
            UNION ALL SELECT file_path AS stored_path FROM document_outputs WHERE POSITION(? IN LOWER(REPLACE(file_path, chr(92), '/'))) > 0
            UNION ALL SELECT file_path AS stored_path FROM document_files WHERE POSITION(? IN LOWER(REPLACE(file_path, chr(92), '/'))) > 0`, [needle, needle, needle]);
        return inspect(refs);
    });
}

module.exports = { withDocumentOrphanGuard };
