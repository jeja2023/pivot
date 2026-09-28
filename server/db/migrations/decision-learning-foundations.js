'use strict';

const DECISION_LEARNING_SQL = `
            CREATE TABLE IF NOT EXISTS decision_records (
                decision_id VARCHAR(128) PRIMARY KEY,
                scenario VARCHAR(80) NOT NULL,
                tenant_id BIGINT,
                user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
                session_id VARCHAR(128) NOT NULL DEFAULT '',
                request_state JSONB NOT NULL DEFAULT '{}'::jsonb,
                candidate_actions JSONB NOT NULL DEFAULT '[]'::jsonb,
                provider_outputs JSONB NOT NULL DEFAULT '[]'::jsonb,
                policy_outcome JSONB NOT NULL DEFAULT '{}'::jsonb,
                selected_action_id VARCHAR(96) NOT NULL DEFAULT '',
                created_at TIMESTAMPTZ NOT NULL,
                updated_at TIMESTAMPTZ NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_decision_records_scenario_created ON decision_records(scenario, created_at DESC);
            CREATE INDEX IF NOT EXISTS idx_decision_records_tenant_created ON decision_records(tenant_id, created_at DESC);
            CREATE INDEX IF NOT EXISTS idx_decision_records_session ON decision_records(session_id, created_at DESC);
            CREATE TABLE IF NOT EXISTS decision_outcomes (
                id VARCHAR(128) PRIMARY KEY,
                decision_id VARCHAR(128) NOT NULL REFERENCES decision_records(decision_id) ON DELETE CASCADE,
                event_type VARCHAR(24) NOT NULL,
                source VARCHAR(24) NOT NULL,
                status VARCHAR(24) NOT NULL,
                selected_action_id VARCHAR(96) NOT NULL DEFAULT '',
                verified_action_id VARCHAR(96) NOT NULL DEFAULT '',
                is_verified BOOLEAN NOT NULL DEFAULT FALSE,
                duration_ms BIGINT NOT NULL DEFAULT 0,
                reason_code VARCHAR(120) NOT NULL DEFAULT '',
                result_reference VARCHAR(160) NOT NULL DEFAULT '',
                metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
                occurred_at TIMESTAMPTZ NOT NULL,
                created_at TIMESTAMPTZ NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_decision_outcomes_decision ON decision_outcomes(decision_id, occurred_at ASC);
            CREATE INDEX IF NOT EXISTS idx_decision_outcomes_verified ON decision_outcomes(is_verified, occurred_at ASC) WHERE is_verified = TRUE;
            CREATE TABLE IF NOT EXISTS decision_model_artifacts (
                id VARCHAR(128) PRIMARY KEY,
                provider_id VARCHAR(80) NOT NULL,
                model_version VARCHAR(128) NOT NULL,
                data_version VARCHAR(128) NOT NULL,
                code_version VARCHAR(128) NOT NULL DEFAULT '',
                weights_hash VARCHAR(160) NOT NULL DEFAULT '',
                calibration JSONB NOT NULL DEFAULT '{}'::jsonb,
                evaluation_report JSONB NOT NULL DEFAULT '{}'::jsonb,
                status VARCHAR(24) NOT NULL DEFAULT 'candidate',
                created_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
                created_at TIMESTAMPTZ NOT NULL,
                promoted_at TIMESTAMPTZ,
                retired_at TIMESTAMPTZ,
                UNIQUE(provider_id, model_version)
            );
            CREATE INDEX IF NOT EXISTS idx_decision_model_artifacts_status ON decision_model_artifacts(provider_id, status, created_at DESC);
            CREATE UNIQUE INDEX IF NOT EXISTS idx_decision_model_artifacts_one_active
                ON decision_model_artifacts(provider_id) WHERE status = 'active';
            CREATE TABLE IF NOT EXISTS decision_preferences (
                id VARCHAR(128) PRIMARY KEY,
                scope VARCHAR(16) NOT NULL,
                subject_key VARCHAR(128) NOT NULL,
                user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
                tenant_id BIGINT,
                scenario VARCHAR(80) NOT NULL,
                action_id VARCHAR(96) NOT NULL,
                enabled BOOLEAN NOT NULL DEFAULT TRUE,
                created_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
                updated_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
                created_at TIMESTAMPTZ NOT NULL,
                updated_at TIMESTAMPTZ NOT NULL,
                UNIQUE(subject_key, scenario)
            );
            CREATE INDEX IF NOT EXISTS idx_decision_preferences_lookup
                ON decision_preferences(scenario, subject_key, enabled, updated_at DESC);
            CREATE TABLE IF NOT EXISTS decision_evaluation_sets (
                version VARCHAR(128) PRIMARY KEY,
                source_digest VARCHAR(160) NOT NULL,
                source_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
                imported_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
                imported_at TIMESTAMPTZ NOT NULL
            );
            CREATE TABLE IF NOT EXISTS decision_evaluation_cases (
                set_version VARCHAR(128) NOT NULL REFERENCES decision_evaluation_sets(version) ON DELETE CASCADE,
                case_id VARCHAR(128) NOT NULL,
                case_digest VARCHAR(160) NOT NULL,
                scenario VARCHAR(80) NOT NULL,
                language VARCHAR(24) NOT NULL,
                input_context JSONB NOT NULL DEFAULT '{}'::jsonb,
                candidate_actions JSONB NOT NULL DEFAULT '[]'::jsonb,
                review_status VARCHAR(24) NOT NULL DEFAULT 'pending_human_review',
                expected_action_id VARCHAR(96) NOT NULL DEFAULT '',
                reviewed_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
                reviewed_at TIMESTAMPTZ,
                review_note TEXT NOT NULL DEFAULT '',
                updated_at TIMESTAMPTZ NOT NULL,
                PRIMARY KEY (set_version, case_id)
            );
            CREATE INDEX IF NOT EXISTS idx_decision_evaluation_cases_review
                ON decision_evaluation_cases(set_version, review_status, scenario, language);
            CREATE TABLE IF NOT EXISTS decision_evaluation_reviews (
                id VARCHAR(128) PRIMARY KEY,
                set_version VARCHAR(128) NOT NULL,
                case_id VARCHAR(128) NOT NULL,
                expected_action_id VARCHAR(96) NOT NULL,
                reviewer_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
                review_note TEXT NOT NULL DEFAULT '',
                reviewed_at TIMESTAMPTZ NOT NULL,
                FOREIGN KEY (set_version, case_id)
                    REFERENCES decision_evaluation_cases(set_version, case_id) ON DELETE CASCADE
            );
            CREATE INDEX IF NOT EXISTS idx_decision_evaluation_reviews_case
                ON decision_evaluation_reviews(set_version, case_id, reviewed_at DESC);
`;

module.exports = [{
    id: '202609280001_decision_learning_foundations',
    description: 'Persist privacy-safe business decisions, verified outcomes, and immutable decision model artifacts.',
    async upPg(client) {
        await client.query(DECISION_LEARNING_SQL);
    }
}];
