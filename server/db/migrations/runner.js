const { getBeijingTimestamp } = require('../../time');

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

module.exports = {
    ensureSchemaMigrationTable,
    hasMigration,
    recordMigration,
    runVersionedMigration,
    runVersionedMigrations
};
