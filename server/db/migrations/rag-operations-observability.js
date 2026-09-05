module.exports = [
    {
        id: '202609050005_rag_operations_observability',
        description: 'Persist bounded embedding latency buckets for RAG operations monitoring.',
        up(db) {
            db.exec(`
                CREATE TABLE IF NOT EXISTS rag_embedding_latency_buckets (
                    bucket_at DATETIME NOT NULL,
                    model_key TEXT NOT NULL,
                    source TEXT NOT NULL,
                    status TEXT NOT NULL,
                    request_count INTEGER NOT NULL DEFAULT 0,
                    input_count INTEGER NOT NULL DEFAULT 0,
                    input_tokens INTEGER NOT NULL DEFAULT 0,
                    total_duration_ms INTEGER NOT NULL DEFAULT 0,
                    max_duration_ms INTEGER NOT NULL DEFAULT 0,
                    error_count INTEGER NOT NULL DEFAULT 0,
                    updated_at DATETIME NOT NULL,
                    PRIMARY KEY (bucket_at, model_key, source, status)
                );
                CREATE INDEX IF NOT EXISTS idx_rag_embedding_latency_recent
                    ON rag_embedding_latency_buckets(bucket_at DESC, model_key, status);
            `);
        },
        async upPg(client) {
            await client.query(`
                CREATE TABLE IF NOT EXISTS rag_embedding_latency_buckets (
                    bucket_at TIMESTAMPTZ NOT NULL,
                    model_key VARCHAR(180) NOT NULL,
                    source VARCHAR(80) NOT NULL,
                    status VARCHAR(16) NOT NULL,
                    request_count BIGINT NOT NULL DEFAULT 0,
                    input_count BIGINT NOT NULL DEFAULT 0,
                    input_tokens BIGINT NOT NULL DEFAULT 0,
                    total_duration_ms BIGINT NOT NULL DEFAULT 0,
                    max_duration_ms BIGINT NOT NULL DEFAULT 0,
                    error_count BIGINT NOT NULL DEFAULT 0,
                    updated_at TIMESTAMPTZ NOT NULL,
                    PRIMARY KEY (bucket_at, model_key, source, status)
                );
                CREATE INDEX IF NOT EXISTS idx_rag_embedding_latency_recent
                    ON rag_embedding_latency_buckets(bucket_at DESC, model_key, status);
            `);
        }
    }
];
