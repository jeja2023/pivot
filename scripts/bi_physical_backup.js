'use strict';

// PostgreSQL 归档与恢复命令仅使用受控私有配置路径和 %p/%f 调用此文件；凭据绝不暴露在子进程命令行中。
const path = require('node:path');
const physical = require('../server/services/physical-backup');
function option(name) { const index = process.argv.indexOf(name); return index < 0 ? '' : String(process.argv[index + 1] || ''); }
async function main() {
    const config = await physical.configuration(option('--config'), { allowUnavailablePrimary: process.argv.includes('--restore-wal') || process.argv.includes('--restore') });
    if (process.argv.includes('--archive')) return physical.archiveWal(config, path.resolve(option('--archive')), option('--name'));
    if (process.argv.includes('--restore-wal')) return physical.restoreWal(config, option('--restore-wal'), path.resolve(option('--destination')), option('--recovery-directory'));
    if (process.argv.includes('--base')) return physical.createBase(config);
    if (process.argv.includes('--point')) {
        await require('../server/services/physical-backup-operations').confirmSecurity(config);
        return require('../server/services/common-recovery').createPoint(config, option('--base-id'));
    }
    if (process.argv.includes('--verify-point')) {
        const { point } = await require('../server/services/common-recovery').verifyPoint(config, option('--verify-point'));
        return { id: point.id, lsn: point.lsn, verified: true };
    }
    if (process.argv.includes('--restore')) return require('../server/services/physical-restore').prepareRestore({ config, configFile: option('--config'), pointId: option('--restore'), destination: option('--destination') });
    if (process.argv.includes('--tick')) return require('../server/services/physical-backup-operations').tick(config, { prune: process.argv.includes('--prune') });
    const client = await physical.connect(config);
    try {
        const facts = await physical.preflight(client, config);
        if (process.argv.includes('--confirm-point')) return require('../server/services/physical-backup-operations').confirmPoint(config, option('--confirm-point'), client);
        return facts;
    }
    finally { await client.end(); }
}
main().then(result => process.stdout.write(JSON.stringify(result) + '\n')).catch(error => {

    // 严禁打印包含本地凭据的 PG 连接对象或命令参数；PostgreSQL 将任何非零退出视为可重试错误。
    process.stderr.write(`物理备份操作失败：${error.message}\n`); process.exitCode = 1;
});
