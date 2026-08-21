/**
 * server/db/migrations/runner.js
 * 版本化迁移执行器（PostgreSQL + legacy SQLite test helpers）
 */
const { getBeijingTimestamp } = require('../../time');

// ── Legacy SQLite helpers ─────────────────────────────────────────────────

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
        throw new Error('无效的版本化迁移配置：缺少 id 或 up 函数');
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
        .filter(migration => typeof migration?.up === 'function')
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
        throw new Error('无效的版本化迁移配置：缺少 id 标识');
    }
    const up = typeof migration.upPg === 'function' ? migration.upPg : migration.up;
    if (typeof up !== 'function') {
        throw new Error(`版本化迁移 [${migration.id}] 无效：缺少 up 或 upPg 执行函数`);
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
