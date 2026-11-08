'use strict';

const crypto = require('node:crypto');
const TARGET_TABLES = Object.freeze(['users', 'analysis_datasets', 'analysis_data_models', 'analysis_field_governance', 'analysis_saved_views', 'analysis_dashboards', 'analysis_metric_definitions']);
const ASSET_TABLES = new Set(['analysis_saved_views', 'analysis_dashboards', 'analysis_metric_definitions']);

async function applyPrincipal(client, record) {
    const value = record.payload_json;
    const disabled = record.tombstone || record.credential_changed || value.status !== 'active';
    const exists = (await client.query('SELECT id FROM users WHERE id=$1', [record.target_id])).rowCount;
    if (!exists) await client.query(`INSERT INTO users(id,username,password_hash,unit,role,status,deleted_at,token_version) OVERRIDING SYSTEM VALUE
        VALUES ($1,$2,$3,$4,$5,'disabled',CASE WHEN $6 THEN NOW() ELSE NULL END,$7)`,
    [record.target_id, value.username, `!recovery-reset:${crypto.randomUUID()}`, value.unit || '', value.role || 'user', record.tombstone, Number(value.token_version || 0) + 1]);
    else await client.query(`UPDATE users SET unit=$1,role=$2,status=$3,deleted_at=CASE WHEN $4 THEN COALESCE(deleted_at,NOW()) ELSE $5::timestamptz END,
        token_version=GREATEST(COALESCE(token_version,0),$6::bigint)+1,username=$8 WHERE id=$7`, [value.unit || '', value.role || 'user', disabled ? 'disabled' : 'active', record.tombstone, value.deleted_at || null, value.token_version || 0, record.target_id, value.username]);
}

async function preparePrincipalNames(client, records) {
    for (const record of records) if (record.target_table === 'users') {
        const current = (await client.query('SELECT username FROM users WHERE id=$1', [record.target_id])).rows[0];
        if (current && current.username !== record.payload_json.username) await client.query('UPDATE users SET username=$1 WHERE id=$2', [`!recovery:${record.target_id}:${crypto.randomUUID()}`, record.target_id]);
    }
}

async function advanceIdentity(client) {
    await client.query("SELECT setval(pg_get_serial_sequence('users','id'),GREATEST((SELECT COALESCE(MAX(id),1) FROM users),nextval(pg_get_serial_sequence('users','id'))),true)");
}

async function applyDataset(client, record) {
    const value = record.payload_json;
    const row = (await client.query('SELECT columns_json FROM analysis_datasets WHERE id=$1', [record.target_id])).rows[0];
    if (!row) return;
    const keys = new Set(value.columnKeys || []);
    const columns = (typeof row.columns_json === 'string' ? JSON.parse(row.columns_json) : row.columns_json).filter(column => keys.has(column.key));
    await client.query(`UPDATE analysis_datasets SET user_id=$1,scope=$2,allowed_units=$3,allowed_user_ids=$4,status=$5,
        deleted_at=CASE WHEN $6 THEN COALESCE(deleted_at,NOW()) ELSE $7::timestamptz END,columns_json=$8 WHERE id=$9`,
    [value.user_id, value.scope || 'personal', value.allowed_units || '', value.allowed_user_ids || '', record.tombstone ? 'deleted' : value.status || 'ready', record.tombstone, value.deleted_at || null, JSON.stringify(columns), record.target_id]);
}

async function applyModel(client, record) {
    const value = record.payload_json;
    // A newer definition cannot be reconstructed from security metadata. Keep
    // that model archived until its immutable definition is explicitly restored.
    await client.query(`UPDATE analysis_data_models SET user_id=$1,scope=$2,allowed_units=$3,allowed_user_ids=$4,
        deleted_at=CASE WHEN $5 THEN COALESCE(deleted_at,NOW()) ELSE $6::timestamptz END,
        archived_at=CASE WHEN encode(sha256(convert_to(COALESCE(definition_json::text,''),'UTF8')),'hex')<>$7 THEN COALESCE(archived_at,NOW()) ELSE $8::timestamptz END WHERE id=$9`,
    [value.user_id, value.scope || 'personal', value.allowed_units || '', value.allowed_user_ids || '', record.tombstone, value.deleted_at || null, value.definitionHash, value.archived_at || null, record.target_id]);
}

