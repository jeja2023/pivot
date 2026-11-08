'use strict';

/**
 * 将演示文稿证据与仅用于提示词的材料载荷分开保存。持久化摘录保持较短，
 * 既能在后续改写和核验中恢复事实上下文，也不会把整份上传报告复制到文稿 IR。
 */
const crypto = require('crypto');

const MAX_MATERIALS = 20;
const MAX_MATERIAL_TEXT_CHARS = 120000;
const MAX_SOURCE_EXCERPT_CHARS = 2400;

function normalizeText(value, maxLength, { trim = true } = {}) {
    let text = String(value ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    if (trim) text = text.trim();
    return text.slice(0, maxLength);
}

function normalizeMaterialId(value, fallback, usedIds) {
    const base = normalizeText(value || fallback, 96)
        .replace(/[^A-Za-z0-9_-]/g, '_')
        .replace(/^_+/, '') || fallback;
    let id = /^[A-Za-z0-9]/.test(base) ? base : 'source_' + base;
    let suffix = 2;
    while (usedIds.has(id)) {
        id = base.slice(0, 90) + '_' + suffix;
        suffix += 1;
    }
    usedIds.add(id);
    return id;
}

function sha256(value) {
    return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function normalizeMaterials(items) {
    const usedIds = new Set();
    return (Array.isArray(items) ? items : []).slice(0, MAX_MATERIALS).flatMap((item, index) => {
        const text = normalizeText(item?.text ?? item?.excerpt, MAX_MATERIAL_TEXT_CHARS);
        if (!text) return [];
        return [{
            id: normalizeMaterialId(item?.id, 'source_' + (index + 1), usedIds),
            title: normalizeText(item?.title, 240) || '材料',
            type: normalizeText(item?.type, 48) || 'material',
            locator: normalizeText(item?.locator, 500),
            text,
            digest: sha256(text),
            excerpt: text.slice(0, MAX_SOURCE_EXCERPT_CHARS),
            excerptTruncated: text.length > MAX_SOURCE_EXCERPT_CHARS
        }];
    });
}

function materialToPresentationSource(material) {
    return {
        id: String(material?.id || ''),
        title: String(material?.title || '材料'),
        type: String(material?.type || 'material'),
        locator: String(material?.locator || ''),
        digest: String(material?.digest || ''),
        excerpt: String(material?.excerpt || ''),
        excerptTruncated: material?.excerptTruncated === true
    };
}

function bindPresentationEvidence(materials, slides) {
    return materials.map(material => {
        const source = materialToPresentationSource(material), fullText = String(material.text ?? material.excerpt ?? '');
        if (!source.digest && fullText) source.digest = sha256(fullText);
        const slices = new Map((material.evidenceSlices || []).map(slice => [slice.digest, slice]));
        for (const slide of slides) for (const claim of (Array.isArray(slide.claims) ? slide.claims.slice(0, 30) : [])) {
            for (const evidence of (Array.isArray(claim.evidence) ? claim.evidence.slice(0, 10) : [])) {
                if (evidence?.sourceId !== source.id || typeof evidence.quote !== 'string' || !evidence.quote.trim() || evidence.quote.length > 1000) continue;
                const start = fullText.indexOf(evidence.quote);
                if (start < 0 || start + evidence.quote.length > MAX_MATERIAL_TEXT_CHARS || slices.size >= 48) continue;
                const digest = sha256(evidence.quote);
                slices.set(digest, { digest, sourceDigest: source.digest, start, end: start + evidence.quote.length, quote: evidence.quote });
            }
        }
        if (slices.size) source.evidenceSlices = normalizeEvidenceSlices([...slices.values()], source.digest);
        return source;
    });
}

function normalizeEvidenceSlices(input, sourceDigest) {
    const invalid = () => { const error = new Error('材料证据片段、范围或摘要无效，请重新读取原始材料。'); error.status = 400; error.code = 'PRESENTATION_EVIDENCE_SLICE_INVALID'; throw error; };
    if (!Array.isArray(input) || input.length > 48) invalid();
    const seen = new Set();
    return input.map(slice => {
        if (!slice || typeof slice !== 'object' || typeof slice.quote !== 'string' || !slice.quote.trim() || slice.quote.length > 1000 || !Number.isInteger(slice.start) || !Number.isInteger(slice.end)
            || slice.start < 0 || slice.end > MAX_MATERIAL_TEXT_CHARS || slice.end - slice.start !== slice.quote.length || !String(sourceDigest || '').trim()
            || slice.sourceDigest !== String(sourceDigest).trim() || slice.digest !== sha256(slice.quote) || seen.has(slice.digest)) invalid();
        seen.add(slice.digest);
        return { digest: slice.digest, sourceDigest: slice.sourceDigest, start: slice.start, end: slice.end, quote: slice.quote };
    });
}

module.exports = {
    MAX_MATERIAL_TEXT_CHARS,
    MAX_SOURCE_EXCERPT_CHARS,
    materialToPresentationSource,
    bindPresentationEvidence,
    normalizeEvidenceSlices,
    normalizeMaterials,
    sha256
};
