'use strict';

module.exports = [{
    id: '202610180022_agent_domain_acceptance_committee_members',
    description: 'Bind each five-point architecture committee role to one distinct active administrator before attestation.',
    async upPg(client) {
        await client.query(`
            CREATE TABLE IF NOT EXISTS agent_domain_acceptance_committee_members (
                committee_role VARCHAR(40) PRIMARY KEY,
                user_id BIGINT NOT NULL UNIQUE REFERENCES users(id) ON DELETE RESTRICT,
                assigned_by_user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
                assigned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                CHECK (committee_role IN ('platform_security', 'runtime', 'qa_sre', 'product'))
            );
        `);
    }
}];
