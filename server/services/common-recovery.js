'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const physical = require('./physical-backup');
const sealed = require('./backup-sealed-files');
const shared = require('./common-recovery-files');
const repository = require('../repositories/analysis-common-recovery');
const { canonicalHash } = require('./data-analysis/bi/canonical');
const journalFiles = require('./data-analysis/bi/security-journal-files');

async function independentSecurity(config, head) {
    const root = config.environment?.DATA_ANALYSIS_SECURITY_JOURNAL_DIR, keyFile = config.environment?.DATA_ANALYSIS_SECURITY_KEY_FILE;
    if (!path.isAbsolute(root || '') || !path.isAbsolute(keyFile || '') || sealed.inside(root, keyFile)) throw new Error('共同恢复点必须配置独立安全记录及分离密钥。');
    const stat = await sealed.regularFile(keyFile);
    if (stat.size > 4096n || await fs.realpath(keyFile) !== path.resolve(keyFile) || process.platform !== 'win32' && (Number(stat.mode) & 0o077)) throw new Error('安全记录密钥无效。');
    const key = (await fs.readFile(keyFile, 'utf8')).trim();
    if (!/^[a-f0-9]{64,128}$/i.test(key)) throw new Error('安全记录密钥无效。');
    const directory = await fs.lstat(root);
    if (!directory.isDirectory() || directory.isSymbolicLink() || await fs.realpath(root) !== path.resolve(root) || process.platform !== 'win32' && (directory.mode & 0o077)) throw new Error('独立安全日志目录缺失或权限无效。');
    for (const other of [...Object.values(config.application.aliases).map(item => item.path), config.primaryDataDirectory, config.backupRoot, config.escrowRoot]) {
        if (sealed.inside(other, root) || sealed.inside(root, other) || sealed.inside(other, keyFile)) throw new Error('安全日志及密钥必须位于主库、数据及备份之外的独立目录。');
    }
    const chain = await journalFiles.readChain({ root, key }, head.originId);
    const entryHash = head.position === 0 ? journalFiles.EMPTY_HASH : chain.entries[head.position - 1]?.hash;
    if (entryHash !== head.hash) throw new Error('恢复点安全高水位缺失或摘要不匹配。');
    return { chainPosition: chain.position, position: head.position, hash: head.hash, originId: head.originId };
}
async function precopyEscrow(config) {
    const sources = config.configurationFiles;
    if (!Array.isArray(sources) || sources.length < 2 || sources.length > 32 || !sources.includes(path.join(config.projectRoot, '.env')) || !sources.includes(path.join(config.projectRoot, 'config.json'))) throw new Error('共同恢复点必须明确托管 .env、config.json 及其他外部必要配置和密钥文件。');
    const files = [];
    for (const source of [...new Set(sources)].sort()) {
        if (!path.isAbsolute(source) || await fs.realpath(source) !== source || source === config.keyFile) throw new Error('配置托管路径无效或包含备份密钥。');
        const stat = await sealed.regularFile(source);
        if (stat.size > 16n * 1024n * 1024n) throw new Error('单个托管配置文件超过十六 MiB。');
        const sha256 = await sealed.digest(source);
        await sealed.sealFile({ source, destination: shared.objectPath(config.escrowRoot, sha256), key: config.key, context: shared.objectContext(`${config.clusterId}:escrow`, sha256), expectedDigest: sha256 });
        if (sealed.signature(stat) !== sealed.signature(await sealed.regularFile(source))) throw new Error('配置托管期间文件已变化。');
        files.push({ path: source, bytes: String(stat.size), signature: sealed.signature(stat), sha256 });
    }
    return files;
}
async function checkEscrowSignatures(files) {
    for (const item of files) if (item.signature !== sealed.signature(await sealed.regularFile(item.path))) throw new Error('共同恢复点建立时配置或密钥已变化。');
}
async function verifyEscrow(config, files) {
    for (const item of files) {
        if (!path.isAbsolute(item.path)) throw new Error('配置托管清单路径无效。');
        await sealed.verifyFile({ source: shared.objectPath(config.escrowRoot, item.sha256), key: config.key,
            context: shared.objectContext(`${config.clusterId}:escrow`, item.sha256), expectedDigest: item.sha256, expectedBytes: item.bytes });
    }
}
async function confirmAliases(config) {
    const current = await shared.applicationRoots(config.environment || {}, config.projectRoot);
    if (canonicalHash(current) !== canonicalHash(config.application)) throw new Error('共同恢复点期间共享逻辑目录已变化。');
}
async function createPoint(config, baseId) {
    const base = await physical.verifyBase(config, baseId), client = await physical.connect(config);
    const id = `point_${crypto.randomUUID()}`;
    let held = false, timer, timedOut = false, inTransaction = false, watchdog, guardian, published = false;
    client.on('error', () => {});
    try {
        watchdog = await physical.connect(config);
        guardian = await require('./physical-backup-watchdog').createBackupWatchdog(config.operatorConnection, () => { timedOut = true; void client.end().catch(() => {}); });
        const facts = await physical.preflight(client, config);
        if (facts.timeline !== base.facts.timeline) throw new Error('基础备份与当前时间线不兼容，请重新建立完整备份。');
        if ((await repository.coverage(client)).length) throw new Error('共享写入屏障未覆盖全部应用表，不能建立共同恢复点。');
        await repository.prepare(client, { id, baseId });
        const objects = await shared.precopy({ roots: config.application.roots, exclusions: config.application.exclusions, backupRoot: config.backupRoot, key: config.key, clusterId: config.clusterId });
        const references = await repository.referenceInventory(client);
        shared.verifyReferences(config.application, references, objects);
        const escrow = await precopyEscrow(config), securityBefore = await repository.securityHead(client);
        await independentSecurity(config, securityBefore);
        const pid = (await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
        const started = Date.now(), deadline = started + 5000;
        while (!(held = await repository.tryBarrier(client))) {
            if (Date.now() >= deadline) throw new Error('共同恢复点等待写入屏障超时。');
            await new Promise(resolve => setTimeout(resolve, 20));
        }
        const lockedAt = Date.now();
        // 即使文件系统操作缓慢，第二个独立操作员会话也会释放停滞的屏障；该时间点仍保留未完成状态。

        timer = setTimeout(() => { timedOut = true; void watchdog.query('SELECT pg_terminate_backend($1)', [pid]).catch(() => {}); }, Math.max(1, deadline - Date.now()));
        await guardian.arm(pid, deadline);
        const remaining = async () => {
            if (timedOut || Date.now() >= deadline) throw new Error('共同恢复点超过五秒写入屏障时限。');
            await client.query(`SET statement_timeout=${Math.max(1, deadline - Date.now())}`);
        };
        await remaining();
        if ((await repository.coverage(client)).length) throw new Error('共同恢复点建立时写入保护已改变。');
        const security = await repository.securityHead(client);
        if (canonicalHash(security) !== canonicalHash(securityBefore)) throw new Error('预复制后安全高水位已变化，请先完成独立确认后重试。');
        if (!shared.sameSignatures(objects, await shared.scan(config.application.roots, deadline, config.application.exclusions))) throw new Error('预复制后共享文件已变化，恢复点未完成。');
        await confirmAliases(config);
        const currentReferences = await repository.referenceInventory(client);
        if (canonicalHash(currentReferences) !== canonicalHash(references)) throw new Error('预复制后共享数据库引用已变化，请重新建立共同恢复点。');
        shared.verifyReferences(config.application, currentReferences, objects);
        await checkEscrowSignatures(escrow); await remaining();
        const point = { version: 1, kind: 'common-point', id, baseId, clusterId: config.clusterId, createdAt: new Date().toISOString(),
            application: config.application, files: objects, references, escrow, security, facts };
        await client.query('BEGIN'); inTransaction = true;
        await repository.register(client, { id, baseId, manifest: point, digest: canonicalHash(point), security });
        await remaining(); await client.query('COMMIT'); inTransaction = false;
        await remaining();
        point.lsn = (await client.query('SELECT pg_create_restore_point($1) AS lsn', [id])).rows[0].lsn;
        // 在发布具名时间点前重新核对易变的文件系统与配置签名；任何竞态均导致该次尝试点不可用。

        if (!shared.sameSignatures(objects, await shared.scan(config.application.roots, deadline, config.application.exclusions))) throw new Error('恢复点定位期间共享文件已变化。');
        await confirmAliases(config);
        await checkEscrowSignatures(escrow); await remaining();
        await repository.releaseBarrier(client); held = false; clearTimeout(timer);
        point.barrierMs = Date.now() - lockedAt;
        await guardian.stop(); guardian = null;
        if (point.barrierMs > 5000 || timedOut) throw new Error('共同恢复点写入暂停超过五秒。');
        await client.query("SET statement_timeout='30s'");
        await client.query('SELECT pg_switch_wal()');
        const archiveDeadline = Date.now() + 120000;
        let wal;
        while (!wal) {
            try { wal = await physical.verifyWalChain(config, base, point.lsn); }
            catch (error) {
                if (error.code !== 'ENOENT' || Date.now() >= archiveDeadline) throw error;
                await new Promise(resolve => setTimeout(resolve, 200));
            }
        }
        point.wal = wal;
        await shared.verifyObjects({ files: objects, backupRoot: config.backupRoot, key: config.key, clusterId: config.clusterId });
        await verifyEscrow(config, escrow); await independentSecurity(config, security);
        if (!(await sealed.readKey(config.keyFile, config.backupRoot)).equals(config.key)) throw new Error('共同恢复点期间独立密钥已变化。');
        point.verifiedAt = new Date().toISOString(); point.status = 'verified';
        await physical.writeManifest(config, point);
        published = true;
        const digest = canonicalHash(point);
        await repository.verified(client, { ...point, digest });
        return { id, baseId, lsn: point.lsn, barrierMs: point.barrierMs, files: objects.length, bytes: objects.reduce((sum, item) => sum + Number(item.bytes), 0), createdAt: point.createdAt, verifiedAt: point.verifiedAt, digest };
    } catch (error) {
        if (inTransaction) await client.query('ROLLBACK').catch(() => {});
        if (held) await repository.releaseBarrier(client).catch(() => {});
        clearTimeout(timer);
        if (published) {
            const pending = new Error(`独立共同恢复点已完成，主库目录确认待重试：${id}`);
            pending.code = 'COMMON_RECOVERY_CONFIRMATION_PENDING'; pending.recoveryPointId = id; throw pending;
        }
        if (watchdog) await repository.failed(watchdog, id, timedOut ? 'BARRIER_TIMEOUT' : 'POINT_INCOMPLETE').catch(() => {});
        throw error;
    } finally { clearTimeout(timer); await guardian?.stop().catch(() => {}); await client.end().catch(() => {}); await watchdog?.end(); }
}
async function verifyPoint(config, id) {
    const point = await physical.readManifest(config, id);
    if (point.version !== 1 || point.kind !== 'common-point' || point.id !== id || point.clusterId !== config.clusterId || point.status !== 'verified' || point.barrierMs > 5000) throw new Error('共同恢复点清单未完成或与集群不匹配。');
    const base = await physical.verifyBase(config, point.baseId);
    const wal = await physical.verifyWalChain(config, base, point.lsn);
    if (canonicalHash(wal) !== canonicalHash(point.wal)) throw new Error('共同恢复点 WAL 链不匹配。');
    await shared.verifyObjects({ files: point.files, backupRoot: config.backupRoot, key: config.key, clusterId: config.clusterId });
    shared.verifyReferences(point.application, point.references, point.files);
    await verifyEscrow(config, point.escrow); await independentSecurity(config, point.security);
    return { point, base };
}

module.exports = { createPoint, verifyPoint };
