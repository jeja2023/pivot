'use strict';

module.exports = [{
    id: '202610180007_agent_prompt_section_draft_status',
    description: 'Allow governed Prompt Section drafts while preserving active and retired release states.',
    async upPg(client) {
        await client.query(`
            ALTER TABLE agent_prompt_section_versions
                DROP CONSTRAINT IF EXISTS agent_prompt_section_versions_status_check;
            ALTER TABLE agent_prompt_section_versions
                ADD CONSTRAINT agent_prompt_section_versions_status_check
                CHECK (status IN ('draft', 'active', 'retired'));
        `);
    }
}];
