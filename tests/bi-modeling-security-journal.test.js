'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { fixture } = require('../scripts/test_support/bi_modeling');
const { queryOne, query, execute, transaction } = require('../server/db/client');
const { getPgPool } = require('../server/db/pg-connection');
const journal = require('../server/services/data-analysis/bi/security-journal');
const files = require('../server/services/data-analysis/bi/security-journal-files');
const recovery = require('../server/services/data-analysis/bi/security-recovery');
const { canonicalHash } = require('../server/services/data-analysis/bi/canonical');
const { runWithRequestContext } = require('../server/services/request-context');
const datasets = require('../server/services/data-analysis/shared');
const { promisify } = require('node:util');
const execFile = promisify(require('node:child_process').execFile);

async function state() { return queryOne("SELECT * FROM analysis_security_state WHERE id='main'"); }
async function chain() { return files.readChain(await files.configuration(), (await state()).origin_id); }

async function currentAuthorityResources() {
    const resources = [];
    for (const table of require('../server/repositories/analysis-security-recovery').TARGET_TABLES) {
        const rows = await query(`SELECT id::text,analysis_security_snapshot(?,to_jsonb(r)) AS payload_json FROM ${table} r`, [table]);
        for (const row of rows) {
            const record = { target_table: table, target_id: row.id, payload_json: row.payload_json, tombstone: Boolean(row.payload_json.deleted_at), credential_changed: false };
            if (table === 'users') record.credentialDigest = crypto.createHash('sha256').update((await queryOne('SELECT password_hash FROM users WHERE id=?', [row.id])).password_hash).digest('hex');
            resources.push(record);
        }
    }
    return resources;
}

async function authority(privateKey, authoritativeResources) {
    const current = await state(), head = await chain(), expected = new Map(authoritativeResources.map(row => [`${row.target_table}:${row.target_id}`, row]));
    const tombstones = new Map(head.entries.filter(entry => entry.record.tombstone).map(entry => [`${entry.record.target_table}:${entry.record.target_id}`, entry.record]));
    const resources = (await currentAuthorityResources()).map(row => {
        const key = `${row.target_table}:${row.target_id}`;
        if (expected.has(key)) return expected.get(key);
        const deleted = tombstones.get(key);
        assert.ok(deleted, `外部核对源不认识恢复后的资源 ${key}，不能从旧数据库猜测授权。`);
        return { target_table: row.target_table, target_id: row.target_id, payload_json: { ...deleted.payload_json, ...(row.target_table === 'users' ? { status: 'disabled' } : {}) }, tombstone: true, credential_changed: false };
    });
    const body = { version: 1, originId: current.origin_id, journalPosition: head.position, journalHash: head.hash, requiresCurrentAuthorityReview: false, authority: '隔离演练故障前单独保存的当前身份与授权核对源', approvedBy: '隔离演练负责人', reason: '依据独立保留的当前状态逐项核对账号、删除墓碑、字段与共享授权。', approvedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 600000).toISOString(), resources };
    return { body, signature: crypto.sign(null, Buffer.from(canonicalHash(body)), privateKey).toString('base64url') };
}

