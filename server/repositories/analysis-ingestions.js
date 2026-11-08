'use strict';

const crypto = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { query, transaction } = require('../db/client');
const authorization = require('./analysis-authorization');
const objects = require('./analysis-objects');
const budget = require('./analysis-runtime-budget');
const { canonicalHash } = require('../services/data-analysis/bi/canonical');
const { biError } = require('../services/data-analysis/bi/errors');

const authorize = (trx, userId) => authorization.authorize(trx, { userId, definition: { nodes: [] }, required: new Map() });
const invalid = (message, status = 409) => biError('ANALYSIS_INGESTION_CONFLICT', message, status);

async function sessionForUser(trx, userId, id, lock = false) {
    await authorize(trx, userId);
    const row = await trx.queryOne(`SELECT *,expires_at>NOW() AS active FROM analysis_ingestion_sessions WHERE id=? AND user_id=?${lock ? ' FOR UPDATE' : ''}`, [id, userId]);
    if (!row) throw invalid('分批导入任务不存在或无权访问。', 404);
    return row;
}

async function createSession(userId, input) {
    return transaction(async trx => {
        await budget.schedulingLock(trx); await authorize(trx, userId);
        const duplicate = await trx.queryOne('SELECT * FROM analysis_ingestion_sessions WHERE user_id=? AND request_key=?', [userId, input.requestKey]);
        if (duplicate) { if (duplicate.request_hash !== input.requestHash) throw invalid('同一导入标识已用于其他文件。'); return duplicate; }
        await require('./analysis-release-controls').assertAllowed(trx, 'admission', { locked: true });
        const counts = await trx.queryOne("SELECT COUNT(*) AS total,COUNT(*) FILTER(WHERE user_id=?) AS own FROM analysis_ingestion_sessions WHERE status='receiving' AND expires_at>NOW()", [userId]);
        if (Number(counts.total) >= 16 || Number(counts.own) >= 3) throw invalid('待上传的分批导入已达到上限，请先完成或取消现有任务。', 429);
        return trx.queryOne(`INSERT INTO analysis_ingestion_sessions(id,user_id,target_dataset_id,name,original_name,role,headers_json,expected_bytes,expected_chunks,expected_rows,request_key,request_hash,source_metadata_json)
            VALUES (?,?,?,?,?,?,?::jsonb,?,?,?,?,?,?::jsonb) RETURNING *`, [`ingest_${crypto.randomUUID()}`, userId, `ds_${crypto.randomUUID()}`, input.name, input.originalName, input.role, JSON.stringify(input.headers), input.expectedBytes, input.expectedChunks, input.expectedRows, input.requestKey, input.requestHash, JSON.stringify(input.sourceMetadata)]);
    });
}

async function get(userId, id) {
    return transaction(async trx => {
        const session = await sessionForUser(trx, userId, id);
        const chunks = await trx.query('SELECT part_index,digest,byte_length FROM analysis_ingestion_chunks WHERE session_id=? ORDER BY part_index', [id]);
        const job = session.job_id ? await trx.queryOne('SELECT id,status,progress,last_error,started_at,completed_at FROM analysis_query_jobs WHERE id=? AND user_id=?', [session.job_id, userId]) : null;
        return { session, chunks, job };
    });
}

async function list(userId) {
    return transaction(async trx => { await authorize(trx, userId); return trx.query('SELECT id FROM analysis_ingestion_sessions WHERE user_id=? ORDER BY created_at DESC LIMIT 30', [userId]); });
}

async function addChunk(userId, id, index, object) {
    return transaction(async trx => {
        const session = await sessionForUser(trx, userId, id, true);
        const previous = await trx.queryOne('SELECT * FROM analysis_ingestion_chunks WHERE session_id=? AND part_index=?', [id, index]);
        if (previous) { if (previous.digest !== object.digest || String(previous.byte_length) !== String(object.byte_length)) throw invalid('已确认的分块不能被其他内容覆盖。'); return previous; }
        if (session.status !== 'receiving' || !session.active) throw invalid('此导入已提交、取消或过期，不能继续写入。');
        if (index >= Number(session.expected_chunks) || Number(session.received_bytes) + Number(object.byte_length) > Number(session.expected_bytes)) throw invalid('分块数量或总字节数与导入合同不一致。');
        const actual = await trx.queryOne("SELECT * FROM analysis_data_objects WHERE id=? AND user_id=? AND state='ready' AND purpose='source'", [object.id, userId]);
        if (!actual || actual.digest !== object.digest || Number(actual.byte_length) !== Number(object.byte_length)) throw invalid('分块内容对象未就绪。');
        await objects.pin([object.id], { kind: 'run', referenceId: id, seconds: 86400 }, trx);
        await trx.execute('INSERT INTO analysis_ingestion_chunks(session_id,part_index,object_id,digest,byte_length) VALUES (?,?,?,?,?)', [id, index, object.id, object.digest, object.byte_length]);
        await trx.execute('UPDATE analysis_ingestion_sessions SET received_bytes=received_bytes+?,updated_at=NOW() WHERE id=?', [object.byte_length, id]);
        return { part_index: index, digest: object.digest, byte_length: object.byte_length };
    });
}

