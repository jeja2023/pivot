'use strict';

/** Stores image dimensions for presentation preflight checks without exposing object paths. */
const migration = {
    id: '202609230003_presentation_quality_metadata',
    description: 'Add image dimensions for presentation quality validation and library filters.',
    async upPg(client) {
        await client.query(`
            ALTER TABLE presentation_assets ADD COLUMN IF NOT EXISTS pixel_width INTEGER NOT NULL DEFAULT 0;
            ALTER TABLE presentation_assets ADD COLUMN IF NOT EXISTS pixel_height INTEGER NOT NULL DEFAULT 0;
            CREATE INDEX IF NOT EXISTS idx_presentation_documents_tenant_updated
                ON presentation_documents (tenant_id, deleted_at, updated_at DESC);
        `);
    },
    async downPg(client) {
        await client.query(`
            DROP INDEX IF EXISTS idx_presentation_documents_tenant_updated;
            ALTER TABLE presentation_assets DROP COLUMN IF EXISTS pixel_width;
            ALTER TABLE presentation_assets DROP COLUMN IF EXISTS pixel_height;
        `);
    }
};

module.exports = [migration];