test('数据库系统标识变化和旧库首次登记谱系都保持关闭，当前授权签认后才接受新谱系', async () => fixture(async ({ user, fact }) => {
    const authoritativeResources = await currentAuthorityResources(), pair = crypto.generateKeyPairSync('ed25519');
    const publicFile = path.join(path.dirname(process.env.DATA_ANALYSIS_SECURITY_KEY_FILE), `lineage-${crypto.randomUUID()}.pub`);
    await fs.writeFile(publicFile, pair.publicKey.export({ type: 'spki', format: 'pem' }), { flag: 'wx', mode: 0o600 });
    const previous = process.env.DATA_ANALYSIS_SECURITY_AUTHORITY_PUBLIC_KEY_FILE; process.env.DATA_ANALYSIS_SECURITY_AUTHORITY_PUBLIC_KEY_FILE = publicFile;
    try {
        await getPgPool().query("UPDATE analysis_security_state SET accepted_database_system_identifier='0' WHERE id='main'");
        await assert.rejects(datasets.getDatasetForUser(user, fact.id), error => error.status === 503);
        assert.equal((await state()).mode, 'recovery_required');
        await recovery.replay({ reason: '隔离模拟逻辑旧库落到不同数据库系统标识。' });
        assert.equal((await recovery.reconcile(await authority(pair.privateKey, authoritativeResources))).mode, 'ready');
        const client = await getPgPool().connect();
        try {
            await client.query('BEGIN');
            await client.query("UPDATE analysis_security_state SET accepted_database_timeline=NULL,accepted_database_system_identifier=NULL WHERE id='main'");
            await require('../server/db/migrations/analysis-common-recovery')[0].upPg(client); await client.query('COMMIT');
        } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
        finally { client.release(); }
        assert.equal((await state()).mode, 'recovery_required'); assert.equal((await state()).recovery_reason, 'database_lineage_review_required');
        await assert.rejects(datasets.getDatasetForUser(user, fact.id), error => error.status === 503);
        await recovery.replay({ reason: '隔离核对旧版独立安全记录首次登记数据库谱系。' });
        assert.equal((await recovery.reconcile(await authority(pair.privateKey, authoritativeResources))).mode, 'ready');
        assert.equal((await queryOne("SELECT accepted_database_system_identifier=pivot_current_database_system_identifier() AS accepted FROM analysis_security_state WHERE id='main'")).accepted, true);
    } finally {
        if (previous === undefined) delete process.env.DATA_ANALYSIS_SECURITY_AUTHORITY_PUBLIC_KEY_FILE; else process.env.DATA_ANALYSIS_SECURITY_AUTHORITY_PUBLIC_KEY_FILE = previous;
        await fs.unlink(publicFile);
    }
}));

test('安全变更和审计先事务落库再独立加密确认，保留真实主体与请求且不记录密码或字段值', async () => fixture(async ({ user, fact }) => {
    const marker = `private_${crypto.randomUUID()}`;
    await runWithRequestContext({ userId: user.id, requestId: marker }, () => execute("UPDATE analysis_datasets SET scope='shared',allowed_user_ids=? WHERE id=?", [String(user.id), fact.id]));
    const event = await queryOne("SELECT * FROM analysis_security_outbox WHERE target_id=? AND request_id=?", [fact.id, marker]);
    assert.equal(event.actor_id, String(user.id)); assert.ok(event.database_actor); assert.ok(event.acknowledged_at); assert.ok(event.journal_position > 0);
    const ledger = await chain(), entry = ledger.byId.get(event.event_id);
    assert.equal(entry.record.request_id, marker); assert.equal(entry.record.payload_json.scope, 'shared');
    const encoded = await fs.readFile(path.join(ledger.directory, `${String(entry.position).padStart(16, '0')}.entry`), 'utf8');
    assert.equal(encoded.includes(marker), false); assert.equal(encoded.includes('password_hash'), false); assert.equal(encoded.includes('100.25'), false);
    const audit = await queryOne('SELECT id,delivered_at FROM analysis_audit_events WHERE user_id=? ORDER BY created_at DESC LIMIT 1', [user.id]);
    assert.ok(audit.delivered_at);
    const sensitive = await queryOne("SELECT payload_json FROM analysis_security_outbox WHERE resource_kind='principal' AND resource_id=? ORDER BY sequence DESC LIMIT 1", [String(user.id)]);
    assert.equal(sensitive.payload_json.password_hash, undefined);
    await assert.rejects(execute("UPDATE analysis_security_outbox SET operation='altered' WHERE event_id=?", [event.event_id]), /不可改写/);
}));

