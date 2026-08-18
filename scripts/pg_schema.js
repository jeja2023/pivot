/**
 * scripts/pg_schema.js
 * 在 PostgreSQL 数据库中创建 Pivot 全量 Schema
 * 用法: node scripts/pg_schema.js
 */
const { Pool } = require('pg');

const pool = new Pool({
    connectionString: process.env.DATABASE_URL || 'postgresql://postgres:123456@localhost:5432/pivot',
    connectionTimeoutMillis: 10000
});

// DDL 语句数组 —— 按依赖拓扑顺序排列
const DDL = [];

// ── 1. 基础无依赖表 ──────────────────────────────────────────────────────
DDL.push(`
CREATE TABLE IF NOT EXISTS users (
    id                  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    username            TEXT UNIQUE NOT NULL,
    deleted_username    TEXT,
    password_hash       TEXT NOT NULL,
    nickname            TEXT,
    unit                TEXT,
    role                TEXT DEFAULT 'user',
    status              TEXT DEFAULT 'active',
    deleted_at          TIMESTAMPTZ,
    deleted_by_admin    BOOLEAN DEFAULT FALSE,
    last_login_at       TIMESTAMPTZ,
    created_at          TIMESTAMPTZ DEFAULT NOW()
)`);

DDL.push(`
CREATE TABLE IF NOT EXISTS app_meta (
    key        TEXT PRIMARY KEY,
    value      TEXT,
    updated_at TIMESTAMPTZ
)`);

DDL.push(`
CREATE TABLE IF NOT EXISTS models (
    id                      BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id                 BIGINT REFERENCES users(id),
    name                    TEXT NOT NULL,
    url                     TEXT NOT NULL,
    api_key                 TEXT,
    model_name              TEXT,
    is_default              BOOLEAN DEFAULT FALSE,
    daily_token_limit       INTEGER DEFAULT 0,
    allowed_units           TEXT DEFAULT '',
    status                  TEXT DEFAULT 'active',
    temperature             DOUBLE PRECISION,
    max_input_tokens        INTEGER,
    max_tokens              INTEGER,
    context_window_tokens   INTEGER,
    monitor_url             TEXT,
    max_concurrent          INTEGER DEFAULT 0,
    supports_vision         BOOLEAN DEFAULT FALSE,
    supports_reasoning      BOOLEAN DEFAULT FALSE,
    chat_thinking_enabled   BOOLEAN DEFAULT FALSE,
    input_price_per_million  DOUBLE PRECISION DEFAULT 0,
    output_price_per_million DOUBLE PRECISION DEFAULT 0,
    price_currency          TEXT DEFAULT '人民币',
    created_at              TIMESTAMPTZ DEFAULT NOW()
)`);

DDL.push(`
CREATE TABLE IF NOT EXISTS app_settings (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at TIMESTAMPTZ,
    updated_by BIGINT REFERENCES users(id)
)`);

DDL.push(`
CREATE TABLE IF NOT EXISTS user_settings (
    user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    key        TEXT NOT NULL,
    value      TEXT NOT NULL,
    updated_at TIMESTAMPTZ,
    PRIMARY KEY (user_id, key)
)`);

DDL.push(`
CREATE TABLE IF NOT EXISTS sessions (
    id                      TEXT PRIMARY KEY,
    user_id                 BIGINT NOT NULL REFERENCES users(id),
    title                   TEXT,
    is_pinned               BOOLEAN DEFAULT FALSE,
    is_archived             BOOLEAN DEFAULT FALSE,
    tags                    TEXT DEFAULT '',
    system_prompt           TEXT,
    deleted_at              TIMESTAMPTZ,
    deleted_by_user         BOOLEAN DEFAULT FALSE,
    parent_session_id       TEXT REFERENCES sessions(id),
    forked_from_message_id  BIGINT,
    fork_root_session_id    TEXT,
    fork_note               TEXT,
    created_at              TIMESTAMPTZ DEFAULT NOW(),
    updated_at              TIMESTAMPTZ DEFAULT NOW()
)`);

DDL.push(`
CREATE TABLE IF NOT EXISTS messages (
    id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    session_id        TEXT NOT NULL REFERENCES sessions(id),
    user_id           BIGINT NOT NULL REFERENCES users(id),
    role              TEXT NOT NULL,
    content           TEXT NOT NULL,
    token_count       INTEGER DEFAULT 0,
    is_summary        BOOLEAN DEFAULT FALSE,
    context_archived  BOOLEAN DEFAULT FALSE,
    compressed_at     TIMESTAMPTZ,
    model_id          BIGINT REFERENCES models(id),
    deleted_at        TIMESTAMPTZ,
    deleted_by_user   BOOLEAN DEFAULT FALSE,
    created_at        TIMESTAMPTZ DEFAULT NOW()
)`);

// 修复 sessions 的 forked_from_message_id FK（messages 表刚建好）
DDL.push(`
ALTER TABLE sessions
    ADD CONSTRAINT fk_sessions_forked_message
    FOREIGN KEY (forked_from_message_id) REFERENCES messages(id)
    NOT VALID`);
DDL.push(`ALTER TABLE sessions VALIDATE CONSTRAINT fk_sessions_forked_message`);

DDL.push(`
CREATE TABLE IF NOT EXISTS memories (
    id                   BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id              BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    scope                TEXT DEFAULT 'user',
    type                 TEXT NOT NULL,
    content              TEXT NOT NULL,
    embedding            vector,
    salience             DOUBLE PRECISION DEFAULT 0.5,
    confidence           DOUBLE PRECISION DEFAULT 0.6,
    source_session_id    TEXT REFERENCES sessions(id),
    source_message_ids   JSONB DEFAULT '[]',
    status               TEXT DEFAULT 'active',
    last_used_at         TIMESTAMPTZ,
    expires_at           TIMESTAMPTZ,
    created_at           TIMESTAMPTZ DEFAULT NOW(),
    updated_at           TIMESTAMPTZ DEFAULT NOW()
)`);

DDL.push(`
CREATE TABLE IF NOT EXISTS memory_extraction_jobs (
    id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id      BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    session_id   TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    message_ids  JSONB DEFAULT '[]',
    model_id     BIGINT REFERENCES models(id) ON DELETE SET NULL,
    dedupe_key   TEXT,
    status       TEXT DEFAULT 'queued',
    attempts     INTEGER DEFAULT 0,
    max_attempts INTEGER DEFAULT 3,
    locked_at    TIMESTAMPTZ,
    last_error   TEXT,
    result       JSONB,
    created_at   TIMESTAMPTZ DEFAULT NOW(),
    updated_at   TIMESTAMPTZ DEFAULT NOW(),
    next_run_at  TIMESTAMPTZ DEFAULT NOW(),
    completed_at TIMESTAMPTZ
)`);

DDL.push(`
CREATE TABLE IF NOT EXISTS refresh_tokens (
    id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token      TEXT UNIQUE NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
)`);

DDL.push(`
CREATE TABLE IF NOT EXISTS api_keys (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    key_hash    TEXT UNIQUE,
    key_preview TEXT,
    key         TEXT,
    status      TEXT DEFAULT 'active',
    usage_tokens    INTEGER DEFAULT 0,
    input_tokens    INTEGER DEFAULT 0,
    output_tokens   INTEGER DEFAULT 0,
    last_used_at    TIMESTAMPTZ,
    created_at      TIMESTAMPTZ DEFAULT NOW()
)`);

DDL.push(`
CREATE TABLE IF NOT EXISTS model_usage_events (
    id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id       BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    model_id      BIGINT NOT NULL REFERENCES models(id) ON DELETE CASCADE,
    source        TEXT DEFAULT 'api',
    token_count   INTEGER DEFAULT 0,
    input_tokens  INTEGER DEFAULT 0,
    output_tokens INTEGER DEFAULT 0,
    created_at    TIMESTAMPTZ DEFAULT NOW()
)`);

DDL.push(`
CREATE TABLE IF NOT EXISTS api_call_logs (
    id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id          BIGINT NOT NULL REFERENCES users(id),
    api_key_id       BIGINT REFERENCES api_keys(id),
    model_id         BIGINT REFERENCES models(id),
    model_name       TEXT,
    request_messages TEXT,
    response_text    TEXT,
    status           TEXT DEFAULT 'success',
    error_message    TEXT,
    input_tokens     INTEGER DEFAULT 0,
    output_tokens    INTEGER DEFAULT 0,
    total_tokens     INTEGER DEFAULT 0,
    stream           BOOLEAN DEFAULT FALSE,
    ip_address       TEXT,
    created_at       TIMESTAMPTZ DEFAULT NOW()
)`);

DDL.push(`
CREATE TABLE IF NOT EXISTS audit_logs (
    id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id    BIGINT REFERENCES users(id),
    action     TEXT NOT NULL,
    details    TEXT,
    ip_address TEXT,
    timestamp  TIMESTAMPTZ DEFAULT NOW()
)`);

