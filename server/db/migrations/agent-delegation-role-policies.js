'use strict';

module.exports = [{
    id: '202610180014_agent_delegation_role_policies',
    description: 'Persist one versioned, atomically updatable collaboration-role policy per organization.',
    async upPg(client) {
        await client.query(`
            CREATE TABLE IF NOT EXISTS agent_delegation_role_policies (
                organization_id BIGINT PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
                policy_json JSONB NOT NULL,
                revision BIGINT NOT NULL DEFAULT 1 CHECK (revision >= 1),
                updated_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            );
        `);
    }
}];
