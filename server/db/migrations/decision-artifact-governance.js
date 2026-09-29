'use strict';

module.exports = [{
    id: '202609290002_decision_artifact_governance',
    description: 'Bind decision artifacts to an approved tenant or explicitly approved global-training scope.',
    async upPg(client) {
        await client.query(`
            ALTER TABLE decision_model_artifacts
                ADD COLUMN IF NOT EXISTS training_tenant_id BIGINT;
            ALTER TABLE decision_model_artifacts
                ADD COLUMN IF NOT EXISTS global_training_approved BOOLEAN NOT NULL DEFAULT FALSE;
            DROP INDEX IF EXISTS idx_decision_model_artifacts_one_active;
            CREATE UNIQUE INDEX IF NOT EXISTS idx_decision_model_artifacts_one_active_scope
                ON decision_model_artifacts(provider_id, COALESCE(training_tenant_id, 0))
                WHERE status = 'active';
            CREATE INDEX IF NOT EXISTS idx_decision_model_artifacts_training_scope
                ON decision_model_artifacts(provider_id, training_tenant_id, status, created_at DESC);
        `);
    }
}];