DDL.push(`
CREATE TABLE IF NOT EXISTS prompts (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name            TEXT NOT NULL,
    content         TEXT NOT NULL,
    category        TEXT,
    description     TEXT DEFAULT '',
    type            TEXT DEFAULT 'role',
    target_surfaces TEXT DEFAULT 'chat,agent,workflow',
    user_id         BIGINT REFERENCES users(id),
    scope           TEXT DEFAULT 'global',
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ
)`);

DDL.push(`
CREATE TABLE IF NOT EXISTS attachments (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id         BIGINT REFERENCES users(id),
    session_id      TEXT REFERENCES sessions(id),
    file_name       TEXT,
    file_path       TEXT,
    file_type       TEXT,
    file_size       BIGINT,
    access_token    TEXT,
    expires_at      TIMESTAMPTZ,
    deleted_at      TIMESTAMPTZ,
    deleted_by_user BOOLEAN DEFAULT FALSE,
    created_at      TIMESTAMPTZ DEFAULT NOW()
)`);

DDL.push(`
CREATE TABLE IF NOT EXISTS announcements (
    id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    title        TEXT NOT NULL,
    content      TEXT NOT NULL,
    type         TEXT DEFAULT 'system',
    priority     TEXT DEFAULT 'normal',
    target_type  TEXT DEFAULT 'all',
    target_value TEXT DEFAULT '',
    require_ack  BOOLEAN DEFAULT FALSE,
    show_on_login BOOLEAN DEFAULT FALSE,
    starts_at    TIMESTAMPTZ,
    ends_at      TIMESTAMPTZ,
    status       TEXT DEFAULT 'draft',
    created_by   BIGINT REFERENCES users(id),
    created_at   TIMESTAMPTZ DEFAULT NOW(),
    updated_at   TIMESTAMPTZ DEFAULT NOW(),
    deleted_at   TIMESTAMPTZ
)`);

DDL.push(`
CREATE TABLE IF NOT EXISTS announcement_reads (
    announcement_id BIGINT NOT NULL REFERENCES announcements(id) ON DELETE CASCADE,
    user_id         BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    read_at         TIMESTAMPTZ,
    acknowledged_at TIMESTAMPTZ,
    dismissed_at    TIMESTAMPTZ,
    PRIMARY KEY (announcement_id, user_id)
)`);

// ── 2. 知识库体系 ─────────────────────────────────────────────────────────
DDL.push(`
CREATE TABLE IF NOT EXISTS knowledge_collections (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id         BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name            TEXT NOT NULL,
    description     TEXT DEFAULT '',
    scope           TEXT DEFAULT 'personal',
    allowed_units   TEXT DEFAULT '',
    allowed_user_ids TEXT DEFAULT '',
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW(),
    deleted_at      TIMESTAMPTZ
)`);

DDL.push(`
CREATE TABLE IF NOT EXISTS knowledge_docs (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id         BIGINT REFERENCES users(id),
    collection_id   BIGINT REFERENCES knowledge_collections(id) ON DELETE SET NULL,
    name            TEXT NOT NULL,
    status          TEXT DEFAULT 'processing',
    is_enabled      BOOLEAN DEFAULT TRUE,
    chunk_count     INTEGER DEFAULT 0,
    indexed_chunks  INTEGER DEFAULT 0,
    progress        INTEGER DEFAULT 0,
    error_message   TEXT,
    processed_at    TIMESTAMPTZ,
    updated_at      TIMESTAMPTZ,
    source_path     TEXT,
    source_size     BIGINT DEFAULT 0,
    deleted_at      TIMESTAMPTZ,
    deleted_by_user BOOLEAN DEFAULT FALSE,
    created_at      TIMESTAMPTZ DEFAULT NOW()
)`);

DDL.push(`
CREATE TABLE IF NOT EXISTS knowledge_chunks (
    id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    doc_id         BIGINT REFERENCES knowledge_docs(id) ON DELETE CASCADE,
    content        TEXT NOT NULL,
    search_content TEXT,
    heading_path   TEXT,
    embedding      vector
)`);

DDL.push(`
CREATE TABLE IF NOT EXISTS knowledge_doc_tags (
    id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    doc_id     BIGINT NOT NULL REFERENCES knowledge_docs(id) ON DELETE CASCADE,
    tag        TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (user_id, doc_id, tag)
)`);

DDL.push(`
CREATE TABLE IF NOT EXISTS knowledge_tags (
    id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    tag        TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    deleted_at TIMESTAMPTZ,
    UNIQUE (user_id, tag)
)`);

DDL.push(`
CREATE TABLE IF NOT EXISTS knowledge_entities (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id         BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name            TEXT NOT NULL,
    normalized_name TEXT NOT NULL,
    type            TEXT DEFAULT 'concept',
    description     TEXT DEFAULT '',
    aliases         JSONB DEFAULT '[]',
    confidence      DOUBLE PRECISION DEFAULT 0.7,
    source_doc_id   BIGINT REFERENCES knowledge_docs(id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW(),
    deleted_at      TIMESTAMPTZ,
    UNIQUE (user_id, normalized_name)
)`);

DDL.push(`
CREATE TABLE IF NOT EXISTS knowledge_entity_mentions (
    id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    entity_id  BIGINT NOT NULL REFERENCES knowledge_entities(id) ON DELETE CASCADE,
    doc_id     BIGINT REFERENCES knowledge_docs(id) ON DELETE CASCADE,
    chunk_id   BIGINT REFERENCES knowledge_chunks(id) ON DELETE CASCADE,
    snippet    TEXT DEFAULT '',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (entity_id, chunk_id)
)`);

DDL.push(`
CREATE TABLE IF NOT EXISTS knowledge_relations (
    id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id          BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    source_entity_id BIGINT NOT NULL REFERENCES knowledge_entities(id) ON DELETE CASCADE,
    target_entity_id BIGINT NOT NULL REFERENCES knowledge_entities(id) ON DELETE CASCADE,
    relation_type    TEXT DEFAULT 'related_to',
    description      TEXT DEFAULT '',
    confidence       DOUBLE PRECISION DEFAULT 0.6,
    source_doc_id    BIGINT REFERENCES knowledge_docs(id) ON DELETE CASCADE,
    source_chunk_id  BIGINT REFERENCES knowledge_chunks(id) ON DELETE CASCADE,
    status           TEXT DEFAULT 'active',
    created_at       TIMESTAMPTZ DEFAULT NOW(),
    updated_at       TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (user_id, source_entity_id, target_entity_id, relation_type, source_chunk_id)
)`);

DDL.push(`
CREATE TABLE IF NOT EXISTS rag_feedback (
    id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id    BIGINT NOT NULL REFERENCES users(id),
    query      TEXT NOT NULL,
    chunk_id   BIGINT REFERENCES knowledge_chunks(id) ON DELETE SET NULL,
    doc_name   TEXT,
    score      DOUBLE PRECISION,
    helpful    INTEGER NOT NULL,
    note       TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
)`);

DDL.push(`
CREATE TABLE IF NOT EXISTS rag_debug_queries (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id         BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    query           TEXT NOT NULL,
    scope_json      JSONB DEFAULT '{}',
    top_k           INTEGER DEFAULT 0,
    candidate_limit INTEGER DEFAULT 0,
    score_threshold DOUBLE PRECISION DEFAULT 0,
    candidate_count INTEGER DEFAULT 0,
    matched_count   INTEGER DEFAULT 0,
    selected_chunk_ids JSONB DEFAULT '[]',
    scores_json     JSONB DEFAULT '[]',
    queue_json      JSONB DEFAULT '{}',
    elapsed_ms      INTEGER DEFAULT 0,
    created_at      TIMESTAMPTZ DEFAULT NOW()
)`);

// ── 3. 法规体系（循环外键用 DEFERRABLE 处理）────────────────────────────
DDL.push(`
CREATE TABLE IF NOT EXISTS regulation_documents (
    id                  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    title               TEXT NOT NULL,
    category            TEXT DEFAULT '',
    issuing_body        TEXT DEFAULT '',
    jurisdiction        TEXT DEFAULT '',
    summary             TEXT DEFAULT '',
    status              TEXT DEFAULT 'active',
    visibility          TEXT DEFAULT 'internal',
    current_version_id  BIGINT,
    version_count       INTEGER DEFAULT 0,
    article_count       INTEGER DEFAULT 0,
    created_by_user     INTEGER DEFAULT 0,
    updated_by_user     INTEGER DEFAULT 0,
    deleted_at          TIMESTAMPTZ,
    deleted_by_user     BOOLEAN DEFAULT FALSE,
    created_at          TIMESTAMPTZ DEFAULT NOW(),
    updated_at          TIMESTAMPTZ DEFAULT NOW()
)`);

