'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

test('主数据库只注册 PostgreSQL 迁移与原生 schema 快照', () => {
    const migrations = require('../server/db/migrations');
    assert.ok(migrations.length > 0);
    assert.ok(migrations.every(migration => typeof migration.upPg === 'function'));
    assert.ok(migrations.every(migration => migration.up === undefined));

    const root = path.resolve(__dirname, '..');
    [
        'server/db/schema/base.js',
        'server/db/schema/tables-core.js',
        'server/db/schema/tables-agent.js',
        'server/db/schema/fts.js',
        'server/db/migrations/legacy.js',
        'scripts/migrate_sqlite_to_pg.js'
    ].forEach(relative => assert.equal(fs.existsSync(path.join(root, relative)), false, `${relative} 不应保留主库 SQLite 兼容层`));

    const { buildPgSchemaStatements } = require('../server/db/schema/pg');
    const plan = buildPgSchemaStatements();
    assert.ok(plan.tables.length >= 104);
    assert.ok(plan.tables.every(sql => /^CREATE TABLE IF NOT EXISTS/i.test(sql.trim())));
});