test('独立副本不可写时撤权仍已生效，明确返回已应用待确认且阻止未确认授权读取', async () => fixture(async ({ user, fact }) => {
    await execute("UPDATE analysis_datasets SET scope='shared',allowed_user_ids='1234567' WHERE id=?", [fact.id]);
    const keyPath = process.env.DATA_ANALYSIS_SECURITY_KEY_FILE;
    process.env.DATA_ANALYSIS_SECURITY_KEY_FILE = `${keyPath}.missing`;
    try {
        await assert.rejects(execute("UPDATE analysis_datasets SET scope='personal',allowed_user_ids='' WHERE id=?", [fact.id]), error => error.code === 'ANALYSIS_SECURITY_COMMITTED_PENDING' && error.applied && error.securityConfirmationPending);
        assert.equal((await queryOne('SELECT scope FROM analysis_datasets WHERE id=?', [fact.id])).scope, 'personal');
        await assert.rejects(datasets.getDatasetForUser(user, fact.id), error => error.status === 503);
        assert.ok((await queryOne('SELECT COUNT(*) AS n FROM analysis_security_outbox WHERE acknowledged_at IS NULL')).n > 0);
    } finally { process.env.DATA_ANALYSIS_SECURITY_KEY_FILE = keyPath; }
    await journal.flush({ force: true });
    assert.equal((await datasets.getDatasetForUser(user, fact.id)).id, fact.id);
}));

test('数据库回滚不生成独立事件，直接 SQL 的真实提交也由触发器捕获', async () => fixture(async ({ user, fact }) => {
    const before = (await chain()).position;
    await assert.rejects(transaction(async trx => { await trx.execute("UPDATE analysis_datasets SET allowed_units='rollback_marker' WHERE id=?", [fact.id]); throw new Error('intentional rollback'); }), /intentional rollback/);
    assert.equal((await chain()).position, before);
    await getPgPool().query("UPDATE analysis_datasets SET allowed_units='database_operator' WHERE id=$1", [fact.id]);
    const pending = await queryOne('SELECT * FROM analysis_security_outbox WHERE target_id=? AND acknowledged_at IS NULL', [fact.id]);
    assert.equal(pending.actor_id, ''); assert.ok(pending.database_actor);
    await assert.rejects(transaction(trx => journal.assertResources(trx, [{ kind: 'dataset', id: fact.id }])), error => error.code === 'ANALYSIS_SECURITY_CONFIRMATION_PENDING');
    await journal.flush(); assert.equal((await datasets.getDatasetForUser(user, fact.id)).allowed_units, 'database_operator');
}));

test('独立追加后主库 ACK 前崩溃，重放同一事件只确认一次且高水位不重复', async () => fixture(async ({ fact }) => {
    await getPgPool().query("UPDATE analysis_datasets SET allowed_units='after_append_crash' WHERE id=$1", [fact.id]);
    const config = await files.configuration(), ledger = await chain();
    const records = await require('../server/repositories/analysis-security-journal').withPump(client => require('../server/repositories/analysis-security-journal').pending(client));
    assert.equal(records.length, 1);
    const entry = await files.append(config, ledger, records[0]);
    assert.equal((await queryOne('SELECT acknowledged_at FROM analysis_security_outbox WHERE event_id=?', [records[0].event_id])).acknowledged_at, null);
    const confirmed = await journal.flush({ force: true }); assert.equal(confirmed.position, entry.position);
    assert.equal((await journal.flush({ force: true })).position, entry.position);
}));

test('独立日志缺口、密文破坏、密钥丢失均不允许当作空日志重新开始', async () => fixture(async () => {
    const ledger = await chain(), first = path.join(ledger.directory, '0000000000000001.entry'), saved = await fs.readFile(first);
    const checkpoint = await state();
    try {
        await fs.rename(first, `${first}.removed`);
        await assert.rejects(journal.flush({ force: true }), error => error.status === 503);
        await fs.rename(`${first}.removed`, first);
        await fs.writeFile(first, `${saved.toString('utf8').slice(0, -10)}broken`);
        await assert.rejects(journal.flush({ force: true }), error => error.status === 503);
    } finally { await fs.writeFile(first, saved); }
    const keyFile = process.env.DATA_ANALYSIS_SECURITY_KEY_FILE;
    process.env.DATA_ANALYSIS_SECURITY_KEY_FILE = `${keyFile}.missing`;
    try { await assert.rejects(journal.flush({ force: true }), error => error.status === 503); }
    finally { process.env.DATA_ANALYSIS_SECURITY_KEY_FILE = keyFile; }
    assert.equal((await journal.flush({ force: true })).position, Number(checkpoint.journal_position));
}));