DDL.push(`
CREATE TABLE IF NOT EXISTS regulation_versions (
    id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    document_id      BIGINT NOT NULL REFERENCES regulation_documents(id) ON DELETE CASCADE,
    version_label    TEXT DEFAULT '',
    source_name      TEXT NOT NULL,
    source_path      TEXT NOT NULL,
    source_size      BIGINT DEFAULT 0,
    source_hash      TEXT DEFAULT '',
    source_format    TEXT DEFAULT '',
    extracted_text   TEXT DEFAULT '',
    summary          TEXT DEFAULT '',
    article_count    INTEGER DEFAULT 0,
    uploaded_by_user INTEGER DEFAULT 0,
    created_at       TIMESTAMPTZ DEFAULT NOW(),
    updated_at       TIMESTAMPTZ DEFAULT NOW()
)`);

// 添加 regulation_documents.current_version_id FK（循环依赖，后补）
DDL.push(`
ALTER TABLE regulation_documents
    ADD CONSTRAINT fk_reg_doc_current_version
    FOREIGN KEY (current_version_id) REFERENCES regulation_versions(id) ON DELETE SET NULL
    NOT VALID`);
DDL.push(`ALTER TABLE regulation_documents VALIDATE CONSTRAINT fk_reg_doc_current_version`);

DDL.push(`
CREATE TABLE IF NOT EXISTS regulation_articles (
    id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    document_id   BIGINT NOT NULL REFERENCES regulation_documents(id) ON DELETE CASCADE,
    version_id    BIGINT NOT NULL REFERENCES regulation_versions(id) ON DELETE CASCADE,
    sort_order    INTEGER DEFAULT 0,
    article_label TEXT NOT NULL,
    article_title TEXT DEFAULT '',
    content       TEXT NOT NULL,
    search_content TEXT,
    heading_path  TEXT DEFAULT '',
    status        TEXT DEFAULT 'active',
    amended_date  TEXT DEFAULT '',
    embedding     vector,
    created_at    TIMESTAMPTZ DEFAULT NOW()
)`);

DDL.push(`
CREATE TABLE IF NOT EXISTS regulation_article_links (
    id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    document_id       BIGINT NOT NULL REFERENCES regulation_documents(id) ON DELETE CASCADE,
    version_id        BIGINT NOT NULL REFERENCES regulation_versions(id) ON DELETE CASCADE,
    source_article_id BIGINT NOT NULL REFERENCES regulation_articles(id) ON DELETE CASCADE,
    target_label      TEXT DEFAULT '',
    target_article_id BIGINT,
    target_document_id BIGINT,
    relation_type     TEXT DEFAULT 'cite',
    confidence        DOUBLE PRECISION DEFAULT 0.7,
    created_at        TIMESTAMPTZ DEFAULT NOW()
)`);

DDL.push(`
CREATE TABLE IF NOT EXISTS regulation_aliases (
    id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    document_id      BIGINT NOT NULL REFERENCES regulation_documents(id) ON DELETE CASCADE,
    alias            TEXT NOT NULL,
    normalized_alias TEXT NOT NULL,
    is_primary       BOOLEAN DEFAULT FALSE,
    created_at       TIMESTAMPTZ DEFAULT NOW()
)`);

DDL.push(`
CREATE TABLE IF NOT EXISTS regulation_article_annotations (
    id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    article_id BIGINT NOT NULL REFERENCES regulation_articles(id) ON DELETE CASCADE,
    user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    content    TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
)`);

DDL.push(`
CREATE TABLE IF NOT EXISTS regulation_access_logs (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id     BIGINT NOT NULL,
    document_id BIGINT,
    action      TEXT NOT NULL,
    detail      TEXT DEFAULT '',
    created_at  TIMESTAMPTZ DEFAULT NOW()
)`);

DDL.push(`
CREATE TABLE IF NOT EXISTS regulation_saved_searches (
    id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id      BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name         TEXT NOT NULL,
    query        TEXT DEFAULT '',
    category     TEXT DEFAULT '',
    jurisdiction TEXT DEFAULT '',
    created_at   TIMESTAMPTZ DEFAULT NOW()
)`);

// ── 4. Agent 体系 ─────────────────────────────────────────────────────────
DDL.push(`
CREATE TABLE IF NOT EXISTS agent_runs (
    id                  TEXT PRIMARY KEY,
    user_id             BIGINT NOT NULL REFERENCES users(id),
    session_id          TEXT REFERENCES sessions(id),
    model_id            BIGINT REFERENCES models(id),
    title               TEXT,
    goal                TEXT NOT NULL,
    status              TEXT DEFAULT 'queued',
    final_answer        TEXT,
    error_message       TEXT,
    max_steps           INTEGER DEFAULT 6,
    parent_run_id       TEXT REFERENCES agent_runs(id),
    priority            INTEGER DEFAULT 0,
    run_mode            TEXT DEFAULT 'standard',
    tool_policy         TEXT DEFAULT 'all',
    tool_allowlist      TEXT,
    approval_policy     TEXT DEFAULT 'safe_mcp_auto',
    timeout_ms          INTEGER DEFAULT 600000,
    tool_timeout_ms     INTEGER DEFAULT 120000,
    retry_limit         INTEGER DEFAULT 1,
    retry_count         INTEGER DEFAULT 0,
    max_token_budget    INTEGER DEFAULT 0,
    export_count        INTEGER DEFAULT 0,
    template_id         BIGINT,
    schedule_id         BIGINT,
    dedupe_key          TEXT,
    context_config      JSONB,
    resume_from_step    INTEGER DEFAULT 0,
    metadata            JSONB,
    model_router        TEXT DEFAULT 'fixed',
    chosen_model_id     BIGINT,
    started_at          TIMESTAMPTZ,
    last_heartbeat_at   TIMESTAMPTZ,
    locked_by           TEXT,
    lock_expires_at     TIMESTAMPTZ,
    input_tokens        INTEGER DEFAULT 0,
    output_tokens       INTEGER DEFAULT 0,
    total_tokens        INTEGER DEFAULT 0,
    cancelled_at        TIMESTAMPTZ,
    deleted_at          TIMESTAMPTZ,
    deleted_by_user     BOOLEAN,
    delete_reason       TEXT,
    created_at          TIMESTAMPTZ DEFAULT NOW(),
    updated_at          TIMESTAMPTZ DEFAULT NOW(),
    completed_at        TIMESTAMPTZ
)`);

DDL.push(`
CREATE TABLE IF NOT EXISTS agent_steps (
    id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    run_id       TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
    step_index   INTEGER NOT NULL,
    type         TEXT NOT NULL,
    title        TEXT,
    tool_name    TEXT,
    input        TEXT,
    output       TEXT,
    error_message TEXT,
    status       TEXT DEFAULT 'success',
    duration_ms  INTEGER DEFAULT 0,
    started_at   TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    created_at   TIMESTAMPTZ DEFAULT NOW()
)`);

DDL.push(`
CREATE TABLE IF NOT EXISTS agent_traces (
    run_id       TEXT PRIMARY KEY REFERENCES agent_runs(id) ON DELETE CASCADE,
    user_id      BIGINT NOT NULL REFERENCES users(id),
    status       TEXT DEFAULT 'queued',
    metadata     TEXT,
    started_at   TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    duration_ms  INTEGER DEFAULT 0,
    created_at   TIMESTAMPTZ DEFAULT NOW(),
    updated_at   TIMESTAMPTZ DEFAULT NOW()
)`);

DDL.push(`
CREATE TABLE IF NOT EXISTS agent_trace_spans (
    id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    span_id        TEXT NOT NULL UNIQUE,
    run_id         TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
    parent_span_id TEXT,
    span_type      TEXT NOT NULL,
    name           TEXT NOT NULL,
    status         TEXT DEFAULT 'running',
    input_summary  TEXT,
    output_summary TEXT,
    details        TEXT,
    error_message  TEXT,
    input_tokens   INTEGER DEFAULT 0,
    output_tokens  INTEGER DEFAULT 0,
    started_at     TIMESTAMPTZ,
    completed_at   TIMESTAMPTZ,
    duration_ms    INTEGER DEFAULT 0,
    created_at     TIMESTAMPTZ DEFAULT NOW()
)`);

DDL.push(`
CREATE TABLE IF NOT EXISTS agent_run_checkpoints (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    checkpoint_id   TEXT NOT NULL UNIQUE,
    run_id          TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
    step_index      INTEGER DEFAULT 0,
    checkpoint_type TEXT DEFAULT 'step',
    status          TEXT DEFAULT 'completed',
    state           TEXT NOT NULL,
    created_at      TIMESTAMPTZ DEFAULT NOW()
)`);

