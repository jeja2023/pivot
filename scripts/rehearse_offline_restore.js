const fs = require('fs/promises'); const path = require('path'); const os = require('os'); const crypto = require('crypto');
const { promisify } = require('util'); const run = promisify(require('child_process').execFile);
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
const { Client } = require('pg');
const { createBackupBundle, verifyBackupBundle } = require('../server/services/offline-backup-bundle');
const { postgresCommandEnv } = require('../server/services/postgres-command-env');

async function main() {
    const url = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
    if (!url) throw new Error('请配置测试数据库连接。');
    const schema = `pivot_restore_${crypto.randomBytes(8).toString('hex')}`;
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pivot-restore-drill-'));
    const bin = process.env.PIVOT_RESTORE_PG_BIN || '';
    const executable = name => bin ? path.join(bin, process.platform === 'win32' ? name + '.exe' : name) : name;
    const client = new Client({ connectionString: url }); await client.connect();
    try {
        await client.query(`CREATE SCHEMA "${schema}"`);
        await client.query(`CREATE TABLE "${schema}".evidence (id integer PRIMARY KEY, content text)`);
        await client.query(`INSERT INTO "${schema}".evidence VALUES (1,$1)`, ['离线恢复验收凭据']);
        const data = path.join(root, 'data'), uploads = path.join(root, 'uploads');
        await fs.mkdir(path.join(data, 'agent-artifact-objects'), { recursive: true }); await fs.mkdir(uploads);
        await fs.writeFile(path.join(data, 'agent-artifact-objects', 'sample.txt'), 'CAS 原始凭据');
        await fs.writeFile(path.join(uploads, 'sample.txt'), '用户上传原始凭据');
        const output = path.join(root, 'backup');
        await createBackupBundle({ output, maintenanceConfirmed: true, env: { DATA_DIR: data, PIVOT_UPLOAD_DIR: uploads }, dumpDatabase: async destination => {
            await run(executable('pg_dump'), ['--no-password', '--format=custom', '--schema', schema, '--file', destination], { env: postgresCommandEnv(url), windowsHide: true, timeout: 60000 });
        } });
        const manifest = await verifyBackupBundle(output);
        // 只删除本次随机生成的测试 schema；永不接受外部 schema 或生产恢复目标。
        if (!/^pivot_restore_[a-f0-9]{16}$/.test(schema)) throw new Error('隔离恢复边界校验失败。');
        await client.query(`DROP SCHEMA "${schema}" CASCADE`);
        await run(executable('pg_restore'), ['--dbname', decodeURIComponent(new URL(url).pathname.slice(1)), '--no-password', '--no-owner', '--no-privileges', '--exit-on-error', path.join(output, 'database.dump')], { env: postgresCommandEnv(url), windowsHide: true, timeout: 60000 });
        const row = await client.query(`SELECT content FROM "${schema}".evidence WHERE id=1`);
        if (row.rows[0]?.content !== '离线恢复验收凭据') throw new Error('数据库恢复对账失败。');
        const restored = path.join(root, 'restored'); await fs.mkdir(restored);
        await fs.cp(path.join(output, 'cas'), path.join(restored, 'cas'), { recursive: true });
        await fs.cp(path.join(output, 'uploads'), path.join(restored, 'uploads'), { recursive: true });
        for (const item of manifest.files.filter(file => file.path !== 'database.dump')) {
            const bytes = await fs.readFile(path.join(restored, item.path));
            if (crypto.createHash('sha256').update(bytes).digest('hex') !== item.sha256) throw new Error('恢复文件摘要不一致。');
        }
        const report = { at: new Date().toISOString(), isolatedSchema: true, databaseRowsRestored: 1, fileHashesVerified: 2, productionModified: false };
        await fs.mkdir(path.resolve('artifacts/acceptance'), { recursive: true });
        await fs.writeFile(path.resolve('artifacts/acceptance/offline-restore.json'), JSON.stringify(report, null, 2));
        console.log('隔离数据库恢复与文件摘要对账通过，验收记录已保存。');
    } finally {
        await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await client.end();
        await fs.rm(root, { recursive: true, force: true });
    }
}
if (require.main === module) main().catch(() => { console.error('隔离恢复演练失败，请核对测试库与 PostgreSQL 工具版本。'); process.exitCode = 1; });
module.exports = { main };
