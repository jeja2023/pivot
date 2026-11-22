'use strict';

const { error } = require('./runtime');
const { normalizeStage } = require('./review-plan');
const { checklistLimits } = require('./checklist-limits');
const { draftWithCitationPlaceholders } = require('./citation-repair');

async function preparePlanBatch(batch, state, verifySource) {
    const invalid = message => error(message, 'PPT_MASTER_ACTION_INVALID', 422);
    const saved = state.planBatch;
    if (!state.request.draftFirst || state.request.operation === 'create_template' || state.pageRepair || state.review?.approvals?.design
        || !state.review || !batch || typeof batch !== 'object' || Array.isArray(batch)) throw invalid('当前阶段不能分批登记页面清单。');
    const { offset, pages } = batch;
    const pageCount = saved?.pageCount ?? batch.pageCount;
    const fixed = state.request.operation === 'generate' && ['default', 'quick', 'image_to_pptx'].includes(state.request.profile);
    if (!Number.isSafeInteger(pageCount) || pageCount < 1 || pageCount > 100 || fixed && pageCount !== state.request.pageCount
        || batch.pageCount !== undefined && batch.pageCount !== pageCount || offset !== (saved?.pages.length || 0)
        || !Array.isArray(pages) || !pages.length || pages.length > 6 || offset + pages.length > pageCount) {
        throw invalid('请按已登记的总页数和下一 offset 分批提交，每批 1 至 6 页。');
    }
    const project = saved?.project ?? batch.project, summary = saved?.summary ?? batch.summary;
    if (saved && (batch.project !== undefined && batch.project !== project || batch.summary !== undefined && batch.summary !== summary)) {
        throw invalid('分批登记期间须沿用已登记的项目、页数和方案说明。');
    }
    const input = { kind: 'confirmation', stage: 'design', question: '登记页面清单', plan: { project, summary, pages } };
    let normalized, issues = [];
    try { normalized = (await normalizeStage(input, state, verifySource, { partial: true })).plan; }
    catch (failure) {
        if (!failure.citationIssues) throw failure;
        if (failure.citationIssues.some(issue => issue.imagePath && !state.reviewedImageDigests?.includes(issue.imageDigest))) throw failure;
        const draft = draftWithCitationPlaceholders(failure);
        if (!draft) throw failure;
        normalized = draft.plan;
        for (const [index, page] of normalized.pages.entries()) {
            if (page.title === `第 ${index + 1} 页（关键数据待核对）`) page.title = `第 ${offset + index + 1} 页（关键数据待核对）`;
        }
        issues = failure.citationIssues.map(({ page, item, reason, titleClaim }) => ({ page: page + offset, item, reason, ...(titleClaim ? { titleClaim } : {}) }));
    }
    const combined = [...(saved?.pages || []), ...normalized.pages];
    if (combined.reduce((count, page) => count + page.values.length, 0) > checklistLimits(state).total) throw invalid('分批清单已超过整稿关键数据容量，请减少待提交的条目。');
    const draft = { project: normalized.project, summary: normalized.summary, pageCount, pages: combined, issues: [...(saved?.issues || []), ...issues] };
    if (combined.length < pageCount) return { planBatch: draft };
    const compiled = await normalizeStage({ ...input, plan: { project, summary, pages: combined, templateUse: batch.templateUse } }, state, verifySource, { trustedPlaceholders: true });
    return { requestInput: { kind: input.kind, question: input.question, context: compiled.plan.summary, ...compiled }, batchIssues: draft.issues };
}

function batchGuidance(state) {
    if (!state.request.draftFirst || state.request.operation === 'create_template' || state.review?.approvals?.design) return '';
    const count = state.planBatch?.pages.length || 0;
    return count ? `分批清单已核对 ${count}/${state.planBatch.pageCount} 页。继续提交 planPages，offset=${count}，每批 1 至 6 页。齐页后宿主合并。`
        : '长清单可只提交 planPages:{offset:0,pageCount,project,summary,pages}，每批 1 至 6 页。后续只填 offset 与 pages，全部齐页后宿主合并。';
}

module.exports = { preparePlanBatch, batchGuidance };