async function applyField(client, record) {
    const value = record.payload_json;
    if (!(await client.query('SELECT id FROM analysis_datasets WHERE id=$1', [value.dataset_id])).rowCount) return;
    if (record.tombstone) {
        // Removing a policy row must not make a restored old column public.
        await client.query("UPDATE analysis_field_governance SET sensitivity='restricted',status='active',revision=revision+1 WHERE dataset_id=$1 AND field_key=$2", [value.dataset_id, value.field_key]);
        return;
    }
    await client.query(`INSERT INTO analysis_field_governance(dataset_id,user_id,field_key,logical_type,unit,date_format,sensitivity,status)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(dataset_id,field_key) DO UPDATE SET logical_type=EXCLUDED.logical_type,unit=EXCLUDED.unit,
        date_format=EXCLUDED.date_format,sensitivity=EXCLUDED.sensitivity,status=EXCLUDED.status,revision=analysis_field_governance.revision+1`,
    [value.dataset_id, value.user_id, value.field_key, value.logical_type || 'auto', value.unit || '', value.date_format || '', value.sensitivity || 'restricted', value.status || 'active']);
}

async function apply(client, record) {
    if (record.target_table === 'users') return applyPrincipal(client, record);
    if (record.target_table === 'analysis_datasets') return applyDataset(client, record);
    if (record.target_table === 'analysis_data_models') return applyModel(client, record);
    if (record.target_table === 'analysis_field_governance') return applyField(client, record);
    if (ASSET_TABLES.has(record.target_table)) {
        const value = record.payload_json;
        return client.query(`UPDATE ${record.target_table} SET user_id=$1,scope=$2,allowed_units=$3,allowed_user_ids=$4,
            deleted_at=CASE WHEN $5 THEN COALESCE(deleted_at,NOW()) ELSE $6::timestamptz END WHERE id=$7`,
        [value.user_id, value.scope || 'personal', value.allowed_units || '', value.allowed_user_ids || '', record.tombstone, value.deleted_at || null, record.target_id]);
    }
}

async function restoreEvent(client, entry) {
    const row = entry.record;
    const columns = ['event_id', 'origin_id', 'transaction_id', 'resource_kind', 'resource_id', 'revision', 'target_table', 'target_id', 'operation', 'actor_id', 'database_actor', 'request_id', 'before_hash', 'after_hash', 'payload_json', 'credential_changed', 'tombstone', 'created_at'];
    await client.query(`INSERT INTO analysis_security_outbox(${columns.join(',')},journal_position,acknowledged_at)
        VALUES (${columns.map((_, i) => `$${i + 1}`).join(',')},$19,NOW()) ON CONFLICT(event_id) DO NOTHING`, [...columns.map(column => row[column]), entry.position]);
    if (row.target_table === 'analysis_audit_events') {
        const value = row.payload_json;
        const user = value.user_id && (await client.query('SELECT id FROM users WHERE id=$1', [value.user_id])).rows[0];
        await client.query(`INSERT INTO analysis_audit_events(id,user_id,model_id,run_id,action,outcome,error_code,details_json,created_at,delivered_at)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW()) ON CONFLICT(id) DO NOTHING`,
        [row.target_id, user?.id || null, value.model_id || null, value.run_id || null, value.action, value.outcome || 'recorded', value.error_code || '', { recoveredFromIndependentJournal: true, originalDetailsHash: value.detailsHash, eventId: row.event_id }, row.created_at]);
    }
    await client.query(`INSERT INTO analysis_security_revisions(resource_kind,resource_id,revision) VALUES ($1,$2,$3)
        ON CONFLICT(resource_kind,resource_id) DO UPDATE SET revision=GREATEST(analysis_security_revisions.revision,EXCLUDED.revision)`, [row.resource_kind, row.resource_id, row.revision]);
}

async function invalidateExecutions(client) {
    await client.query('UPDATE analysis_runtime_slots SET job_id=NULL,execution_epoch=execution_epoch+1,lease_expires_at=NULL');
    await client.query(`UPDATE analysis_query_jobs SET status=CASE WHEN cancel_requested_at IS NOT NULL THEN 'cancelled' WHEN deadline_at<=NOW() OR queue_deadline_at<=NOW() THEN 'failed' ELSE 'retry_wait' END,
        execution_epoch=execution_epoch+1,lease_owner=NULL,lease_expires_at=NULL,execution_deadline_at=NULL,slot_id=NULL,container_id=NULL,next_run_at=NOW(),locked_at=NULL,
        last_error='恢复后原执行租约已失效，需按当前权限重新领取。',updated_at=NOW() WHERE status IN ('running','cancelling')`);
    await client.query('DELETE FROM refresh_tokens');
    await client.query("UPDATE api_keys SET status='disabled' WHERE status='active'");
    await client.query('UPDATE users SET token_version=COALESCE(token_version,0)+1');
    await client.query("UPDATE analysis_refresh_schedules SET status='paused',next_run_at=NULL,last_status='recovery_review_required' WHERE status='active'");
    await client.query("UPDATE analysis_alert_rules SET status='paused' WHERE status='active'");
}

