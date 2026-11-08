'use strict';

const { query, queryOne, execute, transaction } = require('../db/client');
const budget = require('./analysis-runtime-budget');
const owner = `dataset:${require('node:os').hostname()}:${process.pid}:${require('node:crypto').randomUUID()}`;

async function create({ id, userId, datasetId, sql, limit, sourceVersion }) {
    await transaction(async trx => {
        await budget.schedulingLock(trx); await budget.expireQueued(trx); await budget.assertQueue(trx, userId);
        await trx.execute(`INSERT INTO analysis_query_jobs (id, user_id, dataset_id, sql_text, requested_limit, source_version, status, progress, attempts, max_attempts, next_run_at, created_at, updated_at,deadline_at,queue_deadline_at)
            VALUES (?, ?, ?, ?, ?, ?, 'queued', 0, 0, 3, NOW(), NOW(), NOW(),NOW()+INTERVAL '180 seconds',NOW()+INTERVAL '120 seconds')`, [id, userId, datasetId, sql, limit, sourceVersion]);
    });
    return get(userId, id);
}

async function get(userId, id) {
    return queryOne('SELECT * FROM analysis_query_jobs WHERE id = ? AND user_id = ?', [id, userId]);
}

async function list(userId, datasetId, limit) {
    return query(`SELECT * FROM analysis_query_jobs WHERE user_id = ? AND execution_kind = 'dataset_sql' ${datasetId ? 'AND dataset_id = ?' : ''} ORDER BY created_at DESC, id DESC LIMIT ?`, datasetId ? [userId, datasetId, limit] : [userId, limit]);
}

async function cancel(userId, id, { cause = 'user' } = {}) {
    if (!['user', 'system'].includes(cause)) throw new Error('分析取消来源无效。');
    await execute(`UPDATE analysis_query_jobs SET status=CASE WHEN status IN ('running','cancelling') THEN 'cancelling' ELSE 'cancelled' END,cancel_requested_at=NOW(),
        cancel_cause=?,
        completed_at=CASE WHEN status IN ('running','cancelling') THEN NULL ELSE NOW() END,updated_at=NOW()
        WHERE id=? AND user_id=? AND execution_kind='dataset_sql' AND status IN ('queued','running','retry_wait','cancelling')`, [cause, id, userId]);
    return get(userId, id);
}

async function claim(leaseMs) {
    return transaction(trx => budget.claim(trx, { owner, kinds: ['dataset_sql'], leaseSeconds: Math.min(30, leaseMs / 1000) }));
}

async function renew(job) {
    return budget.renew(job);
}

async function finish(job, result, artifact) {
    return transaction(async trx => {
        const row = await trx.queryOne(`UPDATE analysis_query_jobs SET status = 'succeeded', progress = 100, result_columns_json = ?::jsonb,
            result_preview_json = ?::jsonb, result_row_count = ?, result_truncated = ?, result_file_path = ?, completed_at = NOW(), locked_at = NULL, last_error = '', updated_at = NOW()
            WHERE id = ? AND status = 'running' AND attempts = ? AND execution_epoch=? AND lease_owner=? AND lease_expires_at>NOW() AND execution_deadline_at>NOW() AND cancel_requested_at IS NULL RETURNING id`,
        [JSON.stringify(result.columns), JSON.stringify(result.previewRows), result.rowCount, result.truncated, result.filePath, job.id, job.attempts, job.execution_epoch, job.lease_owner]);
        if (!row) return false;
        await trx.execute(`INSERT INTO analysis_artifacts (id, user_id, dataset_id, type, title, content, file_path, metadata_json, created_at)
            VALUES (?, ?, ?, 'async_query', ?, '', ?, ?::jsonb, NOW())`,
        [artifact.id, job.user_id, job.dataset_id, artifact.title, result.filePath, JSON.stringify(artifact.metadata)]);
        return true;
    });
}

async function fail(job, { retry, message, backoffMs }) {
    return execute(`UPDATE analysis_query_jobs SET status=CASE WHEN cancel_requested_at IS NOT NULL THEN 'cancelled' WHEN ? AND deadline_at>NOW() AND queue_deadline_at>NOW() THEN 'retry_wait' ELSE 'failed' END,
        progress=0,last_error=?,next_run_at=NOW()+(? * INTERVAL '1 millisecond'),locked_at=NULL,
        completed_at=CASE WHEN ? AND cancel_requested_at IS NULL AND deadline_at>NOW() AND queue_deadline_at>NOW() THEN NULL ELSE NOW() END,updated_at=NOW()
        WHERE id=? AND status IN ('running','cancelling') AND attempts=? AND execution_epoch=? AND lease_owner=?`, [retry, message, backoffMs, retry, job.id, job.attempts, job.execution_epoch, job.lease_owner]);
}

module.exports = { create, get, list, cancel, claim, renew, finish, fail };