test('旧业务库丢失已确认撤权时持久关闭，重放删除墓碑后仍须当前签认才能开放', async () => fixture(async ({ user, fact, model }) => {
    const checkpoint = await state();
    await execute("UPDATE analysis_datasets SET scope='shared',allowed_user_ids='1234567' WHERE id=?", [fact.id]);
    await execute('UPDATE analysis_data_models SET deleted_at=NOW() WHERE id=?', [model.id]);
    const authoritativeResources = await currentAuthorityResources();
    const events = await query('SELECT event_id FROM analysis_security_outbox WHERE journal_position>? ORDER BY journal_position', [checkpoint.journal_position]);
    const client = await getPgPool().connect();
    try {
        await client.query('BEGIN'); await client.query("SET LOCAL pivot.security_replay='on'");
        await client.query('DELETE FROM analysis_security_outbox WHERE event_id=ANY($1::uuid[])', [events.map(row => row.event_id)]);
        await client.query("UPDATE analysis_security_state SET journal_position=$1,journal_hash=$2 WHERE id='main'", [checkpoint.journal_position, checkpoint.journal_hash]);
        await client.query("UPDATE analysis_datasets SET scope='shared',allowed_user_ids='' WHERE id=$1", [fact.id]);
        await client.query('UPDATE analysis_data_models SET deleted_at=NULL WHERE id=$1', [model.id]);
        await client.query('COMMIT');
    } finally { client.release(); }
    await assert.rejects(journal.flush({ force: true }), error => error.status === 503);
    assert.equal((await state()).mode, 'recovery_required');
    const enabled = process.env.DATA_ANALYSIS_MODEL_ENABLED, root = process.env.DATA_ANALYSIS_SECURITY_JOURNAL_DIR;
    process.env.DATA_ANALYSIS_MODEL_ENABLED = 'false'; delete process.env.DATA_ANALYSIS_SECURITY_JOURNAL_DIR;
    try { await assert.rejects(datasets.getDatasetForUser(user, fact.id), error => error.code === 'ANALYSIS_SECURITY_RECOVERY_REQUIRED'); }
    finally { process.env.DATA_ANALYSIS_MODEL_ENABLED = enabled; process.env.DATA_ANALYSIS_SECURITY_JOURNAL_DIR = root; }
    const replayed = await recovery.replay({ reason: '隔离演练：旧库与当前独立安全日志重放。' }); assert.equal(replayed.mode, 'recovery_required');
    assert.equal((await queryOne('SELECT allowed_user_ids FROM analysis_datasets WHERE id=?', [fact.id])).allowed_user_ids, '1234567');
    assert.ok((await queryOne('SELECT deleted_at FROM analysis_data_models WHERE id=?', [model.id])).deleted_at);
    await assert.rejects(datasets.getDatasetForUser(user, fact.id), error => error.code === 'ANALYSIS_SECURITY_RECOVERY_REQUIRED');
    const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
    const publicFile = path.join(path.dirname(process.env.DATA_ANALYSIS_SECURITY_KEY_FILE), 'authority-public.pem');
    await fs.writeFile(publicFile, publicKey.export({ type: 'spki', format: 'pem' }), { flag: 'wx', mode: 0o600 });
    const previous = process.env.DATA_ANALYSIS_SECURITY_AUTHORITY_PUBLIC_KEY_FILE; process.env.DATA_ANALYSIS_SECURITY_AUTHORITY_PUBLIC_KEY_FILE = publicFile;
    try {
        const signed = await authority(privateKey, authoritativeResources);
        const tampered = JSON.parse(JSON.stringify(signed)); tampered.body.resources[0].payload_json.unit = 'tampered';
        await assert.rejects(recovery.reconcile(tampered), error => error.status === 503);
        const incomplete = JSON.parse(JSON.stringify(signed)); incomplete.body.resources.pop(); incomplete.signature = crypto.sign(null, Buffer.from(canonicalHash(incomplete.body)), privateKey).toString('base64url');
        await assert.rejects(recovery.reconcile(incomplete), error => error.status === 503);
        const wrongCredential = JSON.parse(JSON.stringify(signed)); wrongCredential.body.resources.find(row => row.target_table === 'users' && row.payload_json.status === 'active').credentialDigest = '0'.repeat(64);
        wrongCredential.signature = crypto.sign(null, Buffer.from(canonicalHash(wrongCredential.body)), privateKey).toString('base64url');
        await assert.rejects(recovery.reconcile(wrongCredential), error => error.status === 503);
        assert.equal((await state()).mode, 'recovery_required');
        const originalFlush = journal.flush;
        try {
            journal.flush = async () => { throw new Error('fault_after_authority_commit'); };
            await assert.rejects(recovery.reconcile(signed), /fault_after_authority_commit/);
        } finally { journal.flush = originalFlush; }
        assert.equal((await state()).mode, 'recovery_required');
        assert.equal((await state()).pending_reconciliation_hash, canonicalHash(signed.body));
        const appliedVersion = (await queryOne('SELECT token_version FROM users WHERE id=?', [user.id])).token_version;
        assert.equal((await recovery.reconcile(signed)).mode, 'ready');
        assert.equal((await queryOne('SELECT token_version FROM users WHERE id=?', [user.id])).token_version, appliedVersion);
        assert.equal(Number((await queryOne("SELECT COUNT(*) AS n FROM analysis_audit_events WHERE action='security_recovery_reconciled' AND details_json->>'authorityDigest'=?", [canonicalHash(signed.body)])).n), 1);
        assert.equal((await datasets.getDatasetForUser(user, fact.id)).allowed_user_ids, '1234567');
    } finally {
        if (previous === undefined) delete process.env.DATA_ANALYSIS_SECURITY_AUTHORITY_PUBLIC_KEY_FILE; else process.env.DATA_ANALYSIS_SECURITY_AUTHORITY_PUBLIC_KEY_FILE = previous;
        await fs.unlink(publicFile);
    }
}));

