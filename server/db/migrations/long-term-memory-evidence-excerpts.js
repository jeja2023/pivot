'use strict';

module.exports = [{
    id: '202609260006_long_term_memory_evidence_excerpts',
    description: 'Store source excerpts for per-candidate long-term memory provenance.',
    async upPg(client) {
        await client.query(`
            ALTER TABLE memory_source_evidence
                ADD COLUMN IF NOT EXISTS evidence_excerpt TEXT NOT NULL DEFAULT '';
        `);
    }
}];
