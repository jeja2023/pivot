const { db } = require('./connection');
const logger = require('../logger');
const { getBeijingTimestamp } = require('../time');
const crypto = require('crypto');
const { buildRagSearchContent } = require('../services/rag-tokenizer');

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

const hashApiKey = (key) => crypto.createHash('sha256').update(String(key || '')).digest('hex');
const previewApiKey = (key) => {
    const text = String(key || '');
    if (!text) return '';
    return `${text.slice(0, 8)}...${text.slice(-4)}`;
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
    ensureColumn('messages', 'context_archived', 'INTEGER DEFAULT 0');
    ensureColumn('messages', 'compressed_at', 'DATETIME');
    db.prepare('UPDATE messages SET context_archived = 0 WHERE context_archived IS NULL').run();
    ensureColumn('attachments', 'access_token', 'TEXT');
    ensureColumn('attachments', 'expires_at', 'DATETIME');
    const attachmentsToUpdate = db.prepare("SELECT id, created_at FROM attachments WHERE access_token IS NULL OR access_token = '' OR expires_at IS NULL").all();
    if (attachmentsToUpdate.length > 0) {
        const updateAttachmentToken = db.prepare("UPDATE attachments SET access_token = ?, expires_at = datetime(?, '+30 days') WHERE id = ?");
        const backfill = db.transaction(() => {
            attachmentsToUpdate.forEach(row => {
                const token = crypto.randomBytes(24).toString('base64url');
                const baseTime = row.created_at || getBeijingTimestamp();
                updateAttachmentToken.run(token, baseTime, row.id);
            });
        });
        backfill();
        logger.info({ count: attachmentsToUpdate.length }, '数据库升级：已为历史附件补充访问令牌及过期时间 (30天)');
    }
    ensureColumn('models', 'daily_token_limit', 'INTEGER DEFAULT 0');
    ensureColumn('models', 'allowed_units', "TEXT DEFAULT ''");
    ensureColumn('models', 'status', "TEXT DEFAULT 'active'");
    ensureColumn('models', 'temperature', 'REAL');
    ensureColumn('models', 'max_tokens', 'INTEGER');
    ensureColumn('models', 'monitor_url', 'TEXT');
    ensureColumn('models', 'max_concurrent', 'INTEGER DEFAULT 0');
    ensureColumn('models', 'supports_vision', 'INTEGER DEFAULT 0');
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
    ensureColumn('knowledge_chunks', 'search_content', 'TEXT');

    ensureColumn('prompts', 'user_id', 'INTEGER');
    ensureColumn('prompts', 'scope', "TEXT DEFAULT 'global'");
    ensureColumn('prompts', 'created_at', 'DATETIME');
    db.prepare('UPDATE prompts SET created_at = ? WHERE created_at IS NULL').run(getBeijingTimestamp());

    db.exec(`
        CREATE TABLE IF NOT EXISTS api_keys (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            name TEXT NOT NULL,
            key_hash TEXT UNIQUE,
            key_preview TEXT,
            key TEXT,
            status TEXT DEFAULT 'active',
            last_used_at DATETIME,
            created_at DATETIME DEFAULT (datetime('now', '+8 hours')),
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        );
    `);
    ensureColumn('api_keys', 'key_hash', 'TEXT');
    ensureColumn('api_keys', 'key_preview', 'TEXT');
    ensureColumn('api_keys', 'key', 'TEXT');
    ensureColumn('api_keys', 'status', "TEXT DEFAULT 'active'");
    ensureColumn('api_keys', 'usage_tokens', "INTEGER DEFAULT 0");
    ensureColumn('api_keys', 'last_used_at', 'DATETIME');
    ensureColumn('api_keys', 'created_at', 'DATETIME');

    db.exec(`
        CREATE TABLE IF NOT EXISTS model_usage_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            model_id INTEGER NOT NULL,
            source TEXT DEFAULT 'api',
            token_count INTEGER DEFAULT 0,
            created_at DATETIME DEFAULT (datetime('now', '+8 hours')),
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
            FOREIGN KEY (model_id) REFERENCES models(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_model_usage_user_model_created ON model_usage_events(user_id, model_id, created_at);
    `);

    // 确保字段存在后再创建索引
    try {
        db.exec("CREATE INDEX IF NOT EXISTS idx_api_keys_user ON api_keys(user_id)");
        db.exec("CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys(key_hash)");
    } catch (e) {
        logger.warn('API Key 索引创建失败 (可能字段尚未生效)');
    }
    db.prepare('UPDATE api_keys SET created_at = ? WHERE created_at IS NULL').run(getBeijingTimestamp());

    const legacyKeys = db.prepare("SELECT id, key FROM api_keys WHERE key IS NOT NULL AND key != '' AND (key_hash IS NULL OR key_hash = '')").all();
    if (legacyKeys.length > 0) {
        const migrateKey = db.prepare('UPDATE api_keys SET key_hash = ?, key_preview = ?, key = NULL WHERE id = ?');
        const migrateLegacyKeys = db.transaction(() => {
            legacyKeys.forEach(row => migrateKey.run(hashApiKey(row.key), previewApiKey(row.key), row.id));
        });
        migrateLegacyKeys();
        logger.info({ count: legacyKeys.length }, 'API Key 存储升级：已将明文密钥迁移为哈希');
    }

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

    // --- 全文搜索索引初始化 ---
    try {
        db.exec(`
            DROP TRIGGER IF EXISTS trg_knowledge_chunks_insert;
            DROP TRIGGER IF EXISTS trg_knowledge_chunks_delete;
            DROP TRIGGER IF EXISTS trg_knowledge_chunks_update;
            CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_chunks_fts USING fts5(
                content,
                tokenize='unicode61'
            );
            CREATE TRIGGER IF NOT EXISTS trg_knowledge_chunks_insert AFTER INSERT ON knowledge_chunks BEGIN
                INSERT INTO knowledge_chunks_fts(rowid, content) VALUES (new.id, COALESCE(new.search_content, new.content));
            END;
            CREATE TRIGGER IF NOT EXISTS trg_knowledge_chunks_delete AFTER DELETE ON knowledge_chunks BEGIN
                DELETE FROM knowledge_chunks_fts WHERE rowid = old.id;
            END;
            CREATE TRIGGER IF NOT EXISTS trg_knowledge_chunks_update AFTER UPDATE ON knowledge_chunks
            WHEN old.content != new.content OR COALESCE(old.search_content, '') != COALESCE(new.search_content, '') BEGIN
                UPDATE knowledge_chunks_fts SET content = COALESCE(new.search_content, new.content) WHERE rowid = new.id;
            END;
        `);
        const ragTokenizerMigrationKey = 'rag_cjk_search_content_v1';
        const ragTokenizerMigration = db.prepare('SELECT value FROM app_meta WHERE key = ?').get(ragTokenizerMigrationKey);
        const chunksMissingSearchContent = db.prepare(`
            SELECT id, content FROM knowledge_chunks
            WHERE search_content IS NULL OR search_content = ''
        `).all();
        if (chunksMissingSearchContent.length > 0) {
            const updateSearchContent = db.prepare('UPDATE knowledge_chunks SET search_content = ? WHERE id = ?');
            const backfillSearchContent = db.transaction(() => {
                chunksMissingSearchContent.forEach(row => {
                    updateSearchContent.run(buildRagSearchContent(row.content), row.id);
                });
            });
            backfillSearchContent();
            logger.info({ count: chunksMissingSearchContent.length }, 'RAG search content backfilled with CJK ngrams.');
        }

        const ragFtsCount = db.prepare('SELECT COUNT(*) as count FROM knowledge_chunks_fts').get().count;
        const chunkCount = db.prepare('SELECT COUNT(*) as count FROM knowledge_chunks').get().count;
        if (!ragTokenizerMigration || ragFtsCount === 0) {
            db.exec('DELETE FROM knowledge_chunks_fts');
            if (chunkCount > 0) {
                db.exec('INSERT INTO knowledge_chunks_fts(rowid, content) SELECT id, COALESCE(search_content, content) FROM knowledge_chunks');
                logger.info({ count: chunkCount }, 'RAG FTS index rebuilt with CJK ngrams.');
            }
            recordMigration(ragTokenizerMigrationKey);
        }

        const ftsCount = db.prepare('SELECT COUNT(*) as count FROM messages_fts').get().count;
        if (ftsCount === 0) {
            const msgCount = db.prepare('SELECT COUNT(*) as count FROM messages').get().count;
            if (msgCount > 0) {
                db.exec('INSERT INTO messages_fts(rowid, content) SELECT id, content FROM messages');
                logger.info({ count: msgCount }, '数据库升级：全文搜索索引初始化完成');
            }
        }
    } catch (e) {
        logger.error({ err: e.message }, '全文搜索索引初始化失败');
    }
}

module.exports = { runMigrations, recordMigration };
