'use strict';

module.exports = [{
    id: '202610180005_agent_browser_console_summaries',
    description: 'Persist bounded browser console error summaries without retaining page secrets or network bodies.',
    async upPg(client) {
        await client.query(`
            ALTER TABLE agent_browser_sessions
                ADD COLUMN IF NOT EXISTS console_summary JSONB NOT NULL DEFAULT '[]'::jsonb;
        `);
    }
}];
