'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const physical = require('./physical-backup');
const sealed = require('./backup-sealed-files');
const shared = require('./common-recovery-files');
const { verifyPoint } = require('./common-recovery');
const { canonicalHash } = require('./data-analysis/bi/canonical');

function quotedArgument(value) {
    // This is intentionally a restricted path alphabet: pg restore_command is
    // a shell command on the DB host, while all other invocations use execFile.
    if (!/^[A-Za-z0-9_:./\\ -]+$/.test(value)) throw new Error('PostgreSQL 恢复命令路径含不支持的命令字符。');
    return `"${value}"`;
}
function pgLiteral(value) { return "'" + value.replace(/\\/g, '\\\\').replace(/'/g, "''") + "'"; }
async function checkTargets(config, point, destination) {
    if (!path.isAbsolute(destination)) throw new Error('物理还原必须明确新的绝对 PGDATA 目录。');
    for (const primary of [config.primaryDataDirectory, config.backupRoot, config.escrowRoot, config.stagingRoot, ...point.application.roots]) if (sealed.inside(primary, destination) || sealed.inside(destination, primary)) throw new Error('物理还原目录不得覆盖主库、共享数据或备份。');
    if (point.application.projectRoot !== config.projectRoot) throw new Error('共享整库恢复必须保留各应用记录的逻辑项目路径。');
    for (const [name, item] of Object.entries(point.application.aliases)) if (config.application.aliases[name]?.path !== item.path) throw new Error('共享应用逻辑目录与所选恢复点不匹配。');
    for (const root of [destination, ...point.application.roots]) {
        try {
            const stat = await fs.lstat(root);
            if (!stat.isDirectory() || stat.isSymbolicLink() || await fs.realpath(root) !== root || (await fs.readdir(root)).length) throw new Error('还原目标必须为真实空目录，禁止覆盖现有文件。');
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    for (const item of point.escrow) {
        if (!config.configurationFiles.includes(item.path)) throw new Error('配置托管目标不在当前明确恢复范围内。');
        try {
            if (await sealed.digest(item.path) !== item.sha256) throw new Error('现有配置与恢复点不匹配，禁止覆盖。');
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
}
async function prepareRestore({ config, configFile, pointId, destination }) {
    const startedAt = new Date().toISOString(), { point, base } = await verifyPoint(config, pointId);
    destination = path.resolve(destination);
    await checkTargets(config, point, destination);
    const restoreCommand = [quotedArgument(process.execPath), quotedArgument(path.resolve(__dirname, '../../scripts/bi_physical_backup.js')), '--config', quotedArgument(configFile),
        '--restore-wal', '"%f"', '--destination', '"%p"', '--recovery-directory', quotedArgument(destination)].join(' ');
    await shared.restoreObjects({ files: base.files.map(item => ({ ...item, root: destination })), roots: [destination], backupRoot: config.backupRoot, key: config.key, clusterId: config.clusterId });
    if (!Array.isArray(base.directories)) throw new Error('物理备份缺少 PostgreSQL 空目录清单。');
    for (const directory of base.directories) {
        if (!shared.safeRelative(directory)) throw new Error('物理备份目录清单无效。');
        await fs.mkdir(path.join(destination, ...directory.split('/')), { recursive: true, mode: 0o700 });
    }
    // pg_verifybackup validates the restored base before recovery configuration
    // changes it. This catches plaintext write/storage errors as well as seals.
    await physical.command(config, 'pg_verifybackup', ['--exit-on-error', destination]);
    await shared.restoreObjects({ files: point.files, roots: point.application.roots, backupRoot: config.backupRoot, key: config.key, clusterId: config.clusterId });
    for (const alias of Object.values(point.application.aliases)) if (!alias.absent) await fs.mkdir(alias.path, { recursive: true, mode: 0o700 });
    for (const item of point.escrow) {
        try { await fs.access(item.path); }
        catch (error) {
            if (error.code !== 'ENOENT') throw error;
            await fs.mkdir(path.dirname(item.path), { recursive: true, mode: 0o700 });
            await sealed.restoreFile({ source: shared.objectPath(config.escrowRoot, item.sha256), destination: item.path, privateParent: false,
                key: config.key, context: shared.objectContext(`${config.clusterId}:escrow`, item.sha256), expectedDigest: item.sha256, expectedBytes: item.bytes });
        }
    }
    const settings = [
        `restore_command = ${pgLiteral(restoreCommand)}`,
        `recovery_target_name = ${pgLiteral(point.id)}`,
        "recovery_target_action = 'promote'", `recovery_target_timeline = ${pgLiteral(String(base.facts.timeline))}`,
        "archive_mode = 'off'", "listen_addresses = '127.0.0.1'"
    ];
    // Source includes/data_directory/preload/archive settings can refer to a
    // live host. Retain them for review, but boot the isolated recovery with a
    // fixed local-only configuration, without external effects or includes.
    await fs.rename(path.join(destination, 'postgresql.conf'), path.join(destination, 'postgresql.restored-original.conf'));
    const conf = await fs.open(path.join(destination, 'postgresql.conf'), 'wx', 0o600);
    try {
        await conf.writeFile([`data_directory = ${pgLiteral(destination.replace(/\\/g, '/'))}`, `hba_file = ${pgLiteral(path.join(destination, 'pg_hba.conf').replace(/\\/g, '/'))}`,
            `ident_file = ${pgLiteral(path.join(destination, 'pg_ident.conf').replace(/\\/g, '/'))}`, "listen_addresses = '127.0.0.1'", "unix_socket_directories = ''", "timezone = 'Asia/Shanghai'",
            'fsync = on', 'full_page_writes = on', "wal_level = 'replica'", "archive_mode = 'off'", "shared_preload_libraries = ''", "primary_conninfo = ''"].join('\n') + '\n');
        await conf.sync();
    } finally { await conf.close(); }
    const autoConf = await fs.open(path.join(destination, 'postgresql.auto.conf'), 'w', 0o600);
    try { await autoConf.writeFile('# Pivot verified common recovery point\n' + settings.join('\n') + '\n'); await autoConf.sync(); }
    finally { await autoConf.close(); }
    const signal = await fs.open(path.join(destination, 'recovery.signal'), 'wx', 0o600);
    try { await signal.sync(); } finally { await signal.close(); }
    await sealed.syncDirectory(destination);
    return { version: 1, pointId, pointDigest: canonicalHash(point), lsn: point.lsn, targetTimeline: base.facts.timeline, startedAt, preparedAt: new Date().toISOString(),
        databaseDirectory: destination, sharedFiles: point.files.length, sharedBytes: point.files.reduce((sum, item) => sum + Number(item.bytes), 0),
        nextAction: '以独立新端口启动还原集群；确认有名恢复点、时间线、完整查询与独立当前授权签认后，方可恢复单活服务。', productionCertified: false };
}

module.exports = { prepareRestore, quotedArgument };
