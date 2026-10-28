'use strict';

module.exports = [{
    id: '202610280004_knowledge_ocr_location',
    description: 'Persist OCR block geometry for source-verified PDF previews.',
    async upPg(client) {
        await client.query(`ALTER TABLE knowledge_pdf_ocr_pages ADD COLUMN IF NOT EXISTS location_json JSONB NOT NULL DEFAULT '{}'::jsonb;`);
    }
}];
