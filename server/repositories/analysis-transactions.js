'use strict';
const { query, queryOne, execute, transaction } = require('../db/client');
const crypto = require('node:crypto');
const invalid = (message, status = 422) => Object.assign(new Error(message), { status, expose: true });
async function create({ userId, datasetId, revision, requestKey, inputHash, config }) {
    return transaction(async db => {
        await db.queryOne('SELECT pg_advisory_xact_lock(?)', [Number(userId)]);
        const existing = await db.queryOne('SELECT * FROM analysis_transaction_runs WHERE user_id=? AND request_key=?', [userId, requestKey]);
        if (existing) { if (existing.input_hash !== inputHash) throw invalid('该请求标识已用于不同的交易分析。', 409); return existing; }
        const count = await db.queryOne("SELECT COUNT(*) FILTER(WHERE status IN ('queued','running')) AS active,COUNT(*) AS total FROM analysis_transaction_runs WHERE user_id=? AND expires_at>NOW()", [userId]);
        if (Number(count.active) >= 2 || Number(count.total) >= 100) throw invalid('交易分析任务已达到配额，请先取消或删除旧分析。', 429);
        return db.queryOne("INSERT INTO analysis_transaction_runs(id,user_id,dataset_id,source_revision,request_key,input_hash,config,expires_at) VALUES(?,?,?,?,?,?,?::jsonb,NOW()+?*INTERVAL '1 day') RETURNING *", [crypto.randomUUID(), userId, datasetId, revision, requestKey, inputHash, JSON.stringify(config), config.retentionDays]);
    });
}
async function get(userId, id) { const row = await queryOne('SELECT * FROM analysis_transaction_runs WHERE id=? AND user_id=? AND expires_at>NOW()', [id, userId]); if (!row) throw invalid('交易分析不存在、已到期或无权访问。', 404); return row; }
async function list(userId, datasetId) { return query('SELECT id,dataset_id,status,error,created_at,expires_at FROM analysis_transaction_runs WHERE user_id=? AND dataset_id=? AND expires_at>NOW() ORDER BY created_at DESC LIMIT 100', [userId, datasetId]); }
async function claim() {
    return transaction(async db => {
        const job = await db.queryOne("SELECT * FROM analysis_transaction_runs WHERE (status='queued' OR (status='running' AND lease_expires_at<NOW())) AND expires_at>NOW() ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1");
        if (!job) return null;
        return db.queryOne("UPDATE analysis_transaction_runs SET status='running',lease=?,lease_expires_at=NOW()+INTERVAL '2 minutes',updated_at=NOW() WHERE id=? RETURNING *", [crypto.randomUUID(), job.id]);
    });
}
async function finish(job, result, error = '') { return execute("UPDATE analysis_transaction_runs SET status=?,result=?::jsonb,error=?,lease=NULL,lease_expires_at=NULL,updated_at=NOW() WHERE id=? AND status='running' AND lease=? AND lease_expires_at>NOW() AND expires_at>NOW()", [error ? 'failed' : 'succeeded', result ? JSON.stringify(result) : null, error, job.id, job.lease]); }
async function remove(userId, id) { await get(userId, id); return require('./analysis-transaction-retention').purge({ userId, id }); }
async function purgeDataset(datasetId) { return require('./analysis-transaction-retention').purge({ datasetId }); }
async function cleanup() { return require('./analysis-transaction-retention').purge({ expired: true }); }
module.exports = { create, get, list, claim, finish, remove, purgeDataset, cleanup };
