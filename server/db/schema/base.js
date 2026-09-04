const { db } = require('../connection');
const { applyLegacySchemaPreflight } = require('./legacy-preflight');
const { enterpriseTablesSql, enterpriseIndexesSql } = require('./enterprise');

/**
 * 建表 DDL（SQLite 方言，权威单一数据源）
 *
 * 本函数返回的文本同时被 PostgreSQL 侧复用：server/db/schema/pg.js 会读取
 * 此文本并做方言转换（INTEGER→BIGINT、DATETIME→TIMESTAMPTZ、AUTOINCREMENT→
 * IDENTITY、外键后置化）。因此新增表或列只需改这里一处，两种方言自动同步。
 *
 * 约束：
 *  - 外键必须写成独立的 `FOREIGN KEY (col) REFERENCES tbl(col)` 单行子句，
 *    不要用内联 `col INTEGER REFERENCES tbl(col)` —— PG 转换器按行剥离外键。
 *  - 布尔语义列统一用 `INTEGER DEFAULT 0/1`（两侧一致，应用层 === 1 判断成立）。
 */
function baseTablesSql() {
    return `
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
            deleted_username TEXT,
            password_hash TEXT NOT NULL,
            nickname TEXT,
            unit TEXT,
            default_model_id INTEGER,
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
            parent_session_id TEXT,
            forked_from_message_id INTEGER,
            fork_root_session_id TEXT,
            fork_note TEXT,
            created_at DATETIME DEFAULT (datetime('now', '+8 hours')),
            updated_at DATETIME DEFAULT (datetime('now', '+8 hours')),
            FOREIGN KEY (user_id) REFERENCES users(id),
            FOREIGN KEY (parent_session_id) REFERENCES sessions(id),
            FOREIGN KEY (forked_from_message_id) REFERENCES messages(id)
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
            agent_run_id TEXT,
            cost_time REAL,
            tokens_per_sec REAL,
            deleted_at DATETIME,
            deleted_by_user INTEGER DEFAULT 0,
            created_at DATETIME DEFAULT (datetime('now', '+8 hours')),
            FOREIGN KEY (session_id) REFERENCES sessions(id),
            FOREIGN KEY (user_id) REFERENCES users(id)
        );

        CREATE TABLE IF NOT EXISTS memories (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            scope TEXT DEFAULT 'user',
            type TEXT NOT NULL,
            content TEXT NOT NULL,
            embedding TEXT,
            salience REAL DEFAULT 0.5,
            confidence REAL DEFAULT 0.6,
            source_session_id TEXT,
            source_message_ids TEXT DEFAULT '[]',
            status TEXT DEFAULT 'active',
            last_used_at DATETIME,
            expires_at DATETIME,
            created_at DATETIME DEFAULT (datetime('now', '+8 hours')),
            updated_at DATETIME DEFAULT (datetime('now', '+8 hours')),
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
            FOREIGN KEY (source_session_id) REFERENCES sessions(id)
        );

        CREATE TABLE IF NOT EXISTS memory_extraction_jobs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            session_id TEXT NOT NULL,
            message_ids TEXT DEFAULT '[]',
            model_id INTEGER,
            dedupe_key TEXT,
            status TEXT DEFAULT 'queued',
            attempts INTEGER DEFAULT 0,
            max_attempts INTEGER DEFAULT 3,
            locked_at DATETIME,
            last_error TEXT,
            result TEXT,
            created_at DATETIME DEFAULT (datetime('now', '+8 hours')),
            updated_at DATETIME DEFAULT (datetime('now', '+8 hours')),
            next_run_at DATETIME DEFAULT (datetime('now', '+8 hours')),
            completed_at DATETIME,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
            FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
            FOREIGN KEY (model_id) REFERENCES models(id) ON DELETE SET NULL
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
            context_window_tokens INTEGER,
            monitor_url TEXT,
            max_concurrent INTEGER DEFAULT 0,
            supports_vision INTEGER DEFAULT 0,
            supports_reasoning INTEGER DEFAULT 0,
            chat_thinking_enabled INTEGER DEFAULT 0,
            input_price_per_million REAL DEFAULT 0,
            output_price_per_million REAL DEFAULT 0,
            price_currency TEXT DEFAULT '人民币',
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

        CREATE TABLE IF NOT EXISTS knowledge_collections (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            name TEXT NOT NULL,
            description TEXT DEFAULT '',
            scope TEXT DEFAULT 'personal',
            allowed_units TEXT DEFAULT '',
            allowed_user_ids TEXT DEFAULT '',
            created_at DATETIME DEFAULT (datetime('now', '+8 hours')),
            updated_at DATETIME DEFAULT (datetime('now', '+8 hours')),
            deleted_at DATETIME,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS knowledge_docs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER,
            collection_id INTEGER,
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
            FOREIGN KEY (user_id) REFERENCES users(id),
            FOREIGN KEY (collection_id) REFERENCES knowledge_collections(id) ON DELETE SET NULL
        );

        CREATE TABLE IF NOT EXISTS knowledge_chunks (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            doc_id INTEGER,
            content TEXT NOT NULL,
            search_content TEXT,
            heading_path TEXT,
            embedding TEXT,
            FOREIGN KEY (doc_id) REFERENCES knowledge_docs(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS knowledge_doc_tags (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            doc_id INTEGER NOT NULL,
            tag TEXT NOT NULL,
            created_at DATETIME DEFAULT (datetime('now', '+8 hours')),
            UNIQUE(user_id, doc_id, tag),
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
            FOREIGN KEY (doc_id) REFERENCES knowledge_docs(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS knowledge_tags (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            tag TEXT NOT NULL,
            created_at DATETIME DEFAULT (datetime('now', '+8 hours')),
            updated_at DATETIME DEFAULT (datetime('now', '+8 hours')),
            deleted_at DATETIME,
            UNIQUE(user_id, tag),
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        );


        CREATE TABLE IF NOT EXISTS regulation_documents (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT NOT NULL,
            category TEXT DEFAULT '',
            issuing_body TEXT DEFAULT '',
            jurisdiction TEXT DEFAULT '',
            summary TEXT DEFAULT '',
            status TEXT DEFAULT 'active',
            visibility TEXT DEFAULT 'internal',
            current_version_id INTEGER,
            version_count INTEGER DEFAULT 0,
            article_count INTEGER DEFAULT 0,
            created_by_user INTEGER DEFAULT 0,
            updated_by_user INTEGER DEFAULT 0,
            deleted_at DATETIME,
            deleted_by_user INTEGER DEFAULT 0,
            created_at DATETIME DEFAULT (datetime('now', '+8 hours')),
            updated_at DATETIME DEFAULT (datetime('now', '+8 hours')),
            FOREIGN KEY (current_version_id) REFERENCES regulation_versions(id) ON DELETE SET NULL
        );

        CREATE TABLE IF NOT EXISTS regulation_versions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            document_id INTEGER NOT NULL,
            version_label TEXT DEFAULT '',
            source_name TEXT NOT NULL,
            source_path TEXT NOT NULL,
            source_size INTEGER DEFAULT 0,
            source_hash TEXT DEFAULT '',
            source_format TEXT DEFAULT '',
            extracted_text TEXT DEFAULT '',
            summary TEXT DEFAULT '',
            article_count INTEGER DEFAULT 0,
            uploaded_by_user INTEGER DEFAULT 0,
            created_at DATETIME DEFAULT (datetime('now', '+8 hours')),
            updated_at DATETIME DEFAULT (datetime('now', '+8 hours')),
            FOREIGN KEY (document_id) REFERENCES regulation_documents(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS regulation_articles (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            document_id INTEGER NOT NULL,
            version_id INTEGER NOT NULL,
            sort_order INTEGER DEFAULT 0,
            article_label TEXT NOT NULL,
            article_title TEXT DEFAULT '',
            content TEXT NOT NULL,
            search_content TEXT,
            heading_path TEXT DEFAULT '',
            status TEXT DEFAULT 'active',
            amended_date TEXT DEFAULT '',
            embedding TEXT DEFAULT '',
            created_at DATETIME DEFAULT (datetime('now', '+8 hours')),
            FOREIGN KEY (document_id) REFERENCES regulation_documents(id) ON DELETE CASCADE,
            FOREIGN KEY (version_id) REFERENCES regulation_versions(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS regulation_article_links (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            document_id INTEGER NOT NULL,
            version_id INTEGER NOT NULL,
            source_article_id INTEGER NOT NULL,
            target_label TEXT DEFAULT '',
            target_article_id INTEGER,
            target_document_id INTEGER,
            relation_type TEXT DEFAULT 'cite',
            confidence REAL DEFAULT 0.7,
            created_at DATETIME DEFAULT (datetime('now', '+8 hours')),
            FOREIGN KEY (document_id) REFERENCES regulation_documents(id) ON DELETE CASCADE,
            FOREIGN KEY (version_id) REFERENCES regulation_versions(id) ON DELETE CASCADE,
            FOREIGN KEY (source_article_id) REFERENCES regulation_articles(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS regulation_aliases (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            document_id INTEGER NOT NULL,
            alias TEXT NOT NULL,
            normalized_alias TEXT NOT NULL,
            is_primary INTEGER DEFAULT 0,
            created_at DATETIME DEFAULT (datetime('now', '+8 hours')),
            FOREIGN KEY (document_id) REFERENCES regulation_documents(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS regulation_article_annotations (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            article_id INTEGER NOT NULL,
            user_id INTEGER NOT NULL,
            content TEXT NOT NULL,
            created_at DATETIME DEFAULT (datetime('now', '+8 hours')),
            updated_at DATETIME DEFAULT (datetime('now', '+8 hours')),
            FOREIGN KEY (article_id) REFERENCES regulation_articles(id) ON DELETE CASCADE,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS regulation_access_logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            document_id INTEGER,
            action TEXT NOT NULL,
            detail TEXT DEFAULT '',
            created_at DATETIME DEFAULT (datetime('now', '+8 hours'))
        );

        CREATE TABLE IF NOT EXISTS regulation_saved_searches (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            name TEXT NOT NULL,
            query TEXT DEFAULT '',
            category TEXT DEFAULT '',
            jurisdiction TEXT DEFAULT '',
            created_at DATETIME DEFAULT (datetime('now', '+8 hours')),
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
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

        CREATE TABLE IF NOT EXISTS document_files (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            original_name TEXT NOT NULL,
            stored_name TEXT DEFAULT '',
            file_path TEXT DEFAULT '',
            file_type TEXT DEFAULT '',
            file_ext TEXT DEFAULT '',
            file_size INTEGER DEFAULT 0,
            page_count INTEGER DEFAULT 0,
            source_module TEXT DEFAULT 'document_processing',
            source_ref TEXT DEFAULT '',
            sha256 TEXT DEFAULT '',
            metadata_json TEXT DEFAULT '{}',
            deleted_at DATETIME,
            created_at DATETIME DEFAULT (datetime('now', '+8 hours')),
            updated_at DATETIME DEFAULT (datetime('now', '+8 hours')),
            FOREIGN KEY (user_id) REFERENCES users(id)
        );

        CREATE TABLE IF NOT EXISTS document_jobs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            file_id INTEGER NOT NULL,
            job_type TEXT NOT NULL,
            status TEXT DEFAULT 'queued',
            progress INTEGER DEFAULT 0,
            error_message TEXT DEFAULT '',
            config_json TEXT DEFAULT '{}',
            result_json TEXT DEFAULT '{}',
            attempts INTEGER DEFAULT 0,
            max_attempts INTEGER DEFAULT 3,
            locked_at DATETIME,
            cancelled_at DATETIME,
            completed_at DATETIME,
            source_module TEXT DEFAULT 'document_processing',
            created_at DATETIME DEFAULT (datetime('now', '+8 hours')),
            updated_at DATETIME DEFAULT (datetime('now', '+8 hours')),
            FOREIGN KEY (user_id) REFERENCES users(id),
            FOREIGN KEY (file_id) REFERENCES document_files(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS document_pages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            file_id INTEGER NOT NULL,
            job_id INTEGER NOT NULL,
            page_number INTEGER DEFAULT 1,
            width INTEGER DEFAULT 0,
            height INTEGER DEFAULT 0,
            image_path TEXT DEFAULT '',
            text TEXT DEFAULT '',
            text_length INTEGER DEFAULT 0,
            ocr_status TEXT DEFAULT 'pending',
            confidence REAL,
            created_at DATETIME DEFAULT (datetime('now', '+8 hours')),
            updated_at DATETIME DEFAULT (datetime('now', '+8 hours')),
            FOREIGN KEY (user_id) REFERENCES users(id),
            FOREIGN KEY (file_id) REFERENCES document_files(id) ON DELETE CASCADE,
            FOREIGN KEY (job_id) REFERENCES document_jobs(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS document_ocr_blocks (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            file_id INTEGER NOT NULL,
            job_id INTEGER NOT NULL,
            page_id INTEGER NOT NULL,
            page_number INTEGER DEFAULT 1,
            sort_order INTEGER DEFAULT 0,
            block_type TEXT DEFAULT 'line',
            text TEXT NOT NULL,
            bbox_json TEXT DEFAULT '[]',
            confidence REAL DEFAULT 0,
            language TEXT DEFAULT '',
            engine TEXT DEFAULT '',
            created_at DATETIME DEFAULT (datetime('now', '+8 hours')),
            updated_at DATETIME DEFAULT (datetime('now', '+8 hours')),
            FOREIGN KEY (user_id) REFERENCES users(id),
            FOREIGN KEY (file_id) REFERENCES document_files(id) ON DELETE CASCADE,
            FOREIGN KEY (job_id) REFERENCES document_jobs(id) ON DELETE CASCADE,
            FOREIGN KEY (page_id) REFERENCES document_pages(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS document_outputs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            file_id INTEGER NOT NULL,
            job_id INTEGER NOT NULL,
            output_type TEXT NOT NULL,
            file_path TEXT NOT NULL,
            file_name TEXT DEFAULT '',
            mime_type TEXT DEFAULT 'application/octet-stream',
            file_size INTEGER DEFAULT 0,
            status TEXT DEFAULT 'ready',
            expires_at DATETIME,
            created_at DATETIME DEFAULT (datetime('now', '+8 hours')),
            FOREIGN KEY (user_id) REFERENCES users(id),
            FOREIGN KEY (file_id) REFERENCES document_files(id) ON DELETE CASCADE,
            FOREIGN KEY (job_id) REFERENCES document_jobs(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS document_reviews (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            file_id INTEGER NOT NULL,
            job_id INTEGER NOT NULL,
            page_id INTEGER NOT NULL,
            review_status TEXT DEFAULT 'draft',
            original_text TEXT DEFAULT '',
            revised_text TEXT DEFAULT '',
            low_confidence_confirmed INTEGER DEFAULT 0,
            reviewed_at DATETIME,
            created_at DATETIME DEFAULT (datetime('now', '+8 hours')),
            updated_at DATETIME DEFAULT (datetime('now', '+8 hours')),
            FOREIGN KEY (user_id) REFERENCES users(id),
            FOREIGN KEY (file_id) REFERENCES document_files(id) ON DELETE CASCADE,
            FOREIGN KEY (job_id) REFERENCES document_jobs(id) ON DELETE CASCADE,
            FOREIGN KEY (page_id) REFERENCES document_pages(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS prompts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            content TEXT NOT NULL,
            category TEXT,
            description TEXT DEFAULT '',
            type TEXT DEFAULT 'role',
            target_surfaces TEXT DEFAULT 'chat,agent,workflow',
            user_id INTEGER,
            scope TEXT DEFAULT 'global',
            created_at DATETIME DEFAULT (datetime('now', '+8 hours')),
            updated_at DATETIME,
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
            budget_config TEXT DEFAULT '{}',
            usage_stats TEXT DEFAULT '{}',
            network_policy TEXT DEFAULT '{}',
            export_count INTEGER DEFAULT 0,
            template_id INTEGER,
            schedule_id INTEGER,
            dedupe_key TEXT,
            context_config TEXT,
            resume_from_step INTEGER DEFAULT 0,
            metadata TEXT,
            model_router TEXT DEFAULT 'fixed',
            chosen_model_id INTEGER,
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

        CREATE TABLE IF NOT EXISTS agent_traces (
            run_id TEXT PRIMARY KEY,
            user_id INTEGER NOT NULL,
            status TEXT DEFAULT 'queued',
            metadata TEXT,
            started_at DATETIME,
            completed_at DATETIME,
            duration_ms INTEGER DEFAULT 0,
            created_at DATETIME DEFAULT (datetime('now', '+8 hours')),
            updated_at DATETIME DEFAULT (datetime('now', '+8 hours')),
            FOREIGN KEY (run_id) REFERENCES agent_runs(id) ON DELETE CASCADE,
            FOREIGN KEY (user_id) REFERENCES users(id)
        );

        CREATE TABLE IF NOT EXISTS agent_trace_spans (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            span_id TEXT NOT NULL UNIQUE,
            run_id TEXT NOT NULL,
            parent_span_id TEXT,
            span_type TEXT NOT NULL,
            name TEXT NOT NULL,
            status TEXT DEFAULT 'running',
            input_summary TEXT,
            output_summary TEXT,
            details TEXT,
            error_message TEXT,
            input_tokens INTEGER DEFAULT 0,
            output_tokens INTEGER DEFAULT 0,
            started_at DATETIME,
            completed_at DATETIME,
            duration_ms INTEGER DEFAULT 0,
            created_at DATETIME DEFAULT (datetime('now', '+8 hours')),
            FOREIGN KEY (run_id) REFERENCES agent_runs(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS agent_run_checkpoints (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            checkpoint_id TEXT NOT NULL UNIQUE,
            run_id TEXT NOT NULL,
            step_index INTEGER DEFAULT 0,
            checkpoint_type TEXT DEFAULT 'step',
            status TEXT DEFAULT 'completed',
            state TEXT NOT NULL,
            created_at DATETIME DEFAULT (datetime('now', '+8 hours')),
            FOREIGN KEY (run_id) REFERENCES agent_runs(id) ON DELETE CASCADE
        );


        CREATE TABLE IF NOT EXISTS agent_eval_suites (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            name TEXT NOT NULL,
            description TEXT,
            target_type TEXT DEFAULT 'free',
            workflow_id INTEGER,
            workflow_version TEXT,
            model_id INTEGER,
            run_config TEXT,
            status TEXT DEFAULT 'active',
            created_at DATETIME DEFAULT (datetime('now', '+8 hours')),
            updated_at DATETIME DEFAULT (datetime('now', '+8 hours')),
            deleted_at DATETIME,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
            FOREIGN KEY (workflow_id) REFERENCES agent_workflows(id) ON DELETE SET NULL,
            FOREIGN KEY (model_id) REFERENCES models(id) ON DELETE SET NULL
        );

        CREATE TABLE IF NOT EXISTS agent_eval_cases (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            suite_id INTEGER NOT NULL,
            name TEXT NOT NULL,
            input TEXT NOT NULL,
            input_variables TEXT,
            expected_output TEXT,
            assertions TEXT,
            sort_order INTEGER DEFAULT 0,
            created_at DATETIME DEFAULT (datetime('now', '+8 hours')),
            updated_at DATETIME DEFAULT (datetime('now', '+8 hours')),
            deleted_at DATETIME,
            FOREIGN KEY (suite_id) REFERENCES agent_eval_suites(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS agent_eval_runs (
            id TEXT PRIMARY KEY,
            suite_id INTEGER NOT NULL,
            user_id INTEGER NOT NULL,
            status TEXT DEFAULT 'running',
            target_snapshot TEXT,
            summary TEXT,
            started_at DATETIME,
            completed_at DATETIME,
            created_at DATETIME DEFAULT (datetime('now', '+8 hours')),
            FOREIGN KEY (suite_id) REFERENCES agent_eval_suites(id) ON DELETE CASCADE,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS agent_eval_results (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            eval_run_id TEXT NOT NULL,
            case_id INTEGER NOT NULL,
            agent_run_id TEXT,
            status TEXT DEFAULT 'queued',
            score REAL DEFAULT 0,
            passed INTEGER DEFAULT 0,
            grader_results TEXT,
            actual_output TEXT,
            error_message TEXT,
            duration_ms INTEGER DEFAULT 0,
            total_tokens INTEGER DEFAULT 0,
            created_at DATETIME DEFAULT (datetime('now', '+8 hours')),
            completed_at DATETIME,
            UNIQUE(eval_run_id, case_id),
            FOREIGN KEY (eval_run_id) REFERENCES agent_eval_runs(id) ON DELETE CASCADE,
            FOREIGN KEY (case_id) REFERENCES agent_eval_cases(id) ON DELETE CASCADE,
            FOREIGN KEY (agent_run_id) REFERENCES agent_runs(id) ON DELETE SET NULL
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
            interval_minutes INTEGER DEFAULT 0,
            cron_expression TEXT DEFAULT '',
            status TEXT DEFAULT 'active',
            run_config TEXT,
            next_run_at DATETIME,
            last_run_at DATETIME,
            last_run_id TEXT,
            claim_token TEXT,
            claim_expires_at DATETIME,
            dispatch_failures INTEGER DEFAULT 0,
            dispatch_retry_at DATETIME,
            last_error TEXT,
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
            scope TEXT DEFAULT 'personal',
            allowed_units TEXT DEFAULT '',
            allowed_user_ids TEXT DEFAULT '',
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

        CREATE TABLE IF NOT EXISTS agent_workflow_dependency_bindings (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            workflow_id INTEGER NOT NULL,
            user_id INTEGER NOT NULL,
            published_version_id INTEGER NOT NULL,
            bindings_json TEXT DEFAULT '{}',
            created_at DATETIME DEFAULT (datetime('now', '+8 hours')),
            updated_at DATETIME DEFAULT (datetime('now', '+8 hours')),
            UNIQUE(workflow_id, user_id),
            FOREIGN KEY (workflow_id) REFERENCES agent_workflows(id) ON DELETE CASCADE,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
            FOREIGN KEY (published_version_id) REFERENCES agent_workflow_versions(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS agent_workflow_triggers (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            workflow_id INTEGER NOT NULL,
            name TEXT NOT NULL,
            trigger_type TEXT DEFAULT 'webhook',
            token_hash TEXT,
            token_hint TEXT DEFAULT '',
            status TEXT DEFAULT 'active',
            config_json TEXT DEFAULT '{}',
            watermark TEXT DEFAULT '',
            last_triggered_at DATETIME,
            last_run_id TEXT,
            trigger_count INTEGER DEFAULT 0,
            last_error TEXT,
            claim_token TEXT,
            claim_expires_at DATETIME,
            created_at DATETIME DEFAULT (datetime('now', '+8 hours')),
            updated_at DATETIME DEFAULT (datetime('now', '+8 hours')),
            deleted_at DATETIME,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
            FOREIGN KEY (workflow_id) REFERENCES agent_workflows(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS workflow_credentials (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            name TEXT NOT NULL,
            slug TEXT NOT NULL,
            description TEXT DEFAULT '',
            secret_value TEXT NOT NULL,
            scope TEXT DEFAULT 'personal',
            allowed_units TEXT DEFAULT '',
            allowed_user_ids TEXT DEFAULT '',
            version INTEGER DEFAULT 1,
            previous_value TEXT,
            previous_expires_at DATETIME,
            last_used_at DATETIME,
            use_count INTEGER DEFAULT 0,
            created_at DATETIME DEFAULT (datetime('now', '+8 hours')),
            updated_at DATETIME DEFAULT (datetime('now', '+8 hours')),
            deleted_at DATETIME,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS agent_artifacts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            run_id TEXT,
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
            input_schema TEXT,
            output_schema TEXT,
            depends_on TEXT,
            condition TEXT,
            status TEXT DEFAULT 'pending',
            output TEXT,
            error_message TEXT,
            contract_status TEXT DEFAULT 'unchecked',
            contract_issues TEXT,
            attempt_count INTEGER DEFAULT 0,
            duration_ms INTEGER DEFAULT 0,
            created_at DATETIME DEFAULT (datetime('now', '+8 hours')),
            started_at DATETIME,
            completed_at DATETIME,
            UNIQUE(run_id, node_key),
            FOREIGN KEY (run_id) REFERENCES agent_runs(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS agent_approval_requests (
            id TEXT PRIMARY KEY,
            run_id TEXT NOT NULL,
            user_id INTEGER NOT NULL,
            request_type TEXT DEFAULT 'approval',
            node_key TEXT DEFAULT '',
            approval_key TEXT DEFAULT '',
            title TEXT DEFAULT '',
            summary TEXT DEFAULT '',
            instructions TEXT DEFAULT '',
            status TEXT DEFAULT 'pending',
            current_level INTEGER DEFAULT 1,
            required_levels INTEGER DEFAULT 1,
            levels_json TEXT DEFAULT '[]',
            decisions_json TEXT DEFAULT '[]',
            input_json TEXT DEFAULT '{}',
            callback_token_hash TEXT,
            callback_token_hint TEXT DEFAULT '',
            callback_nonce TEXT DEFAULT '',
            callback_credential_slug TEXT DEFAULT '',
            callback_signature_required INTEGER DEFAULT 0,
            timeout_action TEXT DEFAULT 'reject',
            expires_at DATETIME,
            decided_at DATETIME,
            decided_by INTEGER,
            created_at DATETIME DEFAULT (datetime('now', '+8 hours')),
            updated_at DATETIME DEFAULT (datetime('now', '+8 hours')),
            FOREIGN KEY (run_id) REFERENCES agent_runs(id) ON DELETE CASCADE,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
            FOREIGN KEY (decided_by) REFERENCES users(id) ON DELETE SET NULL
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

        CREATE TABLE IF NOT EXISTS announcements (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT NOT NULL,
            content TEXT NOT NULL,
            type TEXT DEFAULT 'system',
            priority TEXT DEFAULT 'normal',
            target_type TEXT DEFAULT 'all',
            target_value TEXT DEFAULT '',
            require_ack INTEGER DEFAULT 0,
            show_on_login INTEGER DEFAULT 0,
            starts_at DATETIME,
            ends_at DATETIME,
            status TEXT DEFAULT 'draft',
            created_by INTEGER,
            created_at DATETIME DEFAULT (datetime('now', '+8 hours')),
            updated_at DATETIME DEFAULT (datetime('now', '+8 hours')),
            deleted_at DATETIME,
            FOREIGN KEY (created_by) REFERENCES users(id)
        );

        CREATE TABLE IF NOT EXISTS announcement_reads (
            announcement_id INTEGER NOT NULL,
            user_id INTEGER NOT NULL,
            read_at DATETIME,
            acknowledged_at DATETIME,
            dismissed_at DATETIME,
            PRIMARY KEY (announcement_id, user_id),
            FOREIGN KEY (announcement_id) REFERENCES announcements(id) ON DELETE CASCADE,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS mcp_servers (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER,
            name TEXT NOT NULL,
            base_url TEXT NOT NULL,
            api_key TEXT,
            description TEXT,
            config TEXT,
            scope TEXT DEFAULT 'personal',
            allowed_units TEXT DEFAULT '',
            allowed_user_ids TEXT DEFAULT '',
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

        CREATE TABLE IF NOT EXISTS analysis_datasets (
            id TEXT PRIMARY KEY,
            user_id INTEGER NOT NULL,
            name TEXT NOT NULL,
            original_name TEXT DEFAULT '',
            file_type TEXT DEFAULT '',
            file_size INTEGER DEFAULT 0,
            source_path TEXT DEFAULT '',
            parquet_path TEXT DEFAULT '',
            row_count INTEGER DEFAULT 0,
            column_count INTEGER DEFAULT 0,
            source_row_count INTEGER DEFAULT 0,
            source_column_count INTEGER DEFAULT 0,
            truncated INTEGER DEFAULT 0,
            truncation_reason TEXT DEFAULT '',
            columns_json TEXT DEFAULT '[]',
            profile_json TEXT DEFAULT '[]',
            preview_json TEXT DEFAULT '[]',
            sheet_name TEXT DEFAULT '',
            status TEXT DEFAULT 'ready',
            error_message TEXT DEFAULT '',
            deleted_at DATETIME,
            created_at DATETIME DEFAULT (datetime('now', '+8 hours')),
            updated_at DATETIME DEFAULT (datetime('now', '+8 hours')),
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        );
        CREATE TABLE IF NOT EXISTS analysis_artifacts (
            id TEXT PRIMARY KEY,
            user_id INTEGER NOT NULL,
            dataset_id TEXT DEFAULT '',
            type TEXT NOT NULL,
            title TEXT NOT NULL,
            content TEXT DEFAULT '',
            file_path TEXT DEFAULT '',
            metadata_json TEXT DEFAULT '{}',
            created_at DATETIME DEFAULT (datetime('now', '+8 hours')),
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        );
        CREATE TABLE IF NOT EXISTS analysis_cleaning_runs (
            id TEXT PRIMARY KEY,
            user_id INTEGER NOT NULL,
            source_dataset_id TEXT NOT NULL,
            output_dataset_id TEXT DEFAULT '',
            name TEXT NOT NULL,
            rules_json TEXT DEFAULT '[]',
            summary_json TEXT DEFAULT '{}',
            status TEXT DEFAULT 'applied',
            created_at DATETIME DEFAULT (datetime('now', '+8 hours')),
            updated_at DATETIME DEFAULT (datetime('now', '+8 hours')),
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS rate_limit_counters (
            key TEXT PRIMARY KEY,
            window_start_ms INTEGER NOT NULL,
            reset_at_ms INTEGER NOT NULL,
            hits INTEGER NOT NULL DEFAULT 0,
            updated_at DATETIME DEFAULT (datetime('now', '+8 hours'))
        );

        CREATE TABLE IF NOT EXISTS analysis_semantic_jobs (
            id TEXT PRIMARY KEY,
            user_id INTEGER NOT NULL,
            dataset_id TEXT NOT NULL,
            model_id INTEGER,
            text_field TEXT NOT NULL,
            id_field TEXT DEFAULT '',
            instruction TEXT NOT NULL,
            status TEXT DEFAULT 'queued',
            total_rows INTEGER DEFAULT 0,
            analyzed_rows INTEGER DEFAULT 0,
            total_chars INTEGER DEFAULT 0,
            total_batches INTEGER DEFAULT 0,
            completed_batches INTEGER DEFAULT 0,
            succeeded_batches INTEGER DEFAULT 0,
            failed_batches INTEGER DEFAULT 0,
            attempts INTEGER DEFAULT 0,
            max_attempts INTEGER DEFAULT 3,
            options_json TEXT DEFAULT '{}',
            result_json TEXT DEFAULT '{}',
            report_text TEXT DEFAULT '',
            last_error TEXT DEFAULT '',
            locked_at DATETIME,
            next_run_at DATETIME,
            started_at DATETIME,
            completed_at DATETIME,
            created_at DATETIME DEFAULT (datetime('now', '+8 hours')),
            updated_at DATETIME DEFAULT (datetime('now', '+8 hours')),
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
            FOREIGN KEY (dataset_id) REFERENCES analysis_datasets(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS analysis_semantic_batches (
            id TEXT PRIMARY KEY,
            job_id TEXT NOT NULL,
            batch_index INTEGER NOT NULL,
            segment_start INTEGER NOT NULL,
            segment_end INTEGER NOT NULL,
            row_start INTEGER DEFAULT 0,
            row_end INTEGER DEFAULT 0,
            segment_count INTEGER DEFAULT 0,
            row_count INTEGER DEFAULT 0,
            char_count INTEGER DEFAULT 0,
            status TEXT DEFAULT 'queued',
            attempts INTEGER DEFAULT 0,
            max_attempts INTEGER DEFAULT 3,
            result_text TEXT DEFAULT '',
            result_json TEXT DEFAULT '{}',
            last_error TEXT DEFAULT '',
            locked_at DATETIME,
            started_at DATETIME,
            completed_at DATETIME,
            created_at DATETIME DEFAULT (datetime('now', '+8 hours')),
            updated_at DATETIME DEFAULT (datetime('now', '+8 hours')),
            FOREIGN KEY (job_id) REFERENCES analysis_semantic_jobs(id) ON DELETE CASCADE,
            UNIQUE (job_id, batch_index)
        );

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

        ${enterpriseTablesSql()}
    `;
}

