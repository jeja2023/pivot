'use strict';

const crypto = require('crypto');
const fs = require('fs');
const sharp = require('sharp');
const { query, queryOne } = require('../../db/client');
const { getBeijingTimestamp } = require('../../time');
const { buildManagedPath, resolveStoredDocumentPath, safeUnlinkManaged, tempRoot, toProjectRelativePath } = require('./paths');

function regionError(message, code = 'OCR_REGION_INVALID', status = 400) {
    const error = new Error(message);
    error.code = code;
    error.status = status;
    return error;
}

function normalizeRegion(value = {}) {
    const x = Number(value.x);
    const y = Number(value.y);
    const width = Number(value.width);
    const height = Number(value.height);
    if (![x, y, width, height].every(Number.isFinite) || x < 0 || y < 0 || width <= 0 || height <= 0 || x + width > 1 || y + height > 1) {
        throw regionError('识别区域必须是页面左上角起 0 到 1 的有效比例坐标。', 'OCR_REGION_BOUNDS');
    }
    return { x, y, width, height };
}

function createOcrRegionService({ canAccessDocumentJob, recognizePage }) {
    async function getPageForUser({ userId, pageId }) {
        const page = await queryOne('SELECT * FROM document_pages WHERE id = ?', [Number(pageId)]);
        if (!page || !await canAccessDocumentJob({ userId, jobId: page.job_id, sourceModule: 'ocr_app' })) return null;
        return page;
    }

    async function createRegionCandidate({ userId, pageId, region, options = {} }) {
        const page = await getPageForUser({ userId, pageId });
        if (!page) return null;
        const normalized = normalizeRegion(region);
        const sourcePath = resolveStoredDocumentPath(page.image_path);
        if (!sourcePath || !await fs.promises.access(sourcePath, fs.constants.R_OK).then(() => true).catch(() => false)) throw regionError('原页预览已过期，无法进行区域识别。', 'OCR_REGION_SOURCE_MISSING', 409);
        const metadata = await sharp(sourcePath).metadata();
        const sourceWidth = Number(metadata.width || page.pixel_width || page.width || 0);
        const sourceHeight = Number(metadata.height || page.pixel_height || page.height || 0);
        const left = Math.floor(normalized.x * sourceWidth);
        const top = Math.floor(normalized.y * sourceHeight);
        const width = Math.max(1, Math.ceil(normalized.width * sourceWidth));
        const height = Math.max(1, Math.ceil(normalized.height * sourceHeight));
        if (width * height > 40_000_000) throw regionError('选区像素超过安全识别上限，请缩小区域后重试。', 'OCR_REGION_PIXEL_LIMIT', 413);
        const tempPath = await buildManagedPath(tempRoot, userId, `ocr-region-${crypto.randomUUID()}.png`);
        try {
            await sharp(sourcePath).extract({ left, top, width: Math.min(width, sourceWidth - left), height: Math.min(height, sourceHeight - top) }).png().toFile(tempPath);
            const result = await recognizePage(tempPath, { language: options.language, engine: options.engine, timeoutMs: options.timeoutMs });
            const now = getBeijingTimestamp();
            const row = await queryOne(`
                INSERT INTO document_ocr_region_candidates (user_id, job_id, page_id, content_revision, bbox_json, text, confidence, engine, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *
            `, [userId, page.job_id, page.id, Math.max(Number(page.content_revision || 1), 1), JSON.stringify(normalized), result.text, result.confidence, result.engine || '', now, now]);
            return serializeRegionCandidate(row);
        } finally {
            await safeUnlinkManaged(toProjectRelativePath(tempPath));
        }
    }

    function serializeRegionCandidate(row) {
        if (!row) return null;
        let bbox = {};
        try { bbox = JSON.parse(row.bbox_json || '{}'); } catch (_) {}
        return { id: row.id, pageId: row.page_id, contentRevision: Number(row.content_revision || 1), bbox, text: row.text || '', confidence: row.confidence === null ? null : Number(row.confidence), engine: row.engine || '', status: row.status || 'candidate', createdAt: row.created_at };
    }

    async function listRegionCandidates({ userId, pageId }) {
        const page = await getPageForUser({ userId, pageId });
        if (!page) return null;
        const rows = await query('SELECT * FROM document_ocr_region_candidates WHERE page_id = ? ORDER BY created_at DESC, id DESC LIMIT 50', [page.id]);
        return rows.map(serializeRegionCandidate);
    }

    return { createRegionCandidate, listRegionCandidates };
}

module.exports = { createOcrRegionService, normalizeRegion };
