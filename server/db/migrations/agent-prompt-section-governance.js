'use strict';

module.exports = [{
    id: '202610180006_agent_prompt_section_governance',
    description: 'Govern stable Prompt Section drafts, evaluation impact evidence and independent approval.',
    async upPg(client) {
        await client.query(`
            ALTER TABLE agent_prompt_section_versions
                ADD COLUMN IF NOT EXISTS content TEXT NOT NULL DEFAULT '',
                ADD COLUMN IF NOT EXISTS approval_status VARCHAR(24) NOT NULL DEFAULT 'approved',
                ADD COLUMN IF NOT EXISTS impact_report JSONB NOT NULL DEFAULT '{}'::jsonb,
                ADD COLUMN IF NOT EXISTS approved_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
                ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ;
        `);
    }
}];
