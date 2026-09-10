/**
 * 核心业务与知识库基础表 DDL（SQLite 方言）
 */
function coreTablesSql() {
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
            context_token_count INTEGER,
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
            chunk_index INTEGER DEFAULT 0,
            char_start INTEGER,
            char_end INTEGER,
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
            family_id TEXT DEFAULT '',
            consumed_at DATETIME,
            device_id TEXT DEFAULT '',
            created_at DATETIME DEFAULT (datetime('now', '+8 hours')),
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS api_keys (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            name TEXT NOT NULL,
            key_hash TEXT UNIQUE,
            key_preview TEXT,
            key TEXT, status TEXT DEFAULT 'active', scopes TEXT DEFAULT 'openai', expires_at DATETIME,
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
            created_at DATETIME DEFAULT (datetime('now', '+8 hours'))
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
            FOREIGN KEY (api_key_id) REFERENCES api_keys(id) ON DELETE SET NULL,
            FOREIGN KEY (model_id) REFERENCES models(id)
        );
    `;
}

module.exports = { coreTablesSql };
