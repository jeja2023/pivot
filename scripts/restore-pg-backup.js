/* Restore a custom-format PostgreSQL backup only into an explicitly named
 * staging database. Refuses production and requires confirmation. */
require('dotenv').config();
const { spawn } = require('node:child_process');
const path = require('node:path');

function parseDatabaseUrl(value) {
    const url = new URL(String(value || ''));
    if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new Error('DATABASE_URL 必须是 PostgreSQL URL。');
    return { host: url.hostname, port: url.port || '5432', database: decodeURIComponent(url.pathname.slice(1)), user: decodeURIComponent(url.username), password: decodeURIComponent(url.password) };
}

function restore() {
    if (process.env.NODE_ENV === 'production' || process.argv.includes('--confirm-staging') !== true) throw new Error('只允许在非 production 环境显式使用 --confirm-staging。');
    const backup = path.resolve(process.argv[2] || '');
    if (!backup || !require('node:fs').existsSync(backup)) throw new Error('请提供存在的 .dump 备份路径。');
    const target = parseDatabaseUrl(process.env.DATABASE_URL);
    const env = { ...process.env, PGPASSWORD: target.password };
    const bin = process.env.PG_RESTORE_BIN || (process.platform === 'win32' ? 'C:\\Program Files\\PostgreSQL\\18\\bin\\pg_restore.exe' : 'pg_restore');
    const args = ['--clean', '--if-exists', '--no-owner', '--no-privileges', '--exit-on-error', '--host', target.host, '--port', target.port, '--username', target.user, '--dbname', target.database, backup];
    const child = spawn(bin, args, { env, stdio: 'inherit', windowsHide: true });
    child.on('close', code => { process.exitCode = code || 0; });
}

if (require.main === module) { try { restore(); } catch (error) { console.error(error.message); process.exitCode = 1; } }

module.exports = { parseDatabaseUrl, restore };
