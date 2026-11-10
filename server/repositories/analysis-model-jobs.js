'use strict';

const crypto = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { query, queryOne, transaction } = require('../db/client');
const { biError } = require('../services/data-analysis/bi/errors');
const { audit } = require('./analysis-production-models');
const objects = require('./analysis-objects');
const budget = require('./analysis-runtime-budget');

function conflict() { throw biError('ANALYSIS_MODEL_REQUEST_CONFLICT', '同一幂等标识已用于不同请求，请重新生成请求标识。', 409); }

async function get(userId, id, client = { queryOne }) { return client.queryOne("SELECT * FROM analysis_query_jobs WHERE id=? AND user_id=? AND execution_kind IN ('model_check','model_query','model_trial','model_refresh','model_export','dataset_ingest','model_node_preview','model_node_dataset')", [id, userId]); }
async function check(userId, modelId, id) { return queryOne('SELECT * FROM analysis_data_model_checks WHERE id=? AND user_id=? AND model_id=?', [id, userId, modelId]); }
async function latestCheck(userId, modelId, revision) { return queryOne('SELECT * FROM analysis_data_model_checks WHERE user_id=? AND model_id=? AND draft_revision=? ORDER BY created_at DESC LIMIT 1', [userId, modelId, revision]); }
async function listNodeJobs(userId, modelId) { return query("SELECT id,execution_kind,status,progress,last_error,created_at,query_ast_json->>'targetNodeId' AS target_node_id FROM analysis_query_jobs WHERE user_id=? AND model_id=? AND execution_kind IN ('model_node_preview','model_node_dataset') ORDER BY created_at DESC,id DESC LIMIT 20", [userId, modelId]); }

