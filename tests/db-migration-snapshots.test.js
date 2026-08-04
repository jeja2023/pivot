const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const Sqlite = require('better-sqlite3');

const migrations = require('../server/db/migrations');
const { runVersionedMigrations } = require('../server/db/migrations/runner');

const migrationId = '202606260001_rag_search_content_backfill';
const deletedUsernameMigrationId = '202607150001_release_deleted_usernames';
const refreshTokenMigrationId = '202607310001_hash_refresh_tokens';
const sampleText = 'alpha \u4e2d\u6587 \u68c0\u7d22';
const legacyText = 'legacy \u4e2d\u6587 \u5206\u5757';

function removeDir(dir) {
    try {
        fs.rmSync(dir, { recursive: true, force: true });
    } catch (e) {
        if (!['EBUSY', 'ENOTEMPTY', 'EPERM'].includes(e.code)) throw e;
    }
}

function clearServerDbModules() {
    Object.keys(require.cache).forEach(key => {
        const normalized = key.replace(/\\/g, '/');
        if (
            normalized.includes('/server/db/')
            || normalized.endsWith('/server/db.js')
            || normalized.endsWith('/server/services/app-settings.js')
        ) {
            delete require.cache[key];
        }
    });
}

test('versioned migrations upgrade legacy RAG chunk snapshots idempotently', () => {
    const db = new Sqlite(':memory:');
    try {
        db.exec(`
            CREATE TABLE app_meta (key TEXT PRIMARY KEY, value TEXT, updated_at DATETIME);
            CREATE TABLE knowledge_chunks (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                doc_id INTEGER,
                content TEXT
            );
        `);
        db.prepare('INSERT INTO knowledge_chunks (doc_id, content) VALUES (?, ?)').run(1, sampleText);

        const applied = runVersionedMigrations(db, migrations);
        assert.ok(applied.includes(migrationId));

        const columns = db.prepare('PRAGMA table_info(knowledge_chunks)').all().map(col => col.name);
        assert.ok(columns.includes('search_content'));
        const row = db.prepare('SELECT search_content FROM knowledge_chunks WHERE id = 1').get();
        assert.match(row.search_content, /alpha/);
        assert.match(row.search_content, /\u4e2d\u6587/);
        assert.equal(db.prepare('SELECT COUNT(*) AS count FROM knowledge_chunks_fts').get().count, 1);
        assert.ok(db.prepare('SELECT id FROM schema_migrations WHERE id = ?').get(migrationId));

        const secondRun = runVersionedMigrations(db, migrations);
        assert.deepEqual(secondRun, []);
        assert.equal(db.prepare('SELECT COUNT(*) AS count FROM knowledge_chunks_fts').get().count, 1);
    } finally {
        db.close();
    }
});

test('deleted username migration preserves history and releases the unique username', () => {
    const db = new Sqlite(':memory:');
    try {
        db.exec(`
            CREATE TABLE users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT UNIQUE NOT NULL,
                password_hash TEXT NOT NULL,
                status TEXT DEFAULT 'active',
                deleted_at DATETIME
            );
        `);
        const deleted = db.prepare(`
            INSERT INTO users (username, password_hash, status, deleted_at)
            VALUES (?, 'hash', 'disabled', '2026-07-15 10:00:00')
        `).run('reusable_name');
        db.prepare(`
            INSERT INTO users (username, password_hash, status)
            VALUES (?, 'hash', 'active')
        `).run('active_name');

        const migration = migrations.find(item => item.id === deletedUsernameMigrationId);
        assert.ok(migration);
        assert.deepEqual(runVersionedMigrations(db, [migration]), [deletedUsernameMigrationId]);

        const columns = db.prepare('PRAGMA table_info(users)').all().map(column => column.name);
        assert.ok(columns.includes('deleted_username'));
        const archived = db.prepare('SELECT username, deleted_username FROM users WHERE id = ?')
            .get(deleted.lastInsertRowid);
        assert.match(archived.username, /^@deleted:/);
        assert.equal(archived.deleted_username, 'reusable_name');
        assert.equal(db.prepare('SELECT username FROM users WHERE username = ?').get('active_name').username, 'active_name');

        assert.doesNotThrow(() => {
            db.prepare(`
                INSERT INTO users (username, password_hash, status)
                VALUES (?, 'new-hash', 'active')
            `).run('reusable_name');
        });
        assert.deepEqual(runVersionedMigrations(db, [migration]), []);
    } finally {
        db.close();
    }
});

