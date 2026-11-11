'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { transaction } = require('../server/db/client');
const { getPgPool } = require('../server/db/pg-connection');
const repository = require('../server/repositories/analysis-common-recovery');

test('全部迁移执行后新增业务表仍受共同恢复屏障保护，未知缺口不能被迁移静默覆盖', { skip: !process.env.DATABASE_URL }, async () => {
    const pool = getPgPool(), client = await pool.connect();
    try {
        assert.deepEqual(await repository.coverage(client), []);
        const migration = require('../server/db/migrations/common-recovery-late-tables')[0];
        for (let attempt = 0; attempt < 2; attempt++) await transaction(trx => migration.upPg(trx));
        assert.deepEqual(await repository.coverage(client), []);
        await client.query('CREATE TABLE test_unprotected_recovery(id BIGINT)');
        assert.ok((await repository.coverage(client)).some(row => row.relname === 'test_unprotected_recovery'));
        await transaction(trx => migration.upPg(trx));
        assert.ok((await repository.coverage(client)).some(row => row.relname === 'test_unprotected_recovery'));
    } finally { await client.query('DROP TABLE IF EXISTS test_unprotected_recovery'); client.release(); }
});
