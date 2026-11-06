'use strict';
const { transaction } = require('../db/client');

// 锁与任务行一直保持到回调结束，防止清理期间执行器或导出开始使用同一任务。
async function withDocumentOrphanGuard({ jobId, userId, cutoff, name }, inspect) {
    return transaction(async trx => {
        // 清理必须固定在当前 Schema；缺表时禁止 search_path 回退到 public
        // 的同名表，否则引用检查会错误地把仍需保留的文件当成孤儿。
        const namespace = await trx.queryOne('SELECT quote_ident(current_schema()) AS name');
        if (!namespace?.name) throw new Error('无法确认文档清理的数据库范围，请检查数据库配置后重试。');
        const table = name => `${namespace.name}."${name}"`;
        const lock = await trx.queryOne("SELECT pg_try_advisory_xact_lock(hashtext('pivot_document_job'), hashtext(?::text)) AS locked", [String(jobId)]);
        if (!lock?.locked) return 'busy';
        const job = await trx.queryOne(`SELECT id FROM ${table('document_jobs')} WHERE id = ? AND user_id = ?
            AND status IN ('succeeded', 'partial_success', 'needs_review', 'failed', 'cancelled')
            AND updated_at < ? FOR UPDATE`, [jobId, userId, cutoff]);
        if (!job) return 'active_or_missing';
        const exports = await trx.queryOne(`SELECT id FROM ${table('document_exports')} WHERE job_id = ? AND status IN ('queued', 'processing') LIMIT 1`, [jobId]);
        if (exports) return 'busy';
        const needle = String(name).toLowerCase();
        const refs = await trx.query(`SELECT image_path AS stored_path FROM ${table('document_pages')} WHERE POSITION(? IN LOWER(REPLACE(image_path, chr(92), '/'))) > 0
            UNION ALL SELECT file_path AS stored_path FROM ${table('document_outputs')} WHERE POSITION(? IN LOWER(REPLACE(file_path, chr(92), '/'))) > 0
            UNION ALL SELECT file_path AS stored_path FROM ${table('document_files')} WHERE POSITION(? IN LOWER(REPLACE(file_path, chr(92), '/'))) > 0`, [needle, needle, needle]);
        return inspect(refs);
    });
}

module.exports = { withDocumentOrphanGuard };
