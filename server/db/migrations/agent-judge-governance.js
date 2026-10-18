'use strict';

const migration = {
    id: '202610170004_agent_judge_governance',
    description: 'Add versioned Judge profiles, immutable per-result verdict evidence, and human calibration reviews.',
    async upPg(client) {
        await client.query(`
            CREATE TABLE IF NOT EXISTS agent_judge_profiles (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                tenant_id BIGINT NOT NULL DEFAULT 0,
                name VARCHAR(160) NOT NULL,
                model_id BIGINT NOT NULL REFERENCES models(id) ON DELETE RESTRICT,
                prompt_version VARCHAR(80) NOT NULL,
                rubric JSONB NOT NULL DEFAULT '{}'::jsonb,
                config JSONB NOT NULL DEFAULT '{}'::jsonb,
                status VARCHAR(24) NOT NULL DEFAULT 'active' CHECK (status IN ('draft', 'active', 'disabled', 'retired')),
                version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
                created_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai'),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai'),
                UNIQUE(user_id, name, version)
            );
            CREATE INDEX IF NOT EXISTS idx_agent_judge_profiles_user_status
                ON agent_judge_profiles(user_id, status, updated_at DESC);
            CREATE INDEX IF NOT EXISTS idx_agent_judge_profiles_tenant
                ON agent_judge_profiles(tenant_id, status, updated_at DESC);

            CREATE TABLE IF NOT EXISTS agent_judge_results (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                eval_run_id TEXT NOT NULL REFERENCES agent_eval_runs(id) ON DELETE CASCADE,
                eval_result_id BIGINT NOT NULL REFERENCES agent_eval_results(id) ON DELETE CASCADE,
                judge_profile_id UUID NOT NULL REFERENCES agent_judge_profiles(id) ON DELETE RESTRICT,
                subject_model_id BIGINT REFERENCES models(id) ON DELETE SET NULL,
                input_digest VARCHAR(64) NOT NULL,
                verdict JSONB NOT NULL DEFAULT '{}'::jsonb,
                decision VARCHAR(32) NOT NULL DEFAULT 'needs_human_review' CHECK (decision IN ('pass', 'fail', 'needs_human_review')),
                score NUMERIC(5,2),
                confidence NUMERIC(4,3),
                status VARCHAR(24) NOT NULL DEFAULT 'completed' CHECK (status IN ('completed', 'error')),
                error_code VARCHAR(80) NOT NULL DEFAULT '',
                error_message TEXT NOT NULL DEFAULT '',
                created_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai'),
                completed_at TIMESTAMPTZ,
                UNIQUE(eval_result_id, judge_profile_id)
            );
            CREATE INDEX IF NOT EXISTS idx_agent_judge_results_eval_run
                ON agent_judge_results(eval_run_id, created_at DESC);
            CREATE INDEX IF NOT EXISTS idx_agent_judge_results_profile
                ON agent_judge_results(judge_profile_id, status, created_at DESC);

            CREATE TABLE IF NOT EXISTS agent_judge_human_reviews (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                judge_result_id UUID NOT NULL REFERENCES agent_judge_results(id) ON DELETE CASCADE,
                eval_result_id BIGINT NOT NULL REFERENCES agent_eval_results(id) ON DELETE CASCADE,
                reviewer_user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
                decision VARCHAR(32) NOT NULL CHECK (decision IN ('pass', 'fail', 'needs_human_review')),
                score NUMERIC(5,2),
                notes TEXT NOT NULL DEFAULT '',
                created_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai'),
                UNIQUE(judge_result_id, reviewer_user_id)
            );
            CREATE INDEX IF NOT EXISTS idx_agent_judge_human_reviews_result
                ON agent_judge_human_reviews(eval_result_id, created_at DESC);
        `);
    }
};

module.exports = [migration];
