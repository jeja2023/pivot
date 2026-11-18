'use strict';

const repository = require('../../../repositories/presentation-master-tasks');
const { assertTenantContext } = require('../../agent-tenant-context');
const cas = require('../../agent-artifact-cas');
const runtime = require('./runtime');
const { exportReview, pageReviewFor } = require('./review-plan');

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_SNAPSHOT_BYTES = 32 * 1024 * 1024;
const PNG_SIGNATURE = Buffer.from('89504e470d0a1a0a', 'hex');

function exportForPreview(row, task) {
    if (!['failed', 'expired'].includes(task.status)) return '';
    const state = row.result_json.state;
    const project = state?.review?.approvals?.design?.plan?.project;
    if (!project) return '';
    for (let index = (state.messages || []).length - 1; index >= 0; index--) {
        const message = state.messages[index];
        if (message.role !== 'assistant') continue;
        let turn;
        try { turn = JSON.parse(message.content); } catch (_) { continue; }
        if (!turn?.complete) continue;
        const path = turn.complete.path, prefix = project + '/exports/';
        return typeof path === 'string' && path.startsWith(prefix) && /^[^/\\:\u0000-\u001f]+\.pptx$/i.test(path.slice(prefix.length)) ? path : '';
    }
    return '';
}

function unavailable() {
    return runtime.error('未找到可查看的页面，请确认制作记录和材料的访问权限。', 'PPT_MASTER_PREVIEW_UNAVAILABLE', 404);
}

function changed() {
    return runtime.error('制作记录已变化，请重新查看已通过页面后再操作。', 'PPT_MASTER_DRAFT_CHANGED', 409);
}

function previewContext(result) {
    const path = result && exportForPreview(result.row, result.task);
    if (!path) throw unavailable();
    const state = result.row.result_json.state;
    return { path, state, sourceRevision: result.row.review_revision, ...exportReview(state, state.review.approvals.design.plan.project) };
}

function assertSamePreview(previous, current) {
    if (previous.path !== current.path || previous.checklistDigest !== current.checklistDigest
        || previous.sourceRevision !== current.sourceRevision) throw changed();
}

function publicSnapshot(snapshot) {
    return { pages: snapshot.pages.map(({ page, file, title }) => ({ page, file, title })),
        failedPages: snapshot.failedPages, savedAt: snapshot.savedAt };
}

async function updateReferences(executor, before, after, increment) {
    const oldIds = new Set(before?.pages.map(page => page.objectId)), newIds = new Set(after.pages.map(page => page.objectId));
    for (const id of [...new Set([...oldIds, ...newIds])].sort()) {
        const delta = Number(newIds.has(id)) - Number(oldIds.has(id));
        if (delta) await increment(id, delta, { executor });
    }
}

