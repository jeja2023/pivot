'use strict';

const { getPgPool } = require('../db/pg-connection');
const PROTECTIONS_SQL = `SELECT
    (SELECT COUNT(*) FROM pg_trigger WHERE tgname='analysis_security_event' AND tgrelid IN (to_regclass('users'),to_regclass('analysis_datasets'),to_regclass('analysis_data_models'),to_regclass('analysis_field_governance'),to_regclass('analysis_audit_events'),to_regclass('analysis_saved_views'),to_regclass('analysis_dashboards'),to_regclass('analysis_metric_definitions')) AND tgenabled='O')=8
    AND EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='analysis_security_outbox_immutable' AND tgrelid=to_regclass('analysis_security_outbox') AND tgenabled='O') AS ready`;

// 管道故意使用单个裸连接池客户端：确认操作绝不能递归调用普通的数据库提交后钩子。
async function withPump(fn) {
    const client = await getPgPool().connect();
    let locked = false, broken;
    const connectionError = error => { broken = error; }; client.on('error', connectionError);
    try {
        await client.query("SELECT pg_advisory_lock(hashtext('pivot:analysis:security-journal'),0)"); locked = true;
        const exists = await client.query("SELECT to_regclass('analysis_security_state') AS relation");
        if (!exists.rows[0].relation) return { absent: true };
        const state = (await client.query("SELECT *,pivot_current_database_timeline() AS current_database_timeline,pivot_current_database_system_identifier() AS current_database_system_identifier,EXTRACT(EPOCH FROM recovery_started_at)*1000 AS recovery_started_epoch_ms FROM analysis_security_state WHERE id='main'")).rows[0];
        return await fn(client, state);
    } catch (error) { if (error.code?.startsWith('08')) broken = error; throw error; }
    finally {
        if (locked) try { await client.query("SELECT pg_advisory_unlock(hashtext('pivot:analysis:security-journal'),0)"); } catch (error) { broken = error; }
        client.release(broken);
        client.removeListener('error', connectionError);
    }
}

async function records(client, ids) {
    return (await client.query('SELECT event_id::text FROM analysis_security_outbox WHERE event_id=ANY($1::uuid[])', [ids])).rows;
}

async function pending(client, transactionId = '', limit = 500) {
    return (await client.query(`SELECT sequence::text,event_id::text,origin_id::text,transaction_id,resource_kind,resource_id,revision::text,target_table,target_id,operation,
        actor_id,database_actor,request_id,before_hash,after_hash,payload_json,credential_changed,tombstone,created_at::text
        FROM analysis_security_outbox WHERE acknowledged_at IS NULL ORDER BY (transaction_id=$1) DESC,sequence LIMIT $2`, [transactionId, Math.min(500, Math.max(1, limit))])).rows;
}

