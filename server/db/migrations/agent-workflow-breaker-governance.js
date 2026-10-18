'use strict';

module.exports = [{
    id: '202610180004_agent_workflow_breaker_governance',
    description: 'Freeze workflow rollout breaker thresholds for automatic gray-release containment.',
    async upPg(client) {
        await client.query(`
            ALTER TABLE agent_workflow_releases
                ADD COLUMN IF NOT EXISTS breaker_thresholds JSONB NOT NULL DEFAULT '{}'::jsonb;
        `);
    }
}];
