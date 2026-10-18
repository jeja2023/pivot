'use strict';

module.exports = [{
    id: '202610180021_agent_domain_acceptance_committee_attestations',
    description: 'Persist four independently authenticated architecture-committee attestations for five-point evidence.',
    async upPg(client) {
        await client.query(`
            CREATE TABLE IF NOT EXISTS agent_domain_acceptance_committee_attestations (
                id UUID PRIMARY KEY,
                evidence_id UUID NOT NULL REFERENCES agent_domain_acceptance_evidence(id) ON DELETE CASCADE,
                committee_role VARCHAR(40) NOT NULL,
                signer_user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
                attestation_digest CHAR(64) NOT NULL,
                signed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                CHECK (committee_role IN ('platform_security', 'runtime', 'qa_sre', 'product')),
                UNIQUE (evidence_id, committee_role),
                UNIQUE (evidence_id, signer_user_id)
            );
            CREATE INDEX IF NOT EXISTS idx_agent_domain_acceptance_committee_attestations_evidence
                ON agent_domain_acceptance_committee_attestations(evidence_id, signed_at ASC);
        `);
    }
}];
