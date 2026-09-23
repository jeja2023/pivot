'use strict';

const migration = {
    id: '202609230002_presentation_product_governance',
    description: 'Add template review workflow and durable AI request idempotency for presentations.',
    async upPg(client) {
        await client.query(`
            ALTER TABLE presentation_templates DROP CONSTRAINT IF EXISTS presentation_template_status_check;
            ALTER TABLE presentation_templates ADD CONSTRAINT presentation_template_status_check CHECK (status IN ('draft', 'pending_review', 'published', 'unpublished'));
            ALTER TABLE presentation_templates ADD COLUMN IF NOT EXISTS submitted_at TIMESTAMPTZ NULL;
            ALTER TABLE presentation_templates ADD COLUMN IF NOT EXISTS reviewed_by BIGINT REFERENCES users(id) ON DELETE SET NULL;
            ALTER TABLE presentation_templates ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ NULL;
            ALTER TABLE presentation_templates ADD COLUMN IF NOT EXISTS review_note TEXT NOT NULL DEFAULT '';
            CREATE TABLE IF NOT EXISTS presentation_ai_requests (
                id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
                tenant_id BIGINT NOT NULL,
                user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                idempotency_key VARCHAR(180) NOT NULL,
                request_digest CHAR(64) NOT NULL,
                status VARCHAR(24) NOT NULL DEFAULT 'processing',
                response_json TEXT NOT NULL DEFAULT '',
                error_code VARCHAR(64) NOT NULL DEFAULT '',
                created_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai'),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai'),
                UNIQUE (tenant_id, user_id, idempotency_key),
                CONSTRAINT presentation_ai_request_status_check CHECK (status IN ('processing', 'completed', 'failed'))
            );
            CREATE INDEX IF NOT EXISTS idx_presentation_ai_requests_updated ON presentation_ai_requests (tenant_id, user_id, updated_at DESC);
        `);
    },
    async downPg(client) {
        await client.query(`
            DROP TABLE IF EXISTS presentation_ai_requests;
            ALTER TABLE presentation_templates DROP CONSTRAINT IF EXISTS presentation_template_status_check;
            ALTER TABLE presentation_templates ADD CONSTRAINT presentation_template_status_check CHECK (status IN ('draft', 'published', 'unpublished'));
            ALTER TABLE presentation_templates DROP COLUMN IF EXISTS submitted_at;
            ALTER TABLE presentation_templates DROP COLUMN IF EXISTS reviewed_by;
            ALTER TABLE presentation_templates DROP COLUMN IF EXISTS reviewed_at;
            ALTER TABLE presentation_templates DROP COLUMN IF EXISTS review_note;
        `);
    }
};

module.exports = [migration];
