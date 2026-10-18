'use strict';

module.exports = [{
    id: '202610170002_agent_task_transactions',
    description: 'Persist task transaction, effect and compensation states so high-risk Agent work can verify before commit.',
    async upPg(client) {
        await client.query(`
            CREATE TABLE IF NOT EXISTS agent_task_transactions (
                id UUID PRIMARY KEY,
                run_id VARCHAR(160) NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
                user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                tenant_id BIGINT NOT NULL DEFAULT 0,
                status VARCHAR(32) NOT NULL DEFAULT 'draft',
                task_contract JSONB NOT NULL DEFAULT '{}'::jsonb,
                verification JSONB NOT NULL DEFAULT '{}'::jsonb,
                workspace_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
                commit_evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
                failure_reason TEXT NOT NULL DEFAULT '',
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                verified_at TIMESTAMPTZ NULL,
                committed_at TIMESTAMPTZ NULL,
                rolled_back_at TIMESTAMPTZ NULL,
                CHECK (status IN ('draft', 'planned', 'executing', 'verifying', 'awaiting_commit', 'committed', 'compensating', 'rolled_back', 'partial', 'needs_input', 'failed', 'cancelled'))
            );
            CREATE INDEX IF NOT EXISTS idx_agent_task_transactions_run_status
                ON agent_task_transactions(run_id, status, updated_at DESC);
            CREATE INDEX IF NOT EXISTS idx_agent_task_transactions_user_status
                ON agent_task_transactions(user_id, tenant_id, status, updated_at DESC);

            CREATE TABLE IF NOT EXISTS agent_task_effects (
                id UUID PRIMARY KEY,
                transaction_id UUID NOT NULL REFERENCES agent_task_transactions(id) ON DELETE CASCADE,
                run_id VARCHAR(160) NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
                effect_type VARCHAR(96) NOT NULL,
                resource_keys JSONB NOT NULL DEFAULT '[]'::jsonb,
                idempotency_key VARCHAR(255) NOT NULL,
                commit_mode VARCHAR(24) NOT NULL DEFAULT 'after_verify',
                compensation JSONB NOT NULL DEFAULT '{}'::jsonb,
                status VARCHAR(32) NOT NULL DEFAULT 'planned',
                request JSONB NOT NULL DEFAULT '{}'::jsonb,
                result JSONB NOT NULL DEFAULT '{}'::jsonb,
                error_info JSONB NOT NULL DEFAULT '{}'::jsonb,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                committed_at TIMESTAMPTZ NULL,
                CHECK (commit_mode IN ('preview', 'after_verify', 'manual', 'irreversible')),
                CHECK (status IN ('planned', 'staged', 'executing', 'committed', 'compensation_pending', 'compensated', 'failed', 'cancelled')),
                UNIQUE(transaction_id, idempotency_key)
            );
            CREATE INDEX IF NOT EXISTS idx_agent_task_effects_transaction_status
                ON agent_task_effects(transaction_id, status, updated_at ASC);

            CREATE TABLE IF NOT EXISTS agent_compensations (
                id UUID PRIMARY KEY,
                transaction_id UUID NOT NULL REFERENCES agent_task_transactions(id) ON DELETE CASCADE,
                effect_id UUID NOT NULL REFERENCES agent_task_effects(id) ON DELETE CASCADE,
                status VARCHAR(24) NOT NULL DEFAULT 'pending',
                plan JSONB NOT NULL DEFAULT '{}'::jsonb,
                result JSONB NOT NULL DEFAULT '{}'::jsonb,
                error_info JSONB NOT NULL DEFAULT '{}'::jsonb,
                attempt_count INTEGER NOT NULL DEFAULT 0,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                completed_at TIMESTAMPTZ NULL,
                CHECK (status IN ('pending', 'executing', 'completed', 'failed', 'manual_required')),
                UNIQUE(effect_id)
            );
            CREATE INDEX IF NOT EXISTS idx_agent_compensations_transaction_status
                ON agent_compensations(transaction_id, status, updated_at ASC);
        `);
    }
}];
