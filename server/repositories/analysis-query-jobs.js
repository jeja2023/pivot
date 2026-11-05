'use strict';

const { query, queryOne, execute, transaction } = require('../db/client');

async function create({ id, userId, datasetId, sql, limit, sourceVersion }) {
    await execute(`INSERT INTO analysis_query_jobs (id, user_id, dataset_id, sql_text, requested_limit, source_version, status, progress, attempts, max_attempts, next_run_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 'queued', 0, 0, 3, NOW(), NOW(), NOW())`, [id, userId, datasetId, sql, limit, sourceVersion]);
    return get(userId, id);
}

async function get(userId, id) {
    return queryOne('SELECT * FROM analysis_query_jobs WHERE id = ? AND user_id = ?', [id, userId]);
}

async function list(userId, datasetId, limit) {
    return query(`SELECT * FROM analysis_query_jobs WHERE user_id = ? ${datasetId ? 'AND dataset_id = ?' : ''} ORDER BY created_at DESC, id DESC LIMIT ?`, datasetId ? [userId, datasetId, limit] : [userId, limit]);
}

async function cancel(userId, id) {
    await execute(`UPDATE analysis_query_jobs SET status = 'cancelled', locked_at = NULL, completed_at = NOW(), updated_at = NOW()
        WHERE id = ? AND user_id = ? AND status IN ('queued', 'running', 'retry_wait')`, [id, userId]);
    return get(userId, id);
}

async function claim(leaseMs) {
    return transaction(async trx => {
        const job = await trx.queryOne(`SELECT * FROM analysis_query_jobs
            WHERE (status IN ('queued', 'retry_wait') AND COALESCE(next_run_at, created_at) <= NOW())
                OR (status = 'running' AND COALESCE(locked_at, updated_at) < NOW() - (? * INTERVAL '1 millisecond'))
            ORDER BY COALESCE(next_run_at, created_at) ASC, id ASC LIMIT 1 FOR UPDATE SKIP LOCKED`, [leaseMs]);
        if (!job) return null;
        if (Number(job.attempts) >= Number(job.max_attempts)) {
            await trx.execute(`UPDATE analysis_query_jobs SET status = 'failed', progress = 0, locked_at = NULL, completed_at = NOW(), updated_at = NOW(), last_error = '查询中断且已达到重试上限，请重新创建查询。' WHERE id = ?`, [job.id]);
            return { ...job, exhausted: true };
        }
        await trx.execute(`UPDATE analysis_query_jobs SET status = 'running', progress = 5, attempts = attempts + 1, locked_at = NOW(), started_at = COALESCE(started_at, NOW()), updated_at = NOW() WHERE id = ?`, [job.id]);
        return { ...job, status: 'running', attempts: Number(job.attempts || 0) + 1 };
    });
}

async function renew(job) {
    return Boolean(await execute(`UPDATE analysis_query_jobs SET locked_at = NOW(), updated_at = NOW() WHERE id = ? AND status = 'running' AND attempts = ?`, [job.id, job.attempts]));
}

async function finish(job, result, artifact) {
    return transaction(async trx => {
        const row = await trx.queryOne(`UPDATE analysis_query_jobs SET status = 'succeeded', progress = 100, result_columns_json = ?::jsonb,
            result_preview_json = ?::jsonb, result_row_count = ?, result_truncated = ?, result_file_path = ?, completed_at = NOW(), locked_at = NULL, last_error = '', updated_at = NOW()
            WHERE id = ? AND status = 'running' AND attempts = ? RETURNING id`,
        [JSON.stringify(result.columns), JSON.stringify(result.previewRows), result.rowCount, result.truncated, result.filePath, job.id, job.attempts]);
        if (!row) return false;
        await trx.execute(`INSERT INTO analysis_artifacts (id, user_id, dataset_id, type, title, content, file_path, metadata_json, created_at)
            VALUES (?, ?, ?, 'async_query', ?, '', ?, ?::jsonb, NOW())`,
        [artifact.id, job.user_id, job.dataset_id, artifact.title, result.filePath, JSON.stringify(artifact.metadata)]);
        return true;
    });
}

async function fail(job, { retry, message, backoffMs }) {
    return execute(`UPDATE analysis_query_jobs SET status = ?, progress = 0, last_error = ?, next_run_at = NOW() + (? * INTERVAL '1 millisecond'),
        locked_at = NULL, completed_at = CASE WHEN ? THEN NULL ELSE NOW() END, updated_at = NOW()
        WHERE id = ? AND status = 'running' AND attempts = ?`, [retry ? 'retry_wait' : 'failed', message, backoffMs, retry, job.id, job.attempts]);
}

module.exports = { create, get, list, cancel, claim, renew, finish, fail };
