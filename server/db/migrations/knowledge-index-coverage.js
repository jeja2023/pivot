'use strict';

module.exports = [{
    id: '202610280001_knowledge_index_coverage',
    description: 'Persist knowledge extraction coverage and index configuration fingerprint.',
    async upPg(client) {
        await client.query(`
            ALTER TABLE knowledge_docs ADD COLUMN IF NOT EXISTS extraction_coverage_json JSONB NOT NULL DEFAULT '{}'::jsonb;
            ALTER TABLE knowledge_docs ADD COLUMN IF NOT EXISTS index_fingerprint TEXT NOT NULL DEFAULT '';
        `);
    }
}];