test('database boot path upgrades a legacy sqlite snapshot through versioned migrations', () => {
    const previousDataDir = process.env.DATA_DIR;
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pivot-migration-snapshot-'));
    const dbPath = path.join(dataDir, 'chat.db');
    const legacyDb = new Sqlite(dbPath);
    legacyDb.exec(`
        PRAGMA foreign_keys = OFF;
        CREATE TABLE app_meta (key TEXT PRIMARY KEY, value TEXT, updated_at DATETIME);
        CREATE TABLE users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE NOT NULL,
            password_hash TEXT NOT NULL,
            role TEXT DEFAULT 'user',
            created_at DATETIME
        );
        CREATE TABLE sessions (
            id TEXT PRIMARY KEY,
            user_id INTEGER NOT NULL,
            title TEXT,
            created_at DATETIME
        );
        CREATE TABLE messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id TEXT NOT NULL,
            user_id INTEGER NOT NULL,
            role TEXT NOT NULL,
            content TEXT NOT NULL,
            created_at DATETIME
        );
        CREATE TABLE knowledge_docs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER,
            name TEXT NOT NULL,
            status TEXT DEFAULT 'ready',
            created_at DATETIME
        );
        CREATE TABLE knowledge_chunks (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            doc_id INTEGER,
            content TEXT NOT NULL
        );
        INSERT INTO users (username, password_hash, role, created_at) VALUES ('legacy', 'hash', 'user', '2024-01-01 00:00:00');
        INSERT INTO knowledge_docs (id, user_id, name, status, created_at) VALUES (1, 1, 'legacy-doc', 'ready', '2024-01-01 00:00:00');
    `);
    legacyDb.prepare('INSERT INTO knowledge_chunks (doc_id, content) VALUES (?, ?)').run(1, legacyText);
    legacyDb.close();

    try {
        process.env.DATA_DIR = dataDir;
        clearServerDbModules();
        const booted = require('../server/db');
        const row = booted.db.prepare('SELECT search_content FROM knowledge_chunks WHERE id = 1').get();
        assert.match(row.search_content, /legacy/);
        assert.match(row.search_content, /\u4e2d\u6587/);
        assert.ok(booted.db.prepare('SELECT id FROM schema_migrations WHERE id = ?').get(migrationId));
        assert.equal(booted.db.prepare('SELECT COUNT(*) AS count FROM knowledge_chunks_fts').get().count, 1);
        booted.db.close();
    } finally {
        clearServerDbModules();
        if (previousDataDir === undefined) delete process.env.DATA_DIR;
        else process.env.DATA_DIR = previousDataDir;
        removeDir(dataDir);
    }
});

test('database boot migrates legacy automation columns before creating dependent indexes', () => {
    const previousDataDir = process.env.DATA_DIR;
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pivot-automation-migration-'));
    const dbPath = path.join(dataDir, 'chat.db');
    const legacyDb = new Sqlite(dbPath);
    legacyDb.exec(`
        CREATE TABLE app_meta (key TEXT PRIMARY KEY, value TEXT, updated_at DATETIME);
        CREATE TABLE users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE NOT NULL,
            password_hash TEXT NOT NULL,
            role TEXT DEFAULT 'user',
            created_at DATETIME
        );
        CREATE TABLE agent_runs (
            id TEXT PRIMARY KEY,
            user_id INTEGER NOT NULL,
            goal TEXT NOT NULL,
            status TEXT DEFAULT 'queued',
            created_at DATETIME
        );
        CREATE TABLE agent_schedules (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            name TEXT NOT NULL,
            goal TEXT NOT NULL,
            status TEXT DEFAULT 'active',
            next_run_at DATETIME,
            deleted_at DATETIME
        );
    `);
    legacyDb.close();

    try {
        process.env.DATA_DIR = dataDir;
        clearServerDbModules();
        const booted = require('../server/db');
        const runColumns = booted.db.prepare('PRAGMA table_info(agent_runs)').all().map(column => column.name);
        const scheduleColumns = booted.db.prepare('PRAGMA table_info(agent_schedules)').all().map(column => column.name);
        const runIndexes = booted.db.prepare('PRAGMA index_list(agent_runs)').all().map(index => index.name);
        const scheduleIndexes = booted.db.prepare('PRAGMA index_list(agent_schedules)').all().map(index => index.name);

        assert.ok(runColumns.includes('dedupe_key'));
        assert.ok(scheduleColumns.includes('claim_token'));
        assert.ok(scheduleColumns.includes('dispatch_retry_at'));
        assert.ok(scheduleColumns.includes('last_error'));
        assert.ok(runIndexes.includes('idx_agent_runs_user_dedupe'));
        assert.ok(scheduleIndexes.includes('idx_agent_schedules_dispatch'));
        booted.db.close();
    } finally {
        clearServerDbModules();
        if (previousDataDir === undefined) delete process.env.DATA_DIR;
        else process.env.DATA_DIR = previousDataDir;
        removeDir(dataDir);
    }
});

test('refresh token migration hashes legacy plaintext values and is idempotent', () => {
    const db = new Sqlite(':memory:');
    try {
        db.exec(`
            CREATE TABLE refresh_tokens (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                token TEXT UNIQUE NOT NULL
            );
        `);
        const legacyToken = 'a'.repeat(80);
        const hashedToken = 'b'.repeat(64);
        db.prepare('INSERT INTO refresh_tokens (token) VALUES (?)').run(legacyToken);
        db.prepare('INSERT INTO refresh_tokens (token) VALUES (?)').run(hashedToken);

        const migration = migrations.find(item => item.id === refreshTokenMigrationId);
        assert.ok(migration);
        assert.deepEqual(runVersionedMigrations(db, [migration]), [refreshTokenMigrationId]);
        const rows = db.prepare('SELECT token FROM refresh_tokens ORDER BY id').all();
        assert.equal(rows[0].token, crypto.createHash('sha256').update(legacyToken).digest('hex'));
        assert.equal(rows[1].token, hashedToken);
        assert.deepEqual(runVersionedMigrations(db, [migration]), []);
    } finally {
        db.close();
    }
});
