'use strict';

const crypto = require('node:crypto');
const { transaction, query } = require('../db/client');
const { biError } = require('../services/data-analysis/bi/errors');
const { readTypedEnv } = require('../config/env-registry');

// 所有分析类型共用调度锁和槽位。调用者必须在执行单元停止后才释放槽位。
async function schedulingLock(trx) {
    await require('./analysis-release-controls').lock(trx);
    await trx.queryOne("SELECT pg_advisory_xact_lock(hashtext('pivot:analysis:scheduler'),0)");
}

async function assertQueue(trx, userId, { maxQueued = 16, maxUserQueued = 3 } = {}) {
    await require('./analysis-release-controls').assertAllowed(trx, 'admission', { locked: true });
    const counts = await trx.queryOne("SELECT COUNT(*) AS total,COUNT(*) FILTER(WHERE user_id=?) AS own FROM analysis_query_jobs WHERE status IN ('queued','retry_wait')", [userId]);
    if (Number(counts.total) >= maxQueued || Number(counts.own) >= maxUserQueued) throw biError('ANALYSIS_MODEL_QUEUE_FULL', '分析队列已满，请等待当前任务结束后重试。', 429);
}

async function expireQueued(trx) {
    const rows = await trx.query("UPDATE analysis_query_jobs SET status='failed',last_error='任务等待超过截止时间，请重新创建。',completed_at=NOW(),updated_at=NOW() WHERE status IN ('queued','retry_wait') AND (queue_deadline_at<NOW() OR deadline_at<NOW()) RETURNING *");
    for (const row of rows) {
        await require('./analysis-operations').task(trx, row, { status: 'failed', code: 'ANALYSIS_MODEL_QUEUE_EXPIRED' });
        if (row.ingestion_session_id) await require('./analysis-ingestions').markTerminal(trx, row, 'failed', '导入等待超时，请重新创建。');
        if (row.check_id) await trx.execute("UPDATE analysis_data_model_checks SET status='incomplete',complete=FALSE,report_json=?::jsonb,completed_at=NOW() WHERE id=? AND completed_at IS NULL", [JSON.stringify({ blockers: [{ code: 'ANALYSIS_MODEL_QUEUE_EXPIRED', message: '检查任务等待超时，请重新检查。' }], warnings: [] }), row.check_id]);
        if (row.execution_kind === 'model_refresh') await require('./analysis-model-publications').refreshFailed(trx, row, 'ANALYSIS_MODEL_QUEUE_EXPIRED');
        if (row.model_id) {
            await require('./analysis-model-consumers').settleRefreshRuns(trx, row);
            await require('./analysis-production-models').audit(trx, { userId: row.user_id, modelId: row.model_id, runId: row.id, action: 'job_failed', outcome: 'failed', errorCode: 'ANALYSIS_MODEL_QUEUE_EXPIRED' });
        }
    }
}

