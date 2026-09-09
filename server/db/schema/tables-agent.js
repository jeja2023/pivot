/**
 * Agent、工作流、MCP 与分析治理表 DDL（SQLite 方言）
 */
function agentTablesSql() {
    return `
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
            retry_after DATETIME,
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

        CREATE TABLE IF NOT EXISTS official_writing_documents (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            client_id TEXT NOT NULL,
            title TEXT NOT NULL,
            manual_title INTEGER NOT NULL DEFAULT 0,
            state TEXT NOT NULL DEFAULT '{}',
            version INTEGER NOT NULL DEFAULT 1,
            created_at DATETIME DEFAULT (datetime('now', '+8 hours')),
            updated_at DATETIME DEFAULT (datetime('now', '+8 hours')),
            deleted_at DATETIME,
            UNIQUE(user_id, client_id),
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
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
            callback_requirement_key TEXT DEFAULT '',
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
    `;
}

module.exports = { agentTablesSql };