async function acknowledge(client, entry) {
    await client.query('BEGIN');
    try {
        await client.query('UPDATE analysis_security_outbox SET journal_position=$1,acknowledged_at=NOW() WHERE event_id=$2 AND acknowledged_at IS NULL', [entry.position, entry.record.event_id]);
        if (entry.record.target_table === 'analysis_audit_events') await client.query('UPDATE analysis_audit_events SET delivered_at=COALESCE(delivered_at,NOW()) WHERE id=$1', [entry.record.target_id]);
        await client.query("UPDATE analysis_security_state SET journal_position=GREATEST(journal_position,$1),journal_hash=CASE WHEN $1>=journal_position THEN $2 ELSE journal_hash END,updated_at=NOW() WHERE id='main'", [entry.position, entry.hash]);
        await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
}

async function ready(client, chain, inventoryComplete) {
    await client.query("UPDATE analysis_security_state SET enforced=TRUE,mode=CASE WHEN mode='initializing' AND $3 AND NOT EXISTS(SELECT 1 FROM analysis_security_outbox WHERE acknowledged_at IS NULL) THEN 'ready' ELSE mode END,journal_position=$1,journal_hash=$2,updated_at=NOW() WHERE id='main'", [chain.position, chain.hash, inventoryComplete]);
    return (await client.query("SELECT mode FROM analysis_security_state WHERE id='main'")).rows[0].mode;
}

async function close(client, reason) {
    await client.query("UPDATE analysis_security_state SET enforced=TRUE,mode='recovery_required',pending_reconciliation_hash='',recovery_reason=$1,recovery_started_at=COALESCE(recovery_started_at,NOW()),updated_at=NOW() WHERE id='main'", [reason]);
}

async function assertResources(trx, resources) {
    const state = await trx.queryOne("SELECT mode FROM analysis_security_state WHERE id='main' FOR SHARE");
    if (state?.mode === 'initializing') throw require('../services/data-analysis/bi/errors').biError('ANALYSIS_SECURITY_INITIALIZING', '安全记录正在分批回填与独立确认，请完成迁移核对后再读取数据。', 503);
    if (state?.mode !== 'ready') throw require('../services/data-analysis/bi/errors').biError('ANALYSIS_SECURITY_RECOVERY_REQUIRED', '恢复后的当前账号与授权尚未核对，数据读取保持关闭；请联系恢复负责人。', 503);
    const keys = [...new Set(resources.map(item => `${item.kind}:${item.id}`))];
    const result = await trx.queryOne(`SELECT EXISTS(SELECT 1 FROM analysis_security_outbox WHERE resource_kind||':'||resource_id=ANY(?::text[])
        AND acknowledged_at IS NULL AND transaction_id<>pg_current_xact_id()::text) AS pending`, [keys]);
    if (result.pending) throw require('../services/data-analysis/bi/errors').biError('ANALYSIS_SECURITY_CONFIRMATION_PENDING', '当前权限的安全记录待持久确认，已暂停相关数据读取。', 503);
}

async function pendingIn(client) {
    const exists = (await client.query("SELECT to_regclass('analysis_security_outbox') AS relation")).rows[0].relation;
    if (!exists) return false;
    if (!await protections(client)) {
        await close(client, 'security_capture_protection_missing');
        return (await client.query('SELECT pg_current_xact_id()::text AS transaction_id')).rows[0].transaction_id;
    }
    const row = (await client.query('SELECT pg_current_xact_id()::text AS transaction_id,EXISTS(SELECT 1 FROM analysis_security_outbox WHERE transaction_id=pg_current_xact_id()::text AND acknowledged_at IS NULL) AS pending')).rows[0];
    return row.pending ? row.transaction_id : false;
}

async function enforcement(client = getPgPool()) {
    const exists = (await client.query("SELECT to_regclass('analysis_security_state') AS relation")).rows[0].relation;
    if (!exists) return false;
    return Boolean((await client.query("SELECT enforced FROM analysis_security_state WHERE id='main'")).rows[0]?.enforced);
}

async function stateForRead(trx) { return trx.queryOne("SELECT mode,enforced,origin_id,journal_position,journal_hash,accepted_database_timeline,accepted_database_system_identifier,pivot_current_database_timeline() AS current_database_timeline,pivot_current_database_system_identifier() AS current_database_system_identifier FROM analysis_security_state WHERE id='main'"); }
async function knownEvents(trx, ids) { return Number((await trx.queryOne('SELECT COUNT(*) AS n FROM analysis_security_outbox WHERE event_id=ANY(?::uuid[])', [ids])).n); }

async function health() {
    return (await getPgPool().query(`SELECT s.mode,s.enforced,s.origin_id,s.journal_position,s.journal_hash,s.reconciled_at,
        (SELECT COUNT(*) FROM analysis_security_outbox WHERE acknowledged_at IS NULL) AS pending,
        (SELECT EXTRACT(EPOCH FROM NOW()-MIN(created_at)) FROM analysis_security_outbox WHERE acknowledged_at IS NULL) AS pending_age_seconds,
        (SELECT COUNT(*) FROM analysis_security_inventory WHERE NOT complete) AS inventory_remaining,
        (SELECT COALESCE(SUM(scanned),0) FROM analysis_security_inventory) AS inventory_scanned,
        (SELECT COALESCE(SUM(captured),0) FROM analysis_security_inventory) AS inventory_captured
        FROM analysis_security_state s WHERE s.id='main'`)).rows[0];
}

async function transactionPending(transactionId, client = getPgPool()) { return (await client.query('SELECT EXISTS(SELECT 1 FROM analysis_security_outbox WHERE transaction_id=$1 AND acknowledged_at IS NULL) AS pending', [transactionId])).rows[0].pending; }
async function protections(client = getPgPool()) { return (await client.query(PROTECTIONS_SQL)).rows[0].ready; }
async function readProtections(trx) { return (await trx.queryOne(PROTECTIONS_SQL)).ready; }

module.exports = { withPump, records, pending, acknowledge, ready, close, assertResources, pendingIn, enforcement, stateForRead, knownEvents, health, transactionPending, protections, readProtections };
