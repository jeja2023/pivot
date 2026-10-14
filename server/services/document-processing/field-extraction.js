'use strict';

function pageTextEntries(detail = {}) {
    return (Array.isArray(detail.pages) ? detail.pages : []).map((page, index) => ({
        pageId: page.id,
        pageNumber: Number(page.pageNumber || page.page_number || index + 1),
        text: String(page.text || '')
    }));
}

function firstMatch(entries, pattern, normalize = value => value) {
    for (const entry of entries) {
        const match = entry.text.match(pattern);
        if (match) return { value: normalize(match[1] || match[0]), pageId: entry.pageId, pageNumber: entry.pageNumber, confidence: 'candidate' };
    }
    return null;
}

// 字段只做候选提取，不把正则命中表达为已经核验的公文事实。
function extractOcrFieldsFromDetail(detail = {}) {
    const pages = pageTextEntries(detail);
    const fields = {
        documentNumber: firstMatch(pages, /(?:文号|文件编号)\s*[：:]?\s*([^\n]{2,80})/i),
        issueDate: firstMatch(pages, /(\d{4}\s*[年./-]\s*\d{1,2}\s*[月./-]\s*\d{1,2}\s*日?)/, value => value.replace(/\s+/g, '')),
        issuer: firstMatch(pages, /(?:发布单位|发文机关|签发单位)\s*[：:]?\s*([^\n]{2,100})/),
        amount: firstMatch(pages, /(?:金额|合计)\s*[：:]?\s*[¥￥]?\s*([0-9][0-9,]*(?:\.\d{1,2})?\s*元?)/)
    };
    return {
        schemaVersion: '1',
        jobId: detail.job?.id || null,
        contentRevision: Number(detail.job?.contentRevision || 1),
        fields: Object.fromEntries(Object.entries(fields).filter(([, value]) => value))
    };
}

module.exports = { extractOcrFieldsFromDetail };
