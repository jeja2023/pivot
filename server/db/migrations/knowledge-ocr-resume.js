'use strict';

module.exports = [{
    id: '202610280002_knowledge_ocr_resume',
    description: 'Persist OCR page results scoped to document and source hash for safe continuation.',
    async upPg(client) {
        await client.query(`
            CREATE TABLE IF NOT EXISTS knowledge_pdf_ocr_pages (
                doc_id BIGINT NOT NULL REFERENCES knowledge_docs(id) ON DELETE CASCADE,
                source_hash TEXT NOT NULL,
                page_no INTEGER NOT NULL CHECK (page_no > 0),
                content TEXT NOT NULL,
                updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                PRIMARY KEY (doc_id, source_hash, page_no)
            );
        `);
    }
}];
