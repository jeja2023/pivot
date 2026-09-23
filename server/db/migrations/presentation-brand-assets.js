'use strict';

const migration = {
    id: '202609230004_presentation_brand_assets',
    description: 'Add tenant-controlled organization and department visibility for presentation brand assets.',
    async upPg(client) {
        await client.query(`
            ALTER TABLE presentation_assets ADD COLUMN IF NOT EXISTS scope VARCHAR(24) NOT NULL DEFAULT 'private';
            ALTER TABLE presentation_assets ADD COLUMN IF NOT EXISTS department_name VARCHAR(120) NOT NULL DEFAULT '';
            ALTER TABLE presentation_assets ADD CONSTRAINT presentation_asset_scope_check CHECK (scope IN ('private', 'organization', 'department'));
            CREATE INDEX IF NOT EXISTS idx_presentation_assets_visible
                ON presentation_assets (tenant_id, scope, department_name, deleted_at, created_at DESC);
        `);
    },
    async downPg(client) {
        await client.query(`
            DROP INDEX IF EXISTS idx_presentation_assets_visible;
            ALTER TABLE presentation_assets DROP CONSTRAINT IF EXISTS presentation_asset_scope_check;
            ALTER TABLE presentation_assets DROP COLUMN IF EXISTS scope;
            ALTER TABLE presentation_assets DROP COLUMN IF EXISTS department_name;
        `);
    }
};

module.exports = [migration];