async function admit({ userId, modelId, kind, expectedVersion, definition = null, semanticHash = null, rulesHash = null, publishedVersion = null, manifestId = null, checkId = null, requestKey, requestHash, query: ast = {}, authorize, resolveInput = null, bindingRevision = null, sourceRunId = null, resultFormat = 'ndjson', maxQueued = 16, maxUserQueued = 3 }) {
    return transaction(async trx => {
        await budget.schedulingLock(trx);
        const current = await authorize(trx);
        const duplicate = await trx.queryOne('SELECT * FROM analysis_query_jobs WHERE user_id=? AND model_id=? AND execution_kind=? AND request_key=?', [userId, modelId, kind, requestKey]);
        if (duplicate) { if (duplicate.request_hash !== requestHash) conflict(); return duplicate; }
        await budget.expireQueued(trx);
        await budget.assertQueue(trx, userId, { maxQueued, maxUserQueued });
        if (expectedVersion && Number(current.model.version) !== expectedVersion) throw biError('ANALYSIS_MODEL_VERSION_CONFLICT', '草稿已变化，请保存后重新检查。', 409);
        if (current.model.archived_at) throw biError('ANALYSIS_MODEL_ARCHIVED', '模型已归档，不能发起新计算。', 409);
        if (resolveInput) manifestId = await resolveInput(trx, current);
        if (kind === 'model_refresh') {
            const binding = await trx.queryOne('SELECT * FROM analysis_model_data_bindings WHERE model_id=? AND published_version=? FOR UPDATE', [modelId, publishedVersion]);
            if (!binding || Number(binding.revision) !== bindingRevision) throw biError('ANALYSIS_MODEL_BINDING_CONFLICT', '数据绑定已变化，请重新加载后刷新。', 409);
            const active = await trx.queryOne("SELECT id FROM analysis_query_jobs WHERE model_id=? AND published_version=? AND execution_kind='model_refresh' AND status IN ('queued','running','retry_wait','cancelling')", [modelId, publishedVersion]);
            if (active) throw biError('ANALYSIS_MODEL_REFRESH_RUNNING', '此模型版本已有刷新任务，请等待该任务结束。', 409);
            await trx.execute("UPDATE analysis_model_data_bindings SET data_state='pending',last_refresh_error='' WHERE model_id=? AND published_version=?", [modelId, publishedVersion]);
        }
        let actualCheckId = checkId;
        if (['model_check', 'model_refresh'].includes(kind)) {
            actualCheckId = `check_${crypto.randomUUID()}`;
            await trx.execute(`INSERT INTO analysis_data_model_checks(id,model_id,user_id,draft_revision,published_version,definition_json,semantic_hash,rules_hash,manifest_id,request_key,request_hash,comparison_json)
                VALUES (?,?,?,?,?,?::jsonb,?,?,?,?,?,?::jsonb)`, [actualCheckId, modelId, userId, expectedVersion || current.model.version, publishedVersion, JSON.stringify(definition), semanticHash, rulesHash, manifestId, requestKey, requestHash, JSON.stringify(ast.migrationComparison ? { migrationComparison: ast.migrationComparison } : {})]);
        }
        const id = `query_job_${crypto.randomUUID()}`;
        const seconds = ['model_check', 'model_refresh', 'model_export', 'model_node_dataset'].includes(kind) ? 420 : 300;
        const row = await trx.queryOne(`INSERT INTO analysis_query_jobs(id,user_id,dataset_id,sql_text,requested_limit,execution_kind,model_id,published_version,manifest_id,check_id,query_ast_json,authorization_vector_json,request_key,request_hash,deadline_at,queue_deadline_at,next_run_at,runtime_protocol,binding_revision,source_run_id,result_format)
            VALUES (?,?,NULL,'',?,?,?,?,?,?,?::jsonb,?::jsonb,?,?,NOW()+(? * INTERVAL '1 second'),NOW()+(? * INTERVAL '1 second'),NOW(),2,?,?,?) RETURNING *`, [id, userId, ast.limit || 100, kind, modelId, publishedVersion, manifestId, actualCheckId, JSON.stringify(ast), JSON.stringify(current.vector), requestKey, requestHash, seconds, seconds, bindingRevision, sourceRunId, resultFormat]);
        if (manifestId) {
            const members = await trx.query('SELECT object_id FROM analysis_source_manifest_members WHERE manifest_id=? ORDER BY object_id', [manifestId]);
            await objects.pin(members.map(member => member.object_id), { kind: 'run', referenceId: id }, trx);
        }
        if (sourceRunId) {
            const source = await trx.queryOne("SELECT result_object_id FROM analysis_query_jobs WHERE id=? AND user_id=? AND status='succeeded' AND execution_kind='model_query' AND model_id=? AND published_version=? AND manifest_id=? AND NOT COALESCE((result_metadata_json->>'resultExpired')::boolean,FALSE) FOR SHARE", [sourceRunId, userId, modelId, publishedVersion, manifestId]);
            if (!source?.result_object_id) throw biError('ANALYSIS_MODEL_RESULT_UNAVAILABLE', '原分析结果已不可用，请重新计算后导出。', 409);
            await objects.pin([source.result_object_id], { kind: 'run', referenceId: id }, trx);
        }
        await audit(trx, { userId, modelId, runId: id, version: publishedVersion, action: 'job_admitted', details: { kind, requestHash } });
        return row;
    });
}

async function claim(options) {
    return transaction(trx => budget.claim(trx, { ...options, kinds: ['model_check','model_query','model_trial','model_refresh','model_export','dataset_ingest','model_node_preview','model_node_dataset'] }));
}
async function renew(job, leaseSeconds = 30) { return budget.renew(job, leaseSeconds); }
async function attachManifest(job, manifestId) {
    return transaction(async trx => {
        const row = await owned(trx, job);
        if (!row) return false;
        const members = await trx.query('SELECT object_id FROM analysis_source_manifest_members WHERE manifest_id=? ORDER BY object_id', [manifestId]);
        await objects.pin(members.map(member => member.object_id), { kind: 'run', referenceId: job.id }, trx);
        await trx.execute('UPDATE analysis_query_jobs SET manifest_id=? WHERE id=?', [manifestId, job.id]);
        await trx.execute("UPDATE analysis_data_model_checks SET manifest_id=?,status='running' WHERE id=? AND completed_at IS NULL", [manifestId, row.check_id]);
        return true;
    });
}
async function owned(trx, job) { return trx.queryOne(`SELECT q.* FROM analysis_query_jobs q WHERE q.id=? AND q.execution_epoch=? AND q.lease_owner=? AND q.status='running' AND q.lease_expires_at>NOW() AND q.execution_deadline_at>NOW() AND q.cancel_requested_at IS NULL
    AND EXISTS(SELECT 1 FROM analysis_runtime_slots s WHERE s.id=q.slot_id AND s.job_id=q.id AND s.execution_epoch=q.execution_epoch AND s.lease_expires_at>NOW()) FOR UPDATE OF q`, [job.id, job.execution_epoch, job.lease_owner]); }
