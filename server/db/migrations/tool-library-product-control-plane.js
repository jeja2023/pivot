'use strict';

/**
 * 工具库产品级控制面。
 *
 * 这些表刻意与历史 mcp_tool_cache 并存：后者继续作为兼容读模型，新的
 * catalog release 才是可追溯、可回滚的事实源。迁移不修改或删除已有工具，
 * 因而可以在不中断现有聊天、工作流和桌面连接器的前提下逐步切换读路径。
 */
module.exports = [{
    id: '202609200004_tool_library_product_control_plane',
    description: 'Add immutable tool catalog releases, connection accounts, task lifecycle, invocation events and tool evaluation control-plane tables.',
    async upPg(client) {
        const runMigrationSql = (...args) => client.query(...args);
        await runMigrationSql(`
            CREATE TABLE IF NOT EXISTS tool_catalog_releases (
                id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
                server_id BIGINT NOT NULL REFERENCES mcp_servers(id) ON DELETE CASCADE,
                release_version VARCHAR(160) NOT NULL,
                protocol_version VARCHAR(64) NOT NULL DEFAULT '',
                source_etag VARCHAR(512) NOT NULL DEFAULT '',
                source_last_modified VARCHAR(256) NOT NULL DEFAULT '',
                source_digest VARCHAR(128) NOT NULL,
                fetched_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai'),
                published_at TIMESTAMPTZ,
                status VARCHAR(32) NOT NULL DEFAULT 'candidate',
                fetch_duration_ms BIGINT NOT NULL DEFAULT 0,
                tool_count BIGINT NOT NULL DEFAULT 0,
                conformance_status VARCHAR(32) NOT NULL DEFAULT 'not_run',
                error_summary TEXT NOT NULL DEFAULT '',
                compatibility_summary JSONB NOT NULL DEFAULT '{}'::jsonb,
                created_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
                created_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai'),
                UNIQUE(server_id, release_version),
                CHECK (status IN ('candidate', 'active', 'pending_review', 'blocked', 'rolled_back', 'superseded'))
            );
            CREATE UNIQUE INDEX IF NOT EXISTS idx_tool_catalog_one_active_release
                ON tool_catalog_releases(server_id) WHERE status = 'active';
            CREATE INDEX IF NOT EXISTS idx_tool_catalog_releases_server_created
                ON tool_catalog_releases(server_id, created_at DESC);

            CREATE TABLE IF NOT EXISTS tool_catalog_items (
                id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
                release_id BIGINT NOT NULL REFERENCES tool_catalog_releases(id) ON DELETE CASCADE,
                server_id BIGINT NOT NULL REFERENCES mcp_servers(id) ON DELETE CASCADE,
                tool_name VARCHAR(128) NOT NULL,
                full_name VARCHAR(320) NOT NULL DEFAULT '',
                title VARCHAR(255) NOT NULL DEFAULT '',
                description TEXT NOT NULL DEFAULT '',
                input_schema JSONB NOT NULL DEFAULT '{}'::jsonb,
                output_schema JSONB NOT NULL DEFAULT '{}'::jsonb,
                annotations JSONB NOT NULL DEFAULT '{}'::jsonb,
                capabilities JSONB NOT NULL DEFAULT '[]'::jsonb,
                risk_level VARCHAR(16) NOT NULL DEFAULT 'medium',
                side_effect BOOLEAN NOT NULL DEFAULT FALSE,
                idempotent BOOLEAN NOT NULL DEFAULT FALSE,
                cacheable BOOLEAN NOT NULL DEFAULT FALSE,
                cancellable BOOLEAN NOT NULL DEFAULT TRUE,
                concurrency VARCHAR(16) NOT NULL DEFAULT 'read',
                timeout_default_seconds BIGINT NOT NULL DEFAULT 30,
                timeout_max_seconds BIGINT NOT NULL DEFAULT 120,
                auth_scopes JSONB NOT NULL DEFAULT '[]'::jsonb,
                data_classification VARCHAR(64) NOT NULL DEFAULT 'internal',
                examples JSONB NOT NULL DEFAULT '[]'::jsonb,
                tags JSONB NOT NULL DEFAULT '[]'::jsonb,
                definition_digest VARCHAR(128) NOT NULL,
                compatibility_level VARCHAR(32) NOT NULL DEFAULT 'new',
                status VARCHAR(32) NOT NULL DEFAULT 'active',
                deprecation_message TEXT NOT NULL DEFAULT '',
                created_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai'),
                UNIQUE(release_id, tool_name),
                CHECK (risk_level IN ('low', 'medium', 'high', 'critical')),
                CHECK (concurrency IN ('read', 'write', 'exclusive')),
                CHECK (status IN ('active', 'deprecated', 'blocked'))
            );
            CREATE INDEX IF NOT EXISTS idx_tool_catalog_items_release ON tool_catalog_items(release_id, tool_name);
            CREATE INDEX IF NOT EXISTS idx_tool_catalog_items_server_name ON tool_catalog_items(server_id, tool_name);
            CREATE INDEX IF NOT EXISTS idx_tool_catalog_items_digest ON tool_catalog_items(definition_digest);

            CREATE TABLE IF NOT EXISTS tool_catalog_embeddings (
                id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
                tool_item_id BIGINT REFERENCES tool_catalog_items(id) ON DELETE CASCADE,
                source_fingerprint VARCHAR(128) NOT NULL,
                embedding_key VARCHAR(128) NOT NULL,
                owner_key VARCHAR(128) NOT NULL,
                embedding_vector JSONB NOT NULL DEFAULT '[]'::jsonb,
                embedding_dimensions BIGINT NOT NULL DEFAULT 0,
                source_digest VARCHAR(128) NOT NULL DEFAULT '',
                created_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai'),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai'),
                UNIQUE(source_fingerprint, embedding_key, owner_key)
            );
            CREATE INDEX IF NOT EXISTS idx_tool_catalog_embeddings_item
                ON tool_catalog_embeddings(tool_item_id, updated_at DESC);

            CREATE TABLE IF NOT EXISTS tool_catalog_aliases (
                id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
                server_id BIGINT NOT NULL REFERENCES mcp_servers(id) ON DELETE CASCADE,
                tool_item_id BIGINT REFERENCES tool_catalog_items(id) ON DELETE CASCADE,
                alias VARCHAR(320) NOT NULL,
                alias_type VARCHAR(32) NOT NULL DEFAULT 'search',
                migration_message TEXT NOT NULL DEFAULT '',
                created_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai'),
                UNIQUE(server_id, alias),
                CHECK (alias_type IN ('search', 'display', 'legacy_name', 'migration'))
            );
            CREATE INDEX IF NOT EXISTS idx_tool_catalog_aliases_item ON tool_catalog_aliases(tool_item_id);

            CREATE TABLE IF NOT EXISTS connector_definitions (
                id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
                slug VARCHAR(128) NOT NULL UNIQUE,
                display_name VARCHAR(255) NOT NULL,
                icon TEXT NOT NULL DEFAULT '',
                category VARCHAR(64) NOT NULL DEFAULT 'general',
                docs_url TEXT NOT NULL DEFAULT '',
                auth_type VARCHAR(32) NOT NULL DEFAULT 'none',
                supported_protocols JSONB NOT NULL DEFAULT '[]'::jsonb,
                default_scopes JSONB NOT NULL DEFAULT '[]'::jsonb,
                data_residency VARCHAR(64) NOT NULL DEFAULT 'unknown',
                privacy_url TEXT NOT NULL DEFAULT '',
                owner VARCHAR(255) NOT NULL DEFAULT '',
                version VARCHAR(64) NOT NULL DEFAULT '1.0.0',
                status VARCHAR(32) NOT NULL DEFAULT 'active',
                config JSONB NOT NULL DEFAULT '{}'::jsonb,
                created_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai'),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai'),
                CHECK (auth_type IN ('none', 'api_key', 'oauth2', 'service_account', 'database')),
                CHECK (status IN ('active', 'disabled', 'deprecated'))
            );

            CREATE TABLE IF NOT EXISTS connection_accounts (
                id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
                connector_id BIGINT NOT NULL REFERENCES connector_definitions(id) ON DELETE RESTRICT,
                server_id BIGINT REFERENCES mcp_servers(id) ON DELETE SET NULL,
                tenant_id BIGINT REFERENCES organizations(id) ON DELETE SET NULL,
                owner_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
                ownership_scope VARCHAR(32) NOT NULL DEFAULT 'personal',
                display_name VARCHAR(255) NOT NULL,
                auth_state VARCHAR(32) NOT NULL DEFAULT 'unconnected',
                provider_subject VARCHAR(512) NOT NULL DEFAULT '',
                encrypted_secret_ref TEXT NOT NULL DEFAULT '',
                scopes JSONB NOT NULL DEFAULT '[]'::jsonb,
                expires_at TIMESTAMPTZ,
                last_refresh_at TIMESTAMPTZ,
                last_error TEXT NOT NULL DEFAULT '',
                revoked_at TIMESTAMPTZ,
                metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
                created_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai'),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai'),
                CHECK (ownership_scope IN ('personal', 'unit', 'service')),
                CHECK (auth_state IN ('unconnected', 'authorizing', 'active', 'expiring', 'refresh_failed', 'disabled', 'revoked'))
            );
            CREATE INDEX IF NOT EXISTS idx_connection_accounts_owner_state
                ON connection_accounts(owner_user_id, auth_state, updated_at DESC);
            CREATE INDEX IF NOT EXISTS idx_connection_accounts_server ON connection_accounts(server_id, auth_state);

            CREATE TABLE IF NOT EXISTS connection_authorization_requests (
                id VARCHAR(96) PRIMARY KEY,
                connection_account_id BIGINT NOT NULL REFERENCES connection_accounts(id) ON DELETE CASCADE,
                user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                state_hash VARCHAR(128) NOT NULL UNIQUE,
                code_verifier_encrypted TEXT NOT NULL,
                redirect_uri TEXT NOT NULL,
                expires_at TIMESTAMPTZ NOT NULL,
                status VARCHAR(32) NOT NULL DEFAULT 'pending',
                consumed_at TIMESTAMPTZ,
                error_message TEXT NOT NULL DEFAULT '',
                created_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai'),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai'),
                CHECK (status IN ('pending', 'processing', 'completed', 'failed', 'expired'))
            );
            CREATE INDEX IF NOT EXISTS idx_connection_authorization_requests_account
                ON connection_authorization_requests(connection_account_id, status, expires_at DESC);
            CREATE INDEX IF NOT EXISTS idx_connection_authorization_requests_expiry
                ON connection_authorization_requests(expires_at) WHERE status IN ('pending', 'processing');

            CREATE TABLE IF NOT EXISTS tool_connection_bindings (
                id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
                tool_item_id BIGINT NOT NULL REFERENCES tool_catalog_items(id) ON DELETE CASCADE,
                connection_account_id BIGINT NOT NULL REFERENCES connection_accounts(id) ON DELETE CASCADE,
                allowed_scopes JSONB NOT NULL DEFAULT '[]'::jsonb,
                field_policy JSONB NOT NULL DEFAULT '{}'::jsonb,
                is_default BOOLEAN NOT NULL DEFAULT FALSE,
                status VARCHAR(32) NOT NULL DEFAULT 'active',
                created_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai'),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai'),
                UNIQUE(tool_item_id, connection_account_id),
                CHECK (status IN ('active', 'disabled'))
            );
            CREATE UNIQUE INDEX IF NOT EXISTS idx_tool_connection_one_default
                ON tool_connection_bindings(tool_item_id) WHERE is_default AND status = 'active';

            CREATE TABLE IF NOT EXISTS tool_invocation_events (
                id VARCHAR(80) PRIMARY KEY,
                trace_id VARCHAR(128) NOT NULL DEFAULT '',
                span_id VARCHAR(128) NOT NULL DEFAULT '',
                parent_span_id VARCHAR(128) NOT NULL DEFAULT '',
                run_id VARCHAR(128),
                step_id VARCHAR(128) NOT NULL DEFAULT '',
                session_id VARCHAR(128) NOT NULL DEFAULT '',
                tenant_id BIGINT REFERENCES organizations(id) ON DELETE SET NULL,
                actor_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
                tool_item_id BIGINT REFERENCES tool_catalog_items(id) ON DELETE SET NULL,
                release_id BIGINT REFERENCES tool_catalog_releases(id) ON DELETE SET NULL,
                server_id BIGINT REFERENCES mcp_servers(id) ON DELETE SET NULL,
                connection_account_id BIGINT REFERENCES connection_accounts(id) ON DELETE SET NULL,
                tool_name VARCHAR(320) NOT NULL,
                definition_digest VARCHAR(128) NOT NULL DEFAULT '',
                policy_decision VARCHAR(32) NOT NULL,
                policy_reason_codes JSONB NOT NULL DEFAULT '[]'::jsonb,
                approval_id VARCHAR(128) NOT NULL DEFAULT '',
                source VARCHAR(64) NOT NULL DEFAULT 'unknown',
                request_digest VARCHAR(128) NOT NULL DEFAULT '',
                input_ref TEXT NOT NULL DEFAULT '',
                output_ref TEXT NOT NULL DEFAULT '',
                output_digest VARCHAR(128) NOT NULL DEFAULT '',
                attempt BIGINT NOT NULL DEFAULT 1,
                queue_ms BIGINT NOT NULL DEFAULT 0,
                network_ms BIGINT NOT NULL DEFAULT 0,
                execution_ms BIGINT NOT NULL DEFAULT 0,
                total_ms BIGINT NOT NULL DEFAULT 0,
                status VARCHAR(32) NOT NULL,
                error_class VARCHAR(64) NOT NULL DEFAULT '',
                error_code VARCHAR(128) NOT NULL DEFAULT '',
                retryable BOOLEAN NOT NULL DEFAULT FALSE,
                cancelled BOOLEAN NOT NULL DEFAULT FALSE,
                input_tokens BIGINT NOT NULL DEFAULT 0,
                output_tokens BIGINT NOT NULL DEFAULT 0,
                estimated_cost NUMERIC(18, 8) NOT NULL DEFAULT 0,
                created_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai')
            );
            CREATE INDEX IF NOT EXISTS idx_tool_invocation_events_tool_time
                ON tool_invocation_events(tool_name, created_at DESC);
            CREATE INDEX IF NOT EXISTS idx_tool_invocation_events_actor_time
                ON tool_invocation_events(actor_id, created_at DESC);
            CREATE INDEX IF NOT EXISTS idx_tool_invocation_events_release_time
                ON tool_invocation_events(release_id, created_at DESC);
            CREATE INDEX IF NOT EXISTS idx_tool_invocation_events_trace ON tool_invocation_events(trace_id, span_id);

            CREATE TABLE IF NOT EXISTS tool_tasks (
                id VARCHAR(128) PRIMARY KEY,
                user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                tenant_id BIGINT REFERENCES organizations(id) ON DELETE SET NULL,
                invocation_event_id VARCHAR(80) REFERENCES tool_invocation_events(id) ON DELETE SET NULL,
                tool_name VARCHAR(320) NOT NULL,
                release_id BIGINT REFERENCES tool_catalog_releases(id) ON DELETE SET NULL,
                status VARCHAR(32) NOT NULL DEFAULT 'working',
                input_request JSONB NOT NULL DEFAULT '{}'::jsonb,
                result_json JSONB NOT NULL DEFAULT '{}'::jsonb,
                result_ref TEXT NOT NULL DEFAULT '',
                result_digest VARCHAR(128) NOT NULL DEFAULT '',
                error_code VARCHAR(128) NOT NULL DEFAULT '',
                error_message TEXT NOT NULL DEFAULT '',
                cancel_requested_at TIMESTAMPTZ,
                poll_after_ms BIGINT NOT NULL DEFAULT 1000,
                expires_at TIMESTAMPTZ NOT NULL,
                created_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai'),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai'),
                CHECK (status IN ('working', 'input_required', 'completed', 'failed', 'cancelled', 'expired'))
            );
            CREATE INDEX IF NOT EXISTS idx_tool_tasks_user_status ON tool_tasks(user_id, status, updated_at DESC);
            CREATE INDEX IF NOT EXISTS idx_tool_tasks_expiry ON tool_tasks(expires_at) WHERE status IN ('working', 'input_required');
            ALTER TABLE tool_tasks ADD COLUMN IF NOT EXISTS result_json JSONB NOT NULL DEFAULT '{}'::jsonb;

            CREATE TABLE IF NOT EXISTS tool_eval_suites (
                id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
                name VARCHAR(255) NOT NULL,
                description TEXT NOT NULL DEFAULT '',
                owner_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
                status VARCHAR(32) NOT NULL DEFAULT 'active',
                created_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai'),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai')
            );
            CREATE TABLE IF NOT EXISTS tool_eval_cases (
                id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
                suite_id BIGINT NOT NULL REFERENCES tool_eval_suites(id) ON DELETE CASCADE,
                name VARCHAR(255) NOT NULL,
                prompt TEXT NOT NULL,
                expected_tool_names JSONB NOT NULL DEFAULT '[]'::jsonb,
                expected_outcome JSONB NOT NULL DEFAULT '{}'::jsonb,
                tags JSONB NOT NULL DEFAULT '[]'::jsonb,
                status VARCHAR(32) NOT NULL DEFAULT 'active',
                created_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai'),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai')
            );
            CREATE TABLE IF NOT EXISTS tool_eval_runs (
                id VARCHAR(80) PRIMARY KEY,
                suite_id BIGINT NOT NULL REFERENCES tool_eval_suites(id) ON DELETE CASCADE,
                release_id BIGINT REFERENCES tool_catalog_releases(id) ON DELETE SET NULL,
                status VARCHAR(32) NOT NULL DEFAULT 'queued',
                summary JSONB NOT NULL DEFAULT '{}'::jsonb,
                created_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
                started_at TIMESTAMPTZ,
                completed_at TIMESTAMPTZ,
                created_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai')
            );
            CREATE TABLE IF NOT EXISTS tool_eval_results (
                id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
                run_id VARCHAR(80) NOT NULL REFERENCES tool_eval_runs(id) ON DELETE CASCADE,
                case_id BIGINT NOT NULL REFERENCES tool_eval_cases(id) ON DELETE CASCADE,
                selected_tools JSONB NOT NULL DEFAULT '[]'::jsonb,
                outcome JSONB NOT NULL DEFAULT '{}'::jsonb,
                score NUMERIC(8, 4) NOT NULL DEFAULT 0,
                status VARCHAR(32) NOT NULL DEFAULT 'completed',
                error_message TEXT NOT NULL DEFAULT '',
                created_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai'),
                UNIQUE(run_id, case_id)
            );
            CREATE INDEX IF NOT EXISTS idx_tool_eval_results_run ON tool_eval_results(run_id, score DESC);

            CREATE TABLE IF NOT EXISTS toolkit_signing_keys (
                id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
                key_id VARCHAR(128) NOT NULL UNIQUE,
                publisher VARCHAR(255) NOT NULL,
                algorithm VARCHAR(64) NOT NULL DEFAULT 'RSA-SHA256',
                public_key_pem TEXT NOT NULL,
                status VARCHAR(32) NOT NULL DEFAULT 'active',
                expires_at TIMESTAMPTZ,
                revoked_at TIMESTAMPTZ,
                created_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
                created_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai'),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai'),
                CHECK (status IN ('active', 'disabled', 'revoked'))
            );

            CREATE TABLE IF NOT EXISTS toolkit_releases (
                id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
                slug VARCHAR(128) NOT NULL,
                version VARCHAR(64) NOT NULL,
                display_name VARCHAR(255) NOT NULL,
                publisher VARCHAR(255) NOT NULL,
                protocol_type VARCHAR(32) NOT NULL,
                protocol_versions JSONB NOT NULL DEFAULT '[]'::jsonb,
                manifest JSONB NOT NULL,
                content_digest VARCHAR(128) NOT NULL,
                signature TEXT NOT NULL DEFAULT '',
                signing_key_id VARCHAR(128),
                signature_verified BOOLEAN NOT NULL DEFAULT FALSE,
                validation JSONB NOT NULL DEFAULT '{}'::jsonb,
                server_id BIGINT REFERENCES mcp_servers(id) ON DELETE SET NULL,
                status VARCHAR(32) NOT NULL DEFAULT 'draft',
                review_note TEXT NOT NULL DEFAULT '',
                reviewed_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
                reviewed_at TIMESTAMPTZ,
                created_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
                created_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai'),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai'),
                UNIQUE(slug, version),
                CHECK (protocol_type IN ('mcp', 'builtin', 'api_operation')),
                CHECK (status IN ('draft', 'validated', 'pending_review', 'published', 'blocked', 'revoked'))
            );
            CREATE INDEX IF NOT EXISTS idx_toolkit_releases_status ON toolkit_releases(status, updated_at DESC);
            CREATE INDEX IF NOT EXISTS idx_toolkit_releases_server ON toolkit_releases(server_id, status);

            ALTER TABLE agent_workflow_releases
                ADD COLUMN IF NOT EXISTS tool_release_bindings JSONB NOT NULL DEFAULT '[]'::jsonb,
                ADD COLUMN IF NOT EXISTS tool_dependency_stale BOOLEAN NOT NULL DEFAULT FALSE,
                ADD COLUMN IF NOT EXISTS tool_dependency_stale_at TIMESTAMPTZ,
                ADD COLUMN IF NOT EXISTS tool_dependency_stale_reason TEXT NOT NULL DEFAULT '';
            CREATE INDEX IF NOT EXISTS idx_agent_workflow_releases_tool_stale
                ON agent_workflow_releases(workflow_id, status, tool_dependency_stale);
        `);
    }
}];