/**
 * 索引 DDL（SQLite 与 PostgreSQL 共用；PG 侧仅做少量方言修正）
 */
function baseIndexesSql() {
    return `
        CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_logs(user_id);
        CREATE INDEX IF NOT EXISTS idx_models_user ON models(user_id);
        CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
        CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);
        CREATE INDEX IF NOT EXISTS idx_messages_user ON messages(user_id);
        CREATE INDEX IF NOT EXISTS idx_memories_user_status ON memories(user_id, status, updated_at);
        CREATE INDEX IF NOT EXISTS idx_memories_user_type ON memories(user_id, type, status);
        CREATE INDEX IF NOT EXISTS idx_memories_source_session ON memories(source_session_id);
        CREATE INDEX IF NOT EXISTS idx_memory_jobs_status_next_run ON memory_extraction_jobs(status, next_run_at, id);
        CREATE INDEX IF NOT EXISTS idx_memory_jobs_user_status ON memory_extraction_jobs(user_id, status, updated_at);
        CREATE INDEX IF NOT EXISTS idx_memory_jobs_dedupe ON memory_extraction_jobs(dedupe_key, status);
        CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user ON refresh_tokens(user_id);
        CREATE INDEX IF NOT EXISTS idx_refresh_tokens_token ON refresh_tokens(token);
        CREATE INDEX IF NOT EXISTS idx_rate_limit_counters_reset ON rate_limit_counters(reset_at_ms);
        CREATE INDEX IF NOT EXISTS idx_api_keys_user ON api_keys(user_id);
        CREATE INDEX IF NOT EXISTS idx_model_usage_user_model_created ON model_usage_events(user_id, model_id, created_at);
        CREATE INDEX IF NOT EXISTS idx_api_call_logs_created ON api_call_logs(created_at);
        CREATE INDEX IF NOT EXISTS idx_api_call_logs_user ON api_call_logs(user_id, created_at);
        CREATE INDEX IF NOT EXISTS idx_api_call_logs_key ON api_call_logs(api_key_id, created_at);
        -- Indexes for columns added by legacy automation migrations are created after ensureColumn().
        CREATE INDEX IF NOT EXISTS idx_agent_runs_user_created ON agent_runs(user_id, created_at);
        CREATE INDEX IF NOT EXISTS idx_agent_steps_run ON agent_steps(run_id, step_index);
        CREATE INDEX IF NOT EXISTS idx_agent_traces_user_created ON agent_traces(user_id, created_at);
        CREATE INDEX IF NOT EXISTS idx_agent_trace_spans_run_started ON agent_trace_spans(run_id, started_at, id);
    CREATE INDEX IF NOT EXISTS idx_agent_trace_spans_parent ON agent_trace_spans(parent_span_id);
        CREATE INDEX IF NOT EXISTS idx_agent_checkpoints_run_step ON agent_run_checkpoints(run_id, step_index, id);
        CREATE INDEX IF NOT EXISTS idx_agent_eval_suites_user_updated ON agent_eval_suites(user_id, deleted_at, updated_at);
        CREATE INDEX IF NOT EXISTS idx_agent_eval_cases_suite_order ON agent_eval_cases(suite_id, sort_order, id);
        CREATE INDEX IF NOT EXISTS idx_agent_eval_runs_suite_created ON agent_eval_runs(suite_id, created_at);
        CREATE INDEX IF NOT EXISTS idx_agent_eval_results_run_status ON agent_eval_results(eval_run_id, status);
        CREATE INDEX IF NOT EXISTS idx_agent_eval_results_agent_run ON agent_eval_results(agent_run_id);
        CREATE INDEX IF NOT EXISTS idx_agent_templates_user ON agent_templates(user_id, deleted_at);
        CREATE INDEX IF NOT EXISTS idx_agent_schedules_user_status ON agent_schedules(user_id, status, deleted_at);
        CREATE INDEX IF NOT EXISTS idx_agent_schedules_due ON agent_schedules(status, next_run_at, deleted_at);
        CREATE INDEX IF NOT EXISTS idx_agent_workflows_user ON agent_workflows(user_id, deleted_at, updated_at);
        CREATE INDEX IF NOT EXISTS idx_agent_workflows_scope ON agent_workflows(scope, deleted_at, updated_at);
        CREATE INDEX IF NOT EXISTS idx_agent_workflow_versions_workflow ON agent_workflow_versions(workflow_id, version);
        CREATE INDEX IF NOT EXISTS idx_agent_workflow_dependency_bindings_user ON agent_workflow_dependency_bindings(user_id, updated_at);
        CREATE INDEX IF NOT EXISTS idx_agent_workflow_triggers_user ON agent_workflow_triggers(user_id, deleted_at, updated_at);
        CREATE INDEX IF NOT EXISTS idx_agent_workflow_triggers_workflow ON agent_workflow_triggers(workflow_id, deleted_at);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_workflow_triggers_token ON agent_workflow_triggers(token_hash) WHERE token_hash IS NOT NULL;
        CREATE INDEX IF NOT EXISTS idx_agent_workflow_triggers_poll ON agent_workflow_triggers(trigger_type, status, deleted_at);
        CREATE INDEX IF NOT EXISTS idx_workflow_credentials_user ON workflow_credentials(user_id, deleted_at, updated_at);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_workflow_credentials_slug ON workflow_credentials(user_id, slug) WHERE deleted_at IS NULL;
        CREATE INDEX IF NOT EXISTS idx_workflow_credentials_scope ON workflow_credentials(scope, deleted_at);
        CREATE INDEX IF NOT EXISTS idx_agent_artifacts_user ON agent_artifacts(user_id, created_at);
        CREATE INDEX IF NOT EXISTS idx_agent_artifact_versions_artifact ON agent_artifact_versions(artifact_id, version);
        CREATE INDEX IF NOT EXISTS idx_agent_dag_nodes_run ON agent_dag_nodes(run_id, status);
        CREATE INDEX IF NOT EXISTS idx_agent_approval_requests_run ON agent_approval_requests(run_id, request_type, status);
        CREATE INDEX IF NOT EXISTS idx_agent_approval_requests_user ON agent_approval_requests(user_id, status, created_at);
        CREATE INDEX IF NOT EXISTS idx_agent_approval_requests_expires ON agent_approval_requests(status, expires_at);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_approval_requests_callback_token ON agent_approval_requests(callback_token_hash) WHERE callback_token_hash IS NOT NULL;
        CREATE INDEX IF NOT EXISTS idx_agent_notifications_user ON agent_notifications(user_id, status, created_at);
        CREATE INDEX IF NOT EXISTS idx_announcements_status_window ON announcements(status, starts_at, ends_at, deleted_at);
        CREATE INDEX IF NOT EXISTS idx_announcements_deleted_updated ON announcements(deleted_at, updated_at DESC, id DESC);
        CREATE INDEX IF NOT EXISTS idx_announcements_target ON announcements(target_type, target_value);
        CREATE INDEX IF NOT EXISTS idx_announcement_reads_user ON announcement_reads(user_id, announcement_id);
        CREATE INDEX IF NOT EXISTS idx_announcement_reads_announcement ON announcement_reads(announcement_id);
        CREATE INDEX IF NOT EXISTS idx_capability_packages_user ON capability_packages(user_id, status, type);
        CREATE INDEX IF NOT EXISTS idx_observability_events_type_created ON observability_events(type, created_at);
        CREATE INDEX IF NOT EXISTS idx_observability_events_status_created ON observability_events(status, created_at);
        CREATE INDEX IF NOT EXISTS idx_mcp_servers_user ON mcp_servers(user_id, status);
        CREATE INDEX IF NOT EXISTS idx_mcp_servers_scope ON mcp_servers(scope, status, updated_at);
        CREATE INDEX IF NOT EXISTS idx_mcp_tool_cache_server ON mcp_tool_cache(server_id);
        CREATE INDEX IF NOT EXISTS idx_mcp_call_logs_server_created ON mcp_call_logs(server_id, created_at);
        CREATE INDEX IF NOT EXISTS idx_mcp_call_logs_user_created ON mcp_call_logs(user_id, created_at);
        CREATE INDEX IF NOT EXISTS idx_mcp_database_connections_server ON mcp_database_connections(mcp_server_id);
        CREATE INDEX IF NOT EXISTS idx_mcp_database_connections_user ON mcp_database_connections(user_id, status);
        CREATE INDEX IF NOT EXISTS idx_mcp_builtin_configs_server ON mcp_builtin_configs(mcp_server_id);
        CREATE INDEX IF NOT EXISTS idx_mcp_builtin_configs_user ON mcp_builtin_configs(user_id, service_type, status);
        CREATE INDEX IF NOT EXISTS idx_analysis_datasets_user ON analysis_datasets(user_id, deleted_at, updated_at);
        CREATE INDEX IF NOT EXISTS idx_analysis_artifacts_user ON analysis_artifacts(user_id, dataset_id, created_at);
        CREATE INDEX IF NOT EXISTS idx_analysis_cleaning_runs_source ON analysis_cleaning_runs(user_id, source_dataset_id, created_at);
        CREATE INDEX IF NOT EXISTS idx_analysis_semantic_jobs_user_status ON analysis_semantic_jobs(user_id, status, updated_at);
        CREATE INDEX IF NOT EXISTS idx_analysis_semantic_jobs_dataset ON analysis_semantic_jobs(dataset_id, created_at);
        CREATE INDEX IF NOT EXISTS idx_analysis_semantic_jobs_due ON analysis_semantic_jobs(status, next_run_at, updated_at);
        CREATE INDEX IF NOT EXISTS idx_analysis_semantic_batches_job_status ON analysis_semantic_batches(job_id, status, batch_index);
        CREATE INDEX IF NOT EXISTS idx_kg_relations_source_chunk ON knowledge_relations(source_chunk_id);
        CREATE INDEX IF NOT EXISTS idx_rag_feedback_user_created ON rag_feedback(user_id, created_at);
        -- 质量报告按 (user_id, doc_name) 文本键聚合反馈，补充索引避免全表扫描
        CREATE INDEX IF NOT EXISTS idx_rag_feedback_user_doc ON rag_feedback(user_id, doc_name);
        CREATE INDEX IF NOT EXISTS idx_audit_logs_timestamp ON audit_logs(timestamp);
        CREATE INDEX IF NOT EXISTS idx_audit_logs_timestamp_user ON audit_logs(timestamp, user_id);
        CREATE INDEX IF NOT EXISTS idx_audit_logs_user_timestamp ON audit_logs(user_id, timestamp);
        CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at);
        CREATE INDEX IF NOT EXISTS idx_messages_user_created ON messages(user_id, created_at);
        CREATE INDEX IF NOT EXISTS idx_messages_user_deleted ON messages(user_id, deleted_at);
        CREATE INDEX IF NOT EXISTS idx_model_usage_created ON model_usage_events(created_at);
        CREATE INDEX IF NOT EXISTS idx_api_call_logs_created_at ON api_call_logs(created_at);
        CREATE INDEX IF NOT EXISTS idx_knowledge_docs_created ON knowledge_docs(created_at);
        CREATE INDEX IF NOT EXISTS idx_attachments_created ON attachments(created_at);
        CREATE INDEX IF NOT EXISTS idx_prompts_created ON prompts(created_at);

        CREATE INDEX IF NOT EXISTS idx_regulation_documents_status ON regulation_documents(status, deleted_at, updated_at);
        CREATE INDEX IF NOT EXISTS idx_regulation_documents_category ON regulation_documents(category, deleted_at, updated_at);
        CREATE INDEX IF NOT EXISTS idx_regulation_documents_jurisdiction ON regulation_documents(jurisdiction, deleted_at, updated_at);
        CREATE INDEX IF NOT EXISTS idx_regulation_documents_updated ON regulation_documents(updated_at DESC, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_regulation_versions_document ON regulation_versions(document_id, id DESC);
        CREATE INDEX IF NOT EXISTS idx_regulation_articles_document ON regulation_articles(document_id, sort_order, id);
        CREATE INDEX IF NOT EXISTS idx_regulation_articles_version ON regulation_articles(version_id, sort_order, id);
        CREATE INDEX IF NOT EXISTS idx_regulation_article_links_version ON regulation_article_links(version_id);
        CREATE INDEX IF NOT EXISTS idx_regulation_article_links_source ON regulation_article_links(source_article_id);
        CREATE INDEX IF NOT EXISTS idx_regulation_article_links_target ON regulation_article_links(target_article_id);
        CREATE INDEX IF NOT EXISTS idx_regulation_aliases_document ON regulation_aliases(document_id);
        CREATE INDEX IF NOT EXISTS idx_regulation_aliases_normalized ON regulation_aliases(normalized_alias);
        CREATE INDEX IF NOT EXISTS idx_regulation_annotations_article ON regulation_article_annotations(article_id);
        CREATE INDEX IF NOT EXISTS idx_regulation_annotations_user ON regulation_article_annotations(user_id);
        CREATE INDEX IF NOT EXISTS idx_regulation_access_user ON regulation_access_logs(user_id);
        CREATE INDEX IF NOT EXISTS idx_regulation_access_document ON regulation_access_logs(document_id);
        CREATE INDEX IF NOT EXISTS idx_regulation_access_created ON regulation_access_logs(created_at);
        CREATE INDEX IF NOT EXISTS idx_regulation_saved_searches_user ON regulation_saved_searches(user_id);

        ${enterpriseIndexesSql()}
    `;
}

