'use strict';

const crypto = require('node:crypto');
const { Client } = require('pg');
const { getPgPool } = require('../db/pg-connection');
const { query, queryOne, execute, transaction } = require('../db/client');
const objects = require('./analysis-objects');

async function exclusive(run) {
    const client = new Client({ ...getPgPool().options, application_name: 'pivot-analysis-integrity' });
    let locked = false, broken = false;
    client.on('error', () => { broken = true; });
    try {
        await client.connect();
        locked = (await client.query("SELECT pg_try_advisory_lock(hashtext('pivot:analysis:integrity'),0) AS locked")).rows[0].locked;
        return locked ? await run() : { skipped: 'already_running' };
    } finally {
        if (locked && !broken) await client.query("SELECT pg_advisory_unlock(hashtext('pivot:analysis:integrity'),0)").catch(() => {});
        await client.end().catch(() => {});
    }
}
async function principal() { return queryOne("SELECT id FROM users WHERE status='active' AND deleted_at IS NULL ORDER BY CASE WHEN username='admin' THEN 0 ELSE 1 END,id LIMIT 1"); }
async function state() {
    await execute("INSERT INTO analysis_integrity_state(id) VALUES ('main') ON CONFLICT(id) DO NOTHING");
    return queryOne("SELECT * FROM analysis_integrity_state WHERE id='main'");
}
async function candidates(cursor, limit = 64) { return query("SELECT * FROM analysis_data_objects WHERE id>? AND state='ready' ORDER BY id LIMIT ?", [cursor, limit]); }
async function verified(id) { return execute("UPDATE analysis_data_objects SET verified_at=NOW() WHERE id=? AND state='ready'", [id]); }
async function checkpoint(cursor, { completed = false, error = '' } = {}) {
    return execute("UPDATE analysis_integrity_state SET object_cursor=?,scan_started_at=CASE WHEN ? THEN NOW() ELSE scan_started_at END,last_full_scan_at=CASE WHEN ? THEN NOW() ELSE last_full_scan_at END,last_incremental_at=NOW(),last_error=?,updated_at=NOW() WHERE id='main'", [cursor, completed, completed, error]);
}
async function fileCheckpoint(cursor, completed) { return execute("UPDATE analysis_integrity_state SET file_cursor=?,last_file_scan_at=CASE WHEN ? THEN NOW() ELSE last_file_scan_at END WHERE id='main'", [cursor, completed]); }
async function manifests(cursor) { return query('SELECT * FROM analysis_source_manifests WHERE id>? ORDER BY id LIMIT 100', [cursor]); }
async function manifestCheckpoint(cursor) { return execute("UPDATE analysis_integrity_state SET manifest_cursor=? WHERE id='main'", [cursor]); }
async function finding(kind, targetId, details = {}) {
    return execute(`INSERT INTO analysis_integrity_findings(id,kind,target_id,details_json) VALUES (?,?,?,?::jsonb)
        ON CONFLICT(kind,target_id) DO UPDATE SET last_seen_at=NOW(),resolved_at=NULL,details_json=EXCLUDED.details_json`, [crypto.randomUUID(), kind, targetId, JSON.stringify(details)]);
}
async function resolveFinding(kind, targetId) { return execute('UPDATE analysis_integrity_findings SET resolved_at=NOW() WHERE kind=? AND target_id=? AND resolved_at IS NULL', [kind, targetId]); }
async function storageRegistered(key) { return Boolean(await queryOne("SELECT 1 FROM analysis_data_objects WHERE storage_key=? AND state<>'expired'", [key])); }
async function unexpectedReferences() {
    return query(`SELECT DISTINCT r.reference_kind,r.reference_id FROM analysis_object_references r WHERE r.expires_at IS NULL AND (
        (r.reference_kind='run' AND NOT EXISTS(SELECT 1 FROM analysis_query_jobs q WHERE q.id=r.reference_id) AND NOT EXISTS(SELECT 1 FROM analysis_ingestion_sessions s WHERE s.id=r.reference_id)) OR
        (r.reference_kind='manifest' AND r.reference_id NOT LIKE 'dataset-version:%' AND NOT EXISTS(SELECT 1 FROM analysis_source_manifests m WHERE m.id=r.reference_id)) OR
        (r.reference_kind='manifest' AND r.reference_id LIKE 'dataset-version:%' AND NOT EXISTS(SELECT 1 FROM analysis_dataset_versions v JOIN analysis_datasets d ON d.id=v.dataset_id WHERE 'dataset-version:'||v.id=r.reference_id AND d.deleted_at IS NULL)) OR
        (r.reference_kind='export' AND r.reference_id LIKE 'view:%' AND NOT EXISTS(SELECT 1 FROM analysis_saved_views v WHERE 'view:'||v.id=r.reference_id AND v.deleted_at IS NULL)) OR
        (r.reference_kind='export' AND r.reference_id LIKE 'dashboard-item:%' AND NOT EXISTS(SELECT 1 FROM analysis_dashboard_items i JOIN analysis_dashboards d ON d.id=i.dashboard_id WHERE 'dashboard-item:'||i.id=r.reference_id AND d.deleted_at IS NULL))) LIMIT 100`);
}
async function retainFixedResults(trx, { kind, id, jobId }) {
    const job = await trx.queryOne("SELECT * FROM analysis_query_jobs WHERE id=? AND status='succeeded' FOR SHARE", [jobId]);
    if (!job || job.result_metadata_json?.resultExpired) return false;
    const ids = [job.result_object_id, job.result_page_object_id].filter(Boolean);
    if (!ids.length) return false;
    await objects.pin(ids, { kind: 'export', referenceId: `${kind}:${id}` }, trx);
    return true;
}
async function retention() {
    return transaction(async trx => {
        await trx.execute("SET LOCAL lock_timeout='2s'");
        await trx.execute("DELETE FROM analysis_saved_views WHERE id IN (SELECT id FROM analysis_saved_views WHERE deleted_at<NOW()-INTERVAL '90 days' ORDER BY deleted_at LIMIT 100)");
        await trx.execute("DELETE FROM analysis_dashboards WHERE id IN (SELECT id FROM analysis_dashboards WHERE deleted_at<NOW()-INTERVAL '90 days' ORDER BY deleted_at LIMIT 100)");
        const fixed = await trx.query(`SELECT f.* FROM (SELECT 'view' AS kind,v.id,v.last_run_id AS job_id FROM analysis_saved_views v WHERE v.source_type='model' AND v.deleted_at IS NULL AND v.last_run_id IS NOT NULL
            UNION ALL SELECT 'dashboard-item',i.id,COALESCE(i.last_successful_run_id,i.last_run_id) FROM analysis_dashboard_items i JOIN analysis_dashboards d ON d.id=i.dashboard_id WHERE i.source_type='model' AND d.deleted_at IS NULL AND COALESCE(i.last_successful_run_id,i.last_run_id) IS NOT NULL) f
            JOIN analysis_query_jobs q ON q.id=f.job_id AND q.status='succeeded' AND NOT COALESCE((q.result_metadata_json->>'resultExpired')::boolean,FALSE)
            JOIN analysis_data_objects o ON o.id=q.result_object_id AND o.state='ready'
            WHERE NOT EXISTS(SELECT 1 FROM analysis_object_references r WHERE r.reference_kind='export' AND r.reference_id=f.kind||':'||f.id AND r.object_id=q.result_object_id) LIMIT 100`);
        for (const item of fixed) await retainFixedResults(trx, { kind: item.kind, id: item.id, jobId: item.job_id });
        await trx.execute(`WITH due AS (SELECT r.object_id,r.reference_id,q.completed_at+CASE WHEN o.purpose IN ('result','export') THEN INTERVAL '7 days' ELSE INTERVAL '90 days' END AS expires_at
            FROM analysis_object_references r JOIN analysis_query_jobs q ON q.id=r.reference_id JOIN analysis_data_objects o ON o.id=r.object_id
            WHERE r.reference_kind='run' AND r.expires_at IS NULL AND q.status IN ('succeeded','failed','cancelled') AND q.completed_at IS NOT NULL LIMIT 300)
            UPDATE analysis_object_references r SET expires_at=due.expires_at FROM due WHERE r.object_id=due.object_id AND r.reference_id=due.reference_id AND r.reference_kind='run'`);
        const expired = await trx.query(`UPDATE analysis_query_jobs q SET result_metadata_json=(q.result_metadata_json-'rows'-'total'-'preview')||'{"resultExpired":true}'::jsonb
            WHERE q.execution_kind IN ('model_query','model_trial','model_export','model_node_preview') AND q.status='succeeded' AND q.completed_at<NOW()-INTERVAL '7 days' AND NOT COALESCE((q.result_metadata_json->>'resultExpired')::boolean,FALSE)
            AND NOT EXISTS(SELECT 1 FROM analysis_saved_views v WHERE v.last_run_id=q.id AND v.deleted_at IS NULL)
            AND NOT EXISTS(SELECT 1 FROM analysis_dashboard_items i JOIN analysis_dashboards d ON d.id=i.dashboard_id WHERE (i.last_run_id=q.id OR i.last_successful_run_id=q.id) AND d.deleted_at IS NULL)
            AND NOT EXISTS(SELECT 1 FROM analysis_query_jobs child WHERE child.source_run_id=q.id AND child.status IN ('queued','running','retry_wait','cancelling')) RETURNING id,user_id,model_id,published_version`);
        for (const job of expired) await require('./analysis-production-models').audit(trx, { userId: job.user_id, modelId: job.model_id, runId: job.id, version: job.published_version, action: 'model_result_expired' });
        // 终态记录的外键仍在时保留墓碑；不为删除运行记录而删除固定消费者。
        const oldJobs = await trx.query(`SELECT q.id FROM analysis_query_jobs q WHERE q.status IN ('succeeded','failed','cancelled') AND q.completed_at<NOW()-INTERVAL '90 days'
            AND NOT EXISTS(SELECT 1 FROM analysis_runtime_slots s WHERE s.job_id=q.id)
            AND NOT EXISTS(SELECT 1 FROM analysis_query_jobs child WHERE child.source_run_id=q.id)
            AND NOT EXISTS(SELECT 1 FROM analysis_saved_views v WHERE v.last_run_id=q.id)
            AND NOT EXISTS(SELECT 1 FROM analysis_dashboard_items i WHERE i.last_run_id=q.id OR i.last_successful_run_id=q.id)
            AND NOT EXISTS(SELECT 1 FROM analysis_ingestion_sessions s WHERE s.job_id=q.id) ORDER BY q.completed_at LIMIT 100 FOR UPDATE OF q SKIP LOCKED`);
        for (const job of oldJobs) { await objects.release('run', job.id, trx); await trx.execute('DELETE FROM analysis_query_jobs WHERE id=?', [job.id]); }
        const oldChecks = await trx.query(`WITH due AS (SELECT c.id FROM analysis_data_model_checks c WHERE c.completed_at<NOW()-INTERVAL '90 days'
            AND NOT EXISTS(SELECT 1 FROM analysis_query_jobs q WHERE q.check_id=c.id)
            AND NOT EXISTS(SELECT 1 FROM analysis_model_data_bindings b WHERE b.check_id=c.id)
            AND NOT EXISTS(SELECT 1 FROM analysis_model_reviews r WHERE r.check_id=c.id) ORDER BY c.completed_at LIMIT 100 FOR UPDATE SKIP LOCKED)
            DELETE FROM analysis_data_model_checks c USING due WHERE c.id=due.id RETURNING c.id`);
        const oldManifests = await trx.query(`SELECT m.id FROM analysis_source_manifests m WHERE m.created_at<NOW()-INTERVAL '30 days'
            AND NOT EXISTS(SELECT 1 FROM analysis_data_model_checks c WHERE c.manifest_id=m.id)
            AND NOT EXISTS(SELECT 1 FROM analysis_model_data_bindings b WHERE b.manifest_id=m.id)
            AND NOT EXISTS(SELECT 1 FROM analysis_query_jobs q WHERE q.manifest_id=m.id)
            AND NOT EXISTS(SELECT 1 FROM analysis_saved_views v WHERE v.historical_manifest_id=m.id)
            AND NOT EXISTS(SELECT 1 FROM analysis_dashboard_items i WHERE i.historical_manifest_id=m.id)
            AND NOT EXISTS(SELECT 1 FROM analysis_object_references r JOIN analysis_source_manifest_members s ON s.object_id=r.object_id WHERE s.manifest_id=m.id AND r.reference_kind='backup' AND (r.expires_at IS NULL OR r.expires_at>NOW()))
            ORDER BY m.id LIMIT 100 FOR UPDATE OF m SKIP LOCKED`);
        for (const manifest of oldManifests) {
            await trx.execute('DELETE FROM analysis_source_manifests WHERE id=?', [manifest.id]);
            await objects.release('manifest', manifest.id, trx);
        }
        const sessions = await trx.query("SELECT id FROM analysis_ingestion_sessions WHERE status IN ('succeeded','failed','cancelled') AND updated_at<NOW()-INTERVAL '90 days' ORDER BY updated_at LIMIT 100 FOR UPDATE SKIP LOCKED");
        for (const session of sessions) {
            // 导入任务合同要求保留会话指针；先删无消费者的终态任务，再删完整会话，分块由级联一次解除。
            const job = await trx.queryOne("SELECT q.id FROM analysis_query_jobs q WHERE q.ingestion_session_id=? AND q.status IN ('succeeded','failed','cancelled') AND q.completed_at<NOW()-INTERVAL '90 days' AND NOT EXISTS(SELECT 1 FROM analysis_runtime_slots s WHERE s.job_id=q.id) FOR UPDATE", [session.id]);
            if (job) { await objects.release('run', job.id, trx); await trx.execute('DELETE FROM analysis_query_jobs WHERE id=?', [job.id]); }
            if (await trx.queryOne('SELECT 1 FROM analysis_query_jobs WHERE ingestion_session_id=?', [session.id])) continue;
            await objects.release('run', session.id, trx);
            await trx.execute('DELETE FROM analysis_ingestion_sessions WHERE id=?', [session.id]);
        }
        await trx.execute("DELETE FROM analysis_object_references WHERE expires_at<NOW() AND reference_kind IN ('lease','run')");
        await trx.execute("DELETE FROM analysis_audit_events WHERE created_at<NOW()-INTERVAL '180 days' AND delivered_at IS NOT NULL");
        return { resultsExpired: expired.length, runsDeleted: oldJobs.length, checksDeleted: oldChecks.length, manifestsDeleted: oldManifests.length, sessionsDeleted: sessions.length };
    });
}
async function metadataIssues() {
    const issues = await query(`SELECT 'result_missing' AS kind,q.id AS target_id FROM analysis_query_jobs q LEFT JOIN analysis_data_objects o ON o.id=q.result_object_id
        WHERE q.status='succeeded' AND q.execution_kind IN ('model_query','model_trial','model_export') AND NOT COALESCE((q.result_metadata_json->>'resultExpired')::boolean,FALSE) AND (o.id IS NULL OR o.state<>'ready')
        UNION ALL SELECT 'binding_invalid',b.model_id||':'||b.published_version FROM analysis_model_data_bindings b
        JOIN analysis_data_model_versions v ON v.model_id=b.model_id AND v.version=b.published_version LEFT JOIN analysis_data_model_checks c ON c.id=b.check_id
        WHERE c.id IS NULL OR c.status<>'passed' OR NOT c.complete OR c.manifest_id<>b.manifest_id OR c.semantic_hash<>v.semantic_hash
        UNION ALL SELECT 'slot_expired',s.job_id FROM analysis_runtime_slots s WHERE s.job_id IS NOT NULL AND s.lease_expires_at<NOW()
        UNION ALL SELECT 'lease_expired',r.reference_id FROM analysis_object_references r WHERE r.reference_kind='lease' AND r.expires_at<NOW()
        LIMIT 500`);
    await execute(`UPDATE analysis_model_data_bindings b SET data_state='source_unavailable',last_refresh_error='ANALYSIS_OBJECT_CORRUPTED'
        WHERE EXISTS(SELECT 1 FROM analysis_source_manifest_members m JOIN analysis_data_objects o ON o.id=m.object_id WHERE m.manifest_id=b.manifest_id AND o.state<>'ready')
        OR EXISTS(SELECT 1 FROM analysis_integrity_findings f WHERE f.resolved_at IS NULL AND ((f.kind='manifest_invalid' AND f.target_id=b.manifest_id) OR (f.kind='binding_invalid' AND f.target_id=b.model_id||':'||b.published_version)))`);
    return issues;
}
async function tempJobProtected(jobId) {
    return Boolean(await queryOne("SELECT 1 FROM analysis_query_jobs q WHERE q.id=? AND (q.status IN ('running','cancelling','queued','retry_wait') OR EXISTS(SELECT 1 FROM analysis_runtime_slots s WHERE s.job_id=q.id))", [jobId]));
}

module.exports = { exclusive, principal, state, candidates, verified, checkpoint, fileCheckpoint, manifests, manifestCheckpoint, finding, resolveFinding, storageRegistered, unexpectedReferences, retainFixedResults, retention, metadataIssues, tempJobProtected };
