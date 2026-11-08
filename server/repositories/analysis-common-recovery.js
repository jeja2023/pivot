'use strict';

// The physical-backup operator owns this connection. Keep the short session
// barrier and snapshot writes on the same session to avoid self-deadlock.
async function coverage(client) {
    return (await client.query(`SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname=current_schema() AND c.relkind IN ('r','p') AND NOT EXISTS(
            SELECT 1 FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid
            WHERE t.tgrelid=c.oid AND t.tgname='pivot_common_recovery_write' AND NOT t.tgisinternal AND t.tgenabled='O'
                AND t.tgtype=62 AND p.proname='pivot_common_recovery_write_barrier') ORDER BY c.relname`)).rows;
}
async function tryBarrier(client) {
    return (await client.query("SELECT pg_try_advisory_lock(hashtext('pivot:common-recovery'),hashtext(current_database())) AS acquired")).rows[0].acquired;
}
async function releaseBarrier(client) { await client.query("SELECT pg_advisory_unlock(hashtext('pivot:common-recovery'),hashtext(current_database()))"); }
async function securityHead(client) {
    const row = (await client.query(`SELECT *,
        (SELECT COUNT(*)::int FROM analysis_security_outbox WHERE acknowledged_at IS NULL) AS pending,
        (SELECT COUNT(*)::int FROM analysis_security_inventory WHERE NOT complete) AS incomplete
        FROM analysis_security_state WHERE id='main'`)).rows[0];
    if (!row || row.mode !== 'ready' || row.pending || row.incomplete) throw new Error('独立安全记录尚未全部确认，不能建立共同恢复点。');
    return { originId: row.origin_id, position: Number(row.journal_position), hash: row.journal_hash };
}
async function prepare(client, { id, baseId }) {
    await client.query('BEGIN');
    try {
        await client.query("SELECT pg_advisory_xact_lock_shared(hashtext('pivot:common-recovery'),hashtext(current_database()))");
        await client.query(`INSERT INTO analysis_recovery_points(id,database_position,object_manifest_json,manifest_digest,status,authorization_watermark,backup_id,expires_at)
            VALUES($1,'','{}','', 'building','',$2,NOW()+INTERVAL '30 days')`, [id, baseId]);
        // Foreign-key pin checks can wait for object row locks. Do this before
        // the X barrier, never while another writer is blocked on that gate.
        await client.query(`INSERT INTO analysis_object_references(object_id,reference_kind,reference_id,expires_at)
            SELECT id,'backup',$1,NOW()+INTERVAL '30 days' FROM analysis_data_objects WHERE state='ready'
            ON CONFLICT(object_id,reference_kind,reference_id) DO NOTHING`, [id]);
        await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
}
async function register(client, point) {
    const missing = (await client.query(`SELECT EXISTS(SELECT 1 FROM analysis_data_objects o WHERE o.state='ready' AND NOT EXISTS(
        SELECT 1 FROM analysis_object_references r WHERE r.object_id=o.id AND r.reference_kind='backup' AND r.reference_id=$1)) AS missing`, [point.id])).rows[0];
    if (missing.missing) throw new Error('预复制后存在尚未固定的就绪对象，请重新建立共同恢复点。');
    await client.query(`UPDATE analysis_recovery_points SET object_manifest_json=$2::jsonb,manifest_digest=$3,authorization_watermark=$4,expires_at=NOW()+INTERVAL '30 days'
        WHERE id=$1 AND status='building'`, [point.id, JSON.stringify(point.manifest), point.digest, JSON.stringify(point.security)]);
    // Only this point's existing pin rows change, with foreign keys unchanged.
    // Their retention commitment is part of the common-point transaction.
    await client.query("UPDATE analysis_object_references SET expires_at=NOW()+INTERVAL '30 days' WHERE reference_kind='backup' AND reference_id=$1", [point.id]);
}
async function verified(client, point) {
    const { digest, ...manifest } = point;
    await client.query(`UPDATE analysis_recovery_points SET status='verified',database_position=$2,barrier_ms=$3,verified_at=NOW(),manifest_digest=$4,object_manifest_json=$5::jsonb
        WHERE id=$1 AND status='building'`, [point.id, point.lsn, point.barrierMs, digest, JSON.stringify(manifest)]);
}
async function failed(client, id, code) {
    await client.query("UPDATE analysis_recovery_points SET status='failed',failure_code=$2 WHERE id=$1 AND status='building'", [id, code]);
    await client.query("DELETE FROM analysis_object_references WHERE reference_kind='backup' AND reference_id=$1 AND EXISTS(SELECT 1 FROM analysis_recovery_points WHERE id=$1 AND status='failed')", [id]);
}

async function referenceInventory(client) {
    return (await client.query(`SELECT * FROM (
        SELECT 'analysis_object' AS kind,id::text AS id,storage_key AS path,digest AS sha256,byte_length::text AS bytes FROM analysis_data_objects WHERE state='ready'
        UNION ALL SELECT 'cas',id::text,storage_key,content_digest::text,byte_size::text FROM agent_artifact_objects WHERE ref_count>0 OR expires_at IS NULL OR expires_at>NOW()
        UNION ALL SELECT 'dataset',id,parquet_path,'','' FROM analysis_datasets WHERE deleted_at IS NULL AND status='ready'
        UNION ALL SELECT 'dataset_source',id,source_path,'','' FROM analysis_datasets WHERE deleted_at IS NULL AND status='ready' AND source_path<>''
        UNION ALL SELECT 'attachment',id::text,file_path,'',file_size::text FROM attachments WHERE deleted_at IS NULL AND (expires_at IS NULL OR expires_at>NOW()) AND file_path<>''
        UNION ALL SELECT 'document',id::text,file_path,sha256,file_size::text FROM document_files WHERE deleted_at IS NULL AND file_path<>''
        UNION ALL SELECT 'document_output',id::text,file_path,'',file_size::text FROM document_outputs WHERE status='ready' AND (expires_at IS NULL OR expires_at>NOW())
        UNION ALL SELECT 'document_page',p.id::text,p.image_path,'','' FROM document_pages p JOIN document_files f ON f.id=p.file_id WHERE p.image_path<>'' AND f.deleted_at IS NULL
        UNION ALL SELECT 'knowledge',id::text,source_path,'',source_size::text FROM knowledge_docs WHERE deleted_at IS NULL AND source_path<>''
        UNION ALL SELECT 'knowledge_version',id::text,content_path,'','' FROM knowledge_document_versions WHERE content_path<>''
        UNION ALL SELECT 'regulation',id::text,source_path,source_hash,source_size::text FROM regulation_versions WHERE source_path<>''
        UNION ALL SELECT 'regulation_import',id::text,source_path,source_hash,'' FROM regulation_import_jobs WHERE source_path<>'' AND status IN ('queued','running','retry_wait')
        UNION ALL SELECT 'analysis_artifact',id,file_path,'','' FROM analysis_artifacts WHERE file_path<>''
        UNION ALL SELECT 'analysis_materialization',id,result_file_path,'','' FROM analysis_materializations WHERE deleted_at IS NULL AND status='ready' AND result_file_path<>''
        UNION ALL SELECT 'legacy_query',id,result_file_path,'','' FROM analysis_query_jobs WHERE execution_kind='dataset_sql' AND status='succeeded' AND result_file_path<>''
    ) inventory ORDER BY kind,id LIMIT 1000001`)).rows;
}

module.exports = { coverage, tryBarrier, releaseBarrier, securityHead, prepare, register, verified, failed, referenceInventory };
