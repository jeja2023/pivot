'use strict';

module.exports = [{
    id: '202610180020_agent_domain_acceptance_evidence_manifest',
    description: 'Require immutable structured manifests before domain acceptance evidence can count toward a five-point review.',
    async upPg(client) {
        await client.query(`
            ALTER TABLE agent_domain_acceptance_evidence
                ADD COLUMN IF NOT EXISTS evidence_json JSONB NOT NULL DEFAULT '{}'::jsonb;
            CREATE INDEX IF NOT EXISTS idx_agent_domain_acceptance_evidence_manifest
                ON agent_domain_acceptance_evidence USING GIN (evidence_json);
        `);
    }
}];
