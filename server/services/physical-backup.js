'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { Client } = require('pg');
const sealed = require('./backup-sealed-files');
const files = require('./common-recovery-files');
const { postgresCommandEnv } = require('./postgres-command-env');
const execute = promisify(execFile);
const WAL_NAME = /^(?:[0-9A-F]{24}|[0-9A-F]{8}\.history|[0-9A-F]{24}\.[0-9A-F]{8}\.backup)$/;
const ID = /^(?:base|point)_[a-f0-9-]{36}$/;

async function physicalBackupConfiguration(file, { allowUnavailablePrimary = false } = {}) {
    if (!path.isAbsolute(file)) throw new Error('请指定独立运维配置的绝对路径。');
    const stat = await sealed.regularFile(file);
    if (stat.size > 32768n || await fs.realpath(file) !== path.resolve(file) || process.platform !== 'win32' && (Number(stat.mode) & 0o077)) throw new Error('运维配置类型、路径或权限无效。');
    const config = JSON.parse(await fs.readFile(file, 'utf8'));
    for (const field of ['backupRoot', 'escrowRoot', 'keyFile', 'primaryDataDirectory', 'stagingRoot', 'projectRoot']) if (!path.isAbsolute(config[field] || '')) throw new Error(`运维配置缺少绝对目录：${field}`);
    if (!/^\d{10,24}$/.test(config.clusterId || '') || !/^[a-z_][a-z0-9_]{0,62}$/.test(config.schema || '') || !config.operatorConnection || !config.applicationRole || !config.plaintextStagingPolicy) throw new Error('物理备份缺少集群、独立身份、Schema 或明文暂存策略。');
    config.application = await files.applicationRoots(config.environment || {}, config.projectRoot, { allowMissing: allowUnavailablePrimary });
    const primaryPaths = Object.values(config.application.aliases).map(item => item.path).concat(config.primaryDataDirectory);
    for (const directory of [config.backupRoot, config.escrowRoot, config.stagingRoot]) {
        await sealed.privateDirectory(directory);
        for (const primary of primaryPaths) if (sealed.inside(primary, directory) || sealed.inside(directory, primary)) throw new Error('备份、配置托管与暂存必须独立于主库和共享数据目录。');
    }
    for (const [i, directory] of [config.backupRoot, config.escrowRoot, config.stagingRoot].entries()) {
        for (const other of [config.backupRoot, config.escrowRoot, config.stagingRoot].slice(i + 1)) if (sealed.inside(directory, other) || sealed.inside(other, directory)) throw new Error('备份、配置托管和明文暂存目录不得相互包含。');
        if (sealed.inside(directory, path.resolve(file))) throw new Error('运维凭据配置不得存放在备份或暂存目录。');
    }
    config.bin = config.bin ? path.resolve(config.bin) : '';
    for (const primary of primaryPaths) if (sealed.inside(primary, config.keyFile)) throw new Error('备份密钥不得存放在主库或共享数据目录。');
    config.key = await sealed.readKey(config.keyFile, config.backupRoot);
    if (sealed.inside(config.escrowRoot, config.keyFile) || sealed.inside(config.stagingRoot, config.keyFile)) throw new Error('备份密钥不得存放在托管或暂存目录。');
    return config;
}
async function connect(config) {
    const client = new Client({ connectionString: config.operatorConnection, application_name: 'pivot-physical-backup-operator' });
    try {
        await client.connect();
        await client.query(`SET search_path TO "${config.schema}",public`);
        await client.query("SET statement_timeout='30s'"); await client.query("SET lock_timeout='2s'");
        return client;
    } catch (error) { await client.end().catch(() => {}); throw error; }
}
function command(config, name, args, timeout = 30 * 60 * 1000) {
    const executable = config.bin ? path.join(config.bin, process.platform === 'win32' ? `${name}.exe` : name) : name;
    return execute(executable, args, { env: postgresCommandEnv(config.operatorConnection), windowsHide: true, timeout, maxBuffer: 4 * 1024 * 1024 });
}
async function preflight(client, config) {
    const identity = (await client.query(`SELECT system_identifier::text AS id FROM pg_control_system()`)).rows[0];
    if (identity.id !== config.clusterId) throw new Error('运维配置与实际 PostgreSQL 集群不匹配。');
    const databases = (await client.query("SELECT datname FROM pg_database WHERE NOT datistemplate AND datname<>'postgres' AND datname<>current_database()" )).rows;
    if (databases.length) throw new Error('共享物理恢复要求专属应用集群，检测到其他业务数据库。');
    const currentDatabase = (await client.query('SELECT current_database() AS name')).rows[0].name;
    if (currentDatabase !== 'postgres') {
        const otherURL = new URL(config.operatorConnection); otherURL.pathname = '/postgres';
        const administration = new Client({ connectionString: otherURL.toString(), connectionTimeoutMillis: 10000 });
        await administration.connect();
        try {
            const other = (await administration.query("SELECT EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema' AND c.relkind IN ('r','p','f','m')) AS found")).rows[0];
            if (other.found) throw new Error('postgres 管理数据库含其他持久业务对象，不能声称完整共享恢复单位。');
        } finally { await administration.end(); }
    }
    const external = (await client.query("SELECT EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema' AND (c.relkind='f' OR c.relpersistence='u')) AS found")).rows[0];
    if (external.found) throw new Error('物理恢复单位包含外部或无日志关系，必须先落实独立恢复合同。');
    const otherSchemas = (await client.query("SELECT EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema' AND n.nspname<>current_schema() AND c.relkind IN ('r','p','m')) AS found")).rows[0];
    if (otherSchemas.found) throw new Error('应用数据库包含当前共享恢复 Schema 之外的持久表，须先扩展和验证完整恢复合同。');
    const tablespaces = (await client.query("SELECT spcname FROM pg_tablespace WHERE spcname NOT IN ('pg_default','pg_global')")).rows;
    if (tablespaces.length) throw new Error('当前共同恢复合同不支持外部表空间，请使用经过验证的完整集群恢复方案。');
    const settings = {};
    for (const name of ['archive_mode', 'wal_level', 'full_page_writes', 'fsync', 'synchronous_commit', 'data_directory', 'wal_segment_size', 'server_version_num']) settings[name] = (await client.query(`SHOW ${name}`)).rows[0][name];
    if (settings.archive_mode !== 'on' || !['replica', 'logical'].includes(settings.wal_level) || settings.full_page_writes !== 'on' || settings.fsync !== 'on' || settings.synchronous_commit !== 'on') throw new Error('物理备份必须启用连续 WAL、完整页与持久提交。');
    if (path.resolve(settings.data_directory) !== path.resolve(config.primaryDataDirectory)) throw new Error('主库数据目录与恢复单位不匹配。');
    const actor = (await client.query('SELECT current_user AS name')).rows[0].name;
    const role = (await client.query('SELECT * FROM pg_roles WHERE rolname=$1', [config.applicationRole])).rows[0];
    if (!role || role.rolname === actor || role.rolsuper || role.rolreplication || role.rolcreaterole || role.rolcreatedb || role.rolbypassrls) throw new Error('应用身份必须与备份运维身份隔离，且不能持有集群管理权限。');
    const privileged = (await client.query("SELECT pg_has_role($1,'pg_write_server_files','MEMBER') OR pg_has_role($1,'pg_read_server_files','MEMBER') OR pg_has_role($1,'pg_execute_server_program','MEMBER') OR pg_has_role($1,'pg_signal_backend','MEMBER') AS allowed", [config.applicationRole])).rows[0];
    if (privileged.allowed) throw new Error('在线应用身份不得继承服务器文件、命令或运维终止权限。');
    const ddl = (await client.query(`SELECT has_schema_privilege($1,current_schema(),'CREATE') OR has_database_privilege($1,current_database(),'CREATE')
        OR EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=current_schema() AND pg_has_role($1,c.relowner,'MEMBER'))
        OR EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname=current_schema() AND pg_has_role($1,p.proowner,'MEMBER')) AS allowed`, [config.applicationRole])).rows[0];
    if (ddl.allowed) throw new Error('在线应用身份不得修改共享 Schema/表或备份写入保护，迁移须使用独立运维身份。');
    const segmentBytes = parseMemory(settings.wal_segment_size);
    const timeline = Number((await client.query('SELECT pivot_current_database_timeline() AS timeline_id')).rows[0].timeline_id);
    return { clusterId: identity.id, settings, segmentBytes, timeline, applicationRole: role.rolname, operatorRole: actor };
}
function parseMemory(value) {
    const match = /^(\d+)\s*(B|kB|MB|GB)$/i.exec(value);
    if (!match) throw new Error('WAL 段大小无效。');
    return Number(match[1]) * ({ b: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3 })[match[2].toLowerCase()];
}
function walPath(config, name) {
    if (!WAL_NAME.test(name)) throw new Error('WAL 归档名称无效。');
    return path.join(config.backupRoot, 'wal', config.clusterId, `${name}.seal`);
}
function walContext(config, name) { return `wal:${config.clusterId}:${name}`; }
async function archiveWal(config, source, name) {
    const absolute = path.resolve(source), walRoot = path.join(config.primaryDataDirectory, 'pg_wal');
    if (!WAL_NAME.test(name) || path.basename(absolute) !== name || !sealed.inside(walRoot, absolute) || await fs.realpath(absolute) !== absolute) throw new Error('WAL 来源超出已登记主库。');
    return sealed.sealFile({ source: absolute, destination: walPath(config, name), key: config.key, context: walContext(config, name) });
}
async function restoreWal(config, name, destination, recoveryDirectory) {
    if (!path.isAbsolute(recoveryDirectory) || !sealed.inside(path.join(recoveryDirectory, 'pg_wal'), path.resolve(destination))
        || sealed.inside(config.primaryDataDirectory, recoveryDirectory) || sealed.inside(recoveryDirectory, config.primaryDataDirectory)) throw new Error('WAL 还原目标必须为独立新集群。');
    return sealed.restoreFile({ source: walPath(config, name), destination: path.resolve(destination), key: config.key, context: walContext(config, name) });
}
function manifestPath(config, id) {
    if (!ID.test(id)) throw new Error('备份标识无效。');
    return path.join(config.backupRoot, id.startsWith('base_') ? 'bases' : 'points', `${id}.seal`);
}
async function readBackupManifest(config, id) { return sealed.readJson({ source: manifestPath(config, id), key: config.key, context: `manifest:${config.clusterId}:${id}` }); }
async function writeManifest(config, value) { return sealed.writeJson({ value, destination: manifestPath(config, value.id), key: config.key, context: `manifest:${config.clusterId}:${value.id}` }); }
async function createBase(config) {
    const client = await connect(config);
    let staging;
    try {
        const facts = await preflight(client, config), id = `base_${crypto.randomUUID()}`;
        for (const name of ['pg_basebackup', 'pg_verifybackup']) {
            const version = (await command(config, name, ['--version'], 10000)).stdout.match(/\b(\d+)\.\d+/);
            if (!version || Number(version[1]) !== Math.floor(Number(facts.settings.server_version_num) / 10000)) throw new Error('物理备份工具必须与数据库主版本匹配。');
        }
        staging = await fs.mkdtemp(path.join(config.stagingRoot, 'base-'));
        const data = path.join(staging, 'database');
        await command(config, 'pg_basebackup', ['--pgdata', data, '--format=plain', '--wal-method=stream', '--checkpoint=fast', '--manifest-checksums=SHA256', '--no-password']);
        await command(config, 'pg_verifybackup', ['--exit-on-error', data]);
        const pgManifest = JSON.parse(await fs.readFile(path.join(data, 'backup_manifest'), 'utf8'));
        const ranges = pgManifest['WAL-Ranges'];
        if (!Array.isArray(ranges) || ranges.length !== 1 || Number(ranges[0].Timeline) !== facts.timeline) throw new Error('基础备份跨时间线，须先完成独立恢复核验。');
        const objects = await files.precopy({ roots: [data], backupRoot: config.backupRoot, key: config.key, clusterId: config.clusterId });
        const manifest = { version: 1, kind: 'physical-base', id, createdAt: new Date().toISOString(), clusterId: config.clusterId,
            facts, startLSN: ranges[0]['Start-LSN'], endLSN: ranges[0]['End-LSN'], files: objects.map(item => ({ ...item, root: 'PGDATA', signature: undefined })), directories: await files.collectDirectories(data),
            plaintextStagingPolicy: config.plaintextStagingPolicy, postgresVerified: true };
        await files.verifyObjects({ files: manifest.files.map(item => ({ ...item, root: path.resolve('/PGDATA') })), backupRoot: config.backupRoot, key: config.key, clusterId: config.clusterId });
        if (!(await sealed.readKey(config.keyFile, config.backupRoot)).equals(config.key)) throw new Error('基础备份期间独立密钥已变化。');
        await writeManifest(config, manifest);
        if (JSON.stringify(await readBackupManifest(config, id)) !== JSON.stringify(JSON.parse(JSON.stringify(manifest)))) throw new Error('基础备份清单持久校验失败。');
        return { id, createdAt: manifest.createdAt, files: objects.length, startLSN: manifest.startLSN, endLSN: manifest.endLSN };
    } finally {
        await client.end();
        if (staging) {
            if (path.dirname(path.resolve(staging)) !== path.resolve(config.stagingRoot) || !/^base-[a-zA-Z0-9]+$/.test(path.basename(staging))) throw new Error('明文暂存清理边界无效。');
            await fs.rm(staging, { recursive: true, force: true });
        }
    }
}
async function verifyBase(config, id) {
    const manifest = await readBackupManifest(config, id);
    if (manifest.version !== 1 || manifest.kind !== 'physical-base' || manifest.id !== id || manifest.clusterId !== config.clusterId || !manifest.postgresVerified || !manifest.files?.length) throw new Error('物理基础备份清单无效。');
    await files.verifyObjects({ files: manifest.files.map(item => ({ ...item, root: path.resolve('/PGDATA') })), backupRoot: config.backupRoot, key: config.key, clusterId: config.clusterId });
    return manifest;
}
function lsnNumber(lsn) {
    if (!/^[0-9A-F]+\/[0-9A-F]+$/.test(lsn)) throw new Error('数据库恢复位置无效。');
    const [high, low] = lsn.split('/'); return BigInt(`0x${high}`) * 0x100000000n + BigInt(`0x${low}`);
}
function walSegments({ startLSN, endLSN, segmentBytes, timeline }) {
    const start = lsnNumber(startLSN) / BigInt(segmentBytes), end = lsnNumber(endLSN) / BigInt(segmentBytes), perLog = 0x100000000n / BigInt(segmentBytes);
    if (end < start || end - start > 1000000n) throw new Error('WAL 恢复链范围无效或超过单次核对边界。');
    const names = [];
    for (let segment = start; segment <= end; segment++) names.push([BigInt(timeline), segment / perLog, segment % perLog].map(value => value.toString(16).toUpperCase().padStart(8, '0')).join(''));
    return names;
}
async function verifyWalChain(config, base, lsn) {
    const names = walSegments({ startLSN: base.endLSN, endLSN: lsn, segmentBytes: base.facts.segmentBytes, timeline: base.facts.timeline });
    for (const name of names) {
        const verified = await sealed.verifyFile({ source: walPath(config, name), key: config.key, context: walContext(config, name) });
        if (verified.bytes !== base.facts.segmentBytes) throw new Error('WAL 段长度不完整。');
    }
    return names;
}

module.exports = { configuration: physicalBackupConfiguration, connect, command, preflight, archiveWal, restoreWal, walPath, readManifest: readBackupManifest, writeManifest, manifestPath,
    createBase, verifyBase, verifyWalChain, walSegments, lsnNumber };
