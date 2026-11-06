'use strict';

module.exports = [{
    id: '202611060001_presentation_svg_export',
    description: '允许演示文稿登记单页 SVG 导出并保留已有导出记录。',
    async upPg(client) {
        await client.query(`
            ALTER TABLE presentation_exports DROP CONSTRAINT IF EXISTS presentation_export_format_check;
            ALTER TABLE presentation_exports ADD CONSTRAINT presentation_export_format_check CHECK (format IN ('pptx', 'pdf', 'png', 'svg'));
        `);
    },
    async checkPg(client) {
        const result = await client.query(`
            SELECT EXISTS (
                SELECT 1 FROM pg_constraint
                WHERE conrelid = to_regclass(format('%I.%I', current_schema(), 'presentation_exports'))
                  AND conname = 'presentation_export_format_check'
                  AND position('svg' in pg_get_constraintdef(oid)) > 0
            ) AS present
        `);
        return result.rows[0]?.present === true;
    }
}];
