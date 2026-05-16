const { db } = require('./connection');

function initSchema() {
    db.exec(`
        CREATE TABLE IF NOT EXISTS app_meta (
            key TEXT PRIMARY KEY,
            value TEXT,
            updated_at DATETIME
        );

        CREATE TABLE IF NOT EXISTS schema_migrations (
            id TEXT PRIMARY KEY,
            description TEXT,
            applied_at DATETIME DEFAULT (datetime('now', '+8 hours'))
        );

        CREATE TABLE IF NOT EXISTS app_settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL,
            updated_at DATETIME,
            updated_by INTEGER,
            FOREIGN KEY (updated_by) REFERENCES users(id)
        );

        CREATE TABLE IF NOT EXISTS user_settings (
            user_id INTEGER NOT NULL,
            key TEXT NOT NULL,
            value TEXT NOT NULL,
            updated_at DATETIME,
            PRIMARY KEY (user_id, key),
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE NOT NULL,
            password_hash TEXT NOT NULL,
            nickname TEXT,
            unit TEXT,
            role TEXT DEFAULT 'user',
            status TEXT DEFAULT 'active',
            deleted_at DATETIME,
            deleted_by_admin INTEGER DEFAULT 0,
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
            deleted_at DATETIME,
            deleted_by_user INTEGER DEFAULT 0,
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
            deleted_at DATETIME,
            deleted_by_user INTEGER DEFAULT 0,
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
            max_input_tokens INTEGER,
            max_tokens INTEGER,
            monitor_url TEXT,
            max_concurrent INTEGER DEFAULT 0,
            supports_vision INTEGER DEFAULT 0,
            supports_reasoning INTEGER DEFAULT 0,
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
            is_enabled INTEGER DEFAULT 1,
            chunk_count INTEGER DEFAULT 0,
            indexed_chunks INTEGER DEFAULT 0,
            progress INTEGER DEFAULT 0,
            error_message TEXT,
            processed_at DATETIME,
            updated_at DATETIME,
            source_path TEXT,
            source_size INTEGER DEFAULT 0,
            deleted_at DATETIME,
            deleted_by_user INTEGER DEFAULT 0,
            created_at DATETIME DEFAULT (datetime('now', '+8 hours')),
            FOREIGN KEY (user_id) REFERENCES users(id)
        );

        CREATE TABLE IF NOT EXISTS knowledge_chunks (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            doc_id INTEGER,
            content TEXT NOT NULL,
            search_content TEXT,
            embedding TEXT,
            FOREIGN KEY (doc_id) REFERENCES knowledge_docs(id) ON DELETE CASCADE
        );

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
            deleted_at DATETIME,
            deleted_by_user INTEGER DEFAULT 0,
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
            input_tokens INTEGER DEFAULT 0,
            output_tokens INTEGER DEFAULT 0,
            last_used_at DATETIME,
            created_at DATETIME DEFAULT (datetime('now', '+8 hours')),
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        );

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
            parent_run_id TEXT,
            priority INTEGER DEFAULT 0,
            run_mode TEXT DEFAULT 'standard',
            tool_policy TEXT DEFAULT 'all',
            tool_allowlist TEXT,
            approval_policy TEXT DEFAULT 'safe_mcp_auto',
            timeout_ms INTEGER DEFAULT 600000,
            tool_timeout_ms INTEGER DEFAULT 120000,
            retry_limit INTEGER DEFAULT 1,
            retry_count INTEGER DEFAULT 0,
            max_token_budget INTEGER DEFAULT 0,
            export_count INTEGER DEFAULT 0,
            template_id INTEGER,
            schedule_id INTEGER,
            context_config TEXT,
            resume_from_step INTEGER DEFAULT 0,
            metadata TEXT,
            started_at DATETIME,
            last_heartbeat_at DATETIME,
            locked_by TEXT,
            lock_expires_at DATETIME,
            input_tokens INTEGER DEFAULT 0,
            output_tokens INTEGER DEFAULT 0,
            total_tokens INTEGER DEFAULT 0,
            cancelled_at DATETIME,
            deleted_at DATETIME,
            deleted_by_user INTEGER,
            delete_reason TEXT,
            created_at DATETIME DEFAULT (datetime('now', '+8 hours')),
            updated_at DATETIME DEFAULT (datetime('now', '+8 hours')),
            completed_at DATETIME,
            FOREIGN KEY (user_id) REFERENCES users(id),
            FOREIGN KEY (session_id) REFERENCES sessions(id),
            FOREIGN KEY (model_id) REFERENCES models(id),
            FOREIGN KEY (parent_run_id) REFERENCES agent_runs(id)
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
            error_message TEXT,
            status TEXT DEFAULT 'success',
            duration_ms INTEGER DEFAULT 0,
            started_at DATETIME,
            completed_at DATETIME,
            created_at DATETIME DEFAULT (datetime('now', '+8 hours')),
            FOREIGN KEY (run_id) REFERENCES agent_runs(id) ON DELETE CASCADE
        );

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

        CREATE TABLE IF NOT EXISTS agent_artifacts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            run_id TEXT NOT NULL,
            user_id INTEGER NOT NULL,
            type TEXT DEFAULT 'summary',
            title TEXT NOT NULL,
            content TEXT NOT NULL,
            created_at DATETIME DEFAULT (datetime('now', '+8 hours')),
            FOREIGN KEY (run_id) REFERENCES agent_runs(id) ON DELETE CASCADE,
            FOREIGN KEY (user_id) REFERENCES users(id)
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

        CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_logs(user_id);
        CREATE INDEX IF NOT EXISTS idx_models_user ON models(user_id);
        CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
        CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);
        CREATE INDEX IF NOT EXISTS idx_messages_user ON messages(user_id);
        CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user ON refresh_tokens(user_id);
        CREATE INDEX IF NOT EXISTS idx_refresh_tokens_token ON refresh_tokens(token);
        CREATE INDEX IF NOT EXISTS idx_api_keys_user ON api_keys(user_id);
        CREATE INDEX IF NOT EXISTS idx_model_usage_user_model_created ON model_usage_events(user_id, model_id, created_at);
        CREATE INDEX IF NOT EXISTS idx_api_call_logs_created ON api_call_logs(created_at);
        CREATE INDEX IF NOT EXISTS idx_api_call_logs_user ON api_call_logs(user_id, created_at);
        CREATE INDEX IF NOT EXISTS idx_api_call_logs_key ON api_call_logs(api_key_id, created_at);
        CREATE INDEX IF NOT EXISTS idx_agent_runs_user_created ON agent_runs(user_id, created_at);
        CREATE INDEX IF NOT EXISTS idx_agent_steps_run ON agent_steps(run_id, step_index);
        CREATE INDEX IF NOT EXISTS idx_agent_templates_user ON agent_templates(user_id, deleted_at);
        CREATE INDEX IF NOT EXISTS idx_agent_schedules_user_status ON agent_schedules(user_id, status, deleted_at);
        CREATE INDEX IF NOT EXISTS idx_agent_schedules_due ON agent_schedules(status, next_run_at, deleted_at);
        CREATE INDEX IF NOT EXISTS idx_agent_artifacts_user ON agent_artifacts(user_id, created_at);
        CREATE INDEX IF NOT EXISTS idx_agent_notifications_user ON agent_notifications(user_id, status, created_at);
        CREATE INDEX IF NOT EXISTS idx_mcp_servers_user ON mcp_servers(user_id, status);
        CREATE INDEX IF NOT EXISTS idx_mcp_tool_cache_server ON mcp_tool_cache(server_id);
        CREATE INDEX IF NOT EXISTS idx_mcp_database_connections_server ON mcp_database_connections(mcp_server_id);
        CREATE INDEX IF NOT EXISTS idx_mcp_database_connections_user ON mcp_database_connections(user_id, status);
        CREATE INDEX IF NOT EXISTS idx_messages_session_user_created ON messages(session_id, user_id, created_at);
        CREATE INDEX IF NOT EXISTS idx_users_status ON users(status);
        CREATE INDEX IF NOT EXISTS idx_sessions_user_archived ON sessions(user_id, is_archived, is_pinned, created_at);
        CREATE INDEX IF NOT EXISTS idx_prompts_scope_user ON prompts(scope, user_id);
        CREATE INDEX IF NOT EXISTS idx_attachments_user_session ON attachments(user_id, session_id);
        CREATE INDEX IF NOT EXISTS idx_attachments_token ON attachments(access_token);
        CREATE INDEX IF NOT EXISTS idx_knowledge_docs_user_status ON knowledge_docs(user_id, status);
        CREATE INDEX IF NOT EXISTS idx_knowledge_chunks_doc ON knowledge_chunks(doc_id);
        CREATE INDEX IF NOT EXISTS idx_rag_feedback_user_created ON rag_feedback(user_id, created_at);
        CREATE INDEX IF NOT EXISTS idx_audit_logs_timestamp ON audit_logs(timestamp);
        CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at);
        CREATE INDEX IF NOT EXISTS idx_model_usage_created ON model_usage_events(created_at);
        CREATE INDEX IF NOT EXISTS idx_api_call_logs_created_at ON api_call_logs(created_at);
        CREATE INDEX IF NOT EXISTS idx_knowledge_docs_created ON knowledge_docs(created_at);
        CREATE INDEX IF NOT EXISTS idx_attachments_created ON attachments(created_at);
        CREATE INDEX IF NOT EXISTS idx_prompts_created ON prompts(created_at);

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