async function audit(client, details) {
    await client.query(`INSERT INTO analysis_audit_events(id,action,outcome,details_json) VALUES ($1,'security_recovery_reconciled','applied',$2)`, [`audit_${crypto.randomUUID()}`, details]);
}

async function replay(client, chain, latest) {
    await client.query('BEGIN');
    try {
        await client.query("SELECT set_config('pivot.security_replay','on',true)");
        await client.query("SET LOCAL lock_timeout='5s'");
        for (const table of TARGET_TABLES) await client.query(`LOCK TABLE ${table} IN SHARE ROW EXCLUSIVE MODE`);
        await preparePrincipalNames(client, latest.values());
        for (const table of TARGET_TABLES) for (const record of latest.values()) if (record.target_table === table) await apply(client, record);
        for (const entry of chain.entries) await restoreEvent(client, entry);
        await advanceIdentity(client);
        await invalidateExecutions(client);
        await client.query("UPDATE analysis_security_state SET journal_position=$1,journal_hash=$2,updated_at=NOW() WHERE id='main'", [chain.position, chain.hash]);
        await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
}

async function applyAuthority(client, body, chain, authorityDigest) {
    await client.query('BEGIN');
    try {
        await client.query("SET LOCAL lock_timeout='5s'");
        for (const table of TARGET_TABLES) await client.query(`LOCK TABLE ${table} IN SHARE ROW EXCLUSIVE MODE`);
        for (const table of TARGET_TABLES) {
            const rows = (await client.query(`SELECT id::text FROM ${table}`)).rows;
            const approved = new Set(body.resources.filter(row => row.target_table === table).map(row => row.target_id));
            if (rows.some(row => !approved.has(row.id))) throw new Error('当前授权核对清单未覆盖恢复后的全部主体和分析资产。');
        }
        for (const row of body.resources.filter(row => row.target_table === 'users' && row.payload_json.status === 'active' && !row.tombstone)) {
            const current = (await client.query('SELECT password_hash FROM users WHERE id=$1', [row.target_id])).rows[0];
            if (!current || crypto.createHash('sha256').update(current.password_hash).digest('hex') !== row.credentialDigest) throw new Error('当前凭据指纹未得到身份源确认。');
        }
        await preparePrincipalNames(client, body.resources);
        for (const table of TARGET_TABLES) for (const record of body.resources) if (record.target_table === table) await apply(client, record);
        await advanceIdentity(client);
        await audit(client, { authority: String(body.authority).slice(0, 160), approvedBy: String(body.approvedBy).slice(0, 160), authorityDigest, securityHead: { position: chain.position, hash: chain.hash } });
        await client.query("UPDATE analysis_security_state SET pending_reconciliation_hash=$1 WHERE id='main'", [authorityDigest]);
        await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
}

async function finalizeAuthority(client, authorityDigest) {
    return (await client.query("UPDATE analysis_security_state SET mode='ready',accepted_database_timeline=pivot_current_database_timeline(),accepted_database_system_identifier=pivot_current_database_system_identifier(),reconciled_hash=$1,pending_reconciliation_hash='',reconciled_at=NOW(),recovery_reason='',updated_at=NOW() WHERE id='main' AND mode='recovery_required' AND pending_reconciliation_hash=$1 AND NOT EXISTS(SELECT 1 FROM analysis_security_inventory WHERE NOT complete)", [authorityDigest])).rowCount === 1;
}

async function authorityDraft(client) {
    const resources = [];
    for (const table of TARGET_TABLES) {
        const rows = (await client.query(`SELECT id::text,analysis_security_snapshot($1,to_jsonb(r)) AS payload_json${table === 'users' ? ",encode(sha256(convert_to(password_hash,'UTF8')),'hex') AS credential_digest" : ''} FROM ${table} r ORDER BY id`, [table])).rows;
        for (const row of rows) resources.push({ target_table: table, target_id: row.id, payload_json: row.payload_json, tombstone: Boolean(row.payload_json.deleted_at), credential_changed: false, ...(table === 'users' ? { credentialDigest: row.credential_digest } : {}) });
    }
    return resources;
}

module.exports = { TARGET_TABLES, replay, applyAuthority, finalizeAuthority, authorityDraft };
