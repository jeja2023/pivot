'use strict';

function buildOcrChatContext(detail = {}) {
    const jobId = detail.job?.id || '';
    const revision = Number(detail.job?.contentRevision || 1);
    const sources = (detail.pages || []).map((page, index) => ({
        jobId,
        contentRevision: revision,
        pageId: page.id,
        pageNumber: Number(page.pageNumber || index + 1),
        alignmentStatus: page.alignmentStatus || 'aligned'
    }));
    const text = (detail.pages || []).map((page, index) => {
        const body = String(page.text || '').trim();
        if (!body) return '';
        return `[OCR 任务 ${jobId} 修订 ${revision} 第 ${Number(page.pageNumber || index + 1)} 页]\n${body}`;
    }).filter(Boolean).join('\n\n');
    return { text, sources };
}

module.exports = { buildOcrChatContext };