test('历史清单按持久游标分批回填，进程中断后续跑且并行当前变更不会被旧基线覆盖', async () => fixture(async ({ user, model }) => {
    const pool = getPgPool(), prefix = `${model.id}_inventory_`;
    await pool.query('ALTER TABLE analysis_data_models DISABLE TRIGGER analysis_security_event');
    try {
        await pool.query(`INSERT INTO analysis_data_models(id,user_id,name,model_kind,definition_json)
            SELECT $1||lpad(n::text,4,'0'),$2,'历史模型','production',definition_json FROM analysis_data_models CROSS JOIN generate_series(1,250) n WHERE id=$3`, [prefix, user.id, model.id]);
    } finally { await pool.query('ALTER TABLE analysis_data_models ENABLE TRIGGER analysis_security_event'); }
    await pool.query("UPDATE analysis_security_inventory SET cursor_value='',scanned=0,captured=0,complete=FALSE WHERE table_name='analysis_data_models'");
    await pool.query("UPDATE analysis_security_state SET mode='initializing' WHERE id='main'");
    const repository = require('../server/repositories/analysis-security-journal'), inventory = require('../server/repositories/analysis-security-inventory');
    const first = await repository.withPump(client => inventory.backfill(client, { batchSize: 17, maxBatches: 1, budgetMs: 5000 }));
    assert.equal(first.scanned, 17); assert.equal(first.complete, false);
    const cursor = await queryOne("SELECT * FROM analysis_security_inventory WHERE table_name='analysis_data_models'");
    assert.equal(Number(cursor.scanned), 17); assert.ok(cursor.cursor_value);
    await assert.rejects(journal.assertAccess(), error => error.code === 'ANALYSIS_SECURITY_INITIALIZING');
    const changedId = `${prefix}0080`;
    await pool.query("UPDATE analysis_data_models SET scope='shared',allowed_user_ids='1234567' WHERE id=$1", [changedId]);
    const resumed = await repository.withPump(client => inventory.backfill(client, { batchSize: 17, maxBatches: 1, budgetMs: 5000 }));
    assert.equal(resumed.scanned, 17); assert.equal(resumed.complete, false);
    assert.notEqual((await queryOne("SELECT cursor_value FROM analysis_security_inventory WHERE table_name='analysis_data_models'")).cursor_value, cursor.cursor_value);
    const completed = await journal.flush({ force: true, full: true }); assert.equal(completed.mode, 'ready');
    const final = await queryOne("SELECT * FROM analysis_security_inventory WHERE table_name='analysis_data_models'");
    assert.equal(Number(final.scanned), 251); assert.equal(final.complete, true);
    assert.equal(Number((await queryOne('SELECT COUNT(*) AS n FROM analysis_security_outbox WHERE target_table=? AND target_id=?', ['analysis_data_models', changedId])).n), 1);
    assert.equal((await queryOne('SELECT scope FROM analysis_data_models WHERE id=?', [changedId])).scope, 'shared');
    assert.equal((await repository.withPump(client => inventory.backfill(client))).scanned, 0);
}));