DDL.push(`
CREATE TABLE IF NOT EXISTS agent_notifications (
    id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id    BIGINT NOT NULL REFERENCES users(id),
    run_id     TEXT REFERENCES agent_runs(id) ON DELETE CASCADE,
    type       TEXT DEFAULT 'info',
    title      TEXT NOT NULL,
    body       TEXT,
    status     TEXT DEFAULT 'unread',
    read_at    TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW()
)`);

DDL.push(`
CREATE TABLE IF NOT EXISTS agent_dag_nodes (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    run_id          TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
    node_key        TEXT NOT NULL,
    title           TEXT,
    tool_name       TEXT,
    input           TEXT,
    input_schema    TEXT,
    output_schema   TEXT,
    depends_on      TEXT,
    condition       TEXT,
    status          TEXT DEFAULT 'pending',
    output          TEXT,
    error_message   TEXT,
    contract_status TEXT DEFAULT 'unchecked',
    contract_issues TEXT,
    attempt_count   INTEGER DEFAULT 0,
    duration_ms     INTEGER DEFAULT 0,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    started_at      TIMESTAMPTZ,
    completed_at    TIMESTAMPTZ,
    UNIQUE (run_id, node_key)
)`);

DDL.push(`
CREATE TABLE IF NOT EXISTS agent_approval_requests (
    id                          TEXT PRIMARY KEY,
    run_id                      TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
    user_id                     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    request_type                TEXT DEFAULT 'approval',
    node_key                    TEXT DEFAULT '',
    approval_key                TEXT DEFAULT '',
    title                       TEXT DEFAULT '',
    summary                     TEXT DEFAULT '',
    instructions                TEXT DEFAULT '',
    status                      TEXT DEFAULT 'pending',
    current_level               INTEGER DEFAULT 1,
    required_levels             INTEGER DEFAULT 1,
    levels_json                 TEXT DEFAULT '[]',
    decisions_json              TEXT DEFAULT '[]',
    input_json                  TEXT DEFAULT '{}',
    callback_token_hash         TEXT,
    callback_token_hint         TEXT DEFAULT '',
    callback_nonce              TEXT DEFAULT '',
    callback_credential_slug    TEXT DEFAULT '',
    callback_signature_required BOOLEAN DEFAULT FALSE,
    timeout_action              TEXT DEFAULT 'reject',
    expires_at                  TIMESTAMPTZ,
    decided_at                  TIMESTAMPTZ,
    decided_by                  BIGINT REFERENCES users(id) ON DELETE SET NULL,
    created_at                  TIMESTAMPTZ DEFAULT NOW(),
    updated_at                  TIMESTAMPTZ DEFAULT NOW()
)`);

DDL.push(`
CREATE TABLE IF NOT EXISTS agent_artifacts (
    id                 BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    run_id             TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
    user_id            BIGINT NOT NULL REFERENCES users(id),
    type               TEXT DEFAULT 'summary',
    title              TEXT NOT NULL,
    content            TEXT NOT NULL,
    current_version_id BIGINT,
    note               TEXT,
    updated_at         TIMESTAMPTZ,
    created_at         TIMESTAMPTZ DEFAULT NOW()
)`);

DDL.push(`
CREATE TABLE IF NOT EXISTS agent_artifact_versions (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    artifact_id BIGINT NOT NULL REFERENCES agent_artifacts(id) ON DELETE CASCADE,
    version     INTEGER NOT NULL,
    content     TEXT NOT NULL,
    note        TEXT,
    created_by  BIGINT REFERENCES users(id),
    created_at  TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (artifact_id, version)
)`);

DDL.push(`
ALTER TABLE agent_artifacts
    ADD CONSTRAINT fk_agent_artifact_current_version
    FOREIGN KEY (current_version_id) REFERENCES agent_artifact_versions(id) NOT VALID`);
DDL.push(`ALTER TABLE agent_artifacts VALIDATE CONSTRAINT fk_agent_artifact_current_version`);

DDL.push(`
CREATE TABLE IF NOT EXISTS agent_eval_suites (
    id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id          BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name             TEXT NOT NULL,
    description      TEXT,
    target_type      TEXT DEFAULT 'free',
    workflow_id      BIGINT,
    workflow_version TEXT,
    model_id         BIGINT REFERENCES models(id) ON DELETE SET NULL,
    run_config       TEXT,
    status           TEXT DEFAULT 'active',
    created_at       TIMESTAMPTZ DEFAULT NOW(),
    updated_at       TIMESTAMPTZ DEFAULT NOW(),
    deleted_at       TIMESTAMPTZ
)`);

DDL.push(`
CREATE TABLE IF NOT EXISTS agent_eval_cases (
    id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    suite_id         BIGINT NOT NULL REFERENCES agent_eval_suites(id) ON DELETE CASCADE,
    name             TEXT NOT NULL,
    input            TEXT NOT NULL,
    input_variables  TEXT,
    expected_output  TEXT,
    assertions       TEXT,
    sort_order       INTEGER DEFAULT 0,
    created_at       TIMESTAMPTZ DEFAULT NOW(),
    updated_at       TIMESTAMPTZ DEFAULT NOW(),
    deleted_at       TIMESTAMPTZ
)`);

DDL.push(`
CREATE TABLE IF NOT EXISTS agent_eval_runs (
    id              TEXT PRIMARY KEY,
    suite_id        BIGINT NOT NULL REFERENCES agent_eval_suites(id) ON DELETE CASCADE,
    user_id         BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    status          TEXT DEFAULT 'running',
    target_snapshot TEXT,
    summary         TEXT,
    started_at      TIMESTAMPTZ,
    completed_at    TIMESTAMPTZ,
    created_at      TIMESTAMPTZ DEFAULT NOW()
)`);

DDL.push(`
CREATE TABLE IF NOT EXISTS agent_eval_results (
    id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    eval_run_id   TEXT NOT NULL REFERENCES agent_eval_runs(id) ON DELETE CASCADE,
    case_id       BIGINT NOT NULL REFERENCES agent_eval_cases(id) ON DELETE CASCADE,
    agent_run_id  TEXT REFERENCES agent_runs(id) ON DELETE SET NULL,
    status        TEXT DEFAULT 'queued',
    score         DOUBLE PRECISION DEFAULT 0,
    passed        BOOLEAN DEFAULT FALSE,
    grader_results TEXT,
    actual_output TEXT,
    error_message TEXT,
    duration_ms   INTEGER DEFAULT 0,
    total_tokens  INTEGER DEFAULT 0,
    created_at    TIMESTAMPTZ DEFAULT NOW(),
    completed_at  TIMESTAMPTZ,
    UNIQUE (eval_run_id, case_id)
)`);

DDL.push(`
CREATE TABLE IF NOT EXISTS agent_templates (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id         BIGINT NOT NULL REFERENCES users(id),
    scope           TEXT DEFAULT 'personal',
    name            TEXT NOT NULL,
    description     TEXT,
    goal_template   TEXT NOT NULL,
    run_mode        TEXT DEFAULT 'standard',
    tool_policy     TEXT DEFAULT 'all',
    tool_allowlist  TEXT,
    approval_policy TEXT DEFAULT 'safe_mcp_auto',
    max_steps       INTEGER DEFAULT 5,
    max_token_budget INTEGER DEFAULT 0,
    retry_limit     INTEGER DEFAULT 1,
    context_config  TEXT,
    allowed_units   TEXT DEFAULT '',
    model_router    TEXT DEFAULT 'fixed',
    dag_spec        TEXT,
    dag_inputs      TEXT,
    workflow_id     BIGINT,
    workflow_version TEXT,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW(),
    deleted_at      TIMESTAMPTZ
)`);

DDL.push(`
CREATE TABLE IF NOT EXISTS agent_workflows (
    id                   BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id              BIGINT NOT NULL REFERENCES users(id),
    name                 TEXT NOT NULL,
    description          TEXT,
    scope                TEXT DEFAULT 'personal',
    allowed_units        TEXT DEFAULT '',
    allowed_user_ids     TEXT DEFAULT '',
    current_version_id   BIGINT,
    published_version_id BIGINT,
    published_at         TIMESTAMPTZ,
    created_at           TIMESTAMPTZ DEFAULT NOW(),
    updated_at           TIMESTAMPTZ DEFAULT NOW(),
    deleted_at           TIMESTAMPTZ
)`);

DDL.push(`
CREATE TABLE IF NOT EXISTS agent_workflow_versions (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    workflow_id BIGINT NOT NULL REFERENCES agent_workflows(id) ON DELETE CASCADE,
    version     INTEGER NOT NULL,
    dag_spec    TEXT NOT NULL,
    note        TEXT,
    created_by  BIGINT REFERENCES users(id),
    created_at  TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (workflow_id, version)
)`);

DDL.push(`
ALTER TABLE agent_workflows
    ADD CONSTRAINT fk_agent_workflow_current_version
    FOREIGN KEY (current_version_id) REFERENCES agent_workflow_versions(id) NOT VALID`);
