'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { Pool } = require('pg');
const executeFile = promisify(execFile);
const enabled = Boolean(process.env.PIVOT_TEST_BI_COMPATIBLE_SOURCE && process.env.PIVOT_TEST_BI_ORIGINAL_SOURCE);

test('冻结兼容制品从旧 Schema 升级、有限锁等待、完整资产回退与原始旧 Worker 领取保护', { skip: !enabled, timeout: 240000 }, async t => {
    assert.match(process.env.PG_TEST_SCHEMA || '', /^pivot_test_/);
    const current = path.resolve(__dirname, '..'), compatible = await fs.realpath(process.env.PIVOT_TEST_BI_COMPATIBLE_SOURCE), original = await fs.realpath(process.env.PIVOT_TEST_BI_ORIGINAL_SOURCE);
    const root = path.join(process.env.DATA_DIR, `upgrade-${crypto.randomBytes(6).toString('hex')}`);
    await fs.mkdir(root, { recursive: true, mode: 0o700 });
    const schema = `pivot_test_upgrade_${crypto.randomBytes(6).toString('hex')}`, connectionString = process.env.DATABASE_URL;
    const pool = new Pool({ connectionString, options: `-c search_path=${schema},public` });
    const env = { ...process.env, PG_TEST_SCHEMA: schema, DATA_DIR: path.join(root, 'data'), PIVOT_UPLOAD_DIR: path.join(root, 'uploads'), PIVOT_ANALYSIS_DIR: path.join(root, 'analysis'),
        DATA_ANALYSIS_SECURITY_JOURNAL_DIR: path.join(root, 'security'), LOG_DIR: path.join(root, 'logs'), DEFAULT_ADMIN_PASSWORD: '', DATA_ANALYSIS_MODEL_ENABLED: 'true', DATA_ANALYSIS_MODEL_RUNTIME: 'development_process' };
    const helper = path.join(current, 'scripts/test_support/bi_upgrade_application.js');
    const child = async (source, mode, input = {}) => {
        const inputFile = path.join(root, `${mode}-${crypto.randomUUID()}.input.json`), outputFile = inputFile.replace('.input.', '.output.');
        await fs.writeFile(inputFile, JSON.stringify(input), { mode: 0o600 });
        const result = await executeFile(process.execPath, [helper, source, mode, inputFile, outputFile], { cwd: source, env, windowsHide: true, timeout: 120000, maxBuffer: 4 * 1024 ** 2 });
        await fs.writeFile(outputFile + '.log', result.stdout + result.stderr, { mode: 0o600 });
        return JSON.parse(await fs.readFile(outputFile, 'utf8'));
    };
    let blocker;
    try {
        await pool.query(`CREATE SCHEMA ${schema}`);
        const initial = await child(compatible, 'initialize'); assert.equal(initial.migrated, 206);
        const seeded = await child(compatible, 'seed');
        const before = await pool.query('SELECT pg_total_relation_size(\'analysis_operation_state\') AS state_bytes,pg_database_size(current_database()) AS database_bytes');
        assert.equal((await pool.query("SELECT COUNT(*) AS n FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='analysis_operation_state' AND column_name='create_enabled'")).rows[0].n, '0');
        blocker = await pool.connect(); await blocker.query('BEGIN; LOCK analysis_operation_state IN ACCESS EXCLUSIVE MODE');
        const migrator = await pool.connect(), migration = require('../server/db/migrations/analysis-release-controls')[0], lockedAt = Date.now();
        try {
            await migrator.query('BEGIN');
            await assert.rejects(migration.upPg(migrator), error => error.code === '55P03');
            await migrator.query('ROLLBACK');
            assert.ok(Date.now() - lockedAt >= 4500 && Date.now() - lockedAt < 15000);
        } finally { migrator.release(); await blocker.query('ROLLBACK'); blocker.release(); blocker = null; }
        assert.equal((await pool.query("SELECT COUNT(*) AS n FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='analysis_operation_state' AND column_name='create_enabled'")).rows[0].n, '0');
        const upgradedAt = Date.now(), upgraded = await child(current, 'initialize'), migrationMs = Date.now() - upgradedAt;
        assert.equal(upgraded.migrated, 209); assert.equal((await child(current, 'initialize')).migrated, 209);
        const checkClient = await pool.connect(); try { assert.equal(await migration.checkPg(checkClient), true); } finally { checkClient.release(); }
        const control = await pool.query("SELECT create_enabled,publish_enabled,admission_enabled,dispatch_enabled FROM analysis_operation_state WHERE id='main'");
        assert.ok(Object.values(control.rows[0]).every(value => value === true));
        const queued = (await child(compatible, 'queue', seeded)).jobId;
        const rejected = await child(original, 'claim-original-worker', { jobId: queued }); assert.equal(rejected.actualOriginalClaimRejected, true); assert.equal(rejected.version, '0.7.108');
        await pool.query("UPDATE analysis_query_jobs SET status='cancelled',cancel_cause='system' WHERE id=$1", [queued]);
        await pool.query("UPDATE analysis_operation_state SET create_enabled=FALSE,publish_enabled=FALSE,admission_enabled=FALSE,dispatch_enabled=FALSE WHERE id='main'");
        const rollbackAt = Date.now(), rollback = await child(compatible, 'rollback-read', seeded), rollbackMs = Date.now() - rollbackAt;
        assert.equal(rollback.actualOldApplicationStarted, true); assert.ok(rollbackMs <= 15 * 60 * 1000);
        const after = await pool.query('SELECT pg_total_relation_size(\'analysis_operation_state\') AS state_bytes,pg_database_size(current_database()) AS database_bytes');
        t.diagnostic(JSON.stringify({ compatibleVersion: rollback.version, frozenImage: process.env.PIVOT_TEST_BI_COMPATIBLE_IMAGE, originalVersion: rejected.version,
            before: before.rows[0], after: after.rows[0], migrationMs, lockTimeoutMs: 5000, rollbackMs, actualOldApplication: rollback, actualOriginalWorker: rejected, productionCertified: false }));
    } finally {
        if (blocker) { await blocker.query('ROLLBACK'); blocker.release(); }
        await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await pool.end();
        assert.equal(path.dirname(root), path.resolve(process.env.DATA_DIR)); await fs.rm(root, { recursive: true, force: true });
    }
});
