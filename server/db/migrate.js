const { db } = require('./connection');
const { logger } = require('../logger');
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

const ensureMigrationTable = () => {
    db.exec(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
            id TEXT PRIMARY KEY,
            description TEXT,
            applied_at DATETIME DEFAULT (datetime('now', '+8 hours'))
        );
    `);
};

const hasSchemaMigration = (id) => Boolean(db.prepare('SELECT id FROM schema_migrations WHERE id = ?').get(id));

const recordSchemaMigration = (id, description = '') => {
    db.prepare(`
        INSERT OR IGNORE INTO schema_migrations (id, description, applied_at)
        VALUES (?, ?, ?)
    `).run(id, description, getBeijingTimestamp());
    recordMigration(id);
};

const runSchemaMigration = (id, description, fn) => {
    if (hasSchemaMigration(id)) return false;
    const migrate = db.transaction(() => {
        fn();
        recordSchemaMigration(id, description);
    });
    migrate();
    logger.info({ id }, 'Schema migration applied');
    return true;
};

const hashApiKey = (key) => crypto.createHash('sha256').update(String(key || '')).digest('hex');
const previewApiKey = (key) => {
    const text = String(key || '');
    if (!text) return '';
    return `${text.slice(0, 8)}...${text.slice(-4)}`;
};

function runMigrations() {
    ensureMigrationTable();
    // Historical compatibility migrations stay idempotent because LAN deployments
    // may upgrade from different SQLite snapshots. New schema changes should use
    // runSchemaMigration(...) with a stable id instead of extending this block.
    ensureColumn('users', 'nickname', 'TEXT');
    ensureColumn('users', 'unit', 'TEXT');
    ensureColumn('users', 'default_model_id', 'INTEGER');
    ensureColumn('users', 'status', "TEXT DEFAULT 'active'");
    ensureColumn('users', 'deleted_at', 'DATETIME');
    ensureColumn('users', 'deleted_by_admin', 'INTEGER DEFAULT 0');
    ensureColumn('users', 'last_login_at', 'DATETIME');
    ensureColumn('audit_logs', 'ip_address', 'TEXT');
    ensureColumn('messages', 'model_id', 'INTEGER');
    ensureColumn('messages', 'cost_time', 'REAL');
    ensureColumn('messages', 'tokens_per_sec', 'REAL');
    ensureColumn('messages', 'context_archived', 'INTEGER DEFAULT 0');
    ensureColumn('messages', 'compressed_at', 'DATETIME');
    ensureColumn('messages', 'deleted_at', 'DATETIME');
    ensureColumn('messages', 'deleted_by_user', 'INTEGER DEFAULT 0');
    db.prepare('UPDATE messages SET context_archived = 0 WHERE context_archived IS NULL').run();
    ensureColumn('attachments', 'access_token', 'TEXT');
    ensureColumn('attachments', 'expires_at', 'DATETIME');
    ensureColumn('attachments', 'deleted_at', 'DATETIME');
    ensureColumn('attachments', 'deleted_by_user', 'INTEGER DEFAULT 0');
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
    ensureColumn('models', 'max_input_tokens', 'INTEGER');
    ensureColumn('models', 'max_tokens', 'INTEGER');
    ensureColumn('models', 'monitor_url', 'TEXT');
    ensureColumn('models', 'max_concurrent', 'INTEGER DEFAULT 0');
    ensureColumn('models', 'supports_vision', 'INTEGER DEFAULT 0');
    ensureColumn('models', 'supports_reasoning', 'INTEGER DEFAULT 0');
    ensureColumn('models', 'input_price_per_million', 'REAL DEFAULT 0');
    ensureColumn('models', 'output_price_per_million', 'REAL DEFAULT 0');
    ensureColumn('models', 'price_currency', "TEXT DEFAULT 'CNY'");
    ensureColumn('models', 'created_at', "DATETIME");
    db.prepare('UPDATE models SET created_at = ? WHERE created_at IS NULL').run(getBeijingTimestamp());
    ensureColumn('sessions', 'is_pinned', 'INTEGER DEFAULT 0');
    ensureColumn('sessions', 'system_prompt', 'TEXT');
    ensureColumn('sessions', 'is_archived', 'INTEGER DEFAULT 0');
    ensureColumn('sessions', 'tags', "TEXT DEFAULT ''");
    ensureColumn('sessions', 'updated_at', 'DATETIME');
    ensureColumn('sessions', 'deleted_at', 'DATETIME');
    ensureColumn('sessions', 'deleted_by_user', 'INTEGER DEFAULT 0');
    ensureColumn('sessions', 'parent_session_id', 'TEXT');
    ensureColumn('sessions', 'forked_from_message_id', 'INTEGER');
    ensureColumn('sessions', 'fork_root_session_id', 'TEXT');
    ensureColumn('sessions', 'fork_note', 'TEXT');
    db.prepare('UPDATE sessions SET updated_at = created_at WHERE updated_at IS NULL').run();
    db.exec(`
        CREATE INDEX IF NOT EXISTS idx_users_deleted ON users(deleted_at);
        CREATE INDEX IF NOT EXISTS idx_sessions_user_deleted ON sessions(user_id, deleted_at);
        CREATE INDEX IF NOT EXISTS idx_messages_session_deleted ON messages(session_id, user_id, deleted_at);
        CREATE INDEX IF NOT EXISTS idx_attachments_user_deleted ON attachments(user_id, deleted_at);
    `);
    ensureColumn('app_settings', 'updated_at', 'DATETIME');
    ensureColumn('app_settings', 'updated_by', 'INTEGER');
    db.exec(`
        CREATE TABLE IF NOT EXISTS user_settings (
            user_id INTEGER NOT NULL,
            key TEXT NOT NULL,
            value TEXT NOT NULL,
            updated_at DATETIME,
            PRIMARY KEY (user_id, key),
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_user_settings_user_key ON user_settings(user_id, key);
    `);
    db.prepare("UPDATE app_settings SET value = 'http' WHERE key = 'rag_embedding_mode' AND value != 'http'").run();
    db.prepare("DELETE FROM app_settings WHERE key = 'rag_embedding_model_path'").run();
    ensureColumn('knowledge_docs', 'chunk_count', 'INTEGER DEFAULT 0');
    ensureColumn('knowledge_docs', 'indexed_chunks', 'INTEGER DEFAULT 0');
    ensureColumn('knowledge_docs', 'progress', 'INTEGER DEFAULT 0');
    ensureColumn('knowledge_docs', 'error_message', 'TEXT');
    ensureColumn('knowledge_docs', 'processed_at', 'DATETIME');
    ensureColumn('knowledge_docs', 'updated_at', 'DATETIME');
    ensureColumn('knowledge_docs', 'source_path', 'TEXT');
    ensureColumn('knowledge_docs', 'source_size', 'INTEGER DEFAULT 0');
    ensureColumn('knowledge_docs', 'is_enabled', 'INTEGER DEFAULT 1');
    ensureColumn('knowledge_docs', 'deleted_at', 'DATETIME');
    ensureColumn('knowledge_docs', 'deleted_by_user', 'INTEGER DEFAULT 0');
    db.prepare('UPDATE knowledge_docs SET updated_at = created_at WHERE updated_at IS NULL').run();
    db.prepare("UPDATE knowledge_docs SET progress = CASE WHEN status = 'ready' THEN 100 WHEN status = 'error' THEN 0 ELSE COALESCE(progress, 0) END WHERE progress IS NULL OR progress = 0").run();
    db.prepare('UPDATE knowledge_docs SET indexed_chunks = chunk_count WHERE indexed_chunks IS NULL OR indexed_chunks = 0').run();
    ensureColumn('knowledge_chunks', 'search_content', 'TEXT');
    db.exec(`
        CREATE TABLE IF NOT EXISTS rag_feedback (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            query TEXT NOT NULL,
            chunk_id INTEGER,
            doc_name TEXT,
            score REAL,
            helpful INTEGER NOT NULL,
            note TEXT,
            created_at DATETIME DEFAULT (datetime('now', '+8 hours')),
            FOREIGN KEY (user_id) REFERENCES users(id),
            FOREIGN KEY (chunk_id) REFERENCES knowledge_chunks(id) ON DELETE SET NULL
        );
        CREATE INDEX IF NOT EXISTS idx_rag_feedback_user_created ON rag_feedback(user_id, created_at);
        CREATE INDEX IF NOT EXISTS idx_knowledge_docs_user_enabled ON knowledge_docs(user_id, is_enabled, status);
        CREATE INDEX IF NOT EXISTS idx_knowledge_docs_deleted ON knowledge_docs(deleted_at);
    `);
    db.exec(`
        CREATE TABLE IF NOT EXISTS knowledge_entities (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            name TEXT NOT NULL,
            normalized_name TEXT NOT NULL,
            type TEXT DEFAULT 'concept',
            description TEXT DEFAULT '',
            aliases TEXT DEFAULT '[]',
            confidence REAL DEFAULT 0.7,
            source_doc_id INTEGER,
            created_at DATETIME DEFAULT (datetime('now', '+8 hours')),
            updated_at DATETIME DEFAULT (datetime('now', '+8 hours')),
            deleted_at DATETIME,
            UNIQUE(user_id, normalized_name),
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
            FOREIGN KEY (source_doc_id) REFERENCES knowledge_docs(id) ON DELETE SET NULL
        );
        CREATE TABLE IF NOT EXISTS knowledge_entity_mentions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            entity_id INTEGER NOT NULL,
            doc_id INTEGER,
            chunk_id INTEGER,
            snippet TEXT DEFAULT '',
            created_at DATETIME DEFAULT (datetime('now', '+8 hours')),
            UNIQUE(entity_id, chunk_id),
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
            FOREIGN KEY (entity_id) REFERENCES knowledge_entities(id) ON DELETE CASCADE,
            FOREIGN KEY (doc_id) REFERENCES knowledge_docs(id) ON DELETE CASCADE,
            FOREIGN KEY (chunk_id) REFERENCES knowledge_chunks(id) ON DELETE CASCADE
        );
        CREATE TABLE IF NOT EXISTS knowledge_relations (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            source_entity_id INTEGER NOT NULL,
            target_entity_id INTEGER NOT NULL,
            relation_type TEXT DEFAULT 'related_to',
            description TEXT DEFAULT '',
            confidence REAL DEFAULT 0.6,
            source_doc_id INTEGER,
            source_chunk_id INTEGER,
            status TEXT DEFAULT 'active',
            created_at DATETIME DEFAULT (datetime('now', '+8 hours')),
            updated_at DATETIME DEFAULT (datetime('now', '+8 hours')),
            UNIQUE(user_id, source_entity_id, target_entity_id, relation_type, source_chunk_id),
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
            FOREIGN KEY (source_entity_id) REFERENCES knowledge_entities(id) ON DELETE CASCADE,
            FOREIGN KEY (target_entity_id) REFERENCES knowledge_entities(id) ON DELETE CASCADE,
            FOREIGN KEY (source_doc_id) REFERENCES knowledge_docs(id) ON DELETE CASCADE,
            FOREIGN KEY (source_chunk_id) REFERENCES knowledge_chunks(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_knowledge_entities_user_type ON knowledge_entities(user_id, type, deleted_at);
        CREATE INDEX IF NOT EXISTS idx_knowledge_entities_user_name ON knowledge_entities(user_id, normalized_name);
        CREATE INDEX IF NOT EXISTS idx_knowledge_mentions_entity ON knowledge_entity_mentions(entity_id, doc_id);
        CREATE INDEX IF NOT EXISTS idx_knowledge_mentions_chunk ON knowledge_entity_mentions(chunk_id);
        CREATE INDEX IF NOT EXISTS idx_knowledge_relations_user_source ON knowledge_relations(user_id, source_entity_id, status);
        CREATE INDEX IF NOT EXISTS idx_knowledge_relations_user_target ON knowledge_relations(user_id, target_entity_id, status);
        CREATE INDEX IF NOT EXISTS idx_knowledge_relations_chunk ON knowledge_relations(source_chunk_id);
    `);

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
    ensureColumn('api_keys', 'input_tokens', "INTEGER DEFAULT 0");
    ensureColumn('api_keys', 'output_tokens', "INTEGER DEFAULT 0");
    ensureColumn('api_keys', 'last_used_at', 'DATETIME');
    ensureColumn('api_keys', 'created_at', 'DATETIME');

    db.exec(`
        CREATE TABLE IF NOT EXISTS model_usage_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            model_id INTEGER NOT NULL,
            source TEXT DEFAULT 'api',
            token_count INTEGER DEFAULT 0,
            input_tokens INTEGER DEFAULT 0,
            output_tokens INTEGER DEFAULT 0,
            created_at DATETIME DEFAULT (datetime('now', '+8 hours')),
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
            FOREIGN KEY (model_id) REFERENCES models(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_model_usage_user_model_created ON model_usage_events(user_id, model_id, created_at);
    `);
    ensureColumn('model_usage_events', 'input_tokens', "INTEGER DEFAULT 0");
    ensureColumn('model_usage_events', 'output_tokens', "INTEGER DEFAULT 0");

    // 确保字段存在后再创建索引
    db.exec(`
        CREATE TABLE IF NOT EXISTS api_call_logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            api_key_id INTEGER,
            model_id INTEGER,
            model_name TEXT,
            request_messages TEXT,
            response_text TEXT,
            status TEXT DEFAULT 'success',
            error_message TEXT,
            input_tokens INTEGER DEFAULT 0,
            output_tokens INTEGER DEFAULT 0,
            total_tokens INTEGER DEFAULT 0,
            stream INTEGER DEFAULT 0,
            ip_address TEXT,
            created_at DATETIME DEFAULT (datetime('now', '+8 hours')),
            FOREIGN KEY (user_id) REFERENCES users(id),
            FOREIGN KEY (api_key_id) REFERENCES api_keys(id),
            FOREIGN KEY (model_id) REFERENCES models(id)
        );
        CREATE INDEX IF NOT EXISTS idx_api_call_logs_created ON api_call_logs(created_at);
        CREATE INDEX IF NOT EXISTS idx_api_call_logs_user ON api_call_logs(user_id, created_at);
        CREATE INDEX IF NOT EXISTS idx_api_call_logs_key ON api_call_logs(api_key_id, created_at);
    `);

    db.exec(`
        CREATE TABLE IF NOT EXISTS agent_runs (
            id TEXT PRIMARY KEY,
            user_id INTEGER NOT NULL,
            session_id TEXT,
            model_id INTEGER,
            title TEXT,
            goal TEXT NOT NULL,
            status TEXT DEFAULT 'queued',
            final_answer TEXT,
            error_message TEXT,
            max_steps INTEGER DEFAULT 6,
            deleted_at DATETIME,
            deleted_by_user INTEGER,
            delete_reason TEXT,
            created_at DATETIME DEFAULT (datetime('now', '+8 hours')),
            updated_at DATETIME DEFAULT (datetime('now', '+8 hours')),
            completed_at DATETIME,
            FOREIGN KEY (user_id) REFERENCES users(id),
            FOREIGN KEY (session_id) REFERENCES sessions(id),
            FOREIGN KEY (model_id) REFERENCES models(id)
        );
        CREATE TABLE IF NOT EXISTS agent_steps (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            run_id TEXT NOT NULL,
            step_index INTEGER NOT NULL,
            type TEXT NOT NULL,
            title TEXT,
            tool_name TEXT,
            input TEXT,
            output TEXT,
            status TEXT DEFAULT 'success',
            duration_ms INTEGER DEFAULT 0,
            created_at DATETIME DEFAULT (datetime('now', '+8 hours')),
            FOREIGN KEY (run_id) REFERENCES agent_runs(id) ON DELETE CASCADE
        );
        CREATE TABLE IF NOT EXISTS mcp_servers (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER,
            name TEXT NOT NULL,
            base_url TEXT NOT NULL,
            api_key TEXT,
            description TEXT,
            status TEXT DEFAULT 'active',
            last_error TEXT,
            last_checked_at DATETIME,
            created_at DATETIME DEFAULT (datetime('now', '+8 hours')),
            updated_at DATETIME DEFAULT (datetime('now', '+8 hours')),
            FOREIGN KEY (user_id) REFERENCES users(id)
        );
        CREATE TABLE IF NOT EXISTS mcp_tool_cache (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            server_id INTEGER NOT NULL,
            name TEXT NOT NULL,
            description TEXT,
            input_schema TEXT,
            cached_at DATETIME DEFAULT (datetime('now', '+8 hours')),
            UNIQUE(server_id, name),
            FOREIGN KEY (server_id) REFERENCES mcp_servers(id) ON DELETE CASCADE
        );
        CREATE TABLE IF NOT EXISTS mcp_database_connections (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            mcp_server_id INTEGER UNIQUE NOT NULL,
            user_id INTEGER,
            database_type TEXT NOT NULL,
            host TEXT,
            port INTEGER,
            database_name TEXT,
            username TEXT,
            password TEXT,
            options TEXT,
            status TEXT DEFAULT 'active',
            created_at DATETIME DEFAULT (datetime('now', '+8 hours')),
            updated_at DATETIME DEFAULT (datetime('now', '+8 hours')),
            FOREIGN KEY (mcp_server_id) REFERENCES mcp_servers(id) ON DELETE CASCADE,
            FOREIGN KEY (user_id) REFERENCES users(id)
        );
        CREATE TABLE IF NOT EXISTS mcp_builtin_configs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            mcp_server_id INTEGER UNIQUE NOT NULL,
            user_id INTEGER,
            service_type TEXT NOT NULL,
            config TEXT,
            secret TEXT,
            status TEXT DEFAULT 'active',
            created_at DATETIME DEFAULT (datetime('now', '+8 hours')),
            updated_at DATETIME DEFAULT (datetime('now', '+8 hours')),
            FOREIGN KEY (mcp_server_id) REFERENCES mcp_servers(id) ON DELETE CASCADE,
            FOREIGN KEY (user_id) REFERENCES users(id)
        );
    `);
    ensureColumn('agent_runs', 'session_id', 'TEXT');
    ensureColumn('agent_runs', 'model_id', 'INTEGER');
    ensureColumn('agent_runs', 'title', 'TEXT');
    ensureColumn('agent_runs', 'final_answer', 'TEXT');
    ensureColumn('agent_runs', 'error_message', 'TEXT');
    ensureColumn('agent_runs', 'max_steps', 'INTEGER DEFAULT 6');
    ensureColumn('agent_runs', 'parent_run_id', 'TEXT');
    ensureColumn('agent_runs', 'priority', 'INTEGER DEFAULT 0');
    ensureColumn('agent_runs', 'run_mode', "TEXT DEFAULT 'standard'");
    ensureColumn('agent_runs', 'tool_policy', "TEXT DEFAULT 'all'");
    ensureColumn('agent_runs', 'tool_allowlist', 'TEXT');
    ensureColumn('agent_runs', 'approval_policy', "TEXT DEFAULT 'safe_mcp_auto'");
    ensureColumn('agent_runs', 'timeout_ms', 'INTEGER DEFAULT 600000');
    ensureColumn('agent_runs', 'tool_timeout_ms', 'INTEGER DEFAULT 120000');
    ensureColumn('agent_runs', 'retry_limit', 'INTEGER DEFAULT 1');
    ensureColumn('agent_runs', 'retry_count', 'INTEGER DEFAULT 0');
    ensureColumn('agent_runs', 'max_token_budget', 'INTEGER DEFAULT 0');
    ensureColumn('agent_runs', 'export_count', 'INTEGER DEFAULT 0');
    ensureColumn('agent_runs', 'template_id', 'INTEGER');
    ensureColumn('agent_runs', 'schedule_id', 'INTEGER');
    ensureColumn('agent_runs', 'context_config', 'TEXT');
    ensureColumn('agent_runs', 'resume_from_step', 'INTEGER DEFAULT 0');
    ensureColumn('agent_runs', 'metadata', 'TEXT');
    ensureColumn('agent_runs', 'model_router', "TEXT DEFAULT 'fixed'");
    ensureColumn('agent_runs', 'chosen_model_id', 'INTEGER');
    ensureColumn('agent_runs', 'started_at', 'DATETIME');
    ensureColumn('agent_runs', 'last_heartbeat_at', 'DATETIME');
    ensureColumn('agent_runs', 'locked_by', 'TEXT');
    ensureColumn('agent_runs', 'lock_expires_at', 'DATETIME');
    ensureColumn('agent_runs', 'input_tokens', 'INTEGER DEFAULT 0');
    ensureColumn('agent_runs', 'output_tokens', 'INTEGER DEFAULT 0');
    ensureColumn('agent_runs', 'total_tokens', 'INTEGER DEFAULT 0');
    ensureColumn('agent_runs', 'cancelled_at', 'DATETIME');
    ensureColumn('agent_runs', 'completed_at', 'DATETIME');
    ensureColumn('agent_runs', 'deleted_at', 'DATETIME');
    ensureColumn('agent_runs', 'deleted_by_user', 'INTEGER');
    ensureColumn('agent_runs', 'delete_reason', 'TEXT');
    ensureColumn('agent_steps', 'error_message', 'TEXT');
    ensureColumn('agent_steps', 'duration_ms', 'INTEGER DEFAULT 0');
    ensureColumn('agent_steps', 'started_at', 'DATETIME');
    ensureColumn('agent_steps', 'completed_at', 'DATETIME');
    db.exec(`
        CREATE TABLE IF NOT EXISTS agent_templates (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            scope TEXT DEFAULT 'personal',
            name TEXT NOT NULL,
            description TEXT,
            goal_template TEXT NOT NULL,
            run_mode TEXT DEFAULT 'standard',
            tool_policy TEXT DEFAULT 'all',
            tool_allowlist TEXT,
            approval_policy TEXT DEFAULT 'safe_mcp_auto',
            max_steps INTEGER DEFAULT 5,
            max_token_budget INTEGER DEFAULT 0,
            retry_limit INTEGER DEFAULT 1,
            context_config TEXT,
            allowed_units TEXT DEFAULT '',
            model_router TEXT DEFAULT 'fixed',
            dag_spec TEXT,
            dag_inputs TEXT,
            workflow_id INTEGER,
            workflow_version TEXT,
            created_at DATETIME DEFAULT (datetime('now', '+8 hours')),
            updated_at DATETIME DEFAULT (datetime('now', '+8 hours')),
            deleted_at DATETIME,
            FOREIGN KEY (user_id) REFERENCES users(id)
        );
        CREATE TABLE IF NOT EXISTS agent_schedules (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            template_id INTEGER,
            model_id INTEGER,
            name TEXT NOT NULL,
            goal TEXT NOT NULL,
            frequency TEXT DEFAULT 'manual',
            time_of_day TEXT DEFAULT '09:00',
            day_of_week INTEGER DEFAULT 1,
            status TEXT DEFAULT 'active',
            run_config TEXT,
            next_run_at DATETIME,
            last_run_at DATETIME,
            last_run_id TEXT,
            created_at DATETIME DEFAULT (datetime('now', '+8 hours')),
            updated_at DATETIME DEFAULT (datetime('now', '+8 hours')),
            deleted_at DATETIME,
            FOREIGN KEY (user_id) REFERENCES users(id),
            FOREIGN KEY (template_id) REFERENCES agent_templates(id),
            FOREIGN KEY (model_id) REFERENCES models(id)
        );
        CREATE TABLE IF NOT EXISTS agent_workflows (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            name TEXT NOT NULL,
            description TEXT,
            current_version_id INTEGER,
            published_version_id INTEGER,
            published_at DATETIME,
            created_at DATETIME DEFAULT (datetime('now', '+8 hours')),
            updated_at DATETIME DEFAULT (datetime('now', '+8 hours')),
            deleted_at DATETIME,
            FOREIGN KEY (user_id) REFERENCES users(id)
        );
        CREATE TABLE IF NOT EXISTS agent_workflow_versions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            workflow_id INTEGER NOT NULL,
            version INTEGER NOT NULL,
            dag_spec TEXT NOT NULL,
            note TEXT,
            created_by INTEGER,
            created_at DATETIME DEFAULT (datetime('now', '+8 hours')),
            UNIQUE(workflow_id, version),
            FOREIGN KEY (workflow_id) REFERENCES agent_workflows(id) ON DELETE CASCADE,
            FOREIGN KEY (created_by) REFERENCES users(id)
        );
        CREATE TABLE IF NOT EXISTS agent_artifacts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            run_id TEXT NOT NULL,
            user_id INTEGER NOT NULL,
            type TEXT DEFAULT 'summary',
            title TEXT NOT NULL,
            content TEXT NOT NULL,
            current_version_id INTEGER,
            note TEXT,
            updated_at DATETIME,
            created_at DATETIME DEFAULT (datetime('now', '+8 hours')),
            FOREIGN KEY (run_id) REFERENCES agent_runs(id) ON DELETE CASCADE,
            FOREIGN KEY (user_id) REFERENCES users(id)
        );
        CREATE TABLE IF NOT EXISTS agent_artifact_versions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            artifact_id INTEGER NOT NULL,
            version INTEGER NOT NULL,
            content TEXT NOT NULL,
            note TEXT,
            created_by INTEGER,
            created_at DATETIME DEFAULT (datetime('now', '+8 hours')),
            UNIQUE(artifact_id, version),
            FOREIGN KEY (artifact_id) REFERENCES agent_artifacts(id) ON DELETE CASCADE,
            FOREIGN KEY (created_by) REFERENCES users(id)
        );
        CREATE TABLE IF NOT EXISTS agent_dag_nodes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            run_id TEXT NOT NULL,
            node_key TEXT NOT NULL,
            title TEXT,
            tool_name TEXT,
            input TEXT,
            depends_on TEXT,
            condition TEXT,
            status TEXT DEFAULT 'pending',
            output TEXT,
            error_message TEXT,
            attempt_count INTEGER DEFAULT 0,
            duration_ms INTEGER DEFAULT 0,
            created_at DATETIME DEFAULT (datetime('now', '+8 hours')),
            started_at DATETIME,
            completed_at DATETIME,
            UNIQUE(run_id, node_key),
            FOREIGN KEY (run_id) REFERENCES agent_runs(id) ON DELETE CASCADE
        );
        CREATE TABLE IF NOT EXISTS agent_notifications (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            run_id TEXT,
            type TEXT DEFAULT 'info',
            title TEXT NOT NULL,
            body TEXT,
            status TEXT DEFAULT 'unread',
            read_at DATETIME,
            created_at DATETIME DEFAULT (datetime('now', '+8 hours')),
            FOREIGN KEY (user_id) REFERENCES users(id),
            FOREIGN KEY (run_id) REFERENCES agent_runs(id) ON DELETE CASCADE
        );
    `);
    ensureColumn('agent_templates', 'scope', "TEXT DEFAULT 'personal'");
    ensureColumn('agent_templates', 'description', 'TEXT');
    ensureColumn('agent_templates', 'tool_allowlist', 'TEXT');
    ensureColumn('agent_templates', 'max_token_budget', 'INTEGER DEFAULT 0');
    ensureColumn('agent_templates', 'retry_limit', 'INTEGER DEFAULT 1');
    ensureColumn('agent_templates', 'context_config', 'TEXT');
    ensureColumn('agent_templates', 'allowed_units', "TEXT DEFAULT ''");
    ensureColumn('agent_templates', 'model_router', "TEXT DEFAULT 'fixed'");
    ensureColumn('agent_templates', 'dag_spec', 'TEXT');
    ensureColumn('agent_templates', 'dag_inputs', 'TEXT');
    ensureColumn('agent_templates', 'workflow_id', 'INTEGER');
    ensureColumn('agent_templates', 'workflow_version', 'TEXT');
    ensureColumn('agent_templates', 'deleted_at', 'DATETIME');
    ensureColumn('agent_schedules', 'template_id', 'INTEGER');
    ensureColumn('agent_schedules', 'model_id', 'INTEGER');
    ensureColumn('agent_schedules', 'frequency', "TEXT DEFAULT 'manual'");
    ensureColumn('agent_schedules', 'time_of_day', "TEXT DEFAULT '09:00'");
    ensureColumn('agent_schedules', 'day_of_week', 'INTEGER DEFAULT 1');
    ensureColumn('agent_schedules', 'status', "TEXT DEFAULT 'active'");
    ensureColumn('agent_schedules', 'run_config', 'TEXT');
    ensureColumn('agent_schedules', 'next_run_at', 'DATETIME');
    ensureColumn('agent_schedules', 'last_run_at', 'DATETIME');
    ensureColumn('agent_schedules', 'last_run_id', 'TEXT');
    ensureColumn('agent_schedules', 'deleted_at', 'DATETIME');
    ensureColumn('agent_workflows', 'description', 'TEXT');
    ensureColumn('agent_workflows', 'current_version_id', 'INTEGER');
    ensureColumn('agent_workflows', 'published_version_id', 'INTEGER');
    ensureColumn('agent_workflows', 'published_at', 'DATETIME');
    ensureColumn('agent_workflows', 'deleted_at', 'DATETIME');
    ensureColumn('agent_workflow_versions', 'note', 'TEXT');
    ensureColumn('agent_workflow_versions', 'created_by', 'INTEGER');
    ensureColumn('agent_dag_nodes', 'attempt_count', 'INTEGER DEFAULT 0');
    ensureColumn('agent_artifacts', 'current_version_id', 'INTEGER');
    ensureColumn('agent_artifacts', 'note', 'TEXT');
    ensureColumn('agent_artifacts', 'updated_at', 'DATETIME');
    ensureColumn('agent_notifications', 'read_at', 'DATETIME');
    ensureColumn('agent_notifications', 'status', "TEXT DEFAULT 'unread'");
    ensureColumn('mcp_servers', 'user_id', 'INTEGER');
    ensureColumn('mcp_servers', 'api_key', 'TEXT');
    ensureColumn('mcp_servers', 'description', 'TEXT');
    ensureColumn('mcp_servers', 'last_error', 'TEXT');
    ensureColumn('mcp_servers', 'last_checked_at', 'DATETIME');
    ensureColumn('mcp_servers', 'updated_at', 'DATETIME');
    db.exec(`
        CREATE TABLE IF NOT EXISTS mcp_call_logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER,
            server_id INTEGER,
            tool_name TEXT,
            source TEXT DEFAULT 'manual',
            status TEXT DEFAULT 'success',
            duration_ms INTEGER DEFAULT 0,
            input_preview TEXT,
            output_preview TEXT,
            error_message TEXT,
            created_at DATETIME DEFAULT (datetime('now', '+8 hours'))
        );
        CREATE INDEX IF NOT EXISTS idx_mcp_call_logs_server_created ON mcp_call_logs(server_id, created_at);
        CREATE INDEX IF NOT EXISTS idx_mcp_call_logs_user_created ON mcp_call_logs(user_id, created_at);
    `);
    ensureColumn('mcp_call_logs', 'source', "TEXT DEFAULT 'manual'");
    ensureColumn('mcp_call_logs', 'input_preview', 'TEXT');
    ensureColumn('mcp_call_logs', 'output_preview', 'TEXT');
    ensureColumn('mcp_database_connections', 'user_id', 'INTEGER');
    ensureColumn('mcp_database_connections', 'host', 'TEXT');
    ensureColumn('mcp_database_connections', 'port', 'INTEGER');
    ensureColumn('mcp_database_connections', 'database_name', 'TEXT');
    ensureColumn('mcp_database_connections', 'username', 'TEXT');
    ensureColumn('mcp_database_connections', 'password', 'TEXT');
    ensureColumn('mcp_database_connections', 'options', 'TEXT');
    ensureColumn('mcp_database_connections', 'status', "TEXT DEFAULT 'active'");
    ensureColumn('mcp_database_connections', 'created_at', 'DATETIME');
    ensureColumn('mcp_database_connections', 'updated_at', 'DATETIME');
    ensureColumn('mcp_builtin_configs', 'user_id', 'INTEGER');
    ensureColumn('mcp_builtin_configs', 'service_type', 'TEXT');
    ensureColumn('mcp_builtin_configs', 'config', 'TEXT');
    ensureColumn('mcp_builtin_configs', 'secret', 'TEXT');
    ensureColumn('mcp_builtin_configs', 'status', "TEXT DEFAULT 'active'");
    ensureColumn('mcp_builtin_configs', 'created_at', 'DATETIME');
    ensureColumn('mcp_builtin_configs', 'updated_at', 'DATETIME');

    db.exec(`
        CREATE INDEX IF NOT EXISTS idx_agent_runs_user_created ON agent_runs(user_id, created_at);
        CREATE INDEX IF NOT EXISTS idx_agent_runs_user_status_created ON agent_runs(user_id, status, created_at);
        CREATE INDEX IF NOT EXISTS idx_agent_runs_status_priority ON agent_runs(status, priority, created_at);
        CREATE INDEX IF NOT EXISTS idx_agent_runs_queue_claim ON agent_runs(status, priority, created_at, locked_by, lock_expires_at);
        CREATE INDEX IF NOT EXISTS idx_agent_runs_deleted ON agent_runs(deleted_at, user_id);
        CREATE INDEX IF NOT EXISTS idx_agent_steps_run ON agent_steps(run_id, step_index);
        CREATE INDEX IF NOT EXISTS idx_agent_templates_user ON agent_templates(user_id, deleted_at);
        CREATE INDEX IF NOT EXISTS idx_agent_schedules_user_status ON agent_schedules(user_id, status, deleted_at);
        CREATE INDEX IF NOT EXISTS idx_agent_schedules_due ON agent_schedules(status, next_run_at, deleted_at);
        CREATE INDEX IF NOT EXISTS idx_agent_workflows_user ON agent_workflows(user_id, deleted_at, updated_at);
        CREATE INDEX IF NOT EXISTS idx_agent_workflow_versions_workflow ON agent_workflow_versions(workflow_id, version);
        CREATE INDEX IF NOT EXISTS idx_agent_artifacts_user ON agent_artifacts(user_id, created_at);
        CREATE INDEX IF NOT EXISTS idx_agent_artifact_versions_artifact ON agent_artifact_versions(artifact_id, version);
        CREATE INDEX IF NOT EXISTS idx_agent_dag_nodes_run ON agent_dag_nodes(run_id, status);
        CREATE INDEX IF NOT EXISTS idx_agent_notifications_user ON agent_notifications(user_id, status, created_at);
        CREATE INDEX IF NOT EXISTS idx_mcp_servers_user ON mcp_servers(user_id, status);
        CREATE INDEX IF NOT EXISTS idx_mcp_tool_cache_server ON mcp_tool_cache(server_id);
        CREATE INDEX IF NOT EXISTS idx_mcp_database_connections_server ON mcp_database_connections(mcp_server_id);
        CREATE INDEX IF NOT EXISTS idx_mcp_database_connections_user ON mcp_database_connections(user_id, status);
        CREATE INDEX IF NOT EXISTS idx_mcp_builtin_configs_server ON mcp_builtin_configs(mcp_server_id);
        CREATE INDEX IF NOT EXISTS idx_mcp_builtin_configs_user ON mcp_builtin_configs(user_id, service_type, status);
    `);

    db.exec(`
        CREATE TABLE IF NOT EXISTS capability_packages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            package_key TEXT UNIQUE NOT NULL,
            type TEXT NOT NULL,
            source_ref TEXT NOT NULL,
            user_id INTEGER,
            scope TEXT DEFAULT 'user',
            name TEXT NOT NULL,
            description TEXT,
            status TEXT DEFAULT 'enabled',
            config TEXT,
            created_at DATETIME DEFAULT (datetime('now', '+8 hours')),
            updated_at DATETIME DEFAULT (datetime('now', '+8 hours')),
            FOREIGN KEY (user_id) REFERENCES users(id)
        );
        CREATE TABLE IF NOT EXISTS observability_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            type TEXT NOT NULL,
            source TEXT,
            severity TEXT DEFAULT 'warning',
            duration_ms INTEGER DEFAULT 0,
            threshold_ms INTEGER DEFAULT 0,
            message TEXT,
            details TEXT,
            status TEXT DEFAULT 'open',
            alerted_at DATETIME,
            acknowledged_at DATETIME,
            created_at DATETIME DEFAULT (datetime('now', '+8 hours'))
        );
        CREATE INDEX IF NOT EXISTS idx_sessions_parent ON sessions(parent_session_id);
        CREATE INDEX IF NOT EXISTS idx_capability_packages_user ON capability_packages(user_id, status, type);
        CREATE INDEX IF NOT EXISTS idx_observability_events_type_created ON observability_events(type, created_at);
        CREATE INDEX IF NOT EXISTS idx_observability_events_status_created ON observability_events(status, created_at);
    `);

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

    recordSchemaMigration('20260516_schema_migrations_v1', 'Track applied schema migrations in a dedicated table.');
    recordSchemaMigration('20260516_agent_queue_locks_v1', 'Add database-backed agent queue lock fields and indexes.');
    recordSchemaMigration('20260516_branch_artifact_observability_capabilities_v1', 'Add conversation forks, artifact versions, DAG nodes, capability packages, and observability events.');
    recordSchemaMigration('20260517_mcp_call_logs_v1', 'Track MCP tool calls for audit and health governance.');
}

module.exports = { runMigrations, recordMigration, recordSchemaMigration, runSchemaMigration };
