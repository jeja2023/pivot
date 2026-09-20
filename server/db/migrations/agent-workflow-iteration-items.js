'use strict';

const migration = {
    id: '202609200001_agent_workflow_iteration_items',
    description: 'Persist iteration item digests and terminal results so an interrupted run can reuse completed readonly subworkflow items.',
    async upPg(client) {
        await client.query(`
            CREATE TABLE IF NOT EXISTS agent_workflow_iteration_items (
                id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
                run_id VARCHAR(128) NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
                iteration_key VARCHAR(512) NOT NULL,
                input_index INTEGER NOT NULL,
                item_id VARCHAR(64) NOT NULL,
                input_digest VARCHAR(64) NOT NULL,
                workflow_id BIGINT NOT NULL,
                workflow_version_id BIGINT,
                invocation_id VARCHAR(128),
                status VARCHAR(32) NOT NULL DEFAULT 'pending',
                input_json JSONB NOT NULL DEFAULT '{}'::jsonb,
                result_json JSONB,
                error_message TEXT NOT NULL DEFAULT '',
                created_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai'),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai'),
                completed_at TIMESTAMPTZ,
                UNIQUE(run_id, iteration_key, input_index)
            );
            CREATE INDEX IF NOT EXISTS idx_agent_workflow_iteration_items_run
                ON agent_workflow_iteration_items(run_id, iteration_key, status, input_index);
        `);
    }
};

module.exports = [migration];
