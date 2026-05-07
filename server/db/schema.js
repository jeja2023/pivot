const { db } = require('./connection');

function initSchema() {
    db.exec(`
        CREATE TABLE IF NOT EXISTS app_meta (
            key TEXT PRIMARY KEY,
            value TEXT,
            updated_at DATETIME
        );

        CREATE TABLE IF NOT EXISTS app_settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL,
            updated_at DATETIME,
            updated_by INTEGER,
            FOREIGN KEY (updated_by) REFERENCES users(id)
        );

        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE NOT NULL,
            password_hash TEXT NOT NULL,
            nickname TEXT,
            unit TEXT,
            role TEXT DEFAULT 'user',
            status TEXT DEFAULT 'active',
            last_login_at DATETIME,
            created_at DATETIME DEFAULT (datetime('now', '+8 hours'))
        );

        CREATE TABLE IF NOT EXISTS sessions (
            id TEXT PRIMARY KEY,
            user_id INTEGER NOT NULL,
            title TEXT,
            is_pinned INTEGER DEFAULT 0,
            is_archived INTEGER DEFAULT 0,
            tags TEXT DEFAULT '',
            system_prompt TEXT,
            created_at DATETIME DEFAULT (datetime('now', '+8 hours')),
            updated_at DATETIME DEFAULT (datetime('now', '+8 hours')),
            FOREIGN KEY (user_id) REFERENCES users(id)
        );

        CREATE TABLE IF NOT EXISTS messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id TEXT NOT NULL,
            user_id INTEGER NOT NULL,
            role TEXT NOT NULL,
            content TEXT NOT NULL,
            token_count INTEGER DEFAULT 0,
            is_summary INTEGER DEFAULT 0,
            context_archived INTEGER DEFAULT 0,
            compressed_at DATETIME,
            model_id INTEGER,
            created_at DATETIME DEFAULT (datetime('now', '+8 hours')),
            FOREIGN KEY (session_id) REFERENCES sessions(id),
            FOREIGN KEY (user_id) REFERENCES users(id)
        );

        CREATE TABLE IF NOT EXISTS models (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER,
            name TEXT NOT NULL,
            url TEXT NOT NULL,
            api_key TEXT,
            model_name TEXT,
            is_default INTEGER DEFAULT 0,
            daily_token_limit INTEGER DEFAULT 0,
            allowed_units TEXT DEFAULT '',
            status TEXT DEFAULT 'active',
            temperature REAL,
            max_tokens INTEGER,
            monitor_url TEXT,
            max_concurrent INTEGER DEFAULT 0,
            created_at DATETIME DEFAULT (datetime('now', '+8 hours')),
            FOREIGN KEY (user_id) REFERENCES users(id)
        );

        CREATE TABLE IF NOT EXISTS audit_logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER,
            action TEXT NOT NULL,
            details TEXT,
            ip_address TEXT,
            timestamp DATETIME DEFAULT (datetime('now', '+8 hours')),
            FOREIGN KEY (user_id) REFERENCES users(id)
        );

        CREATE TABLE IF NOT EXISTS knowledge_docs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER,
            name TEXT NOT NULL,
            status TEXT DEFAULT 'processing',
            created_at DATETIME DEFAULT (datetime('now', '+8 hours')),
            FOREIGN KEY (user_id) REFERENCES users(id)
        );

        CREATE TABLE IF NOT EXISTS knowledge_chunks (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            doc_id INTEGER,
            content TEXT NOT NULL,
            embedding TEXT,
            FOREIGN KEY (doc_id) REFERENCES knowledge_docs(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS attachments (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER,
            session_id TEXT,
            file_name TEXT,
            file_path TEXT,
            file_type TEXT,
            file_size INTEGER,
            access_token TEXT,
            expires_at DATETIME,
            created_at DATETIME DEFAULT (datetime('now', '+8 hours')),
            FOREIGN KEY (user_id) REFERENCES users(id),
            FOREIGN KEY (session_id) REFERENCES sessions(id)
        );

        CREATE TABLE IF NOT EXISTS prompts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            content TEXT NOT NULL,
            category TEXT,
            user_id INTEGER,
            scope TEXT DEFAULT 'global',
            created_at DATETIME DEFAULT (datetime('now', '+8 hours')),
            FOREIGN KEY (user_id) REFERENCES users(id)
        );

        CREATE TABLE IF NOT EXISTS refresh_tokens (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            token TEXT UNIQUE NOT NULL,
            expires_at DATETIME NOT NULL,
            created_at DATETIME DEFAULT (datetime('now', '+8 hours')),
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS api_keys (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            name TEXT NOT NULL,
            key_hash TEXT UNIQUE,
            key_preview TEXT,
            key TEXT,
            status TEXT DEFAULT 'active',
            usage_tokens INTEGER DEFAULT 0,
            last_used_at DATETIME,
            created_at DATETIME DEFAULT (datetime('now', '+8 hours')),
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_logs(user_id);
        CREATE INDEX IF NOT EXISTS idx_models_user ON models(user_id);
        CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
        CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);
        CREATE INDEX IF NOT EXISTS idx_messages_user ON messages(user_id);
        CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user ON refresh_tokens(user_id);
        CREATE INDEX IF NOT EXISTS idx_refresh_tokens_token ON refresh_tokens(token);
        CREATE INDEX IF NOT EXISTS idx_api_keys_user ON api_keys(user_id);
        CREATE INDEX IF NOT EXISTS idx_messages_session_user_created ON messages(session_id, user_id, created_at);
        CREATE INDEX IF NOT EXISTS idx_users_status ON users(status);
        CREATE INDEX IF NOT EXISTS idx_sessions_user_archived ON sessions(user_id, is_archived, is_pinned, created_at);
        CREATE INDEX IF NOT EXISTS idx_prompts_scope_user ON prompts(scope, user_id);
        CREATE INDEX IF NOT EXISTS idx_attachments_user_session ON attachments(user_id, session_id);
        CREATE INDEX IF NOT EXISTS idx_attachments_token ON attachments(access_token);
        CREATE INDEX IF NOT EXISTS idx_knowledge_docs_user_status ON knowledge_docs(user_id, status);
        CREATE INDEX IF NOT EXISTS idx_knowledge_chunks_doc ON knowledge_chunks(doc_id);
        CREATE INDEX IF NOT EXISTS idx_audit_logs_timestamp ON audit_logs(timestamp);

        -- 全文搜索支持 (FTS5)
        CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
            content,
            tokenize='unicode61'
        );

        -- 触发器：同步消息到全文索引
        CREATE TRIGGER IF NOT EXISTS trg_messages_insert AFTER INSERT ON messages BEGIN
            INSERT INTO messages_fts(rowid, content) VALUES (new.id, new.content);
        END;
        CREATE TRIGGER IF NOT EXISTS trg_messages_delete AFTER DELETE ON messages BEGIN
            DELETE FROM messages_fts WHERE rowid = old.id;
        END;
        CREATE TRIGGER IF NOT EXISTS trg_messages_update AFTER UPDATE ON messages WHEN old.content != new.content BEGIN
            UPDATE messages_fts SET content = new.content WHERE rowid = new.id;
        END;
    `);
}

module.exports = { initSchema };