DDL.push(`ALTER TABLE agent_workflows VALIDATE CONSTRAINT fk_agent_workflow_current_version`);
DDL.push(`
ALTER TABLE agent_workflows
    ADD CONSTRAINT fk_agent_workflow_published_version
    FOREIGN KEY (published_version_id) REFERENCES agent_workflow_versions(id) NOT VALID`);
DDL.push(`ALTER TABLE agent_workflows VALIDATE CONSTRAINT fk_agent_workflow_published_version`);

DDL.push(`
CREATE TABLE IF NOT EXISTS agent_workflow_dependency_bindings (
    id                   BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    workflow_id          BIGINT NOT NULL REFERENCES agent_workflows(id) ON DELETE CASCADE,
    user_id              BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    published_version_id BIGINT NOT NULL REFERENCES agent_workflow_versions(id) ON DELETE CASCADE,
    bindings_json        TEXT DEFAULT '{}',
    created_at           TIMESTAMPTZ DEFAULT NOW(),
    updated_at           TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (workflow_id, user_id)
)`);

DDL.push(`
CREATE TABLE IF NOT EXISTS agent_workflow_triggers (
    id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id           BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    workflow_id       BIGINT NOT NULL REFERENCES agent_workflows(id) ON DELETE CASCADE,
    name              TEXT NOT NULL,
    trigger_type      TEXT DEFAULT 'webhook',
    token_hash        TEXT,
    token_hint        TEXT DEFAULT '',
    status            TEXT DEFAULT 'active',
    config_json       TEXT DEFAULT '{}',
    watermark         TEXT DEFAULT '',
    last_triggered_at TIMESTAMPTZ,
    last_run_id       TEXT,
    trigger_count     INTEGER DEFAULT 0,
    last_error        TEXT,
    claim_token       TEXT,
    claim_expires_at  TIMESTAMPTZ,
    created_at        TIMESTAMPTZ DEFAULT NOW(),
    updated_at        TIMESTAMPTZ DEFAULT NOW(),
    deleted_at        TIMESTAMPTZ
)`);

DDL.push(`
CREATE TABLE IF NOT EXISTS workflow_credentials (
    id                  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id             BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name                TEXT NOT NULL,
    slug                TEXT NOT NULL,
    description         TEXT DEFAULT '',
    secret_value        TEXT NOT NULL,
    scope               TEXT DEFAULT 'personal',
    allowed_units       TEXT DEFAULT '',
    version             INTEGER DEFAULT 1,
    previous_value      TEXT,
    previous_expires_at TIMESTAMPTZ,
    last_used_at        TIMESTAMPTZ,
    use_count           INTEGER DEFAULT 0,
    created_at          TIMESTAMPTZ DEFAULT NOW(),
    updated_at          TIMESTAMPTZ DEFAULT NOW(),
    deleted_at          TIMESTAMPTZ
)`);

DDL.push(`
CREATE TABLE IF NOT EXISTS agent_schedules (
    id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id           BIGINT NOT NULL REFERENCES users(id),
    template_id       BIGINT,
    model_id          BIGINT REFERENCES models(id),
    name              TEXT NOT NULL,
    goal              TEXT NOT NULL,
    frequency         TEXT DEFAULT 'manual',
    time_of_day       TEXT DEFAULT '09:00',
    day_of_week       INTEGER DEFAULT 1,
    interval_minutes  INTEGER DEFAULT 0,
    cron_expression   TEXT DEFAULT '',
    status            TEXT DEFAULT 'active',
    run_config        TEXT,
    next_run_at       TIMESTAMPTZ,
    last_run_at       TIMESTAMPTZ,
    last_run_id       TEXT,
    claim_token       TEXT,
    claim_expires_at  TIMESTAMPTZ,
    dispatch_failures INTEGER DEFAULT 0,
    dispatch_retry_at TIMESTAMPTZ,
    last_error        TEXT,
    created_at        TIMESTAMPTZ DEFAULT NOW(),
    updated_at        TIMESTAMPTZ DEFAULT NOW(),
    deleted_at        TIMESTAMPTZ
)`);

// ── 5. MCP / 文档处理 / 数据分析 / 企业 / 杂表 ──────────────────────────
DDL.push(`
CREATE TABLE IF NOT EXISTS mcp_servers (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id         BIGINT REFERENCES users(id),
    name            TEXT NOT NULL,
    base_url        TEXT NOT NULL,
    api_key         TEXT,
    description     TEXT,
    config          TEXT,
    scope           TEXT DEFAULT 'personal',
    allowed_units   TEXT DEFAULT '',
    allowed_user_ids TEXT DEFAULT '',
    status          TEXT DEFAULT 'active',
    last_error      TEXT,
    last_checked_at TIMESTAMPTZ,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW()
)`);

DDL.push(`
CREATE TABLE IF NOT EXISTS mcp_tool_cache (
    id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    server_id    BIGINT NOT NULL REFERENCES mcp_servers(id) ON DELETE CASCADE,
    name         TEXT NOT NULL,
    description  TEXT,
    input_schema TEXT,
    cached_at    TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (server_id, name)
)`);

DDL.push(`
CREATE TABLE IF NOT EXISTS mcp_call_logs (
    id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id        BIGINT,
    server_id      BIGINT,
    tool_name      TEXT,
    source         TEXT DEFAULT 'manual',
    status         TEXT DEFAULT 'success',
    duration_ms    INTEGER DEFAULT 0,
    input_preview  TEXT,
    output_preview TEXT,
    error_message  TEXT,
    created_at     TIMESTAMPTZ DEFAULT NOW()
)`);

DDL.push(`
CREATE TABLE IF NOT EXISTS mcp_database_connections (
    id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    mcp_server_id  BIGINT UNIQUE NOT NULL REFERENCES mcp_servers(id) ON DELETE CASCADE,
    user_id        BIGINT REFERENCES users(id),
    database_type  TEXT NOT NULL,
    host           TEXT,
    port           INTEGER,
    database_name  TEXT,
    username       TEXT,
    password       TEXT,
    options        TEXT,
    status         TEXT DEFAULT 'active',
    created_at     TIMESTAMPTZ DEFAULT NOW(),
    updated_at     TIMESTAMPTZ DEFAULT NOW()
)`);

DDL.push(`
CREATE TABLE IF NOT EXISTS mcp_builtin_configs (
    id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    mcp_server_id BIGINT UNIQUE NOT NULL REFERENCES mcp_servers(id) ON DELETE CASCADE,
    user_id       BIGINT REFERENCES users(id),
    service_type  TEXT NOT NULL,
    config        TEXT,
    secret        TEXT,
    status        TEXT DEFAULT 'active',
    created_at    TIMESTAMPTZ DEFAULT NOW(),
    updated_at    TIMESTAMPTZ DEFAULT NOW()
)`);

DDL.push(`
CREATE TABLE IF NOT EXISTS document_files (
    id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id       BIGINT NOT NULL REFERENCES users(id),
    original_name TEXT NOT NULL,
    stored_name   TEXT DEFAULT '',
    file_path     TEXT DEFAULT '',
    file_type     TEXT DEFAULT '',
    file_ext      TEXT DEFAULT '',
    file_size     BIGINT DEFAULT 0,
    page_count    INTEGER DEFAULT 0,
    source_module TEXT DEFAULT 'document_processing',
    source_ref    TEXT DEFAULT '',
    sha256        TEXT DEFAULT '',
    metadata_json TEXT DEFAULT '{}',
    deleted_at    TIMESTAMPTZ,
    created_at    TIMESTAMPTZ DEFAULT NOW(),
    updated_at    TIMESTAMPTZ DEFAULT NOW()
)`);

DDL.push(`
CREATE TABLE IF NOT EXISTS document_jobs (
    id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id       BIGINT NOT NULL REFERENCES users(id),
    file_id       BIGINT NOT NULL REFERENCES document_files(id) ON DELETE CASCADE,
    job_type      TEXT NOT NULL,
    status        TEXT DEFAULT 'queued',
    progress      INTEGER DEFAULT 0,
    error_message TEXT DEFAULT '',
    config_json   TEXT DEFAULT '{}',
    result_json   TEXT DEFAULT '{}',
    attempts      INTEGER DEFAULT 0,
    max_attempts  INTEGER DEFAULT 3,
    locked_at     TIMESTAMPTZ,
    cancelled_at  TIMESTAMPTZ,
    completed_at  TIMESTAMPTZ,
    source_module TEXT DEFAULT 'document_processing',
    created_at    TIMESTAMPTZ DEFAULT NOW(),
    updated_at    TIMESTAMPTZ DEFAULT NOW()
)`);

