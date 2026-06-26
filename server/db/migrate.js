const { db } = require('./connection');
const { logger } = require('../logger');
const legacyMigrations = require('./migrations/legacy');
const versionedMigrations = require('./migrations');
const {
    ensureSchemaMigrationTable,
    hasMigration: hasVersionedMigration,
    recordMigration: recordVersionedMigration,
    runVersionedMigrations
} = require('./migrations/runner');

function recordMigration(key, value = 'done') {
    return legacyMigrations.recordMigration(key, value);
}

function ensureMigrationTable() {
    ensureSchemaMigrationTable(db);
}


function recordSchemaMigration(id, description = '') {
    ensureMigrationTable();
    recordVersionedMigration(db, id, description);
    recordMigration(id);
}

function runSchemaMigration(id, description, fn) {
    ensureMigrationTable();
    if (hasVersionedMigration(db, id)) return false;
    const migrate = db.transaction(() => {
        fn(db);
        recordVersionedMigration(db, id, description || '');
        recordMigration(id);
    });
    migrate();
    logger.info({ id }, '版本化数据库迁移已应用');
    return true;
}

function runMigrations() {
    ensureMigrationTable();
    legacyMigrations.runMigrations();
    const applied = runVersionedMigrations(db, versionedMigrations, { logger });
    applied.forEach(id => recordMigration(id));
    return applied;
}

module.exports = {
    runMigrations,
    recordMigration,
    recordSchemaMigration,
    runSchemaMigration
};
