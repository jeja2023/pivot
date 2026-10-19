'use strict';

module.exports = [{
    id: '202610190003_automatic_memory_project_context',
    description: 'Persist trusted project scope for asynchronous memory extraction.',
    async upPg(client) {
        await client.query("ALTER TABLE memory_extraction_jobs ADD COLUMN IF NOT EXISTS project_id TEXT NOT NULL DEFAULT ''");
    }
}];
