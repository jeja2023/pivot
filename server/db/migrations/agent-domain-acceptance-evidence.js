'use strict';

module.exports = [{
    id: '202610180019_agent_domain_acceptance_evidence',
    description: 'Persist auditable five-point domain acceptance evidence without auto-promoting maturity scores.',
    async upPg(client) {
        await client.query(`
            CREATE TABLE IF NOT EXISTS agent_domain_acceptance_evidence (
                id UUID PRIMARY KEY,
                domain_key VARCHAR(64) NOT NULL,
                evidence_type VARCHAR(32) NOT NULL,
                status VARCHAR(16) NOT NULL DEFAULT 'submitted',
                evidence_summary VARCHAR(4000) NOT NULL,
                evidence_ref VARCHAR(1024) NOT NULL DEFAULT '',
                evidence_digest CHAR(64) NOT NULL,
                submitted_by_user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
                submitted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                verified_by_user_id BIGINT NULL REFERENCES users(id) ON DELETE RESTRICT,
                verified_at TIMESTAMPTZ NULL,
                verification_note VARCHAR(2000) NOT NULL DEFAULT '',
                updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                CHECK (evidence_type IN ('implementation_review', 'automated', 'nonfunctional', 'canary', 'committee')),
                CHECK (status IN ('submitted', 'verified', 'rejected')),
                UNIQUE(domain_key, evidence_type, evidence_digest)
            );
            CREATE INDEX IF NOT EXISTS idx_agent_domain_acceptance_evidence_domain
                ON agent_domain_acceptance_evidence(domain_key, evidence_type, status, updated_at DESC);
        `);
    }
}];
