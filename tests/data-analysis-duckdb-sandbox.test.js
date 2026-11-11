const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { DuckDBInstance } = require('@duckdb/node-api');
const { lockDuckExternalAccess } = require('../server/services/data-analysis/duckdb-sandbox');
const { sqlLiteral } = require('../server/services/data-analysis/shared');

test('DuckDB 沙箱仅允许指定导出路径并锁定配置', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pivot-duck-sandbox-'));
    const permitted = path.join(root, 'result.parquet');
    const secret = path.join(root, 'secret.txt');
    await fs.writeFile(secret, 'private');
    const instance = await DuckDBInstance.create(':memory:');
    const connection = await instance.connect();
    let cleanupSandbox;
    try {
        await connection.run('CREATE TABLE data AS SELECT 42 AS value');
        const aws = (await connection.runAndReadAll("SELECT loaded,installed FROM duckdb_extensions() WHERE extension_name='aws'")).getRowObjectsJson()[0];
        assert.equal(aws.loaded, false); assert.equal(aws.installed, false);
        await connection.run(`SET allowed_directories=[${sqlLiteral(root)}]`);
        await connection.run(`SET allowed_paths=[${sqlLiteral(secret)}]`);
        cleanupSandbox = await lockDuckExternalAccess(connection, { allowedPaths: [permitted] });
        const spill = (await connection.runAndReadAll("SELECT current_setting('temp_directory') AS directory")).getRowObjectsJson()[0].directory;
        assert.notEqual(path.resolve(spill), path.resolve(root));
        assert.match(path.basename(spill), /^pivot-duck-spill-/);
        await assert.rejects(connection.run(`SELECT * FROM read_text(${sqlLiteral(secret)})`), /disabled|permission/i);
        await assert.rejects(connection.run('SET enable_external_access=true'), /cannot|locked/i);
        await assert.rejects(connection.run('LOAD aws'), /Loading external extensions is disabled/i);
        await assert.rejects(connection.run('SET autoload_known_extensions=true'), /cannot|locked/i);
        await assert.rejects(connection.run(`SET temp_directory=${sqlLiteral(root)}`), /disabled|locked/i);
        await connection.run(`COPY data TO ${sqlLiteral(permitted)} (FORMAT PARQUET)`);
        assert.ok((await fs.stat(permitted)).size > 0);
    } finally {
        connection.closeSync();
        instance.closeSync();
        await cleanupSandbox?.();
        await fs.rm(root, { recursive: true, force: true });
    }
});

test('无输出路径的 DuckDB 沙箱清除旧文件白名单', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pivot-duck-reset-'));
    const file = path.join(root, 'old.txt');
    const instance = await DuckDBInstance.create(':memory:'); const connection = await instance.connect();
    let cleanupSandbox;
    try {
        await fs.writeFile(file, '旧授权');
        await connection.run(`SET allowed_paths=[${sqlLiteral(file)}]`);
        cleanupSandbox = await lockDuckExternalAccess(connection);
        await assert.rejects(connection.run(`SELECT * FROM read_text(${sqlLiteral(file)})`), /disabled|permission/i);
    } finally { connection.closeSync(); instance.closeSync(); await cleanupSandbox?.(); await fs.rm(root, { recursive: true, force: true }); }
});

test('私有溢写从输入物化前启用，锁定后仍可完成超内存数据计算并清理目录', async () => {
    const { createDuckConnection, tempRoot } = require('../server/services/data-analysis/shared');
    const { instance, connection, spillDirectory, cleanupSpill } = await createDuckConnection({ privateSpill: true });
    let cleanupSandbox;
    try {
        assert.equal(path.dirname(spillDirectory), path.resolve(tempRoot));
        await connection.run("SET memory_limit='16MB'");
        await connection.run("CREATE TABLE data AS SELECT i, repeat('材料',128) AS material FROM range(300000) source(i)");
        assert.ok((await fs.readdir(spillDirectory)).length > 0, '输入应实际使用私有溢写文件');
        cleanupSandbox = await lockDuckExternalAccess(connection, { spillDirectory });
        const row = (await connection.runAndReadAll('SELECT sum(i) AS total,count(*) AS n FROM data')).getRowObjectsJson()[0];
        assert.equal(String(row.total), '44999850000'); assert.equal(String(row.n), '300000');
    } finally { connection.closeSync(); instance.closeSync(); await cleanupSandbox?.(); await cleanupSpill(); }
    await assert.rejects(fs.stat(spillDirectory), { code: 'ENOENT' });
});
