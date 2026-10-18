'use strict';

module.exports = [{
    id: '202610170012_long_term_memory_source_reference_uniqueness',
    description: 'Enforce one live provenance reference per Memory so external source revalidation is deterministic.',
    async upPg(client) {
        await client.query(`
            CREATE UNIQUE INDEX IF NOT EXISTS uq_memory_source_evidence_reference
                ON memory_source_evidence(memory_id, source_kind, source_ref)
                WHERE source_ref <> '';
        `);
    }
}];