async function submit(userId, id) {
    return transaction(async trx => {
        await budget.schedulingLock(trx);
        const session = await sessionForUser(trx, userId, id, true);
        if (session.job_id) return session;
        if (session.status !== 'receiving' || !session.active) throw invalid('此导入已取消或过期，请新建导入任务。');
        const chunks = await trx.query('SELECT * FROM analysis_ingestion_chunks WHERE session_id=? ORDER BY part_index', [id]);
        if (chunks.length !== Number(session.expected_chunks) || chunks.some((part, index) => Number(part.part_index) !== index) || Number(session.received_bytes) !== Number(session.expected_bytes)) throw invalid('文件分块尚未完整到齐，不能开始导入。');
        await budget.expireQueued(trx); await budget.assertQueue(trx, userId);
        const manifestHash = canonicalHash({ requestHash: session.request_hash, chunks: chunks.map(part => [Number(part.part_index), part.digest, String(part.byte_length)]) });
        const jobId = `query_job_${crypto.randomUUID()}`;
        await objects.pin(chunks.map(part => part.object_id), { kind: 'run', referenceId: jobId }, trx);
        await trx.execute(`INSERT INTO analysis_query_jobs(id,user_id,dataset_id,sql_text,execution_kind,runtime_protocol,ingestion_session_id,request_key,request_hash,query_ast_json,deadline_at,queue_deadline_at,next_run_at)
            VALUES (?,?,NULL,'','dataset_ingest',2,?,?,?,?::jsonb,NOW()+INTERVAL '420 seconds',NOW()+INTERVAL '120 seconds',NOW())`, [jobId, userId, id, session.request_key, manifestHash, JSON.stringify({ sessionId: id, manifestHash })]);
        return trx.queryOne("UPDATE analysis_ingestion_sessions SET status='queued',manifest_hash=?,job_id=?,updated_at=NOW() WHERE id=? RETURNING *", [manifestHash, jobId, id]);
    });
}

async function executionInput(job) {
    return transaction(async trx => {
        if (!await require('./analysis-model-jobs').owned(trx, job)) throw biError('ANALYSIS_MODEL_LEASE_LOST', '导入执行租约已失效，不能读取来源或变更状态。', 409);
        const session = await sessionForUser(trx, job.user_id, job.ingestion_session_id, true);
        if (session.job_id !== job.id || session.manifest_hash !== job.request_hash) throw invalid('导入任务与固定分块清单不一致。');
        const chunks = await trx.query('SELECT c.*,o.storage_key,o.state,o.purpose,o.user_id FROM analysis_ingestion_chunks c JOIN analysis_data_objects o ON o.id=c.object_id WHERE session_id=? ORDER BY part_index', [session.id]);
        const hash = canonicalHash({ requestHash: session.request_hash, chunks: chunks.map(part => [Number(part.part_index), part.digest, String(part.byte_length)]) });
        if (hash !== session.manifest_hash || chunks.length !== Number(session.expected_chunks)) throw invalid('导入来源清单校验失败。');
        await trx.execute("UPDATE analysis_ingestion_sessions SET status='running',updated_at=NOW() WHERE id=?", [session.id]);
        return { session, chunks };
    });
}

