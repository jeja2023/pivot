module.exports = [
    {
        id: '202609180001_chat_adaptive_routing',
        description: 'Persist collection catalog vectors, bounded chat route metrics, and safe route summaries for chat history.',
        up(db) {
            const messageColumns = db.pragma('table_info(messages)');
            if (messageColumns.length && !messageColumns.some(column => column.name === 'route_metadata')) {
                db.exec("ALTER TABLE messages ADD COLUMN route_metadata TEXT DEFAULT '{}'");
            }
            db.exec(`
                CREATE TABLE IF NOT EXISTS knowledge_collection_catalog (
                    collection_id INTEGER NOT NULL,
                    embedding_key TEXT NOT NULL,
                    semantic_summary TEXT NOT NULL DEFAULT '',
                    domain_tags TEXT NOT NULL DEFAULT '[]',
                    embedding_vector TEXT NOT NULL DEFAULT '[]',
                    embedding_dimensions INTEGER NOT NULL DEFAULT 0,
                    source_version TEXT NOT NULL DEFAULT '',
                    created_at DATETIME NOT NULL,
                    updated_at DATETIME NOT NULL,
                    PRIMARY KEY (collection_id, embedding_key),
                    FOREIGN KEY (collection_id) REFERENCES knowledge_collections(id) ON DELETE CASCADE
                );
                CREATE INDEX IF NOT EXISTS idx_knowledge_collection_catalog_updated
                    ON knowledge_collection_catalog(collection_id, updated_at DESC);
                CREATE TABLE IF NOT EXISTS chat_route_metrics_buckets (
                    bucket_at DATETIME NOT NULL,
                    route_mode TEXT NOT NULL,
                    rag_action TEXT NOT NULL,
                    tool_action TEXT NOT NULL,
                    request_count INTEGER NOT NULL DEFAULT 0,
                    error_count INTEGER NOT NULL DEFAULT 0,
                    total_route_duration_ms INTEGER NOT NULL DEFAULT 0,
                    total_embedding_duration_ms INTEGER NOT NULL DEFAULT 0,
                    total_rag_candidates INTEGER NOT NULL DEFAULT 0,
                    total_tool_candidates INTEGER NOT NULL DEFAULT 0,
                    updated_at DATETIME NOT NULL,
                    PRIMARY KEY (bucket_at, route_mode, rag_action, tool_action)
                );
                CREATE INDEX IF NOT EXISTS idx_chat_route_metrics_recent
                    ON chat_route_metrics_buckets(bucket_at DESC, route_mode);
            `);
        },
        async upPg(client) {
            await client.query(`
                ALTER TABLE messages ADD COLUMN IF NOT EXISTS route_metadata TEXT DEFAULT '{}';
                CREATE TABLE IF NOT EXISTS knowledge_collection_catalog (
                    collection_id BIGINT NOT NULL,
                    embedding_key VARCHAR(128) NOT NULL,
                    semantic_summary TEXT NOT NULL DEFAULT '',
                    domain_tags JSONB NOT NULL DEFAULT '[]'::jsonb,
                    embedding_vector JSONB NOT NULL DEFAULT '[]'::jsonb,
                    embedding_dimensions BIGINT NOT NULL DEFAULT 0,
                    source_version VARCHAR(128) NOT NULL DEFAULT '',
                    created_at TIMESTAMPTZ NOT NULL,
                    updated_at TIMESTAMPTZ NOT NULL,
                    PRIMARY KEY (collection_id, embedding_key),
                    FOREIGN KEY (collection_id) REFERENCES knowledge_collections(id) ON DELETE CASCADE
                );
                CREATE INDEX IF NOT EXISTS idx_knowledge_collection_catalog_updated
                    ON knowledge_collection_catalog(collection_id, updated_at DESC);
                CREATE TABLE IF NOT EXISTS chat_route_metrics_buckets (
                    bucket_at TIMESTAMPTZ NOT NULL,
                    route_mode VARCHAR(16) NOT NULL,
                    rag_action VARCHAR(24) NOT NULL,
                    tool_action VARCHAR(24) NOT NULL,
                    request_count BIGINT NOT NULL DEFAULT 0,
                    error_count BIGINT NOT NULL DEFAULT 0,
                    total_route_duration_ms BIGINT NOT NULL DEFAULT 0,
                    total_embedding_duration_ms BIGINT NOT NULL DEFAULT 0,
                    total_rag_candidates BIGINT NOT NULL DEFAULT 0,
                    total_tool_candidates BIGINT NOT NULL DEFAULT 0,
                    updated_at TIMESTAMPTZ NOT NULL,
                    PRIMARY KEY (bucket_at, route_mode, rag_action, tool_action)
                );
                CREATE INDEX IF NOT EXISTS idx_chat_route_metrics_recent
                    ON chat_route_metrics_buckets(bucket_at DESC, route_mode);
            `);
        }
    }
];