async function claim(trx, { owner, kinds, jobId = null, slots = readTypedEnv('DATA_ANALYSIS_MODEL_RUNNING_LIMIT'), leaseSeconds = 30 }) {
    await schedulingLock(trx);
    if (!await require('./analysis-release-controls').dispatchAllowed(trx)) return null;
    await expireQueued(trx);
    for (let index = 1; index <= slots; index++) await trx.execute('INSERT INTO analysis_runtime_slots(id) VALUES (?) ON CONFLICT(id) DO NOTHING', [index]);
    const slot = await trx.queryOne('SELECT * FROM analysis_runtime_slots WHERE id<=? AND job_id IS NULL ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED', [slots]);
    if (!slot) return null;
    const job = await trx.queryOne(`SELECT q.* FROM analysis_query_jobs q WHERE (q.runtime_protocol=2 OR q.execution_kind='dataset_sql')
        AND q.status IN ('queued','retry_wait') AND COALESCE(q.next_run_at,q.created_at)<=NOW() AND q.queue_deadline_at>NOW() AND q.deadline_at>NOW() AND q.cancel_requested_at IS NULL
        AND NOT EXISTS(SELECT 1 FROM analysis_runtime_slots s JOIN analysis_query_jobs active ON active.id=s.job_id WHERE active.user_id=q.user_id)
        AND (q.execution_kind IN ('model_query','model_trial','dataset_sql','legacy_operation','model_node_preview') OR NOT EXISTS(SELECT 1 FROM analysis_runtime_slots s JOIN analysis_query_jobs batch ON batch.id=s.job_id WHERE batch.execution_kind IN ('model_check','model_refresh','model_export','dataset_ingest','model_node_dataset')))
        ORDER BY CASE WHEN q.created_at<NOW()-INTERVAL '30 seconds' THEN 0 WHEN q.execution_kind IN ('model_query','model_trial','dataset_sql','legacy_operation','model_node_preview') THEN 1 ELSE 2 END,
        COALESCE((SELECT MAX(history.started_at) FROM analysis_query_jobs history WHERE history.user_id=q.user_id),'-infinity'::timestamptz),q.created_at,q.id LIMIT 1 FOR UPDATE SKIP LOCKED`);
    // 各执行器只领取兼容类型；全局队首由对应执行器领取，避免跨类型绕过公平性。
    if (!job || !kinds.includes(job.execution_kind) || (jobId && job.id !== jobId)) return null;
    const epoch = Number(job.execution_epoch) + 1;
    const seconds = ['model_check', 'model_refresh', 'model_export', 'dataset_ingest', 'model_node_dataset'].includes(job.execution_kind) ? 300 : 180;
    const containerId = (job.execution_kind.startsWith('model_') || job.execution_kind === 'dataset_ingest') ? `pivot-bi-${job.id.replace(/[^A-Za-z0-9]/g, '').slice(0, 48)}-${epoch}` : null;
    const claimed = await trx.queryOne(`UPDATE analysis_query_jobs SET status='running',runtime_protocol=2,execution_epoch=?,lease_owner=?,lease_expires_at=NOW()+(? * INTERVAL '1 second'),container_id=?,slot_id=?,attempts=attempts+1,
        started_at=COALESCE(started_at,NOW()),locked_at=NOW(),execution_deadline_at=LEAST(deadline_at,NOW()+(? * INTERVAL '1 second')),progress=5,updated_at=NOW() WHERE id=? RETURNING *`, [epoch, owner, leaseSeconds, containerId, slot.id, seconds, job.id]);
    await trx.execute('UPDATE analysis_runtime_slots SET job_id=?,execution_epoch=?,lease_expires_at=(SELECT lease_expires_at FROM analysis_query_jobs WHERE id=?) WHERE id=?', [job.id, epoch, job.id, slot.id]);
    return claimed;
}

async function renew(job, leaseSeconds = 30) {
    return transaction(async trx => {
        const row = await trx.queryOne(`UPDATE analysis_query_jobs SET lease_expires_at=NOW()+(? * INTERVAL '1 second'),locked_at=NOW(),updated_at=NOW()
            WHERE id=? AND execution_epoch=? AND lease_owner=? AND status='running' AND lease_expires_at>NOW() AND execution_deadline_at>NOW() AND cancel_requested_at IS NULL RETURNING lease_expires_at`, [leaseSeconds, job.id, job.execution_epoch, job.lease_owner]);
        if (!row) return false;
        return Boolean(await trx.execute('UPDATE analysis_runtime_slots SET lease_expires_at=(SELECT lease_expires_at FROM analysis_query_jobs WHERE id=?) WHERE job_id=? AND execution_epoch=?', [job.id, job.id, job.execution_epoch]));
    });
}

async function release(trx, job) { await trx.execute('UPDATE analysis_runtime_slots SET job_id=NULL,lease_expires_at=NULL WHERE job_id=? AND execution_epoch=?', [job.id, job.execution_epoch]); }

async function createLegacy(userId) {
    return transaction(async trx => {
        await schedulingLock(trx); await expireQueued(trx); await assertQueue(trx, userId);
        const user = await trx.queryOne("SELECT id FROM users WHERE id=? AND status='active' AND deleted_at IS NULL", [userId]);
        if (!user) throw biError('ANALYSIS_MODEL_NOT_FOUND', '分析所属账号已失效。', 403);
        return trx.queryOne(`INSERT INTO analysis_query_jobs(id,user_id,dataset_id,sql_text,execution_kind,runtime_protocol,deadline_at,queue_deadline_at,next_run_at)
            VALUES (?,?,NULL,'','legacy_operation',2,NOW()+INTERVAL '300 seconds',NOW()+INTERVAL '300 seconds',NOW()) RETURNING *`, [`analysis_legacy_${crypto.randomUUID()}`, userId]);
    });
}