/**
 * SQLite 专属：FTS5 全文索引虚拟表与同步触发器。
 * PostgreSQL 侧不建虚拟表，改用 pg_trgm GIN 索引，见 server/db/schema/pg.js。
 */
function sqliteFtsSql() {
    return `
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

        CREATE VIRTUAL TABLE IF NOT EXISTS regulation_articles_fts USING fts5(
            content,
            tokenize='unicode61'
        );
        CREATE TRIGGER IF NOT EXISTS trg_regulation_articles_insert AFTER INSERT ON regulation_articles BEGIN
            INSERT INTO regulation_articles_fts(rowid, content) VALUES (new.id, COALESCE(new.search_content, new.content));
        END;
        CREATE TRIGGER IF NOT EXISTS trg_regulation_articles_delete AFTER DELETE ON regulation_articles BEGIN
            DELETE FROM regulation_articles_fts WHERE rowid = old.id;
        END;
        CREATE TRIGGER IF NOT EXISTS trg_regulation_articles_update AFTER UPDATE ON regulation_articles BEGIN
            UPDATE regulation_articles_fts SET content = COALESCE(new.search_content, new.content) WHERE rowid = new.id;
        END;

        CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
            content,
            tokenize='unicode61'
        );

        -- 触发器：同步消息到全文索引
        -- 注意：这些触发器不区分软删除（deleted_at），被软删除的消息仍保留在 messages_fts 中。
        -- 因此全文搜索查询必须在 SQL 层显式过滤 m.deleted_at IS NULL（参见 routes/sessions.js 搜索路由），
        -- 不要依赖 FTS 索引本身排除已删除消息。
        CREATE TRIGGER IF NOT EXISTS trg_messages_insert AFTER INSERT ON messages BEGIN
            INSERT INTO messages_fts(rowid, content) VALUES (new.id, new.content);
        END;
        CREATE TRIGGER IF NOT EXISTS trg_messages_delete AFTER DELETE ON messages BEGIN
            DELETE FROM messages_fts WHERE rowid = old.id;
        END;
        CREATE TRIGGER IF NOT EXISTS trg_messages_update AFTER UPDATE ON messages WHEN old.content != new.content BEGIN
            UPDATE messages_fts SET content = new.content WHERE rowid = new.id;
        END;
    `;
}

function initSchema() {
    if (!db || typeof db.exec !== 'function') {
        throw new Error('[DB] 当前版本已切换为 PostgreSQL-only；SQLite initSchema 仅允许历史旧库升级工具显式注入 SQLite 连接后调用。');
    }
    applyLegacySchemaPreflight();
    db.exec(baseTablesSql());
    db.exec(baseIndexesSql());
    db.exec(sqliteFtsSql());
}

module.exports = { initSchema, baseTablesSql, baseIndexesSql, sqliteFtsSql };
