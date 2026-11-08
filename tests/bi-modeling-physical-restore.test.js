'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');
const os = require('node:os');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { Client } = require('pg');
const { withPostgresCluster, hasPostgresClusterSync } = require('../scripts/test_support/isolated_postgres');
const physical = require('../server/services/physical-backup');
const recovery = require('../server/services/common-recovery');
const sealed = require('../server/services/backup-sealed-files');
const reference = require('../server/repositories/analysis-common-recovery');
const { prepareRestore, quotedArgument } = require('../server/services/physical-restore');
const execute = promisify(execFile);
const skipCluster = !hasPostgresClusterSync() && '未检测到 PostgreSQL 服务端运行工具 (initdb)，跳过物理恢复测试';

async function reservePort() {
    const server = net.createServer();
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port;
}

test('independent watchdog releases the real write barrier while its coordinator event loop is blocked', { skip: skipCluster, timeout: 60000 }, async () => withPostgresCluster(async cluster => {
    const victim = new Client({ connectionString: cluster.url }), observer = new Client({ connectionString: cluster.url });
    await victim.connect(); await observer.connect(); victim.on('error', () => {});
    let expired = false;
    const guardian = await require('../server/services/physical-backup-watchdog').createBackupWatchdog(cluster.url, () => { expired = true; });
    try {
        const pid = (await victim.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
        assert.equal(await reference.tryBarrier(victim), true);
        await guardian.arm(pid, Date.now() + 500);
        // 测试专用的协调器暂停逻辑；看门狗拥有独立事件循环与数据库连接，仍必须终止该会话。

        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
        assert.equal(await reference.tryBarrier(observer), true);
        await reference.releaseBarrier(observer); assert.equal(expired, true);
    } finally { await guardian.stop(); await victim.end().catch(() => {}); await observer.end(); }
}));

test('durable whole-cluster PITR restores a common shared-file point after complete source loss, then replays current security', { skip: skipCluster, timeout: 1800000 }, async t => withPostgresCluster(async cluster => {
    const schema = `pivot_test_physical_${crypto.randomBytes(6).toString('hex')}`, root = cluster.root;
    const application = path.join(root, 'application'), projectRoot = path.join(application, 'project'), independent = path.join(root, 'independent');
    const data = path.join(application, 'data'), uploads = path.join(application, 'uploads');
    const securityRoot = path.join(independent, 'security'), keysRoot = path.join(independent, 'keys');
    await fs.mkdir(projectRoot, { recursive: true, mode: 0o700 }); await fs.mkdir(keysRoot, { recursive: true, mode: 0o700 });
    const securityKey = path.join(keysRoot, 'security.key'), backupKey = path.join(keysRoot, 'backup.key');
    await fs.writeFile(securityKey, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
    await fs.writeFile(backupKey, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
    const signing = crypto.generateKeyPairSync('ed25519'), publicKey = path.join(keysRoot, 'authority.pub');
    await fs.writeFile(publicKey, signing.publicKey.export({ type: 'spki', format: 'pem' }), { mode: 0o600 });
    const environment = { DATA_DIR: data, PIVOT_UPLOAD_DIR: uploads, UPLOAD_DIR: uploads, PIVOT_ARTIFACT_CAS_DIR: path.join(application, 'cas'),
        PIVOT_DOCUMENT_PROCESSING_DIR: path.join(application, 'documents'), PIVOT_ANALYSIS_DIR: path.join(application, 'analysis'),
        AGENT_BLOB_DIR: path.join(application, 'blobs'), PIVOT_RUNTIME_PACK_ROOT: path.join(application, 'packs'),
        DATA_ANALYSIS_SECURITY_JOURNAL_DIR: securityRoot, DATA_ANALYSIS_SECURITY_KEY_FILE: securityKey, DATA_ANALYSIS_SECURITY_AUTHORITY_PUBLIC_KEY_FILE: publicKey };
    for (const directory of [data, uploads, ...Object.values(require('../server/services/offline-backup-bundle').backupPaths(environment))]) await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const fixtureFiles = [];
    for (const [name, directory] of Object.entries({ data, ...require('../server/services/offline-backup-bundle').backupPaths(environment) })) {
        const file = path.join(directory, `physical-${name}.txt`), content = `共享模块 ${name} 的恢复样本`;
        await fs.writeFile(file, content, { mode: 0o600 }); fixtureFiles.push({ file, content });
    }
    const applicationConfig = { NODE_ENV: 'production', JWT_SECRET: crypto.randomBytes(32).toString('hex'), DATA_ENCRYPTION_KEY: crypto.randomBytes(32).toString('hex'),
        PIVOT_MEMORY_SOURCE_FINGERPRINT_SECRET: crypto.randomBytes(32).toString('hex'), PIVOT_AGENT_LIFECYCLE_HOOKS_ENABLED: 'false',
        DEFAULT_ADMIN_PASSWORD: 'PhysicalRestore123!', BCRYPT_ROUNDS: '12', DATA_ANALYSIS_MODEL_ENABLED: 'true', DATA_ANALYSIS_MODEL_RUNTIME: 'development_process' };
    await fs.writeFile(path.join(projectRoot, '.env'), Object.entries({ ...environment, ...applicationConfig, DATABASE_URL: cluster.url }).map(([key, value]) => `${key}=${value}`).join('\n') + '\n', { mode: 0o600 });
    await fs.writeFile(path.join(projectRoot, 'config.json'), '{"mode":"isolated-restore-fixture"}', { mode: 0o600 });
    const env = { ...process.env, ...environment, ...applicationConfig, PG_TEST_SCHEMA: schema, DATABASE_URL: cluster.url, TEST_DATABASE_URL: cluster.url,
        PIVOT_TEST_PG_SYNC: 'true', PG_IDLE_TIMEOUT_MS: '100', PIVOT_ALERT_WEBHOOK_URL: '', LOG_DIR: path.join(root, 'test-logs'),
        PATH: cluster.bin ? `${cluster.bin}${path.delimiter}${process.env.PATH}` : process.env.PATH };
    const run = (args, selectedEnv = env) => execute(process.execPath, args, { env: selectedEnv, cwd: path.resolve(__dirname, '..'), windowsHide: true, timeout: 180000, maxBuffer: 12 * 1024 * 1024 });
    const action = async (mode, input = '', selectedEnv = env) => {
        const output = path.join(independent, `result-${crypto.randomUUID()}.json`);
        await run(['scripts/test_support/bi_physical_application.js', mode, input || '-', output], selectedEnv);
        return JSON.parse(await fs.readFile(output, 'utf8'));
    };
    // 在执行耗时物理拷贝前验证真实生产启动契约，并托管已恢复进程将使用的相同配置。

    await run(['-e', "require('./server/config').validateConfig()"]);
    await run(['scripts/setup_pg_test_db.js']);
    const client = new Client({ connectionString: cluster.url }); await client.connect(); await client.query(`SET search_path TO "${schema}",public`);
    const applicationRole = 'pivot_physical_application';
    await client.query(`CREATE ROLE ${applicationRole} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`);
    await client.query(`GRANT USAGE ON SCHEMA "${schema}" TO ${applicationRole}`);
    await client.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA "${schema}" TO ${applicationRole}`);
    await client.query(`GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA "${schema}" TO ${applicationRole}`);
    const configFile = path.join(independent, 'physical-operator.json');
    const configBody = { clusterId: (await client.query('SELECT system_identifier::text AS id FROM pg_control_system()')).rows[0].id,
        schema, applicationRole, operatorConnection: cluster.url, bin: cluster.bin, primaryDataDirectory: cluster.data,
        projectRoot, environment, backupRoot: path.join(independent, 'database-objects'), escrowRoot: path.join(independent, 'config-escrow'), stagingRoot: path.join(independent, 'private-plaintext-stage'),
        keyFile: backupKey, configurationFiles: [path.join(projectRoot, '.env'), path.join(projectRoot, 'config.json')], plaintextStagingPolicy: '本机隔离演练私有临时目录；仅验证功能，不认证生产磁盘加密。' };
    await fs.writeFile(configFile, JSON.stringify(configBody), { mode: 0o600 });
    const archiveCommand = [quotedArgument(process.execPath), quotedArgument(path.resolve('scripts/bi_physical_backup.js')), '--config', quotedArgument(configFile), '--archive', '"%p"', '--name', '"%f"'].join(' ');
    await client.query(`ALTER SYSTEM SET archive_command='${archiveCommand.replace(/'/g, "''")}'`); await client.query('SELECT pg_reload_conf()');
    let config = await physical.configuration(configFile), restoredClient;
    try {
        await physical.preflight(client, config);
        const fixture = await action('seed'), fixtureFile = path.join(independent, 'fixture.json');
        await fs.writeFile(fixtureFile, JSON.stringify(fixture), { mode: 0o600 });
        const base = await physical.createBase(config); t.diagnostic(`verified physical base ${base.files} files`);
        await client.query('CREATE DATABASE unrelated_business');
        await assert.rejects(physical.preflight(client, config), /其他业务数据库/); await client.query('DROP DATABASE unrelated_business');
        await client.query('CREATE TABLE uncovered_reference(id INT)');
        assert.ok((await reference.coverage(client)).some(row => row.relname === 'uncovered_reference'));
        await assert.rejects(recovery.createPoint(config, base.id), /未覆盖/); await client.query('DROP TABLE uncovered_reference');
        // 所有应用（而不只是分析表）共同接入该屏障。
        const writer = new Client({ connectionString: cluster.url }); await writer.connect(); await writer.query(`SET search_path TO "${schema}",public`);
        try {
            assert.equal(await reference.tryBarrier(client), true);
            const writerPid = (await writer.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
            let finished = false;
            const pending = writer.query("UPDATE sessions SET title=title WHERE id=$1", [fixture.sessionId]).then(() => { finished = true; });
            const deadline = Date.now() + 3000;
            while (!(await client.query("SELECT EXISTS(SELECT 1 FROM pg_locks WHERE pid=$1 AND locktype='advisory' AND NOT granted) AS waiting", [writerPid])).rows[0].waiting) {
                assert.ok(Date.now() < deadline, '共享会话写入未实际等待恢复屏障。'); await new Promise(resolve => setTimeout(resolve, 20));
            }
            assert.equal(finished, false);
            await reference.releaseBarrier(client); await pending; assert.equal(finished, true);
        } finally { await reference.releaseBarrier(client); await writer.end(); }
        const heldWriter = new Client({ connectionString: cluster.url }); await heldWriter.connect(); await heldWriter.query(`SET search_path TO "${schema}",public`);
        try {
            await heldWriter.query('BEGIN'); await heldWriter.query('UPDATE sessions SET title=title WHERE id=$1', [fixture.sessionId]);
            await assert.rejects(recovery.createPoint(config, base.id), /屏障超时/);
            await heldWriter.query('COMMIT');
            assert.equal(await reference.tryBarrier(client), true); await reference.releaseBarrier(client);
            await heldWriter.query('BEGIN'); await heldWriter.query('UPDATE sessions SET title=title WHERE id=$1', [fixture.sessionId]);
            let changedOutcome;
            const changed = recovery.createPoint(config, base.id).then(value => (changedOutcome = { value }), error => (changedOutcome = { error })), deadline = Date.now() + 60000;
            while (!(await client.query("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name='pivot-physical-backup-operator' AND query LIKE '%pg_try_advisory_lock%' AND state='idle') AS waiting")).rows[0].waiting) {
                if (changedOutcome?.error) throw changedOutcome.error;
                assert.ok(Date.now() < deadline, '共同恢复点没有进入实际屏障等待。'); await new Promise(resolve => setTimeout(resolve, 20));
            }
            const originalFile = fixtureFiles[0]; await fs.writeFile(originalFile.file, originalFile.content + 'changed');
            await heldWriter.query('COMMIT');
            await assert.rejects(async () => { const outcome = await changed; if (outcome.error) throw outcome.error; }, /共享文件已变化/); await fs.writeFile(originalFile.file, originalFile.content);
        } finally { await heldWriter.query('ROLLBACK').catch(() => {}); await heldWriter.end(); }
        const object = (await client.query("SELECT storage_key FROM analysis_data_objects WHERE state='ready' LIMIT 1")).rows[0];
        const required = path.join(environment.PIVOT_ANALYSIS_DIR, 'objects', object.storage_key);
        await fs.rename(required, required + '.unavailable');
        try { await assert.rejects(recovery.createPoint(config, base.id), /缺少数据库必须文件/); }
        finally { await fs.rename(required + '.unavailable', required); }
        const temporary = path.join(environment.PIVOT_ANALYSIS_DIR, 'tmp', 'active-output'); await fs.mkdir(path.dirname(temporary), { recursive: true });
        await client.query(`CREATE FUNCTION test_point_confirmation_failure() RETURNS trigger LANGUAGE plpgsql AS $body$ BEGIN
            IF NEW.status='verified' AND pivot_current_database_timeline()=1 THEN RAISE EXCEPTION 'isolated point confirmation interruption'; END IF; RETURN NEW; END $body$;
            CREATE TRIGGER test_point_confirmation_failure BEFORE UPDATE ON analysis_recovery_points FOR EACH ROW EXECUTE FUNCTION test_point_confirmation_failure()`);
        let pendingTemporary = null, counter = 0;
        const temporaryWriter = setInterval(() => {
            if (!pendingTemporary) pendingTemporary = fs.writeFile(temporary, `未登记的执行暂存 ${counter++}`).finally(() => { pendingTemporary = null; });
        }, 10);
        let point;
        try {
            await assert.rejects(recovery.createPoint(config, base.id), error => {
                assert.equal(error.code, 'COMMON_RECOVERY_CONFIRMATION_PENDING'); point = { id: error.recoveryPointId }; return true;
            });
        }
        finally { clearInterval(temporaryWriter); if (pendingTemporary) await pendingTemporary; }
        assert.equal((await client.query('SELECT status FROM analysis_recovery_points WHERE id=$1', [point.id])).rows[0].status, 'building');
        await client.query('DROP TRIGGER test_point_confirmation_failure ON analysis_recovery_points; DROP FUNCTION test_point_confirmation_failure()');
        assert.equal((await require('../server/services/physical-backup-operations').confirmPoint(config, point.id, client)).verified, true);
        point = await physical.readManifest(config, point.id);
        t.diagnostic(`common point barrier ${point.barrierMs}ms, ${point.files.length} shared files`);
        assert.ok(point.barrierMs <= 5000);
        assert.ok(Number((await client.query("SELECT COUNT(*) AS n FROM analysis_object_references WHERE reference_kind='backup' AND reference_id=$1", [point.id])).rows[0].n) > 0);
        const { point: manifest } = await recovery.verifyPoint(config, point.id);
        assert.ok(counter > 0); assert.ok(manifest.files.every(item => !path.resolve(item.root, item.path).startsWith(path.dirname(temporary) + path.sep)));
        // 每个必需的独立组件必须在创建任何恢复目标前报错；缺失或被篡改的数据绝不标记成功。

        const walFile = physical.walPath(config, manifest.wal[0]);
        await fs.rename(walFile, walFile + '.missing');
        try { await assert.rejects(recovery.verifyPoint(config, point.id)); }
        finally { await fs.rename(walFile + '.missing', walFile); }
        const objectFile = require('../server/services/common-recovery-files').objectPath(config.backupRoot, manifest.files[0].sha256), original = await fs.readFile(objectFile);
        const corrupt = Buffer.from(original); corrupt[25] ^= 1; await fs.writeFile(objectFile, corrupt);
        const untouched = path.join(root, 'must-stay-absent');
        try { await assert.rejects(prepareRestore({ config, configFile, pointId: point.id, destination: untouched })); await assert.rejects(fs.stat(untouched), { code: 'ENOENT' }); }
        finally { await fs.writeFile(objectFile, original); }
        await fs.rename(backupKey, backupKey + '.missing');
        try { await assert.rejects(physical.configuration(configFile)); }
        finally { await fs.rename(backupKey + '.missing', backupKey); }
        await action('revoke', fixtureFile);
        // 当前授权在丢失前独立复制，绝不直接将已恢复历史数据库派生为预期授权策略。

        const authoritative = await require('../server/repositories/analysis-security-recovery').authorityDraft(client);
        const authorityFile = path.join(independent, 'current-authority.json');
        await fs.writeFile(authorityFile, JSON.stringify({ resources: authoritative, privateKey: signing.privateKey.export({ type: 'pkcs8', format: 'pem' }) }), { mode: 0o600 });
        const faultAt = Date.now();
        await client.end(); await cluster.stop();
        for (const target of [cluster.data, application]) {
            assert.ok(sealed.inside(root, target) && target !== root && !sealed.inside(target, independent));
            await fs.rm(target, { recursive: true, force: true }); await assert.rejects(fs.stat(target), { code: 'ENOENT' });
        }
        config = await physical.configuration(configFile, { allowUnavailablePrimary: true });
        const destination = path.join(root, 'recovered-cluster');
        const restored = await prepareRestore({ config, configFile, pointId: point.id, destination });
        for (const item of fixtureFiles) assert.equal(await fs.readFile(item.file, 'utf8'), item.content);
        const port = await reservePort(); await cluster.start(destination, port);
        const restoredURL = `postgresql://pivot_test@127.0.0.1:${port}/pivot_test_chain`;
        restoredClient = new Client({ connectionString: restoredURL }); await restoredClient.connect(); await restoredClient.query(`SET search_path TO "${schema}",public`);
        const promotionDeadline = Date.now() + 120000;
        while ((await restoredClient.query('SELECT pg_is_in_recovery() AS recovery')).rows[0].recovery) {
            assert.ok(Date.now() < promotionDeadline, '有名恢复点尚未完成 WAL 回放与提升。');
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        const timeline = (await restoredClient.query('SELECT pivot_current_database_timeline() AS current,accepted_database_timeline AS accepted FROM analysis_security_state')).rows[0];
        assert.ok(Number(timeline.current) > Number(timeline.accepted));
        assert.equal((await restoredClient.query('SELECT title FROM sessions WHERE id=$1', [fixture.sessionId])).rows[0].title, '共享整库恢复前会话');
        const recoveredConfig = require('dotenv').parse(await fs.readFile(path.join(projectRoot, '.env')));
        for (const [key, value] of Object.entries(applicationConfig)) assert.equal(recoveredConfig[key], value);
        const restoredEnv = { ...env, ...recoveredConfig, DATABASE_URL: restoredURL, TEST_DATABASE_URL: restoredURL };
        assert.equal((await action('closed', fixtureFile, restoredEnv)).recovery_reason, 'database_physical_recovery_detected');
        await action('replay', fixtureFile, restoredEnv);
        const signed = await action('sign', authorityFile, restoredEnv), signedFile = path.join(independent, 'signed-authority.json');
        await fs.writeFile(signedFile, JSON.stringify(signed), { mode: 0o600 });
        assert.equal((await action('reconcile', signedFile, restoredEnv)).mode, 'ready');
        const verified = await action('verify', fixtureFile, restoredEnv);
        const restoredConfig = { ...config, operatorConnection: restoredURL, primaryDataDirectory: destination };
        assert.equal((await require('../server/services/physical-backup-operations').confirmPoint(restoredConfig, point.id, restoredClient)).verified, true);
        assert.equal((await restoredClient.query('SELECT status FROM analysis_recovery_points WHERE id=$1', [point.id])).rows[0].status, 'verified');
        const health = await action('health', fixtureFile, restoredEnv);
        assert.equal(health.alerts.includes('recovery_point_lag'), false); assert.equal(health.probeOutcome, 'succeeded');
        const completedAt = Date.now(), rpoSeconds = (faultAt - Date.parse(point.createdAt)) / 1000, rtoSeconds = (completedAt - faultAt) / 1000;
        t.diagnostic(JSON.stringify({ pointId: point.id, baseId: base.id, barrierMs: point.barrierMs, restored, verified, configurationEscrowReused: true, rpoSeconds, rtoSeconds, productionCertified: false }));
        assert.ok(rpoSeconds <= 900); assert.ok(rtoSeconds <= 3600);
    } finally { await client.end().catch(() => {}); await restoredClient?.end(); }
}, { durable: true,
    // 当临时目录位于源码树内部时，分析模块存储项目相对路径；独立的专用挂载验证受支持的契约，
    // 不覆盖开发者的真实配置文件。

    tempRoot: sealed.inside(path.resolve(__dirname, '..'), os.tmpdir()) ? path.join(path.parse(os.tmpdir()).root, 'pivot-isolated-recovery-tests') : os.tmpdir(),
    settings: ["archive_mode = 'on'", "wal_level = 'replica'", 'full_page_writes = on', 'fsync = on', 'synchronous_commit = on', 'archive_timeout = 60'] }));
