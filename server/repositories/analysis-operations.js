'use strict';

const { query, queryOne, execute, transaction } = require('../db/client');
const { LATENCIES, classify } = require('../services/data-analysis/bi/operation-classification');
const { canonicalHash } = require('../services/data-analysis/bi/canonical');

async function increment(client, { domain, operation, outcome, durationMs = 0, qualityFailure = false }) {
    const duration = Math.max(0, Math.min(86400000, Math.round(durationMs)));
    const histogram = LATENCIES.map(() => 0); histogram[LATENCIES.findIndex(limit => duration <= limit)] = 1;
    return client.execute(`INSERT INTO analysis_operation_buckets(minute_at,domain,operation,outcome,count,quality_failures,duration_sum_ms,latency_counts)
        VALUES (date_trunc('minute',NOW()),?,?,?,1,?,?,?::bigint[]) ON CONFLICT(minute_at,domain,operation,outcome) DO UPDATE
        SET count=analysis_operation_buckets.count+1,quality_failures=analysis_operation_buckets.quality_failures+EXCLUDED.quality_failures,
        duration_sum_ms=analysis_operation_buckets.duration_sum_ms+EXCLUDED.duration_sum_ms,
        latency_counts=ARRAY(SELECT a+b FROM unnest(analysis_operation_buckets.latency_counts,EXCLUDED.latency_counts) AS bins(a,b))`, [domain, operation, outcome, qualityFailure ? 1 : 0, duration, histogram]);
}

async function control(sample) { return increment({ execute }, { domain: 'control', ...sample }); }
async function task(trx, row, { code = '', status = 'succeeded', report = null, errorStatus = 500 } = {}) {
    if (!row.model_id && row.execution_kind !== 'dataset_ingest') return;
    const now = await trx.queryOne('SELECT EXTRACT(EPOCH FROM NOW()-?::timestamptz)*1000 AS duration', [row.created_at]);
    await increment(trx, { domain: 'task', operation: row.execution_kind, outcome: status === 'succeeded' ? 'success' : classify({ status: errorStatus, code, cancelled: status === 'cancelled' && row.cancel_cause === 'user' }),
        durationMs: Number(now.duration), qualityFailure: report?.complete === true && report.passed === false });
}

async function samples(hours = 720) {
    return query(`SELECT domain,operation,outcome,SUM(count) AS count,SUM(quality_failures) AS quality_failures,SUM(duration_sum_ms) AS duration_sum_ms,
        ARRAY[${LATENCIES.map((_, index) => `SUM((b.latency_counts)[${index + 1}])`).join(',')}] AS latency_counts
        FROM analysis_operation_buckets b WHERE minute_at>=NOW()-(?*INTERVAL '1 hour') GROUP BY domain,operation,outcome`, [hours]);
}