async function finish(job, { result, object, parquetPath, runtimeMetrics = {} }) {
    const registrationStarted = performance.now();
    return transaction(async trx => {
        const owned = await require('./analysis-model-jobs').owned(trx, job);
        if (!owned) return false;
        const session = await sessionForUser(trx, job.user_id, job.ingestion_session_id, true);
        if (session.job_id !== job.id || session.manifest_hash !== job.request_hash || result.rowCount < 1 || result.rowCount > (session.role === 'fact' ? 1000000 : 2000000) || session.expected_rows !== null && result.rowCount !== Number(session.expected_rows)) throw invalid('导入结果行数或来源清单不符合合同，未登记数据集。');
        if (!Number.isSafeInteger(result.rowCount) || result.complete !== true || !Array.isArray(result.columns) || result.columns.length !== session.headers_json.length || result.columns.some((column, index) => column.key !== `c_${index + 1}` || column.name !== session.headers_json[index]) || !Array.isArray(result.profile) || result.profile.length !== result.columns.length || !Array.isArray(result.previewRows) || result.previewRows.length > 100 || String(result.inputBytes) !== String(session.expected_bytes) || String(result.outputBytes) !== String(object.byte_length)) throw invalid('隔离导入产物不符合完整性合同，未登记数据集。');
        const versionId = `dsv_${crypto.randomUUID()}`;
        const sourceMetadata = { ...session.source_metadata_json, dataUpdatedAt: session.source_metadata_json.dataUpdatedAt || new Date().toISOString(), coverage: session.source_metadata_json.coverage || 'full' };
        await objects.pin([object.id], { kind: 'manifest', referenceId: `dataset-version:${versionId}` }, trx);
        await trx.execute(`INSERT INTO analysis_datasets(id,user_id,name,original_name,file_type,file_size,source_path,parquet_path,row_count,column_count,source_row_count,source_column_count,truncated,truncation_reason,columns_json,profile_json,preview_json,sheet_name,status,source_version,active_version,scope)
            VALUES (?,?,?,?,'controlled_csv',?,'',?,?,?,?,?,0,'',?,?,?,'','ready',1,1,'private')`, [session.target_dataset_id, job.user_id, session.name, session.original_name, session.expected_bytes, parquetPath, result.rowCount, result.columns.length, result.rowCount, result.columns.length, JSON.stringify(result.columns), JSON.stringify(result.profile), JSON.stringify(result.previewRows)]);
        await trx.execute(`INSERT INTO analysis_dataset_versions(id,dataset_id,user_id,version,operation,parquet_path,row_count,column_count,manifest_json)
            VALUES (?,?,?,1,'controlled_import',?,?,?,?::jsonb)`, [versionId, session.target_dataset_id, job.user_id, parquetPath, result.rowCount, result.columns.length, JSON.stringify({ objectId: object.id, digest: object.digest, byteLength: String(object.byte_length), ingestionSessionId: session.id, inputManifestHash: session.manifest_hash, inputBytes: String(session.expected_bytes), coverage: sourceMetadata.coverage, sourceMetadata, previewCellLimit: 256 })]);
        await trx.execute("UPDATE analysis_query_jobs SET status='succeeded',progress=100,result_metadata_json=?::jsonb,result_object_id=?,completed_at=NOW(),last_error='',updated_at=NOW() WHERE id=?", [JSON.stringify({ datasetId: session.target_dataset_id, rowCount: result.rowCount, columnCount: result.columns.length, complete: true, manifestHash: session.manifest_hash }), object.id, job.id]);
        await objects.pin([object.id], { kind: 'run', referenceId: job.id }, trx);
        await trx.execute("UPDATE analysis_ingestion_sessions SET status='succeeded',dataset_id=?,updated_at=NOW(),expires_at=NOW()+INTERVAL '30 days' WHERE id=?", [session.target_dataset_id, session.id]);
        await trx.execute("UPDATE analysis_object_references SET expires_at=NOW()+INTERVAL '30 days' WHERE reference_kind='run' AND reference_id=?", [session.id]);
        const measured = { ...runtimeMetrics, queueWaitMs: Math.max(0, new Date(job.started_at).getTime() - new Date(job.created_at).getTime()), resultRegistrationMs: (runtimeMetrics.resultRegistrationMs || 0) + Math.ceil(performance.now() - registrationStarted) };
        await trx.execute('UPDATE analysis_query_jobs SET execution_metrics_json=?::jsonb WHERE id=?', [JSON.stringify(measured), job.id]);
        await require('./analysis-production-models').audit(trx, { userId: job.user_id, modelId: null, runId: job.id, action: 'dataset_ingested', details: { datasetId: session.target_dataset_id, manifestHash: session.manifest_hash, rowCount: result.rowCount, executionEpoch: job.execution_epoch, runtimeMetrics: measured } });
        await require('./analysis-operations').task(trx, job);
        return true;
    });
}

async function markTerminal(trx, job, status, message = '') {
    if (!job.ingestion_session_id) return;
    await trx.execute('UPDATE analysis_ingestion_sessions SET status=?,last_error=?,updated_at=NOW() WHERE id=? AND job_id=?', [status === 'retry_wait' ? 'queued' : status, message, job.ingestion_session_id, job.id]);
}

async function cancelReceiving(userId, id) {
    return transaction(async trx => {
        const session = await sessionForUser(trx, userId, id, true);
        if (session.job_id) return session;
        if (session.status === 'receiving') await trx.execute("UPDATE analysis_ingestion_sessions SET status='cancelled',updated_at=NOW(),expires_at=NOW()+INTERVAL '7 days' WHERE id=?", [id]);
        return session;
    });
}

async function expireAbandoned() {
    return query(`UPDATE analysis_ingestion_sessions SET status='failed',last_error='分批上传已过期，请重新创建导入任务。',updated_at=NOW()
        WHERE id IN (SELECT id FROM analysis_ingestion_sessions WHERE status='receiving' AND expires_at<NOW() LIMIT 100 FOR UPDATE SKIP LOCKED) RETURNING id`);
}

module.exports = { createSession, get, list, addChunk, submit, executionInput, finish, markTerminal, cancelReceiving, expireAbandoned };
