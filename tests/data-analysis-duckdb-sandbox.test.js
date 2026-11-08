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
    try {
        await connection.run('CREATE TABLE data AS SELECT 42 AS value');
        const aws = (await connection.runAndReadAll("SELECT loaded,installed FROM duckdb_extensions() WHERE extension_name='aws'")).getRowObjectsJson()[0];
        assert.equal(aws.loaded, false); assert.equal(aws.installed, false);
        await lockDuckExternalAccess(connection, { allowedPaths: [permitted] });
        await assert.rejects(connection.run(`SELECT * FROM read_text(${sqlLiteral(secret)})`), /disabled|permission/i);
        await assert.rejects(connection.run('SET enable_external_access=true'), /cannot|locked/i);
        await assert.rejects(connection.run('LOAD aws'), /Loading external extensions is disabled/i);
        await assert.rejects(connection.run('SET autoload_known_extensions=true'), /cannot|locked/i);
        await connection.run(`COPY data TO ${sqlLiteral(permitted)} (FORMAT PARQUET)`);
        assert.ok((await fs.stat(permitted)).size > 0);
    } finally {
        connection.closeSync();
        instance.closeSync();
        await fs.rm(root, { recursive: true, force: true });
    }
});