async function unlockSlot(trx, job) { return budget.release(trx, job); }

async function complete(job, { report = null, result = null, resultObject = null, resultPageObject = null, runtimeMetrics = {}, cacheContext = null, authorize }) {
    const registrationStarted = performance.now();
    return transaction(async trx => {
        const row = await owned(trx, job);
        if (!row) return false;
        const current = await authorize(trx);
        if (row.execution_kind === 'model_query' && result && cacheContext) result = { ...result, cache: { ...result.cache,
            hit: result.cache?.hit === true, key: require('../services/data-analysis/bi/result-cache-key').modelResultCacheKey(row, cacheContext, current.vector),
            computedAt: result.cache?.computedAt || new Date().toISOString() } };
        if (row.execution_kind === 'model_refresh') await require('./analysis-model-publications').activateRefresh(trx, row, report);
        if (report) await trx.execute('UPDATE analysis_data_model_checks SET status=?,complete=?,report_json=?::jsonb,completed_at=NOW() WHERE id=? AND completed_at IS NULL', [report.passed ? 'passed' : 'failed', report.complete, JSON.stringify(report), row.check_id]);
        if (resultObject) await objects.pin([resultObject.id], { kind: 'run', referenceId: job.id }, trx);
        if (resultPageObject) await objects.pin([resultPageObject.id], { kind: 'run', referenceId: job.id }, trx);
        await trx.execute(`UPDATE analysis_query_jobs SET status='succeeded',progress=100,result_metadata_json=?::jsonb,result_object_id=?,result_page_object_id=?,authorization_vector_json=?::jsonb,completed_at=NOW(),lease_expires_at=NULL,locked_at=NULL,last_error='',updated_at=NOW() WHERE id=?`, [JSON.stringify(result || { checkId: row.check_id }), resultObject?.id || null, resultPageObject?.id || null, JSON.stringify(current.vector), job.id]);
        if (row.execution_kind === 'model_query') await require('./analysis-model-consumers').successfulRun(trx, row);
        await require('./analysis-model-consumers').settleRefreshRuns(trx, row);
        const measured = { ...runtimeMetrics, queueWaitMs: Math.max(0, new Date(row.started_at).getTime() - new Date(row.created_at).getTime()), resultRegistrationMs: (runtimeMetrics.resultRegistrationMs || 0) + Math.ceil(performance.now() - registrationStarted) };
        await trx.execute('UPDATE analysis_query_jobs SET execution_metrics_json=?::jsonb WHERE id=?', [JSON.stringify(measured), row.id]);
        await audit(trx, { userId: row.user_id, modelId: row.model_id, version: row.published_version, runId: row.id, action: report ? 'model_checked' : 'model_queried', details: { manifestId: row.manifest_id, passed: report?.passed ?? true, executionEpoch: row.execution_epoch, runtimeMetrics: measured } });
        await require('./analysis-operations').task(trx, row, { report });
        return true;
    });
}
async function releaseSlot(job) { return transaction(trx => unlockSlot(trx, job)); }

