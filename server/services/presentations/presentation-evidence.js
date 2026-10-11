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

module.exports = {
    MAX_MATERIAL_TEXT_CHARS,
    MAX_SOURCE_EXCERPT_CHARS,
    materialToPresentationSource,
    normalizeMaterials,
    sha256
};
