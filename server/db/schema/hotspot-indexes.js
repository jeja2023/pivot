// PostgreSQL/SQLite 共用的业务热点与外键级联索引。
// 单独拆分，避免基础 schema 文件继续膨胀，也便于索引基线逐项审查。
function hotspotIndexesSql() {
    return `
        CREATE INDEX IF NOT EXISTS idx_messages_session_user_created ON messages(session_id, user_id, created_at);
        CREATE INDEX IF NOT EXISTS idx_users_status ON users(status);
        CREATE INDEX IF NOT EXISTS idx_sessions_user_archived ON sessions(user_id, is_archived, is_pinned, created_at);
        CREATE INDEX IF NOT EXISTS idx_prompts_scope_user ON prompts(scope, user_id);
        CREATE INDEX IF NOT EXISTS idx_prompts_type ON prompts(type, category);
        CREATE INDEX IF NOT EXISTS idx_attachments_user_session ON attachments(user_id, session_id);
        CREATE INDEX IF NOT EXISTS idx_attachments_token ON attachments(access_token);
        CREATE INDEX IF NOT EXISTS idx_document_files_user_created ON document_files(user_id, created_at);
        CREATE INDEX IF NOT EXISTS idx_document_files_source ON document_files(source_module, source_ref);
        CREATE INDEX IF NOT EXISTS idx_document_jobs_user_status ON document_jobs(user_id, status, updated_at);
        CREATE INDEX IF NOT EXISTS idx_document_jobs_file ON document_jobs(file_id, created_at);
        CREATE INDEX IF NOT EXISTS idx_document_pages_job_number ON document_pages(job_id, page_number);
        CREATE INDEX IF NOT EXISTS idx_document_blocks_page_order ON document_ocr_blocks(page_id, sort_order);
        CREATE INDEX IF NOT EXISTS idx_document_outputs_user_job ON document_outputs(user_id, job_id, created_at);
        CREATE INDEX IF NOT EXISTS idx_document_reviews_page ON document_reviews(page_id, updated_at);
        CREATE INDEX IF NOT EXISTS idx_knowledge_collections_user ON knowledge_collections(user_id, deleted_at, updated_at);
        CREATE INDEX IF NOT EXISTS idx_knowledge_collections_scope ON knowledge_collections(scope, deleted_at, updated_at);
        CREATE INDEX IF NOT EXISTS idx_knowledge_docs_user_status ON knowledge_docs(user_id, status);
        CREATE INDEX IF NOT EXISTS idx_knowledge_chunks_doc ON knowledge_chunks(doc_id);
        CREATE INDEX IF NOT EXISTS idx_knowledge_doc_tags_user_tag ON knowledge_doc_tags(user_id, tag);
        CREATE INDEX IF NOT EXISTS idx_knowledge_doc_tags_doc ON knowledge_doc_tags(doc_id);
        CREATE INDEX IF NOT EXISTS idx_knowledge_tags_user ON knowledge_tags(user_id, deleted_at, tag);
        CREATE INDEX IF NOT EXISTS idx_kg_mentions_user ON knowledge_entity_mentions(user_id);
        CREATE INDEX IF NOT EXISTS idx_kg_mentions_chunk ON knowledge_entity_mentions(chunk_id);
        CREATE INDEX IF NOT EXISTS idx_kg_relations_user_status ON knowledge_relations(user_id, status);
        CREATE INDEX IF NOT EXISTS idx_kg_relations_source_entity ON knowledge_relations(source_entity_id, status);
        CREATE INDEX IF NOT EXISTS idx_kg_relations_target_entity ON knowledge_relations(target_entity_id, status);
    `;
}

module.exports = { hotspotIndexesSql };
