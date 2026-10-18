'use strict';

const migration = {
    id: '202610170010_long_term_memory_source_fingerprints',
    description: 'Track Memory provenance fingerprints and require review when a source mutates or is partially revoked.',
    async upPg(client) {
        await client.query(`
            ALTER TABLE memory_source_evidence ADD COLUMN IF NOT EXISTS source_ref VARCHAR(255) NOT NULL DEFAULT '';
            ALTER TABLE memory_source_evidence ADD COLUMN IF NOT EXISTS source_fingerprint VARCHAR(64) NOT NULL DEFAULT '';
            ALTER TABLE memory_source_evidence ADD COLUMN IF NOT EXISTS review_required_at TIMESTAMPTZ;
            UPDATE memory_source_evidence
            SET source_ref = CASE
                WHEN source_ref <> '' THEN source_ref
                WHEN message_id IS NOT NULL THEN 'message:' || message_id::text
                WHEN session_id IS NOT NULL AND session_id <> '' THEN 'session:' || session_id
                ELSE ''
            END
            WHERE source_ref = '';
            CREATE INDEX IF NOT EXISTS idx_memory_source_evidence_fingerprint
                ON memory_source_evidence(user_id, source_kind, source_ref, source_fingerprint);
        `);
    }
};

module.exports = [migration];
