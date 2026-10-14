'use strict';

const { query, queryOne } = require('../../db/client');

function createDocumentJobDetails(deps) {
    const {
        canAccessDocumentJob, extractOcrFieldsFromDetail, getBlocks, getDocumentFileForUser, getJobItems, getJobPassword,
        getOutputs, getPages, getReviews, JOB_STATUSES, parseJson, preflightPdfFile,
        serializeBlock, serializeFile, serializeJob, serializeOutput, serializePage
    } = deps;

    function allowedActions(job) {
        const status = job?.status || '';
        return {
            view: Boolean(job),
            cancel: [JOB_STATUSES.QUEUED, JOB_STATUSES.PROCESSING].includes(status),
            retry: [JOB_STATUSES.FAILED, JOB_STATUSES.PARTIAL_SUCCESS, JOB_STATUSES.NEEDS_REVIEW, JOB_STATUSES.CANCELLED].includes(status),
            reprocess: [JOB_STATUSES.SUCCEEDED, JOB_STATUSES.PARTIAL_SUCCESS, JOB_STATUSES.FAILED, JOB_STATUSES.NEEDS_REVIEW, JOB_STATUSES.CANCELLED].includes(status),
            download: [JOB_STATUSES.SUCCEEDED, JOB_STATUSES.PARTIAL_SUCCESS, JOB_STATUSES.NEEDS_REVIEW].includes(status),
            delete: ![JOB_STATUSES.QUEUED, JOB_STATUSES.PROCESSING].includes(status)
        };
    }

    async function getJobPreflight(job, file) {
        const config = parseJson(job?.config_json, {});
        const password = await getJobPassword({ userId: job.user_id, jobId: job.id });
        const sourceIds = Array.isArray(config.sourceFileIds) && config.sourceFileIds.length ? config.sourceFileIds : [file?.id];
        const files = [];
        for (const sourceId of sourceIds.slice(0, 20)) {
            const source = await getDocumentFileForUser(sourceId, job.user_id);
            if (source) files.push(await preflightPdfFile(source, { maxPages: config.maxToolPages || 300, password, userId: job.user_id }));
        }
        return { operation: config.operation || '', mode: config.mode || 'single', files, totalPages: files.reduce((sum, source) => sum + Number(source.pageCount || 0), 0), warnings: files.flatMap(source => source.warnings || []) };
    }

    async function getJobDetail({ userId, jobId, sourceModule = '' }) {
        const job = await canAccessDocumentJob({ userId, jobId, sourceModule });
        if (!job) return null;
        const file = await getDocumentFileForUser(job.file_id, job.user_id);
        const [pages, blocks, outputs, reviews, items] = await Promise.all([getPages(job.id), getBlocks(job.id), getOutputs(job.id), getReviews(job.id), getJobItems(job.id)]);
        return {
            job: { ...serializeJob(job), allowedActions: allowedActions(job), isOwner: Number(job.user_id) === Number(userId) },
            file: serializeFile(file),
            pages: pages.map(serializePage),
            blocks: blocks.map(serializeBlock),
            outputs: outputs.map(serializeOutput),
            items: items.map(row => ({ id: row.id, fileId: row.file_id, itemOrder: Number(row.item_order || 0), status: row.status || '', progress: Number(row.progress || 0), errorCode: row.error_code || '', errorMessage: row.error_message || '', result: parseJson(row.result_json, {}) })),
            reviews: reviews.map(row => ({ id: row.id, pageId: row.page_id, reviewStatus: row.review_status, revisedText: row.revised_text, lowConfidenceConfirmed: Boolean(row.low_confidence_confirmed), reviewedAt: row.reviewed_at, updatedAt: row.updated_at })),
            preflight: job.source_module === 'pdf_tools' ? await getJobPreflight(job, file) : null
        };
    }

    async function getJobPageSlice({ userId, jobId, sourceModule = '', page = 1, limit = 20 }) {
        const job = await canAccessDocumentJob({ userId, jobId, sourceModule });
        if (!job) return null;
        const safePage = Math.max(Number.parseInt(page, 10) || 1, 1);
        const safeLimit = Math.min(Math.max(Number.parseInt(limit, 10) || 20, 1), 100);
        const countRow = await queryOne('SELECT COUNT(*) AS count FROM document_pages WHERE job_id = ?', [job.id]);
        const total = Number(countRow?.count || 0);
        const pages = await query(`
            SELECT * FROM document_pages WHERE job_id = ?
            ORDER BY page_number ASC, id ASC LIMIT ? OFFSET ?
        `, [job.id, safeLimit, (safePage - 1) * safeLimit]);
        const pageIds = pages.map(row => Number(row.id));
        const blocks = pageIds.length
            ? await query(`SELECT * FROM document_ocr_blocks WHERE page_id = ANY(?) ORDER BY page_number ASC, sort_order ASC, id ASC`, [pageIds])
            : [];
        return {
            job: { ...serializeJob(job), allowedActions: allowedActions(job), isOwner: Number(job.user_id) === Number(userId) },
            data: pages.map(serializePage),
            blocks: blocks.map(serializeBlock),
            total,
            page: safePage,
            limit: safeLimit
        };
    }

    async function getPageRevisions({ userId, pageId, sourceModule = '' }) {
        const page = await queryOne(`
            SELECT p.* FROM document_pages p
            JOIN document_jobs j ON j.id = p.job_id AND j.user_id = p.user_id
            WHERE p.id = ? ${sourceModule ? 'AND j.source_module = ?' : ''}
        `, sourceModule ? [Number(pageId), sourceModule] : [Number(pageId)]);
        if (!page || !await canAccessDocumentJob({ userId, jobId: page.job_id, sourceModule })) return null;
        const rows = await query(`
            SELECT id, revision, base_revision, source_kind, raw_text, effective_text, alignment_status,
                review_status, low_confidence_confirmed, created_at
            FROM document_page_revisions WHERE page_id = ? ORDER BY revision DESC, id DESC
        `, [page.id]);
        const initialRevision = Math.max(Number(page.content_revision || 1), 1) === 1
            ? [{ id: null, revision: 1, baseRevision: 0, sourceKind: 'engine', rawText: page.raw_text || page.text || '', effectiveText: page.raw_text || page.text || '', alignmentStatus: 'aligned', reviewStatus: page.ocr_status || '', lowConfidenceConfirmed: false, createdAt: page.created_at }]
            : [];
        return {
            pageId: Number(page.id),
            currentRevision: Math.max(Number(page.content_revision || 1), 1),
            revisions: [...rows.map(row => ({
                id: row.id, revision: Number(row.revision), baseRevision: Number(row.base_revision || 0), sourceKind: row.source_kind,
                rawText: row.raw_text || '', effectiveText: row.effective_text || '', alignmentStatus: row.alignment_status || 'aligned',
                reviewStatus: row.review_status || '', lowConfidenceConfirmed: Boolean(row.low_confidence_confirmed), createdAt: row.created_at
            })), ...initialRevision]
        };
    }

    async function extractOcrFields({ userId, jobId }) {
        const detail = await getJobDetail({ userId, jobId, sourceModule: 'ocr_app' });
        return detail ? extractOcrFieldsFromDetail(detail) : null;
    }

    return { allowedActions, extractOcrFields, getJobDetail, getJobPageSlice, getPageRevisions };
}

module.exports = { createDocumentJobDetails };
