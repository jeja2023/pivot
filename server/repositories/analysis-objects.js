'use strict';

const { query, queryOne, execute, transaction } = require('../db/client');
const { biError } = require('../services/data-analysis/bi/errors');

async function stage(values) {
    await execute(`INSERT INTO analysis_data_objects(id,user_id,digest,byte_length,storage_key,state,purpose,expires_at)
        VALUES (?,?,?,?,?,'staging',?,NOW()+INTERVAL '1 day') ON CONFLICT (user_id,digest,purpose) DO UPDATE SET state='staging',storage_key=EXCLUDED.storage_key,expires_at=EXCLUDED.expires_at
        WHERE analysis_data_objects.state='expired'`, [values.id, values.userId, values.digest, values.byteSize, values.storageKey, values.purpose]);
    return queryOne('SELECT * FROM analysis_data_objects WHERE user_id = ? AND digest = ? AND purpose = ?', [values.userId, values.digest, values.purpose]);
}
async function ready(id, referenceId) {
    return transaction(async trx => {
        const row = await trx.queryOne("UPDATE analysis_data_objects SET state='ready',ready_at=COALESCE(ready_at,NOW()),verified_at=NOW(),expires_at=GREATEST(expires_at,NOW()+CASE WHEN purpose='source' THEN INTERVAL '30 days' ELSE INTERVAL '7 days' END) WHERE id=? AND state IN ('staging','ready') RETURNING *", [id]);
        if (!row) throw biError('ANALYSIS_OBJECT_NOT_READY', '数据对象不可用，请重新创建来源清单。', 409);
        if (referenceId) await trx.execute("INSERT INTO analysis_object_references(object_id,reference_kind,reference_id,expires_at) VALUES (?,'lease',?,NOW()+INTERVAL '10 minutes') ON CONFLICT (object_id,reference_kind,reference_id) DO UPDATE SET expires_at=EXCLUDED.expires_at", [id, referenceId]);
        return row;
    });
}
async function get(id) { return queryOne('SELECT * FROM analysis_data_objects WHERE id=?', [id]); }
async function quarantine(id) { return execute("UPDATE analysis_data_objects SET state='quarantined' WHERE id=? AND state<>'expired'", [id]); }
async function pin(ids, { kind, referenceId, seconds = null }, trx) {
    for (const id of [...new Set(ids)].sort()) {
        const row = await trx.queryOne("SELECT id FROM analysis_data_objects WHERE id=? AND state='ready' FOR UPDATE", [id]);
        if (!row) throw biError('ANALYSIS_OBJECT_NOT_READY', '来源或结果对象已不可用，请重新检查。', 409);
        await trx.execute(`INSERT INTO analysis_object_references(object_id,reference_kind,reference_id,expires_at) VALUES (?,?,?,CASE WHEN ?::bigint IS NULL THEN NULL ELSE NOW()+(? * INTERVAL '1 second') END)
            ON CONFLICT (object_id,reference_kind,reference_id) DO UPDATE SET expires_at=EXCLUDED.expires_at`, [id, kind, referenceId, seconds, seconds]);
    }
}
async function release(kind, referenceId, client = null) {
    const operation = async trx => {
        const rows = await trx.query('SELECT o.id FROM analysis_data_objects o JOIN analysis_object_references r ON r.object_id=o.id WHERE r.reference_kind=? AND r.reference_id=? ORDER BY o.id FOR UPDATE OF o', [kind, referenceId]);
        for (const row of rows) await trx.execute("UPDATE analysis_data_objects SET expires_at=GREATEST(expires_at,NOW()+CASE WHEN purpose='source' THEN INTERVAL '30 days' ELSE INTERVAL '7 days' END) WHERE id=? AND state IN ('ready','staging')", [row.id]);
        return trx.execute('DELETE FROM analysis_object_references WHERE reference_kind=? AND reference_id=?', [kind, referenceId]);
    };
    return client ? operation(client) : transaction(operation);
}
async function expired(limit = 100) {
    return query(`SELECT id FROM analysis_data_objects o WHERE state IN ('staging','ready','deleting') AND expires_at<NOW()
        AND NOT EXISTS(SELECT 1 FROM analysis_object_references r WHERE r.object_id=o.id AND (r.expires_at IS NULL OR r.expires_at>NOW()))
        ORDER BY expires_at,id LIMIT ?`, [limit]);
}
async function claimDeletion(id) {
    return transaction(async trx => {
        const row = await trx.queryOne('SELECT * FROM analysis_data_objects WHERE id=? FOR UPDATE', [id]);
        if (!row || !['ready', 'staging', 'deleting'].includes(row.state)) return null;
        const retained = await trx.queryOne(`SELECT 1 FROM analysis_object_references WHERE object_id=? AND (expires_at IS NULL OR expires_at>NOW())
            UNION ALL SELECT 1 FROM analysis_source_manifest_members m JOIN analysis_model_data_bindings b ON b.manifest_id=m.manifest_id WHERE m.object_id=?
            UNION ALL SELECT 1 FROM analysis_query_jobs q WHERE (q.result_object_id=? OR q.result_page_object_id=? OR EXISTS(SELECT 1 FROM analysis_source_manifest_members m WHERE m.manifest_id=q.manifest_id AND m.object_id=?))
                AND (q.status IN ('queued','running','retry_wait','cancelling') OR EXISTS(SELECT 1 FROM analysis_runtime_slots s WHERE s.job_id=q.id))
            UNION ALL SELECT 1 FROM analysis_dataset_versions v JOIN analysis_datasets d ON d.id=v.dataset_id AND d.parquet_path=v.parquet_path WHERE v.manifest_json->>'objectId'=? AND d.deleted_at IS NULL
            LIMIT 1`, [id, id, id, id, id, id]);
        if (retained) return null;
        if (row.state !== 'deleting') return trx.queryOne("UPDATE analysis_data_objects SET state='deleting',deletion_epoch=deletion_epoch+1 WHERE id=? AND expires_at<NOW() RETURNING *", [id]);
        return row;
    });
}
async function finishDeletion(row) { return execute("UPDATE analysis_data_objects SET state='expired',storage_key='' WHERE id=? AND state='deleting' AND deletion_epoch=?", [row.id, row.deletion_epoch]); }
async function protectDatasetDeletion(datasetId) {
    const dependency = await queryOne(`SELECT 1 FROM analysis_source_manifest_members WHERE dataset_id=? UNION ALL SELECT 1 FROM analysis_data_model_nodes WHERE dataset_id=? LIMIT 1`, [datasetId, datasetId]);
    if (dependency) throw biError('ANALYSIS_SOURCE_IN_USE', '该数据集仍被数据模型或历史清单引用，请先在依赖页面处理模型引用和保留策略。', 409);
}
module.exports = { stage, ready, get, quarantine, pin, release, expired, claimDeletion, finishDeletion, protectDatasetDeletion };
