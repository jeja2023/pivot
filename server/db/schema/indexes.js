const { hotspotIndexesSql } = require('./hotspot-indexes');
const { enterpriseIndexesSql } = require('./enterprise');

/**
 * 索引 DDL（SQLite 与 PostgreSQL 共用；PG 侧仅做少量方言修正）
 */
function baseIndexesSql() {
    return `
        CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_logs(user_id);
        CREATE INDEX IF NOT EXISTS idx_models_user ON models(user_id);
        CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
        CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);
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
        CREATE INDEX IF NOT EXISTS idx_official_writing_documents_user_updated ON official_writing_documents(user_id, deleted_at, updated_at);
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
        ${hotspotIndexesSql()}
        CREATE INDEX IF NOT EXISTS idx_kg_relations_source_chunk ON knowledge_relations(source_chunk_id);
        CREATE INDEX IF NOT EXISTS idx_rag_feedback_user_created ON rag_feedback(user_id, created_at);
        -- 质量报告按 (user_id, doc_name) 文本键聚合反馈，补充索引避免全表扫描
        CREATE INDEX IF NOT EXISTS idx_rag_feedback_user_doc ON rag_feedback(user_id, doc_name);
        CREATE INDEX IF NOT EXISTS idx_audit_logs_timestamp_user ON audit_logs(timestamp, user_id);
        CREATE INDEX IF NOT EXISTS idx_audit_logs_user_timestamp ON audit_logs(user_id, timestamp);
        CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at);
        CREATE INDEX IF NOT EXISTS idx_messages_user_created ON messages(user_id, created_at);
        CREATE INDEX IF NOT EXISTS idx_messages_user_deleted ON messages(user_id, deleted_at);
        CREATE INDEX IF NOT EXISTS idx_model_usage_created ON model_usage_events(created_at);
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

module.exports = { baseIndexesSql };

