'use strict';

const migration = {
    id: '202609230006_presentation_rich_media',
    description: 'Classify presentation assets so fonts, media and safe attachments can use the same governed CAS chain.',
    async upPg(client) {
        await client.query(`
            ALTER TABLE presentation_assets ADD COLUMN IF NOT EXISTS asset_type VARCHAR(24) NOT NULL DEFAULT 'image';
            ALTER TABLE presentation_assets ADD CONSTRAINT presentation_asset_type_check CHECK (asset_type IN ('image', 'font', 'audio', 'video', 'attachment'));
            CREATE INDEX IF NOT EXISTS idx_presentation_assets_type_visible
                ON presentation_assets (tenant_id, asset_type, scope, department_name, deleted_at, created_at DESC);
        `);
    },
    async downPg(client) {
        await client.query(`
            DROP INDEX IF EXISTS idx_presentation_assets_type_visible;
            ALTER TABLE presentation_assets DROP CONSTRAINT IF EXISTS presentation_asset_type_check;
            ALTER TABLE presentation_assets DROP COLUMN IF EXISTS asset_type;
        `);
    }
};

module.exports = [migration];
