'use strict';

module.exports = [{
    id: '202609260002_long_term_memory_evaluations',
    description: 'Add persistent long-term memory retrieval evaluation cases and results.',
    async upPg(client) {
        await client.query(`
            CREATE TABLE IF NOT EXISTS memory_evaluation_cases (
                id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
                user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                name VARCHAR(180) NOT NULL,
                query TEXT NOT NULL,
                expected_memory_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
                forbidden_memory_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
                scope JSONB NOT NULL DEFAULT '{}'::jsonb,
                category VARCHAR(32) NOT NULL DEFAULT 'general',
                status VARCHAR(24) NOT NULL DEFAULT 'active',
                deleted_at TIMESTAMPTZ,
                created_at TIMESTAMPTZ DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai'),
                updated_at TIMESTAMPTZ DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai')
            );
            CREATE TABLE IF NOT EXISTS memory_evaluation_runs (
                id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
                user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                status VARCHAR(24) NOT NULL DEFAULT 'completed',
                strategy VARCHAR(24) NOT NULL DEFAULT 'current',
                summary JSONB NOT NULL DEFAULT '{}'::jsonb,
                created_at TIMESTAMPTZ DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai'),
                completed_at TIMESTAMPTZ
            );
            CREATE TABLE IF NOT EXISTS memory_evaluation_results (
                id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
                run_id BIGINT NOT NULL REFERENCES memory_evaluation_runs(id) ON DELETE CASCADE,
                case_id BIGINT NOT NULL REFERENCES memory_evaluation_cases(id) ON DELETE CASCADE,
                result JSONB NOT NULL DEFAULT '{}'::jsonb,
                created_at TIMESTAMPTZ DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai'),
                UNIQUE(run_id, case_id)
            );
            CREATE INDEX IF NOT EXISTS idx_memory_evaluation_cases_user
                ON memory_evaluation_cases(user_id, status, deleted_at, updated_at DESC);
            CREATE INDEX IF NOT EXISTS idx_memory_evaluation_runs_user
                ON memory_evaluation_runs(user_id, created_at DESC);
            CREATE INDEX IF NOT EXISTS idx_memory_evaluation_results_run
                ON memory_evaluation_results(run_id, case_id);
        `);
    }
}];
