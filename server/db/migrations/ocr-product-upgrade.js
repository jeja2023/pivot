'use strict';

// OCR 结果需要同时保存识别原文、人工修订和处理覆盖率。以下字段均采用可追加
// 方式，旧任务保持可读，升级后的任务再逐步写入版本化结果。
module.exports = [{
    id: '202610130003_ocr_product_upgrade',
    description: 'Upgrade OCR jobs with page coverage, result revisions, and scoped review records.',
    async upPg(client) {
        await client.query(`
            ALTER TABLE document_jobs ADD COLUMN IF NOT EXISTS source_page_count BIGINT NOT NULL DEFAULT 0;
            ALTER TABLE document_jobs ADD COLUMN IF NOT EXISTS planned_page_count BIGINT NOT NULL DEFAULT 0;
            ALTER TABLE document_jobs ADD COLUMN IF NOT EXISTS processed_page_count BIGINT NOT NULL DEFAULT 0;
            ALTER TABLE document_jobs ADD COLUMN IF NOT EXISTS failed_page_count BIGINT NOT NULL DEFAULT 0;
            ALTER TABLE document_jobs ADD COLUMN IF NOT EXISTS omitted_pages_json TEXT NOT NULL DEFAULT '[]';
            ALTER TABLE document_jobs ADD COLUMN IF NOT EXISTS coverage_complete BIGINT NOT NULL DEFAULT 0;
            ALTER TABLE document_jobs ADD COLUMN IF NOT EXISTS content_revision BIGINT NOT NULL DEFAULT 1;
            ALTER TABLE document_jobs ADD COLUMN IF NOT EXISTS review_state TEXT NOT NULL DEFAULT 'not_required';
            ALTER TABLE document_jobs ADD COLUMN IF NOT EXISTS lease_owner TEXT NOT NULL DEFAULT '';
            ALTER TABLE document_jobs ADD COLUMN IF NOT EXISTS execution_epoch BIGINT NOT NULL DEFAULT 0;

            ALTER TABLE document_pages ADD COLUMN IF NOT EXISTS raw_text TEXT NOT NULL DEFAULT '';
            ALTER TABLE document_pages ADD COLUMN IF NOT EXISTS content_revision BIGINT NOT NULL DEFAULT 1;
            ALTER TABLE document_pages ADD COLUMN IF NOT EXISTS alignment_status TEXT NOT NULL DEFAULT 'aligned';
            ALTER TABLE document_pages ADD COLUMN IF NOT EXISTS result_json TEXT NOT NULL DEFAULT '{}';
            ALTER TABLE document_pages ADD COLUMN IF NOT EXISTS processing_state TEXT NOT NULL DEFAULT '';

            ALTER TABLE document_ocr_blocks ADD COLUMN IF NOT EXISTS stable_key TEXT NOT NULL DEFAULT '';
            ALTER TABLE document_ocr_blocks ADD COLUMN IF NOT EXISTS raw_text TEXT NOT NULL DEFAULT '';
            ALTER TABLE document_ocr_blocks ADD COLUMN IF NOT EXISTS effective_text TEXT NOT NULL DEFAULT '';
            ALTER TABLE document_ocr_blocks ADD COLUMN IF NOT EXISTS alignment_status TEXT NOT NULL DEFAULT 'aligned';
            ALTER TABLE document_ocr_blocks ADD COLUMN IF NOT EXISTS confidence_source TEXT NOT NULL DEFAULT 'engine';
            ALTER TABLE document_ocr_blocks ADD COLUMN IF NOT EXISTS result_revision BIGINT NOT NULL DEFAULT 1;

            CREATE TABLE IF NOT EXISTS document_page_revisions (
                id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
                user_id BIGINT NOT NULL,
                file_id BIGINT NOT NULL,
                job_id BIGINT NOT NULL,
                page_id BIGINT NOT NULL,
                revision BIGINT NOT NULL,
                base_revision BIGINT NOT NULL DEFAULT 0,
                source_kind TEXT NOT NULL DEFAULT 'review',
                raw_text TEXT NOT NULL DEFAULT '',
                effective_text TEXT NOT NULL DEFAULT '',
                alignment_status TEXT NOT NULL DEFAULT 'aligned',
                review_status TEXT NOT NULL DEFAULT 'draft',
                low_confidence_confirmed BIGINT NOT NULL DEFAULT 0,
                created_at TIMESTAMPTZ DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai'),
                UNIQUE(page_id, revision)
            );

            CREATE TABLE IF NOT EXISTS document_batches (
                id TEXT PRIMARY KEY,
                user_id BIGINT NOT NULL,
                source_module TEXT NOT NULL DEFAULT 'ocr_app',
                status TEXT NOT NULL DEFAULT 'queued',
                total_files BIGINT NOT NULL DEFAULT 0,
                completed_files BIGINT NOT NULL DEFAULT 0,
                failed_files BIGINT NOT NULL DEFAULT 0,
                config_json TEXT NOT NULL DEFAULT '{}',
                created_at TIMESTAMPTZ DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai'),
                updated_at TIMESTAMPTZ DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai')
            );
            CREATE TABLE IF NOT EXISTS document_batch_items (
                id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
                batch_id TEXT NOT NULL,
                user_id BIGINT NOT NULL,
                job_id BIGINT,
                item_order BIGINT NOT NULL DEFAULT 0,
                original_name TEXT NOT NULL DEFAULT '',
                status TEXT NOT NULL DEFAULT 'queued',
                error_message TEXT NOT NULL DEFAULT '',
                created_at TIMESTAMPTZ DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai'),
                updated_at TIMESTAMPTZ DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai')
            );
            CREATE TABLE IF NOT EXISTS document_review_assignments (
                id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
                job_id BIGINT NOT NULL,
                owner_user_id BIGINT NOT NULL,
                reviewer_user_id BIGINT NOT NULL,
                status TEXT NOT NULL DEFAULT 'assigned',
                assigned_by BIGINT NOT NULL,
                note TEXT NOT NULL DEFAULT '',
                created_at TIMESTAMPTZ DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai'),
                updated_at TIMESTAMPTZ DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai'),
                UNIQUE(job_id, reviewer_user_id)
            );
            CREATE TABLE IF NOT EXISTS document_ocr_region_candidates (
                id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
                user_id BIGINT NOT NULL,
                job_id BIGINT NOT NULL,
                page_id BIGINT NOT NULL,
                content_revision BIGINT NOT NULL DEFAULT 1,
                bbox_json TEXT NOT NULL DEFAULT '{}',
                text TEXT NOT NULL DEFAULT '',
                confidence DOUBLE PRECISION,
                engine TEXT NOT NULL DEFAULT '',
                status TEXT NOT NULL DEFAULT 'candidate',
                created_at TIMESTAMPTZ DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai'),
                updated_at TIMESTAMPTZ DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai')
            );
            CREATE TABLE IF NOT EXISTS document_ocr_feedback (
                id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
                user_id BIGINT NOT NULL,
                job_id BIGINT NOT NULL,
                page_id BIGINT NOT NULL,
                content_revision BIGINT NOT NULL DEFAULT 1,
                feedback_type TEXT NOT NULL DEFAULT 'correction',
                original_text TEXT NOT NULL DEFAULT '',
                corrected_text TEXT NOT NULL DEFAULT '',
                consented BIGINT NOT NULL DEFAULT 0,
                status TEXT NOT NULL DEFAULT 'pending',
                review_note TEXT NOT NULL DEFAULT '',
                reviewed_by BIGINT,
                reviewed_at TIMESTAMPTZ,
                created_at TIMESTAMPTZ DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai'),
                updated_at TIMESTAMPTZ DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai')
            );

            CREATE INDEX IF NOT EXISTS idx_document_jobs_ocr_coverage
                ON document_jobs(user_id, source_module, coverage_complete, review_state, updated_at DESC);
            CREATE INDEX IF NOT EXISTS idx_document_pages_ocr_state
                ON document_pages(job_id, processing_state, ocr_status, page_number);
            CREATE INDEX IF NOT EXISTS idx_document_ocr_blocks_page_revision
                ON document_ocr_blocks(page_id, result_revision, sort_order, id);
            CREATE INDEX IF NOT EXISTS idx_document_page_revisions_page_revision
                ON document_page_revisions(page_id, revision DESC);
            CREATE INDEX IF NOT EXISTS idx_document_batches_user_status
                ON document_batches(user_id, source_module, status, created_at DESC);
            CREATE INDEX IF NOT EXISTS idx_document_batch_items_batch_order
                ON document_batch_items(batch_id, item_order);
            CREATE INDEX IF NOT EXISTS idx_document_review_assignments_reviewer
                ON document_review_assignments(reviewer_user_id, status, updated_at DESC);
            CREATE INDEX IF NOT EXISTS idx_document_ocr_region_candidates_page
                ON document_ocr_region_candidates(page_id, created_at DESC);
            CREATE INDEX IF NOT EXISTS idx_document_ocr_feedback_status
                ON document_ocr_feedback(status, created_at DESC);
        `);
    }
}];