function createReviewPreviewService(accessibleTask) {
    async function inspectExport(user, id, { lookup = accessibleTask, execute = runtime.execute } = {}) {
        const previous = previewContext(await lookup(user, id));
        const { state, path, checklist } = previous;
        const review = await execute(user, id, { action: 'inspect_export', path, checklist });
        assertSamePreview(previous, previewContext(await lookup(user, id)));
        const pageReview = pageReviewFor(state, review.pageReview, checklist);
        const allPassed = review.pageReview?.failedPages?.length === 0 && Array.isArray(review.pageReview.passedPages)
            && review.pageReview.passedPages.length === checklist.length;
        const passed = new Set(pageReview?.passedPages || (allPassed ? review.pageReview.passedPages : []));
        const pages = [];
        for (const { page, file } of review.pages || []) {
            if (!passed.has(page) || !Number.isInteger(page) || page < 1 || page > checklist.length
                || !runtime.isReviewImage(file) || !file.endsWith('-' + page + '.png')) continue;
            passed.delete(page);
            pages.push({ page, file, title: checklist[page - 1][0] });
        }
        const exportRevision = pages[0]?.file.split('-')[1];
        if (pages.some(({ file }) => !file.startsWith('review-' + exportRevision + '-'))) throw changed();
        return { context: previous, exportRevision, preview: { pages, failedPages: pageReview?.failedPages || [] } };
    }

    async function inspectPages(user, id, dependencies = {}) {
        const { exportRevision, preview } = await inspectExport(user, id, dependencies);
        return { ...preview, exportRevision };
    }

    async function readSavedPages(user, id, { lookup = accessibleTask } = {}) {
        const saved = (await lookup(user, id))?.row.result_json.savedReviewPages;
        if (!saved) throw unavailable();
        return publicSnapshot(saved);
    }

    async function saveReviewPages(user, id, revision, deps = {}) {
        if (typeof revision !== 'string' || !/^[a-f0-9]{64}$/.test(revision)) throw runtime.error('请先查看已通过页面，再保存。');
        const lookup = deps.lookup || accessibleTask;
        const existing = await lookup(user, id);
        if (!existing) throw unavailable();
        const saved = existing.row.result_json.savedReviewPages;
        if (saved?.exportRevision === revision && saved.sourceRevision === existing.row.review_revision) return publicSnapshot(saved);

        const { context, exportRevision, preview } = await inspectExport(user, id, deps);
        if (!preview.pages.length || exportRevision !== revision) throw changed();
        const tenant = await (deps.tenantContext || assertTenantContext)(user);
        const pages = [];
        let totalBytes = 0;
        for (const page of preview.pages) {
            const buffer = await (deps.readOutput || runtime.readOutput)(user, id, page.file, MAX_IMAGE_BYTES);
            totalBytes += buffer.length;
            if (buffer.length > MAX_IMAGE_BYTES || totalBytes > MAX_SNAPSHOT_BYTES || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
                throw runtime.error('通过页图片无效或超过保存上限。', 'PPT_MASTER_PREVIEW_INVALID', 422);
            }
            const { objectId } = await (deps.putBuffer || cas.putBuffer)({ buffer, mimeType: 'image/png', maxBytes: MAX_IMAGE_BYTES,
                tenantId: tenant.tenantId, ownerUserId: user.id, kind: 'ppt_master_review_png' });
            pages.push({ ...page, objectId });
        }
        assertSamePreview(context, previewContext(await lookup(user, id)));
        const snapshot = { exportRevision, sourceRevision: context.sourceRevision, savedAt: new Date().toISOString(),
            pages, failedPages: preview.failedPages.map(({ page }) => ({ page })) };
        const result = await (deps.persist || repository.saveReviewPages)(user, id, context.sourceRevision, snapshot,
            (executor, before) => updateReferences(executor, before, snapshot, deps.incrementRefCount || cas.incrementRefCount));
        if (!result) throw changed();
        return publicSnapshot(result);
    }

    async function readPagePreview(user, id, file, deps = {}) {
        if (!runtime.isReviewImage(file)) throw runtime.error('预览图片标识无效。');
        const lookup = deps.lookup || accessibleTask;
        const result = await lookup(user, id);
        const saved = result?.row.result_json.savedReviewPages?.pages.find(page => page.file === file);
        if (saved) {
            const tenant = await (deps.tenantContext || assertTenantContext)(user);
            // CAS 按租户去重，页面访问仍由上面的任务归属与材料权限控制。
            const { buffer } = await (deps.readBuffer || cas.readBuffer)({
                objectId: saved.objectId, tenantId: tenant.tenantId, userId: user.id, tenantScoped: true
            });
            const current = (await lookup(user, id))?.row.result_json.savedReviewPages;
            if (!current?.pages.some(page => page.file === file && page.objectId === saved.objectId)) throw changed();
            return buffer;
        }
        const previous = previewContext(result);
        const buffer = await (deps.readOutput || runtime.readOutput)(user, id, file, MAX_IMAGE_BYTES);
        assertSamePreview(previous, previewContext(await lookup(user, id)));
        return buffer;
    }

    return { inspectPages, readSavedPages, saveReviewPages, readPagePreview };
}

module.exports = { createReviewPreviewService, exportForPreview };
