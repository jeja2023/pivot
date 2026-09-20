'use strict';

const migration = {
    id: '202609200003_agent_workflow_release_review',
    description: 'Store workflow release notes and tenant-admin review decisions without changing release resolution semantics.',
    up() {
        // agent_workflow_releases 是 PostgreSQL 控制面表；SQLite 不承载该发布投影。
    },
    async upPg(client) {
        await client.query(`
            ALTER TABLE agent_workflow_releases ADD COLUMN IF NOT EXISTS release_note TEXT NOT NULL DEFAULT '';
            ALTER TABLE agent_workflow_releases ADD COLUMN IF NOT EXISTS review_status VARCHAR(32) NOT NULL DEFAULT 'not_required';
            ALTER TABLE agent_workflow_releases ADD COLUMN IF NOT EXISTS review_note TEXT NOT NULL DEFAULT '';
            ALTER TABLE agent_workflow_releases ADD COLUMN IF NOT EXISTS reviewed_by BIGINT REFERENCES users(id) ON DELETE SET NULL;
            ALTER TABLE agent_workflow_releases ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ;
        `);
    }
};

module.exports = [migration];