async function settleLegacy(job, succeeded, message = '') {
    return transaction(trx => settleLegacyIn(trx, job, succeeded, message));
}

async function settleLegacyIn(trx, job, succeeded, message = '') {
    const row = await trx.queryOne(`UPDATE analysis_query_jobs SET status=CASE WHEN cancel_requested_at IS NOT NULL THEN 'cancelled' WHEN ? AND lease_expires_at>NOW() AND execution_deadline_at>NOW() THEN 'succeeded' ELSE 'failed' END,
        last_error=?,completed_at=NOW(),updated_at=NOW() WHERE id=? AND execution_epoch=? AND lease_owner=? AND execution_kind='legacy_operation' AND status IN ('running','cancelling') RETURNING status`, [succeeded, message, job.id, job.execution_epoch, job.lease_owner]);
    await release(trx, job);
    if (row) return row.status === 'succeeded';
    const completed = await trx.queryOne("SELECT status FROM analysis_query_jobs WHERE id=? AND execution_epoch=? AND lease_owner=? AND execution_kind='legacy_operation'", [job.id, job.execution_epoch, job.lease_owner]);
    return completed?.status === 'succeeded';
}

async function abandonLegacy(id) { return transaction(trx => trx.execute("UPDATE analysis_query_jobs SET status='cancelled',completed_at=NOW(),last_error='请求已结束。' WHERE id=? AND execution_kind='legacy_operation' AND status IN ('queued','retry_wait')", [id])); }

async function cancelLegacyForRelease(userId, id) {
    await transaction(trx => trx.execute(`UPDATE analysis_query_jobs SET status=CASE WHEN status IN ('running','cancelling') THEN 'cancelling' ELSE 'cancelled' END,
        cancel_requested_at=NOW(),cancel_cause='system',completed_at=CASE WHEN status IN ('running','cancelling') THEN NULL ELSE NOW() END,updated_at=NOW()
        WHERE id=? AND user_id=? AND execution_kind='legacy_operation' AND status IN ('queued','retry_wait','running','cancelling')`, [id, userId]));
}

async function expiredNative() {
    return query(`SELECT q.* FROM analysis_query_jobs q JOIN analysis_runtime_slots s ON s.job_id=q.id
    WHERE q.execution_kind IN ('dataset_sql','legacy_operation') AND (q.lease_expires_at<NOW() OR q.execution_deadline_at<NOW() OR q.status NOT IN ('running','cancelling') OR q.cancel_requested_at IS NOT NULL)`);
}

// 只接受监督器已经确认停止的执行单元，不通过租约过期推断进程已终止。
async function settleStopped(job) {
    return transaction(async trx => {
        const current = await trx.queryOne('SELECT * FROM analysis_query_jobs WHERE id=? AND execution_epoch=? AND lease_owner=? FOR UPDATE', [job.id, job.execution_epoch, job.lease_owner]);
        if (!current) return false;
        await trx.execute(`UPDATE analysis_query_jobs SET status=CASE WHEN status IN ('succeeded','failed','cancelled') THEN status WHEN cancel_requested_at IS NOT NULL THEN 'cancelled'
            WHEN execution_kind='dataset_sql' AND attempts<3 AND deadline_at>NOW() AND queue_deadline_at>NOW() THEN 'retry_wait' ELSE 'failed' END,
            next_run_at=NOW()+INTERVAL '5 seconds',completed_at=CASE WHEN execution_kind='dataset_sql' AND status='running' AND cancel_requested_at IS NULL AND attempts<3 AND deadline_at>NOW() AND queue_deadline_at>NOW() THEN NULL ELSE COALESCE(completed_at,NOW()) END,
            lease_expires_at=NULL,locked_at=NULL,last_error='旧执行单元已确认停止。',updated_at=NOW() WHERE id=?`, [job.id]);
        await release(trx, job);
        return true;
    });
}

module.exports = { schedulingLock, assertQueue, expireQueued, claim, renew, release, createLegacy, settleLegacy, settleLegacyIn, abandonLegacy, cancelLegacyForRelease, expiredNative, settleStopped };
