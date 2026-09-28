'use strict';

const DECISION_EVALUATION_GOVERNANCE_SQL = [
    'CREATE TABLE IF NOT EXISTS decision_evaluation_sets (',
    'version VARCHAR(128) PRIMARY KEY,',
    'source_digest VARCHAR(160) NOT NULL,',
    "source_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,",
    'imported_by BIGINT REFERENCES users(id) ON DELETE SET NULL,',
    'imported_at TIMESTAMPTZ NOT NULL',
    ');',
    'CREATE TABLE IF NOT EXISTS decision_evaluation_cases (',
    'set_version VARCHAR(128) NOT NULL REFERENCES decision_evaluation_sets(version) ON DELETE CASCADE,',
    'case_id VARCHAR(128) NOT NULL,',
    'case_digest VARCHAR(160) NOT NULL,',
    'scenario VARCHAR(80) NOT NULL,',
    'language VARCHAR(24) NOT NULL,',
    "input_context JSONB NOT NULL DEFAULT '{}'::jsonb,",
    "candidate_actions JSONB NOT NULL DEFAULT '[]'::jsonb,",
    "review_status VARCHAR(24) NOT NULL DEFAULT 'pending_human_review',",
    "expected_action_id VARCHAR(96) NOT NULL DEFAULT '',",
    'reviewed_by BIGINT REFERENCES users(id) ON DELETE SET NULL,',
    'reviewed_at TIMESTAMPTZ,',
    "review_note TEXT NOT NULL DEFAULT '',",
    'updated_at TIMESTAMPTZ NOT NULL,',
    'PRIMARY KEY (set_version, case_id)',
    ');',
    'CREATE INDEX IF NOT EXISTS idx_decision_evaluation_cases_review ON decision_evaluation_cases(set_version, review_status, scenario, language);',
    'CREATE TABLE IF NOT EXISTS decision_evaluation_reviews (',
    'id VARCHAR(128) PRIMARY KEY,',
    'set_version VARCHAR(128) NOT NULL,',
    'case_id VARCHAR(128) NOT NULL,',
    'expected_action_id VARCHAR(96) NOT NULL,',
    'reviewer_id BIGINT REFERENCES users(id) ON DELETE SET NULL,',
    "review_note TEXT NOT NULL DEFAULT '',",
    'reviewed_at TIMESTAMPTZ NOT NULL,',
    'FOREIGN KEY (set_version, case_id) REFERENCES decision_evaluation_cases(set_version, case_id) ON DELETE CASCADE',
    ');',
    'CREATE INDEX IF NOT EXISTS idx_decision_evaluation_reviews_case ON decision_evaluation_reviews(set_version, case_id, reviewed_at DESC);',
    'DO $decision_outcomes_fk$',
    'BEGIN',
    "IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'decision_outcomes'::regclass AND contype = 'f' AND confrelid = 'decision_records'::regclass) THEN",
    'ALTER TABLE decision_outcomes ADD CONSTRAINT fk_decision_outcomes_record FOREIGN KEY (decision_id) REFERENCES decision_records(decision_id) ON DELETE CASCADE;',
    'END IF;',
    'END',
    '$decision_outcomes_fk$;'
].join('\n');

module.exports = [{
    id: '202609280002_decision_evaluation_governance',
    description: 'Add persisted frozen evaluation reviews and decision outcome referential integrity after the initial decision migration.',
    async upPg(client) {
        await client.query(DECISION_EVALUATION_GOVERNANCE_SQL);
    }
}];