async function fail(job, { code, message, retryable = false, runtimeMetrics = {}, errorStatus = 500 }) {
    return transaction(async trx => {
        const row = await trx.queryOne('SELECT * FROM analysis_query_jobs WHERE id=? AND execution_epoch=? AND lease_owner=? FOR UPDATE', [job.id, job.execution_epoch, job.lease_owner]);
        if (!row || !['running', 'cancelling'].includes(row.status)) return false;
        const retry = retryable && !row.cancel_requested_at && Number(row.attempts) < 3;
        const cancelled = Boolean(row.cancel_requested_at);
        const status = cancelled ? 'cancelled' : retry ? 'retry_wait' : 'failed';
        await trx.execute(`UPDATE analysis_query_jobs SET status=?,last_error=?,completed_at=CASE WHEN ? THEN NULL ELSE NOW() END,next_run_at=NOW()+(? * INTERVAL '1 second'),lease_expires_at=NULL,locked_at=NULL,updated_at=NOW() WHERE id=?`, [status, message, retry, (Number(row.attempts) === 1 ? 5 : 15) + Math.random(), job.id]);
        if (!retry && row.execution_kind === 'model_refresh') await require('./analysis-model-publications').refreshFailed(trx, row, code);
        if (!retry && row.check_id && ['model_check', 'model_refresh'].includes(row.execution_kind)) await trx.execute('UPDATE analysis_data_model_checks SET status=?,report_json=?::jsonb,complete=FALSE,completed_at=NOW() WHERE id=? AND completed_at IS NULL', [cancelled ? 'cancelled' : 'incomplete', JSON.stringify({ blockers: [{ code, message }], warnings: [] }), row.check_id]);
        if (row.ingestion_session_id) await require('./analysis-ingestions').markTerminal(trx, row, status, message);
        await unlockSlot(trx, job);
        if (!retry) await require('./analysis-model-consumers').settleRefreshRuns(trx, row);
        await trx.execute('UPDATE analysis_query_jobs SET execution_metrics_json=?::jsonb WHERE id=?', [JSON.stringify(runtimeMetrics), row.id]);
        await audit(trx, { userId: row.user_id, modelId: row.model_id, runId: row.id, action: 'job_failed', outcome: status, errorCode: code, details: { executionEpoch: row.execution_epoch, runtimeMetrics } });
        if (!retry) await require('./analysis-operations').task(trx, row, { status, code, errorStatus });
        return true;
    });
}
async function cancel(userId, id, { cause = 'user' } = {}) {
    if (!['user', 'system'].includes(cause)) throw biError('ANALYSIS_MODEL_INPUT_INVALID', '取消任务的来源无效，请重试。');
    return transaction(async trx => {
        const row = await trx.queryOne("SELECT * FROM analysis_query_jobs WHERE id=? AND user_id=? AND execution_kind IN ('model_check','model_query','model_trial','model_refresh','model_export','dataset_ingest','model_node_preview','model_node_dataset') FOR UPDATE", [id, userId]);
        if (!row) throw biError('ANALYSIS_MODEL_JOB_NOT_FOUND', '分析任务不存在或无权操作。', 404);
        if (!['queued', 'running', 'retry_wait', 'cancelling'].includes(row.status)) return row;
        if (row.status === 'cancelling') return row;
        const active = ['running', 'cancelling'].includes(row.status);
        await trx.execute('UPDATE analysis_query_jobs SET status=?,cancel_requested_at=NOW(),cancel_cause=?,completed_at=CASE WHEN ? THEN NULL ELSE NOW() END,updated_at=NOW() WHERE id=?', [active ? 'cancelling' : 'cancelled', cause, active, id]);
        if (!active && row.check_id && ['model_check', 'model_refresh'].includes(row.execution_kind)) await trx.execute("UPDATE analysis_data_model_checks SET status='cancelled',completed_at=NOW() WHERE id=? AND completed_at IS NULL", [row.check_id]);
        if (!active && row.execution_kind === 'model_refresh') await require('./analysis-model-publications').refreshFailed(trx, row, 'ANALYSIS_MODEL_QUERY_CANCELLED');
        if (!active && row.ingestion_session_id) await require('./analysis-ingestions').markTerminal(trx, row, 'cancelled', '导入已取消。');
        if (!active) await require('./analysis-model-consumers').settleRefreshRuns(trx, row);
        if (!active) await require('./analysis-operations').task(trx, { ...row, cancel_cause: cause }, { status: 'cancelled' });
        await audit(trx, { userId, modelId: row.model_id, version: row.published_version, runId: row.id, action: 'model_job_cancelled', details: { cause, executionEpoch: row.execution_epoch, pendingTermination: active } });
        return trx.queryOne('SELECT * FROM analysis_query_jobs WHERE id=? AND user_id=?', [id, userId]);
    });
}
async function expired() { return query("SELECT * FROM analysis_query_jobs WHERE execution_kind IN ('model_check','model_query','model_trial','model_refresh','model_export','dataset_ingest','model_node_preview','model_node_dataset') AND status IN ('running','cancelling') AND (lease_expires_at<NOW() OR execution_deadline_at<NOW() OR cancel_requested_at IS NOT NULL)"); }

module.exports = { get, check, latestCheck, listNodeJobs, admit, claim, renew, attachManifest, owned, complete, fail, cancel, expired, releaseSlot };
