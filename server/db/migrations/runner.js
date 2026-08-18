/**
 * server/db/migrations/runner.js
 * 版本化迁移执行器（支持 SQLite 同步 + PostgreSQL 异步）
 */
const { getBeijingTimestamp } = require('../../time');

// ── SQLite 同步实现 ────────────────────────────────────────────────────────

function ensureSchemaMigrationTable(db) {
    db.exec(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
            id TEXT PRIMARY KEY,
            description TEXT,
            applied_at DATETIME DEFAULT (datetime('now', '+8 hours'))
        );
    `);
}

function hasMigration(db, id) {
    return Boolean(db.prepare('SELECT id FROM schema_migrations WHERE id = ?').get(id));
}

function recordMigration(db, id, description = '') {
    db.prepare(`
        INSERT OR IGNORE INTO schema_migrations (id, description, applied_at)
        VALUES (?, ?, ?)
    `).run(id, description, getBeijingTimestamp());
}

function runVersionedMigration(db, migration, options = {}) {
    if (!migration || !migration.id || typeof migration.up !== 'function') {
        throw new Error('Invalid versioned migration: expected { id, up }');
    }
    ensureSchemaMigrationTable(db);
    if (hasMigration(db, migration.id)) return false;
    const run = db.transaction(() => {
        migration.up(db, options);
        recordMigration(db, migration.id, migration.description || '');
    });
    run();
    options.logger?.info?.({ id: migration.id }, '版本化数据库迁移已应用');
    return true;
}

function runVersionedMigrations(db, migrations = [], options = {}) {
    ensureSchemaMigrationTable(db);
    return migrations
        .slice()
        .sort((a, b) => String(a.id).localeCompare(String(b.id)))
        .filter(migration => runVersionedMigration(db, migration, options))
        .map(migration => migration.id);
}

// ── PostgreSQL 异步实现 ─────────────────────────────────────────────────────

async function ensurePgMigrationTable(client) {
    await client.query(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
            id TEXT PRIMARY KEY,
            description TEXT,
            applied_at TIMESTAMPTZ DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai')
        )
    `);
}

async function hasPgMigration(client, id) {
    const result = await client.query('SELECT id FROM schema_migrations WHERE id = $1', [id]);
    return result.rows.length > 0;
}

async function recordPgMigration(client, id, description = '') {
    await client.query(
        `INSERT INTO schema_migrations (id, description, applied_at)
         VALUES ($1, $2, (NOW() AT TIME ZONE 'Asia/Shanghai'))
         ON CONFLICT (id) DO NOTHING`,
        [id, description]
    );
}

async function runPgVersionedMigration(client, migration, options = {}) {
    if (!migration || !migration.id) {
        throw new Error('Invalid versioned migration: expected { id }');
    }
    const up = typeof migration.upPg === 'function' ? migration.upPg : migration.up;
    if (typeof up !== 'function') {
        throw new Error(`Invalid versioned migration ${migration.id}: expected up or upPg`);
    }
    await ensurePgMigrationTable(client);
    if (await hasPgMigration(client, migration.id)) return false;
    await client.query('BEGIN');
    try {
        await up(client, options);
        await recordPgMigration(client, migration.id, migration.description || '');
        await client.query('COMMIT');
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    }
    options.logger?.info?.({ id: migration.id }, '版本化数据库迁移已应用 [PG]');
    return true;
}

async function runPgVersionedMigrations(pool, migrations = [], options = {}) {
    const client = await pool.connect();
    try {
        await ensurePgMigrationTable(client);
        const sorted = migrations.slice().sort((a, b) => String(a.id).localeCompare(String(b.id)));
        const applied = [];
        for (const migration of sorted) {
            const wasApplied = await runPgVersionedMigration(client, migration, options);
            if (wasApplied) applied.push(migration.id);
        }
        return applied;
    } finally {
        client.release();
    }
}

module.exports = {
    // SQLite
    ensureSchemaMigrationTable,
    hasMigration,
    recordMigration,
    runVersionedMigration,
    runVersionedMigrations,
    // PostgreSQL
    ensurePgMigrationTable,
    hasPgMigration,
    recordPgMigration,
    runPgVersionedMigration,
    runPgVersionedMigrations,
};
