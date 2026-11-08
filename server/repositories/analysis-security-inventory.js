'use strict';

const TABLES = new Map([
    ['users', { kind: 'principal', numeric: true }], ['analysis_datasets', { kind: 'dataset' }], ['analysis_data_models', { kind: 'model' }],
    ['analysis_field_governance', { kind: 'dataset', numeric: true, field: true }], ['analysis_audit_events', { kind: 'audit' }],
    ...['analysis_saved_views', 'analysis_dashboards', 'analysis_metric_definitions'].map(table => [table, { kind: 'asset' }])
]);

async function batch(client, size) {
    const progress = (await client.query('SELECT * FROM analysis_security_inventory WHERE NOT complete ORDER BY table_name LIMIT 1')).rows[0];
    if (!progress) return { complete: true, scanned: 0, captured: 0 };
    const table = progress.table_name, contract = TABLES.get(table);
    if (!contract) throw new Error('安全清单回填目标不在固定白名单内。');
    const rows = (await client.query(`SELECT id::text AS id,${contract.field ? 'dataset_id' : 'id::text'} AS resource_id FROM ${table}
        WHERE id>${contract.numeric ? "COALESCE(NULLIF($1,''),'0')::bigint" : '$1'} ORDER BY id LIMIT $2`, [progress.cursor_value, size])).rows;
    const lastId = rows.at(-1)?.id || progress.cursor_value;
    const ordered = rows.map(row => ({ ...row, resource_id: contract.kind === 'asset' ? `${table}:${row.id}` : row.resource_id })).sort((a, b) => a.resource_id.localeCompare(b.resource_id, 'en'));
    let captured = 0;
    const transactionDeadline = Date.now() + 5000;
    await client.query('BEGIN');
    try {
        await client.query("SET LOCAL lock_timeout='2s'; SET LOCAL statement_timeout='5s'");
        for (const row of ordered) {
            const remaining = transactionDeadline - Date.now();
            if (remaining <= 0) throw new Error('安全清单单批时间预算已到，事务回滚后可沿原游标重试。');
            await client.query("SELECT set_config('statement_timeout',$1,true),set_config('lock_timeout',$2,true)", [String(remaining), String(Math.min(2000, remaining))]);
            await client.query("SELECT pg_advisory_xact_lock(hashtext('pivot:analysis:authorization'),hashtext($1))", [`${contract.kind}:${row.resource_id}`]);
            if ((await client.query('SELECT 1 FROM analysis_security_outbox WHERE target_table=$1 AND target_id=$2 LIMIT 1', [table, row.id])).rowCount) continue;
            const current = (await client.query(`SELECT analysis_security_snapshot($1,to_jsonb(r)) AS payload FROM ${table} r WHERE id=$2${contract.numeric ? '::bigint' : ''}`, [table, row.id])).rows[0];
            if (!current) continue;
            const revision = (await client.query(`INSERT INTO analysis_security_revisions(resource_kind,resource_id,revision) VALUES ($1,$2,1)
                ON CONFLICT(resource_kind,resource_id) DO UPDATE SET revision=analysis_security_revisions.revision+1 RETURNING revision::text`, [contract.kind, row.resource_id])).rows[0].revision;
            await client.query(`INSERT INTO analysis_security_outbox(origin_id,transaction_id,resource_kind,resource_id,revision,target_table,target_id,operation,database_actor,before_hash,after_hash,payload_json,tombstone)
                SELECT origin_id,pg_current_xact_id()::text,$1,$2,$3,$4,$5,'BASELINE',session_user,'',encode(sha256(convert_to($6::jsonb::text,'UTF8')),'hex'),$6::jsonb,$7 FROM analysis_security_state WHERE id='main'`,
            [contract.kind, row.resource_id, revision, table, row.id, current.payload, Boolean(current.payload.deleted_at)]);
            captured++;
        }
        await client.query('UPDATE analysis_security_inventory SET cursor_value=$1,scanned=scanned+$2,captured=captured+$3,complete=$4,updated_at=NOW() WHERE table_name=$5', [lastId, rows.length, captured, rows.length < size, table]);
        await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
    return { complete: false, scanned: rows.length, captured };
}

async function backfill(client, { batchSize = 100, maxBatches = 16, budgetMs = 1000 } = {}) {
    const size = Math.max(1, Math.min(500, Number(batchSize) || 100)), limit = Math.max(1, Math.min(32, Number(maxBatches) || 16));
    const deadline = Date.now() + Math.max(1, Math.min(5000, Number(budgetMs) || 1000));
    let scanned = 0, captured = 0, batches = 0;
    while (batches < limit && Date.now() < deadline) {
        const result = await batch(client, size); batches++; scanned += result.scanned; captured += result.captured;
        if (result.complete) return { complete: true, batches, scanned, captured };
    }
    return { complete: !(await client.query('SELECT 1 FROM analysis_security_inventory WHERE NOT complete LIMIT 1')).rowCount, batches, scanned, captured };
}

module.exports = { backfill };
