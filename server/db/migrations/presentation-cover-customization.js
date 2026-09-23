'use strict';

const migration = {
    id: '202609230008_presentation_cover_customization',
    description: 'Persist a controlled cover asset reference for presentation library cards.',
    async upPg(client) {
        await client.query(`
            ALTER TABLE presentation_documents ADD COLUMN IF NOT EXISTS cover_asset_ref VARCHAR(96) NOT NULL DEFAULT '';
        `);
    },
    async downPg(client) {
        await client.query(`
            ALTER TABLE presentation_documents DROP COLUMN IF EXISTS cover_asset_ref;
        `);
    }
};

module.exports = [migration];