async function state() { return queryOne("SELECT * FROM analysis_operation_state WHERE id='main'"); }
async function workerHeartbeat() { await execute("UPDATE analysis_operation_state SET last_worker_poll_at=NOW() WHERE id='main'"); }
async function assertIdleForPreflight() {
    const row = await queryOne('SELECT COUNT(*) AS n FROM analysis_runtime_slots WHERE job_id IS NOT NULL');
    if (Number(row.n)) throw require('../services/data-analysis/bi/errors').biError('ANALYSIS_OPERATIONS_BUSY', '请先在维护窗口排空现有分析任务，再执行完整隔离预检。', 503);
}
async function alertsToEmit(findings) {
    return transaction(async trx => {
        const state = await trx.queryOne("SELECT alert_state_json FROM analysis_operation_state WHERE id='main' FOR UPDATE");
        const previous = state.alert_state_json, next = {}, emit = [], now = Date.now();
        for (const finding of findings) {
            const old = previous[finding.code], changed = !old || old.severity !== finding.severity || now - Date.parse(old.at) >= 300000;
            next[finding.code] = changed ? { severity: finding.severity, at: new Date(now).toISOString() } : old;
            if (changed) emit.push(finding);
        }
        await trx.execute("UPDATE analysis_operation_state SET alert_state_json=?::jsonb WHERE id='main'", [JSON.stringify(next)]);
        return emit;
    });
}
async function saveProbe(config, userId) {
    return transaction(async trx => {
        const previous = await trx.queryOne("SELECT probe_config_json FROM analysis_operation_state WHERE id='main' FOR UPDATE");
        const result = await trx.queryOne("UPDATE analysis_operation_state SET probe_config_json=?::jsonb,probe_revision=probe_revision+1,pending_run_id=NULL,probe_outcome=?,probe_error='',probe_started_at=NULL,probe_finished_at=NULL,updated_at=NOW() WHERE id='main' RETURNING *", [JSON.stringify(config), config.enabled ? 'ready' : 'disabled']);
        await require('./analysis-production-models').audit(trx, { userId, modelId: config.modelId || previous.probe_config_json.modelId || null, version: config.publishedVersion || null,
            action: config.enabled ? 'model_probe_configured' : 'model_probe_disabled', details: { revision: result.probe_revision, beforeHash: canonicalHash(previous.probe_config_json), afterHash: canonicalHash(config), expectedHash: config.expectedHash || null } });
        return result;
    });
}
async function updateProbe(revision, { jobId = null, outcome, error = '', started = false, finished = false }) {
    return queryOne(`UPDATE analysis_operation_state SET pending_run_id=?,probe_outcome=?,probe_error=?,
        probe_started_at=CASE WHEN ? THEN NOW() ELSE probe_started_at END,probe_finished_at=CASE WHEN ? THEN NOW() ELSE probe_finished_at END,updated_at=NOW()
        WHERE id='main' AND probe_revision=? RETURNING *`, [jobId, outcome, error.slice(0, 500), started, finished, revision]);
}
async function principals(ids) { return query("SELECT id,username,unit,role,status,deleted_at,(password_hash LIKE '!bi-probe:%') AS service_only FROM users WHERE id=ANY(?::bigint[])", [ids]); }
async function createProbePrincipals() {
    const crypto = require('node:crypto');
    return transaction(async trx => {
        const result = [];
        for (const kind of ['positive', 'negative']) result.push(await trx.queryOne("INSERT INTO users(username,password_hash,unit,role,status) VALUES (?,?,?,'user','active') RETURNING id,username,unit,role,status", [`bi_probe_${kind}_${crypto.randomUUID()}`, `!bi-probe:${crypto.randomUUID()}`, `BI专用监控_${crypto.randomUUID()}`]));
        return result;
    });
}
async function fence(reason, { userId = null, actor = 'bi_probe' } = {}) {
    return transaction(async trx => {
        const row = await trx.queryOne("SELECT access_fenced,fence_reason FROM analysis_operation_state WHERE id='main' FOR UPDATE");
        if (row.access_fenced && row.fence_reason === reason) return;
        const after = { access_fenced: true, fence_reason: reason.slice(0, 500) };
        await trx.execute("UPDATE analysis_operation_state SET access_fenced=TRUE,fence_reason=?,updated_at=NOW() WHERE id='main'", [after.fence_reason]);
        await require('./analysis-production-models').audit(trx, { userId, action: 'model_incident_fenced', details: { actor, beforeHash: canonicalHash(row), afterHash: canonicalHash(after) } });
    });
}
async function resume(userId, reason) {
    return transaction(async trx => {
        const row = await trx.queryOne("SELECT * FROM analysis_operation_state WHERE id='main' FOR UPDATE");
        if (row.probe_outcome !== 'succeeded' || Date.now() - new Date(row.probe_finished_at).getTime() > 90000) throw require('../services/data-analysis/bi/errors').biError('ANALYSIS_MODEL_PROBE_REQUIRED', '请先完成最近九十秒内的正向与反向合成检查，再恢复业务分析。', 409);
        await trx.execute("UPDATE analysis_operation_state SET access_fenced=FALSE,fence_reason='',updated_at=NOW() WHERE id='main'");
        await require('./analysis-production-models').audit(trx, { userId, action: 'model_incident_resumed', details: { reason, probeRevision: row.probe_revision, beforeHash: canonicalHash({ accessFenced: row.access_fenced, reason: row.fence_reason }), afterHash: canonicalHash({ accessFenced: false, reason: '' }) } });
        return { resumed: true };
    });
}
async function health() {
    return queryOne(`SELECT
        (SELECT COUNT(*) FROM analysis_query_jobs WHERE (execution_kind LIKE 'model_%' OR execution_kind='dataset_ingest') AND status IN ('queued','retry_wait') AND created_at<NOW()-INTERVAL '30 seconds') AS waiting,
        (SELECT COUNT(*) FROM analysis_runtime_slots s JOIN analysis_query_jobs q ON q.id=s.job_id WHERE q.execution_kind LIKE 'model_%' AND (q.status NOT IN ('running','cancelling') OR s.lease_expires_at<NOW())) AS orphan_slots,
        (SELECT COUNT(*) FROM analysis_integrity_findings WHERE resolved_at IS NULL) AS integrity_findings,
        (SELECT EXTRACT(EPOCH FROM NOW()-MAX(created_at)) FROM analysis_recovery_points WHERE status='verified') AS recovery_age_seconds,
        (SELECT EXTRACT(EPOCH FROM NOW()-MIN(created_at)) FROM analysis_audit_events WHERE delivered_at IS NULL) AS audit_lag_seconds,
        (SELECT MAX(GREATEST(COALESCE((execution_metrics_json->>'maxRssBytes')::bigint,0),COALESCE((execution_metrics_json->>'cgroupPeakBytes')::bigint,0))) FROM analysis_query_jobs WHERE completed_at>NOW()-INTERVAL '5 minutes' AND execution_kind IN ('model_check','model_query','model_trial','model_refresh','model_export','dataset_ingest')) AS memory_peak_bytes,
        (SELECT MAX((execution_metrics_json->>'peakSpillBytes')::bigint) FROM analysis_query_jobs WHERE completed_at>NOW()-INTERVAL '5 minutes' AND execution_kind IN ('model_check','model_query','model_trial','model_refresh','model_export','dataset_ingest')) AS spill_peak_bytes,
        (SELECT COUNT(*) FROM analysis_data_models m JOIN analysis_data_model_versions v ON v.model_id=m.id AND v.version=m.published_version
            JOIN analysis_model_data_bindings b ON b.model_id=m.id AND b.published_version=m.published_version
            JOIN analysis_source_manifests s ON s.id=b.manifest_id WHERE m.deleted_at IS NULL AND m.archived_at IS NULL AND (
                b.data_state<>'available' OR EXISTS(SELECT 1 FROM jsonb_array_elements(s.manifest_json->'members') member WHERE (member->'watermark'->>'updatedAt')::timestamptz<NOW()-(COALESCE((v.definition_json->>'maxStaleness')::double precision,86400)*INTERVAL '1 second')))) AS stale_models`);
}
async function tick(error = '') {
    await execute("UPDATE analysis_operation_state SET last_tick_at=NOW(),last_error=?,updated_at=NOW() WHERE id='main'", [error.slice(0, 500)]);
    await execute("DELETE FROM analysis_operation_buckets WHERE minute_at<NOW()-INTERVAL '30 days'");
}
async function lockedProbe(run, { required = false } = {}) {
    return transaction(async trx => {
        const lock = await trx.queryOne("SELECT pg_try_advisory_xact_lock(hashtext('pivot:analysis:probe'),0) AS locked");
        if (!lock.locked) {
            if (required) throw require('../services/data-analysis/bi/errors').biError('ANALYSIS_OPERATIONS_BUSY', '合成监控正在核查，请稍后重试配置。', 503);
            return null;
        }
        return run();
    });
}

module.exports = { control, task, samples, state, workerHeartbeat, assertIdleForPreflight, alertsToEmit, saveProbe, updateProbe, principals, createProbePrincipals, fence, resume, health, tick, lockedProbe };
