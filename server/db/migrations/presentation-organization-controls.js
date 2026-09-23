'use strict';

const migration = {
    id: '202609230003_presentation_organization_controls',
    description: 'Add department-scoped templates and brand-control metadata for presentation templates.',
    async upPg(client) {
        await client.query(`
            ALTER TABLE presentation_templates DROP CONSTRAINT IF EXISTS presentation_template_scope_check;
            ALTER TABLE presentation_templates ADD COLUMN IF NOT EXISTS department_name VARCHAR(120) NOT NULL DEFAULT '';
            ALTER TABLE presentation_templates ADD CONSTRAINT presentation_template_scope_check CHECK (scope IN ('private', 'organization', 'department', 'published'));
            CREATE INDEX IF NOT EXISTS idx_presentation_templates_department_visible
                ON presentation_templates (tenant_id, department_name, status, updated_at DESC)
                WHERE deleted_at IS NULL;
        `);
    },
    async downPg(client) {
        await client.query(`
            ALTER TABLE presentation_templates DROP CONSTRAINT IF EXISTS presentation_template_scope_check;
            ALTER TABLE presentation_templates ADD CONSTRAINT presentation_template_scope_check CHECK (scope IN ('private', 'organization', 'published'));
            DROP INDEX IF EXISTS idx_presentation_templates_department_visible;
            ALTER TABLE presentation_templates DROP COLUMN IF EXISTS department_name;
        `);
    }
};

module.exports = [migration];
