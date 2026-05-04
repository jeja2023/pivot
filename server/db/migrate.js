const { db } = require('./connection');
const logger = require('../logger');
const { getBeijingTimestamp } = require('../time');

const ensureColumn = (table, column, definition) => {
    try {
        const columns = db.prepare(`PRAGMA table_info(${table})`).all();
        if (!columns.some(col => col.name === column)) {
            db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
            logger.info({ table, column }, '数据库升级：已补全字段');
        }
    } catch (e) {
        logger.error({ table, column, err: e.message }, '数据库升级失败');
    }
};

const recordMigration = (key, value = 'done') => {
    db.prepare('INSERT OR REPLACE INTO app_meta (key, value, updated_at) VALUES (?, ?, ?)')
      .run(key, value, getBeijingTimestamp());
};

function runMigrations() {
    ensureColumn('users', 'nickname', 'TEXT');
    ensureColumn('users', 'unit', 'TEXT');
    ensureColumn('users', 'default_model_id', 'INTEGER');
    ensureColumn('users', 'status', "TEXT DEFAULT 'active'");
    ensureColumn('users', 'last_login_at', 'DATETIME');
    ensureColumn('audit_logs', 'ip_address', 'TEXT');
    ensureColumn('messages', 'model_id', 'INTEGER');
    ensureColumn('messages', 'cost_time', 'REAL');
    ensureColumn('messages', 'tokens_per_sec', 'REAL');
    ensureColumn('attachments', 'access_token', 'TEXT');
    ensureColumn('models', 'daily_token_limit', 'INTEGER DEFAULT 0');
    ensureColumn('models', 'allowed_units', "TEXT DEFAULT ''");
    ensureColumn('models', 'status', "TEXT DEFAULT 'active'");
    ensureColumn('models', 'created_at', "DATETIME");
    db.prepare('UPDATE models SET created_at = ? WHERE created_at IS NULL').run(getBeijingTimestamp());
    ensureColumn('sessions', 'is_pinned', 'INTEGER DEFAULT 0');
    ensureColumn('sessions', 'system_prompt', 'TEXT');
    ensureColumn('sessions', 'is_archived', 'INTEGER DEFAULT 0');
    ensureColumn('sessions', 'tags', "TEXT DEFAULT ''");
    ensureColumn('sessions', 'updated_at', 'DATETIME');
    db.prepare('UPDATE sessions SET updated_at = created_at WHERE updated_at IS NULL').run();
    ensureColumn('app_settings', 'updated_at', 'DATETIME');
    ensureColumn('app_settings', 'updated_by', 'INTEGER');

    ensureColumn('prompts', 'user_id', 'INTEGER');
    ensureColumn('prompts', 'scope', "TEXT DEFAULT 'global'");
    ensureColumn('prompts', 'created_at', 'DATETIME');
    db.prepare('UPDATE prompts SET created_at = ? WHERE created_at IS NULL').run(getBeijingTimestamp());

    // --- 历史时间迁移：旧版本表默认 CURRENT_TIMESTAMP，实际存储 UTC，需要补正为东八区 ---
    const timeMigrationKey = 'utc_timestamp_migrated_to_beijing_v1';
    const timeMigration = db.prepare('SELECT value FROM app_meta WHERE key = ?').get(timeMigrationKey);
    if (!timeMigration) {
        const migrateTime = db.transaction(() => {
            db.prepare("UPDATE users SET created_at = datetime(created_at, '+8 hours') WHERE created_at IS NOT NULL").run();
            db.prepare("UPDATE sessions SET created_at = datetime(created_at, '+8 hours') WHERE created_at IS NOT NULL").run();
            db.prepare("UPDATE messages SET created_at = datetime(created_at, '+8 hours') WHERE created_at IS NOT NULL").run();
            db.prepare("UPDATE audit_logs SET timestamp = datetime(timestamp, '+8 hours') WHERE timestamp IS NOT NULL").run();
            db.prepare("UPDATE attachments SET created_at = datetime(created_at, '+8 hours') WHERE created_at IS NOT NULL").run();
            db.prepare("UPDATE knowledge_docs SET created_at = datetime(created_at, '+8 hours') WHERE created_at IS NOT NULL").run();
            db.prepare('INSERT INTO app_meta (key, value, updated_at) VALUES (?, ?, ?)')
              .run(timeMigrationKey, 'done', getBeijingTimestamp());
        });
        migrateTime();
        logger.info('数据库升级：已将历史 UTC 时间补正为东八区时间');
    }
}

module.exports = { runMigrations, recordMigration };