DDL.push(`
CREATE TABLE IF NOT EXISTS document_pages (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id     BIGINT NOT NULL REFERENCES users(id),
    file_id     BIGINT NOT NULL REFERENCES document_files(id) ON DELETE CASCADE,
    job_id      BIGINT NOT NULL REFERENCES document_jobs(id) ON DELETE CASCADE,
    page_number INTEGER DEFAULT 1,
    width       INTEGER DEFAULT 0,
    height      INTEGER DEFAULT 0,
    image_path  TEXT DEFAULT '',
    text        TEXT DEFAULT '',
    text_length INTEGER DEFAULT 0,
    ocr_status  TEXT DEFAULT 'pending',
    confidence  DOUBLE PRECISION,
    created_at  TIMESTAMPTZ DEFAULT NOW(),
    updated_at  TIMESTAMPTZ DEFAULT NOW()
)`);

DDL.push(`
CREATE TABLE IF NOT EXISTS document_ocr_blocks (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id     BIGINT NOT NULL REFERENCES users(id),
    file_id     BIGINT NOT NULL REFERENCES document_files(id) ON DELETE CASCADE,
    job_id      BIGINT NOT NULL REFERENCES document_jobs(id) ON DELETE CASCADE,
    page_id     BIGINT NOT NULL REFERENCES document_pages(id) ON DELETE CASCADE,
    page_number INTEGER DEFAULT 1,
    sort_order  INTEGER DEFAULT 0,
    block_type  TEXT DEFAULT 'line',
    text        TEXT NOT NULL,
    bbox_json   TEXT DEFAULT '[]',
    confidence  DOUBLE PRECISION DEFAULT 0,
    language    TEXT DEFAULT '',
    engine      TEXT DEFAULT '',
    created_at  TIMESTAMPTZ DEFAULT NOW(),
    updated_at  TIMESTAMPTZ DEFAULT NOW()
)`);

DDL.push(`
CREATE TABLE IF NOT EXISTS document_outputs (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id     BIGINT NOT NULL REFERENCES users(id),
    file_id     BIGINT NOT NULL REFERENCES document_files(id) ON DELETE CASCADE,
    job_id      BIGINT NOT NULL REFERENCES document_jobs(id) ON DELETE CASCADE,
    output_type TEXT NOT NULL,
    file_path   TEXT NOT NULL,
    file_name   TEXT DEFAULT '',
    mime_type   TEXT DEFAULT 'application/octet-stream',
    file_size   BIGINT DEFAULT 0,
    status      TEXT DEFAULT 'ready',
    expires_at  TIMESTAMPTZ,
    created_at  TIMESTAMPTZ DEFAULT NOW()
)`);

DDL.push(`
CREATE TABLE IF NOT EXISTS document_reviews (
    id                       BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id                  BIGINT NOT NULL REFERENCES users(id),
    file_id                  BIGINT NOT NULL REFERENCES document_files(id) ON DELETE CASCADE,
    job_id                   BIGINT NOT NULL REFERENCES document_jobs(id) ON DELETE CASCADE,
    page_id                  BIGINT NOT NULL REFERENCES document_pages(id) ON DELETE CASCADE,
    review_status            TEXT DEFAULT 'draft',
    original_text            TEXT DEFAULT '',
    revised_text             TEXT DEFAULT '',
    low_confidence_confirmed BOOLEAN DEFAULT FALSE,
    reviewed_at              TIMESTAMPTZ,
    created_at               TIMESTAMPTZ DEFAULT NOW(),
    updated_at               TIMESTAMPTZ DEFAULT NOW()
)`);

DDL.push(`
CREATE TABLE IF NOT EXISTS analysis_datasets (
    id            TEXT PRIMARY KEY,
    user_id       BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name          TEXT NOT NULL,
    original_name TEXT DEFAULT '',
    file_type     TEXT DEFAULT '',
    file_size     BIGINT DEFAULT 0,
    source_path   TEXT DEFAULT '',
    parquet_path  TEXT DEFAULT '',
    row_count     INTEGER DEFAULT 0,
    column_count  INTEGER DEFAULT 0,
    columns_json  TEXT DEFAULT '[]',
    profile_json  TEXT DEFAULT '[]',
    preview_json  TEXT DEFAULT '[]',
    sheet_name    TEXT DEFAULT '',
    status        TEXT DEFAULT 'ready',
    error_message TEXT DEFAULT '',
    deleted_at    TIMESTAMPTZ,
    created_at    TIMESTAMPTZ DEFAULT NOW(),
    updated_at    TIMESTAMPTZ DEFAULT NOW()
)`);

DDL.push(`
CREATE TABLE IF NOT EXISTS analysis_artifacts (
    id            TEXT PRIMARY KEY,
    user_id       BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    dataset_id    TEXT DEFAULT '',
    type          TEXT NOT NULL,
    title         TEXT NOT NULL,
    content       TEXT DEFAULT '',
    file_path     TEXT DEFAULT '',
    metadata_json TEXT DEFAULT '{}',
    created_at    TIMESTAMPTZ DEFAULT NOW()
)`);

DDL.push(`
CREATE TABLE IF NOT EXISTS capability_packages (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    package_key TEXT UNIQUE NOT NULL,
    type        TEXT NOT NULL,
    source_ref  TEXT NOT NULL,
    user_id     BIGINT REFERENCES users(id),
    scope       TEXT DEFAULT 'user',
    name        TEXT NOT NULL,
    description TEXT,
    status      TEXT DEFAULT 'enabled',
    config      TEXT,
    created_at  TIMESTAMPTZ DEFAULT NOW(),
    updated_at  TIMESTAMPTZ DEFAULT NOW()
)`);

DDL.push(`
CREATE TABLE IF NOT EXISTS observability_events (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    type            TEXT NOT NULL,
    source          TEXT,
    severity        TEXT DEFAULT 'warning',
    duration_ms     INTEGER DEFAULT 0,
    threshold_ms    INTEGER DEFAULT 0,
    message         TEXT,
    details         TEXT,
    status          TEXT DEFAULT 'open',
    alerted_at      TIMESTAMPTZ,
    acknowledged_at TIMESTAMPTZ,
    created_at      TIMESTAMPTZ DEFAULT NOW()
)`);

DDL.push(`
CREATE TABLE IF NOT EXISTS schema_migrations (
    id          TEXT PRIMARY KEY,
    description TEXT,
    applied_at  TIMESTAMPTZ DEFAULT NOW()
)`);

DDL.push(`
CREATE TABLE IF NOT EXISTS rag_debug_queries (
    id                 BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id            BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    query              TEXT NOT NULL,
    scope_json         TEXT DEFAULT '{}',
    top_k              INTEGER DEFAULT 0,
    candidate_limit    INTEGER DEFAULT 0,
    score_threshold    DOUBLE PRECISION DEFAULT 0,
    candidate_count    INTEGER DEFAULT 0,
    matched_count      INTEGER DEFAULT 0,
    selected_chunk_ids TEXT DEFAULT '[]',
    scores_json        TEXT DEFAULT '[]',
    queue_json         TEXT DEFAULT '{}',
    elapsed_ms         INTEGER DEFAULT 0,
    created_at         TIMESTAMPTZ DEFAULT NOW()
)`);

DDL.push(`
CREATE TABLE IF NOT EXISTS organizations (
    id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name          TEXT NOT NULL,
    slug          TEXT UNIQUE NOT NULL,
    status        TEXT DEFAULT 'active',
    metadata_json TEXT DEFAULT '{}',
    created_at    TIMESTAMPTZ DEFAULT NOW(),
    updated_at    TIMESTAMPTZ DEFAULT NOW()
)`);

DDL.push(`
CREATE TABLE IF NOT EXISTS teams (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    organization_id BIGINT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    name            TEXT NOT NULL,
    slug            TEXT NOT NULL,
    status          TEXT DEFAULT 'active',
    metadata_json   TEXT DEFAULT '{}',
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (organization_id, slug)
)`);

DDL.push(`
CREATE TABLE IF NOT EXISTS team_members (
    id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    team_id    BIGINT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role       TEXT DEFAULT 'member',
    status     TEXT DEFAULT 'active',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (team_id, user_id)
)`);

DDL.push(`
CREATE TABLE IF NOT EXISTS resource_permissions (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    subject_type    TEXT NOT NULL,
    subject_id      TEXT NOT NULL,
    resource_type   TEXT NOT NULL,
    resource_id     TEXT NOT NULL,
    action          TEXT NOT NULL,
    effect          TEXT DEFAULT 'allow',
    conditions_json TEXT DEFAULT '{}',
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW()
)`);

DDL.push(`
CREATE TABLE IF NOT EXISTS policy_objects (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    organization_id BIGINT REFERENCES organizations(id) ON DELETE SET NULL,
    owner_user_id   BIGINT REFERENCES users(id) ON DELETE SET NULL,
    object_type     TEXT NOT NULL,
    object_id       TEXT NOT NULL,
    classification  TEXT DEFAULT 'internal',
    policy_json     TEXT DEFAULT '{}',
    status          TEXT DEFAULT 'active',
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW()
)`);

