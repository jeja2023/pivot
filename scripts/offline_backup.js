const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
const { spawn } = require('child_process');
const { backupPaths, createBackupBundle, verifyBackupBundle } = require('../server/services/offline-backup-bundle');

async function main(args = process.argv.slice(2)) {
    if (args[0] === '--plan') return console.log(JSON.stringify(backupPaths(), null, 2));
    if (args[0] === '--verify' && args[1]) {
        const manifest = await verifyBackupBundle(path.resolve(args[1]));
        return console.log(`备份校验通过，共 ${manifest.files.length} 个文件。`);
    }
    const outputIndex = args.indexOf('--output');
    if (outputIndex < 0 || !args[outputIndex + 1]) throw new Error('请使用 --output 指定全新的备份目录，或使用 --plan / --verify。');
    if (!process.env.DATABASE_URL) throw new Error('未配置 PostgreSQL 连接。');
    await createBackupBundle({ output: args[outputIndex + 1], maintenanceConfirmed: args.includes('--maintenance-confirmed'), dumpDatabase: destination => new Promise((resolve, reject) => {
        // 连接串只经子进程环境传递，不放入命令行、日志或清单。
        const child = spawn('pg_dump', ['--no-password', '--format=custom', '--file', destination], { env: require('../server/services/postgres-command-env').postgresCommandEnv(process.env.DATABASE_URL), stdio: ['ignore', 'ignore', 'ignore'], windowsHide: true });
        child.once('error', () => reject(new Error('无法启动 pg_dump，请检查 PostgreSQL 客户端。')));
        child.once('exit', code => code === 0 ? resolve() : reject(new Error('PostgreSQL 备份失败，请检查连接与权限。')));
    }) });
    console.log('数据库、CAS 与上传目录备份完成，校验清单已生成。');
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { main };