test('主库和独立日志都不能证明最新撤权时，恢复流程保持关闭并依据单独保留的当前授权核对', async () => fixture(async ({ user, fact }) => {
    const reader = await queryOne("INSERT INTO users(username,password_hash,unit) VALUES (?,'hash','QA') RETURNING id,username,status,unit", [`bi_recovery_reader_${crypto.randomUUID()}`]);
    try {
        await execute("UPDATE analysis_datasets SET scope='shared',allowed_user_ids='' WHERE id=?", [fact.id]);
        const keyFile = process.env.DATA_ANALYSIS_SECURITY_KEY_FILE;
        process.env.DATA_ANALYSIS_SECURITY_KEY_FILE = `${keyFile}.missing`;
        try { await assert.rejects(execute("UPDATE analysis_datasets SET scope='personal' WHERE id=?", [fact.id]), error => error.applied === true); }
        finally { process.env.DATA_ANALYSIS_SECURITY_KEY_FILE = keyFile; }
        const authoritativeResources = await currentAuthorityResources();
        const client = await getPgPool().connect();
        try {
            await client.query('BEGIN'); await client.query("SET LOCAL pivot.security_replay='on'");
            await client.query('DELETE FROM analysis_security_outbox WHERE acknowledged_at IS NULL AND target_id=$1', [fact.id]);
            await client.query("UPDATE analysis_datasets SET scope='shared',allowed_user_ids='' WHERE id=$1", [fact.id]); await client.query('COMMIT');
        } finally { client.release(); }
        await recovery.replay({ reason: '隔离演练：恢复前已收紧但副本尚未确认的撤权，禁止凭旧头自动开放。' });
        await assert.rejects(datasets.getDatasetForUser(reader, fact.id), error => error.code === 'ANALYSIS_SECURITY_RECOVERY_REQUIRED');
        const pair = crypto.generateKeyPairSync('ed25519'), publicFile = path.join(path.dirname(keyFile), `authority-${crypto.randomUUID()}.pem`);
        await fs.writeFile(publicFile, pair.publicKey.export({ type: 'spki', format: 'pem' }), { flag: 'wx', mode: 0o600 });
        const previous = process.env.DATA_ANALYSIS_SECURITY_AUTHORITY_PUBLIC_KEY_FILE; process.env.DATA_ANALYSIS_SECURITY_AUTHORITY_PUBLIC_KEY_FILE = publicFile;
        try { await recovery.reconcile(await authority(pair.privateKey, authoritativeResources)); }
        finally { if (previous === undefined) delete process.env.DATA_ANALYSIS_SECURITY_AUTHORITY_PUBLIC_KEY_FILE; else process.env.DATA_ANALYSIS_SECURITY_AUTHORITY_PUBLIC_KEY_FILE = previous; await fs.unlink(publicFile); }
        assert.equal((await datasets.getDatasetForUser(user, fact.id)).scope, 'personal');
        await assert.rejects(datasets.getDatasetForUser(reader, fact.id), error => error.status === 404);
    } finally { await execute('DELETE FROM users WHERE id=?', [reader.id]); }
}));