DDL.push(`
CREATE TABLE IF NOT EXISTS deployment_provider_configs (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    provider_type   TEXT NOT NULL,
    provider_key    TEXT NOT NULL,
    status          TEXT DEFAULT 'planned',
    config_json     TEXT DEFAULT '{}',
    health_json     TEXT DEFAULT '{}',
    last_checked_at TIMESTAMPTZ,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (provider_type, provider_key)
)`);

// ── 6. 核心索引 ───────────────────────────────────────────────────────────
const INDEXES = [
    `CREATE INDEX IF NOT EXISTS idx_users_status ON users(status)`,
    `CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id)`,
    `CREATE INDEX IF NOT EXISTS idx_sessions_user_archived ON sessions(user_id, is_archived, is_pinned, created_at)`,
    `CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id)`,
    `CREATE INDEX IF NOT EXISTS idx_messages_user ON messages(user_id)`,
    `CREATE INDEX IF NOT EXISTS idx_messages_session_user_created ON messages(session_id, user_id, created_at)`,
    `CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at)`,
    `CREATE INDEX IF NOT EXISTS idx_memories_user_status ON memories(user_id, status, updated_at)`,
    `CREATE INDEX IF NOT EXISTS idx_memories_user_type ON memories(user_id, type, status)`,
    `CREATE INDEX IF NOT EXISTS idx_memories_source_session ON memories(source_session_id)`,
    `CREATE INDEX IF NOT EXISTS idx_memory_jobs_status_next_run ON memory_extraction_jobs(status, next_run_at, id)`,
    `CREATE INDEX IF NOT EXISTS idx_memory_jobs_user_status ON memory_extraction_jobs(user_id, status, updated_at)`,
    `CREATE INDEX IF NOT EXISTS idx_memory_jobs_dedupe ON memory_extraction_jobs(dedupe_key, status)`,
    `CREATE INDEX IF NOT EXISTS idx_models_user ON models(user_id)`,
    `CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_logs(user_id)`,
    `CREATE INDEX IF NOT EXISTS idx_audit_logs_timestamp ON audit_logs(timestamp)`,
    `CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user ON refresh_tokens(user_id)`,
    `CREATE INDEX IF NOT EXISTS idx_refresh_tokens_token ON refresh_tokens(token)`,
    `CREATE INDEX IF NOT EXISTS idx_api_keys_user ON api_keys(user_id)`,
    `CREATE INDEX IF NOT EXISTS idx_model_usage_user_model_created ON model_usage_events(user_id, model_id, created_at)`,
    `CREATE INDEX IF NOT EXISTS idx_model_usage_created ON model_usage_events(created_at)`,
    `CREATE INDEX IF NOT EXISTS idx_api_call_logs_created ON api_call_logs(created_at)`,
    `CREATE INDEX IF NOT EXISTS idx_api_call_logs_user ON api_call_logs(user_id, created_at)`,
    `CREATE INDEX IF NOT EXISTS idx_api_call_logs_key ON api_call_logs(api_key_id, created_at)`,
    `CREATE INDEX IF NOT EXISTS idx_prompts_scope_user ON prompts(scope, user_id)`,
    `CREATE INDEX IF NOT EXISTS idx_prompts_type ON prompts(type, category)`,
    `CREATE INDEX IF NOT EXISTS idx_prompts_created ON prompts(created_at)`,
    `CREATE INDEX IF NOT EXISTS idx_attachments_user_session ON attachments(user_id, session_id)`,
    `CREATE INDEX IF NOT EXISTS idx_attachments_token ON attachments(access_token)`,
    `CREATE INDEX IF NOT EXISTS idx_attachments_created ON attachments(created_at)`,
    `CREATE INDEX IF NOT EXISTS idx_announcements_status_window ON announcements(status, starts_at, ends_at, deleted_at)`,
    `CREATE INDEX IF NOT EXISTS idx_announcements_target ON announcements(target_type, target_value)`,
    `CREATE INDEX IF NOT EXISTS idx_announcement_reads_user ON announcement_reads(user_id, announcement_id)`,
    `CREATE INDEX IF NOT EXISTS idx_knowledge_collections_user ON knowledge_collections(user_id, deleted_at, updated_at)`,
    `CREATE INDEX IF NOT EXISTS idx_knowledge_collections_scope ON knowledge_collections(scope, deleted_at, updated_at)`,
    `CREATE INDEX IF NOT EXISTS idx_knowledge_docs_user_status ON knowledge_docs(user_id, status)`,
    `CREATE INDEX IF NOT EXISTS idx_knowledge_docs_created ON knowledge_docs(created_at)`,
    `CREATE INDEX IF NOT EXISTS idx_knowledge_chunks_doc ON knowledge_chunks(doc_id)`,
    `CREATE INDEX IF NOT EXISTS idx_knowledge_chunks_content_trgm ON knowledge_chunks USING gin(content gin_trgm_ops)`,
    `CREATE INDEX IF NOT EXISTS idx_knowledge_doc_tags_user_tag ON knowledge_doc_tags(user_id, tag)`,
    `CREATE INDEX IF NOT EXISTS idx_knowledge_doc_tags_doc ON knowledge_doc_tags(doc_id)`,
    `CREATE INDEX IF NOT EXISTS idx_knowledge_tags_user ON knowledge_tags(user_id, deleted_at, tag)`,
    `CREATE INDEX IF NOT EXISTS idx_kg_mentions_user ON knowledge_entity_mentions(user_id)`,
    `CREATE INDEX IF NOT EXISTS idx_kg_mentions_chunk ON knowledge_entity_mentions(chunk_id)`,
    `CREATE INDEX IF NOT EXISTS idx_kg_relations_user_status ON knowledge_relations(user_id, status)`,
    `CREATE INDEX IF NOT EXISTS idx_kg_relations_source_entity ON knowledge_relations(source_entity_id, status)`,
    `CREATE INDEX IF NOT EXISTS idx_kg_relations_target_entity ON knowledge_relations(target_entity_id, status)`,
    `CREATE INDEX IF NOT EXISTS idx_kg_relations_source_chunk ON knowledge_relations(source_chunk_id)`,
    `CREATE INDEX IF NOT EXISTS idx_rag_feedback_user_created ON rag_feedback(user_id, created_at)`,
    `CREATE INDEX IF NOT EXISTS idx_rag_feedback_user_doc ON rag_feedback(user_id, doc_name)`,
    `CREATE INDEX IF NOT EXISTS idx_rag_debug_queries_user_created ON rag_debug_queries(user_id, created_at)`,
    `CREATE INDEX IF NOT EXISTS idx_regulation_documents_status ON regulation_documents(status, deleted_at, updated_at)`,
    `CREATE INDEX IF NOT EXISTS idx_regulation_documents_category ON regulation_documents(category, deleted_at, updated_at)`,
    `CREATE INDEX IF NOT EXISTS idx_regulation_documents_updated ON regulation_documents(updated_at DESC, created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_regulation_versions_document ON regulation_versions(document_id, id DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_regulation_articles_document ON regulation_articles(document_id, sort_order, id)`,
    `CREATE INDEX IF NOT EXISTS idx_regulation_articles_version ON regulation_articles(version_id, sort_order, id)`,
    `CREATE INDEX IF NOT EXISTS idx_regulation_articles_content_trgm ON regulation_articles USING gin(content gin_trgm_ops)`,
    `CREATE INDEX IF NOT EXISTS idx_regulation_article_links_version ON regulation_article_links(version_id)`,
    `CREATE INDEX IF NOT EXISTS idx_regulation_article_links_source ON regulation_article_links(source_article_id)`,
    `CREATE INDEX IF NOT EXISTS idx_regulation_aliases_document ON regulation_aliases(document_id)`,
    `CREATE INDEX IF NOT EXISTS idx_regulation_aliases_normalized ON regulation_aliases(normalized_alias)`,
    `CREATE INDEX IF NOT EXISTS idx_regulation_annotations_article ON regulation_article_annotations(article_id)`,
    `CREATE INDEX IF NOT EXISTS idx_regulation_access_user ON regulation_access_logs(user_id)`,
    `CREATE INDEX IF NOT EXISTS idx_regulation_access_created ON regulation_access_logs(created_at)`,
    `CREATE INDEX IF NOT EXISTS idx_regulation_saved_searches_user ON regulation_saved_searches(user_id)`,
    `CREATE INDEX IF NOT EXISTS idx_agent_runs_user_created ON agent_runs(user_id, created_at)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_runs_user_dedupe ON agent_runs(user_id, dedupe_key) WHERE dedupe_key IS NOT NULL AND deleted_at IS NULL`,
    `CREATE INDEX IF NOT EXISTS idx_agent_steps_run ON agent_steps(run_id, step_index)`,
    `CREATE INDEX IF NOT EXISTS idx_agent_traces_user_created ON agent_traces(user_id, created_at)`,
    `CREATE INDEX IF NOT EXISTS idx_agent_trace_spans_run_started ON agent_trace_spans(run_id, started_at, id)`,
    `CREATE INDEX IF NOT EXISTS idx_agent_trace_spans_parent ON agent_trace_spans(parent_span_id)`,
    `CREATE INDEX IF NOT EXISTS idx_agent_checkpoints_run_step ON agent_run_checkpoints(run_id, step_index, id)`,
    `CREATE INDEX IF NOT EXISTS idx_agent_notifications_user ON agent_notifications(user_id, status, created_at)`,
    `CREATE INDEX IF NOT EXISTS idx_agent_dag_nodes_run ON agent_dag_nodes(run_id, status)`,
    `CREATE INDEX IF NOT EXISTS idx_agent_approval_requests_run ON agent_approval_requests(run_id, request_type, status)`,
    `CREATE INDEX IF NOT EXISTS idx_agent_approval_requests_user ON agent_approval_requests(user_id, status, created_at)`,
    `CREATE INDEX IF NOT EXISTS idx_agent_approval_requests_expires ON agent_approval_requests(status, expires_at)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_approval_requests_callback_token ON agent_approval_requests(callback_token_hash) WHERE callback_token_hash IS NOT NULL`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_approval_requests_pending_key ON agent_approval_requests(run_id, request_type, approval_key) WHERE status = 'pending'`,
    `CREATE INDEX IF NOT EXISTS idx_agent_artifacts_user ON agent_artifacts(user_id, created_at)`,
    `CREATE INDEX IF NOT EXISTS idx_agent_artifact_versions_artifact ON agent_artifact_versions(artifact_id, version)`,
    `CREATE INDEX IF NOT EXISTS idx_agent_eval_suites_user_updated ON agent_eval_suites(user_id, deleted_at, updated_at)`,
    `CREATE INDEX IF NOT EXISTS idx_agent_eval_cases_suite_order ON agent_eval_cases(suite_id, sort_order, id)`,
    `CREATE INDEX IF NOT EXISTS idx_agent_eval_runs_suite_created ON agent_eval_runs(suite_id, created_at)`,
    `CREATE INDEX IF NOT EXISTS idx_agent_eval_results_run_status ON agent_eval_results(eval_run_id, status)`,
    `CREATE INDEX IF NOT EXISTS idx_agent_eval_results_agent_run ON agent_eval_results(agent_run_id)`,
    `CREATE INDEX IF NOT EXISTS idx_agent_templates_user ON agent_templates(user_id, deleted_at)`,
    `CREATE INDEX IF NOT EXISTS idx_agent_schedules_user_status ON agent_schedules(user_id, status, deleted_at)`,
    `CREATE INDEX IF NOT EXISTS idx_agent_schedules_due ON agent_schedules(status, next_run_at, deleted_at)`,
    `CREATE INDEX IF NOT EXISTS idx_agent_workflows_user ON agent_workflows(user_id, deleted_at, updated_at)`,
    `CREATE INDEX IF NOT EXISTS idx_agent_workflows_scope ON agent_workflows(scope, deleted_at, updated_at)`,
    `CREATE INDEX IF NOT EXISTS idx_agent_workflow_versions_workflow ON agent_workflow_versions(workflow_id, version)`,
    `CREATE INDEX IF NOT EXISTS idx_agent_workflow_dependency_bindings_user ON agent_workflow_dependency_bindings(user_id, updated_at)`,
    `CREATE INDEX IF NOT EXISTS idx_agent_workflow_triggers_user ON agent_workflow_triggers(user_id, deleted_at, updated_at)`,
    `CREATE INDEX IF NOT EXISTS idx_agent_workflow_triggers_workflow ON agent_workflow_triggers(workflow_id, deleted_at)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_workflow_triggers_token ON agent_workflow_triggers(token_hash) WHERE token_hash IS NOT NULL`,
    `CREATE INDEX IF NOT EXISTS idx_agent_workflow_triggers_poll ON agent_workflow_triggers(trigger_type, status, deleted_at)`,
    `CREATE INDEX IF NOT EXISTS idx_workflow_credentials_user ON workflow_credentials(user_id, deleted_at, updated_at)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_workflow_credentials_slug ON workflow_credentials(user_id, slug) WHERE deleted_at IS NULL`,
    `CREATE INDEX IF NOT EXISTS idx_workflow_credentials_scope ON workflow_credentials(scope, deleted_at)`,
    `CREATE INDEX IF NOT EXISTS idx_mcp_servers_user ON mcp_servers(user_id, status)`,
    `CREATE INDEX IF NOT EXISTS idx_mcp_servers_scope ON mcp_servers(scope, status, updated_at)`,
    `CREATE INDEX IF NOT EXISTS idx_mcp_tool_cache_server ON mcp_tool_cache(server_id)`,
    `CREATE INDEX IF NOT EXISTS idx_mcp_call_logs_server_created ON mcp_call_logs(server_id, created_at)`,
    `CREATE INDEX IF NOT EXISTS idx_mcp_call_logs_user_created ON mcp_call_logs(user_id, created_at)`,
    `CREATE INDEX IF NOT EXISTS idx_mcp_database_connections_user ON mcp_database_connections(user_id, status)`,
    `CREATE INDEX IF NOT EXISTS idx_document_files_user_created ON document_files(user_id, created_at)`,
    `CREATE INDEX IF NOT EXISTS idx_document_files_source ON document_files(source_module, source_ref)`,
    `CREATE INDEX IF NOT EXISTS idx_document_jobs_user_status ON document_jobs(user_id, status, updated_at)`,
    `CREATE INDEX IF NOT EXISTS idx_document_jobs_file ON document_jobs(file_id, created_at)`,
    `CREATE INDEX IF NOT EXISTS idx_document_pages_job_number ON document_pages(job_id, page_number)`,
    `CREATE INDEX IF NOT EXISTS idx_document_blocks_page_order ON document_ocr_blocks(page_id, sort_order)`,
    `CREATE INDEX IF NOT EXISTS idx_document_outputs_user_job ON document_outputs(user_id, job_id, created_at)`,
    `CREATE INDEX IF NOT EXISTS idx_document_reviews_page ON document_reviews(page_id, updated_at)`,
    `CREATE INDEX IF NOT EXISTS idx_analysis_datasets_user ON analysis_datasets(user_id, deleted_at, updated_at)`,
    `CREATE INDEX IF NOT EXISTS idx_analysis_artifacts_user ON analysis_artifacts(user_id, dataset_id, created_at)`,
    `CREATE INDEX IF NOT EXISTS idx_capability_packages_user ON capability_packages(user_id, status, type)`,
    `CREATE INDEX IF NOT EXISTS idx_observability_events_type_created ON observability_events(type, created_at)`,
    `CREATE INDEX IF NOT EXISTS idx_observability_events_status_created ON observability_events(status, created_at)`,
    `CREATE INDEX IF NOT EXISTS idx_teams_org_status ON teams(organization_id, status)`,
    `CREATE INDEX IF NOT EXISTS idx_team_members_user_status ON team_members(user_id, status)`,
    `CREATE INDEX IF NOT EXISTS idx_resource_permissions_subject ON resource_permissions(subject_type, subject_id)`,
    `CREATE INDEX IF NOT EXISTS idx_resource_permissions_resource ON resource_permissions(resource_type, resource_id)`,
    `CREATE INDEX IF NOT EXISTS idx_policy_objects_lookup ON policy_objects(object_type, object_id, status)`,
    `CREATE INDEX IF NOT EXISTS idx_deployment_provider_configs_type ON deployment_provider_configs(provider_type, status)`,
    `CREATE INDEX IF NOT EXISTS idx_messages_content_trgm ON messages USING gin(content gin_trgm_ops)`,
];

INDEXES.forEach(sql => DDL.push(sql));

// ── 执行 DDL ──────────────────────────────────────────────────────────────
async function main() {
    const client = await pool.connect();
    console.log('✅ 已连接 PostgreSQL');
    let ok = 0, fail = 0;

    for (const sql of DDL) {
        const preview = sql.trim().replace(/\s+/g, ' ').slice(0, 80);
        try {
            await client.query(sql);
            console.log(`  ✓ ${preview}…`);
            ok++;
        } catch (e) {
            if (e.code === '42P07' || e.code === '42710' || e.message.includes('already exists')) {
                console.log(`  ⏩ (已存在) ${preview}…`);
                ok++;
            } else {
                console.error(`  ❌ 失败: ${e.message}\n     SQL: ${preview}`);
                fail++;
            }
        }
    }

    client.release();
    await pool.end();
    console.log(`\n${'─'.repeat(60)}`);
    console.log(`Schema 创建完成：${ok} 成功 / ${fail} 失败`);
    if (fail > 0) process.exit(1);
}

main();
