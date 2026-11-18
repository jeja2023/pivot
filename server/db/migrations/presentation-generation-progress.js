'use strict';

module.exports = {
    id: '202611180001_presentation_generation_progress',
    description: 'Preserve approved generation input and roster progress on partial presentations.',
    upPg: client => client.query('ALTER TABLE presentation_documents ADD COLUMN IF NOT EXISTS generation_json JSONB'),
    downPg: client => client.query('ALTER TABLE presentation_documents DROP COLUMN IF EXISTS generation_json')
};