test('新进程中关闭执行开关并移除日志配置，也不能绕过已持久启用的独立确认要求', async () => fixture(async ({ user }) => {
    const code = `const db=require('./server/db/client'); db.execute("UPDATE users SET status='disabled' WHERE id=?",[process.argv[1]]).then(()=>{process.stdout.write(JSON.stringify({unexpected:true})+'\\n');process.exitCode=1;}).catch(e=>process.stdout.write(JSON.stringify({code:e.code,applied:e.applied})+'\\n')).finally(()=>require('./server/db/pg-connection').closePgPool());`;
    const result = await execFile(process.execPath, ['-e', code, String(user.id)], { cwd: path.resolve(__dirname, '..'), windowsHide: true,
        env: { ...process.env, DATA_ANALYSIS_MODEL_ENABLED: 'false', DATA_ANALYSIS_SECURITY_JOURNAL_DIR: '', DATA_ANALYSIS_SECURITY_KEY_FILE: '' }, timeout: 20000 });
    const response = result.stdout.split(/\r?\n/).filter(Boolean).map(line => { try { return JSON.parse(line); } catch (_) { return {}; } }).find(row => row.applied);
    assert.deepEqual(response, { code: 'ANALYSIS_SECURITY_COMMITTED_PENDING', applied: true });
    assert.equal((await queryOne('SELECT status FROM users WHERE id=?', [user.id])).status, 'disabled');
    await journal.flush({ force: true, full: true });
    await execute("UPDATE users SET status='active' WHERE id=?", [user.id]);
}));

test('捕获保护丢失时仍保留已提交收紧并持久关闭，修复触发器不会自动取消恢复核对', async () => fixture(async ({ user }) => {
    await getPgPool().query('ALTER TABLE users DISABLE TRIGGER analysis_security_event');
    let authoritativeResources;
    try {
        await assert.rejects(execute("UPDATE users SET status='disabled' WHERE id=?", [user.id]), error => error.applied === true && error.code === 'ANALYSIS_SECURITY_COMMITTED_PENDING');
        assert.equal((await queryOne('SELECT status FROM users WHERE id=?', [user.id])).status, 'disabled');
        assert.equal((await state()).mode, 'recovery_required');
        await assert.rejects(journal.assertAccess(), error => error.status === 503);
        authoritativeResources = await currentAuthorityResources();
    } finally { await getPgPool().query('ALTER TABLE users ENABLE TRIGGER analysis_security_event'); }
    await assert.rejects(journal.assertAccess(), error => error.code === 'ANALYSIS_SECURITY_RECOVERY_REQUIRED');
    await recovery.replay({ reason: '隔离演练：恢复安全捕获保护后重新核对遗漏的主体收紧。' });
    const pair = crypto.generateKeyPairSync('ed25519'), publicFile = path.join(path.dirname(process.env.DATA_ANALYSIS_SECURITY_KEY_FILE), `authority-${crypto.randomUUID()}.pem`);
    await fs.writeFile(publicFile, pair.publicKey.export({ type: 'spki', format: 'pem' }), { flag: 'wx', mode: 0o600 });
    const previous = process.env.DATA_ANALYSIS_SECURITY_AUTHORITY_PUBLIC_KEY_FILE; process.env.DATA_ANALYSIS_SECURITY_AUTHORITY_PUBLIC_KEY_FILE = publicFile;
    try { await recovery.reconcile(await authority(pair.privateKey, authoritativeResources)); }
    finally { if (previous === undefined) delete process.env.DATA_ANALYSIS_SECURITY_AUTHORITY_PUBLIC_KEY_FILE; else process.env.DATA_ANALYSIS_SECURITY_AUTHORITY_PUBLIC_KEY_FILE = previous; await fs.unlink(publicFile); }
    assert.equal((await queryOne('SELECT status FROM users WHERE id=?', [user.id])).status, 'disabled');
    assert.equal((await queryOne("SELECT payload_json FROM analysis_security_outbox WHERE target_table='users' AND target_id=? ORDER BY sequence DESC LIMIT 1", [String(user.id)])).payload_json.status, 'disabled');
}));
