'use strict';

const repository = require('../../repositories/presentation-quality-tasks');
const taskStore = require('../tool-tasks');
const service = require('./presentation-service');
const { isAdmin } = require('../../permissions');
const { computePresentationDigest, presentationError } = require('./presentation-schema');
const { optimizeDesignLayout } = require('./presentation-layout-optimizer');
const { reviewPresentationSlide } = require('./presentation-design-review');
const { TOOL } = repository;

function taskJson(value) { try { return typeof value === 'string' ? JSON.parse(value || '{}') : value || {}; } catch (_) { return {}; } }
async function accessible(user, id, editing = false) {
    const document = await service.getPresentation(user, id);
    if (!document) throw presentationError('文稿不存在或已无权访问，请重新打开文稿。', 404, 'PRESENTATION_NOT_FOUND');
    if (editing && !document.isOwner && document.collaboratorRole !== 'editor' && !isAdmin(user)) throw presentationError('当前角色不能修改排版。', 403, 'PRESENTATION_EDIT_FORBIDDEN');
    return document;
}

async function runQualityTask(id, user, input, deps = {}) {
    const store = deps.store || taskStore, getDocument = deps.getDocument || accessible, publish = deps.publish || repository.writeProgress;
    const controller = store.beginExecution(id), signal = controller.signal;
    const result = { mode: input.mode, contentDigest: input.contentDigest, progress: { completed: 0, total: 0, phase: 'preparing' }, reviews: [], changedSlides: [], visualStatus: 'not_requested' };
    const ensureCurrent = async () => {
        signal.throwIfAborted();
        const task = await store.getForUser(id, user);
        if (!task || task.status !== 'working') throw presentationError('检查任务已停止。', 409, 'PRESENTATION_CHECK_STOPPED');
        if (input.runId) {
            const run = await (deps.getRun || repository.parentStatus)(input.runId, user.id);
            if (!run || ['completed', 'completed_with_errors', 'partial', 'cancelled', 'deleted', 'failed', 'error', 'needs_input'].includes(run.status)) throw presentationError('所属任务已停止，本次整稿检查不再继续。', 409, 'PRESENTATION_PARENT_STOPPED');
        }
        const document = await getDocument(user, input.presentationId, !['visual', 'production'].includes(input.mode));
        if (computePresentationDigest(document.content) !== result.contentDigest) throw presentationError('文稿已修改，旧版本检查已停止，请检查最新文稿。', 409, 'PRESENTATION_CHECK_STALE');
        return document;
    };
    try {
        let document = await ensureCurrent();
        let workingContent = document.content;
        const assets = await (deps.resolveAssets || service.resolvePresentationAssets)(user, document.content, { presentationId: document.id });
        const options = { signal, assetResolver: async ref => assets.get(ref) || null };
        result.progress.total = document.content.slides.length;
        await publish(id, user, result);
        if (['layout', 'visual_repair'].includes(input.mode)) {
            const template = await (deps.resolveTemplate || service.resolveTemplateVersionForUser)(user, document.template.id, document.template.version, { historical: true });
            if (!template) throw new Error('模板版本不可用，请重新选择模板。');
            const optimized = await (deps.optimize || optimizeDesignLayout)(document.content, template, { ...options,
                onProgress: async progress => { result.progress = progress; await ensureCurrent(); await publish(id, user, result); } });
            await ensureCurrent();
            if (optimized.changedSlides.length) {
                workingContent = optimized.content;
                result.proposal = { content: workingContent, sourceDigest: result.contentDigest, baseVersion: document.version };
                result.changedSlides = optimized.changedSlides;
            }
            result.validation = optimized.validation;
        }
        if (input.mode === 'production') {
            result.progress = { completed: 0, total: document.content.slides.length, phase: 'production', message: '正在检查事实、版式和最终文件' };
            await publish(id, user, result);
            result.productionReview = await (deps.productionReview || require('./presentation-production-review').reviewPresentationProduction)(workingContent, { ...options,
                onProgress: async progress => { result.progress = progress; await ensureCurrent(); await publish(id, user, result); } });
            result.validation = { status: result.productionReview.status, summary: result.productionReview.summary, issues: result.productionReview.issues, semantics: result.productionReview.checks.evidence };
        }
        if (['visual', 'visual_repair'].includes(input.mode)) {
            for (let index = 0; index < document.content.slides.length; index++) {
                document = await ensureCurrent();
                result.progress = { completed: index, total: document.content.slides.length, phase: 'visual', message: `正在复核第 ${index + 1} 页` };
                await publish(id, user, result);
                const review = await (deps.reviewSlide || reviewPresentationSlide)(workingContent, user, { ...options, slideIndex: index, modelId: input.modelId, budget: deps.budget, runId: input.runId });
                await ensureCurrent();
                result.reviews.push(review);
                result.progress.completed = index + 1;
                if (review.status === 'unavailable') { result.visualStatus = 'unavailable'; break; }
                await publish(id, user, result);
            }
            if (result.visualStatus !== 'unavailable') result.visualStatus = result.reviews.some(review => review.status === 'blocked') ? 'blocked'
                : result.reviews.some(review => review.status === 'warning') ? 'warning' : result.reviews.length === document.content.slides.length ? 'passed' : 'incomplete';
        }
        await ensureCurrent();
        result.progress.phase = 'finished';
        result.progress.completed = ['layout', 'production'].includes(input.mode) ? document.content.slides.length : result.reviews.filter(review => review.status !== 'unavailable').length;
        result.checkedContentDigest = computePresentationDigest(workingContent);
        result.message = input.mode === 'production' ? `已检查${result.progress.completed}页及最终PPTX：${result.productionReview.summary.blocking}项阻断、${result.productionReview.summary.warnings}项建议。视觉与Office检查范围见报告。`
            : input.mode === 'layout' ? `已提出 ${result.changedSlides.length} 页排版优化建议，确认后应用；未执行视觉模型复核。`
            : result.visualStatus === 'unavailable' ? '视觉模型不可用，整稿尚未通过视觉复核。'
                : `已复核 ${result.progress.completed} 页，${result.visualStatus === 'passed' ? '未发现新增视觉问题' : '请处理检查列出的问题'}。`;
        await store.complete(id, user, result);
    } catch (error) {
        result.message = error.code === 'PRESENTATION_CHECK_STALE' ? error.message : signal.aborted ? '检查已取消，已保存的排版修改和检查结果保留。' : '检查未完成，请查看错误后重试。';
        result.visualStatus = 'incomplete';
        await publish(id, user, result).catch(() => {});
        await store.complete(id, user, result, { failed: true, errorCode: error.code || 'PRESENTATION_CHECK_FAILED', errorMessage: String(error.message || '检查未完成').slice(0, 500) });
    } finally { store.endExecution(id, controller); }
}

async function createQualityTask(user, input, context = {}) {
    const mode = input.mode || 'visual';
    if (!['visual', 'layout', 'visual_repair', 'production'].includes(mode)) throw presentationError('检查方式无效。');
    const document = await accessible(user, input.presentationId, !['visual', 'production'].includes(mode));
    context.signal?.throwIfAborted();
    const payload = { presentationId: document.id, contentDigest: computePresentationDigest(document.content), mode, modelId: String(input.modelId || ''), runId: String(context.run?.id || '') };
    const existing = await repository.findWorking(user, payload);
    if (existing) return getQualityTask(user, document.id, existing.id);
    const task = await taskStore.create({ user, toolName: TOOL, inputRequest: payload, ttlMs: 15 * 60 * 1000 });
    setImmediate(() => { runQualityTask(task.id, user, payload, { budget: context.budget }).catch(error => require('../../logger').logger.warn({ taskId: task.id, code: error.code || 'PRESENTATION_CHECK_FAILED' }, '整稿检查任务未能保存结果')); });
    return { ...task, mode, progress: { completed: 0, total: document.content.slides.length, phase: 'preparing' }, sourceDigest: payload.contentDigest };
}

async function getQualityTask(user, presentationId, taskId) {
    const document = await accessible(user, presentationId);
    const row = await repository.readTask(user, document.id, taskId);
    if (!row || taskJson(row.input_request).presentationId !== document.id) return null;
    const task = await taskStore.getForUser(row.id, user), result = taskJson(row.result_json);
    if (!task) return null;
    return { ...task, mode: taskJson(row.input_request).mode, result, progress: result.progress || { completed: 0, total: document.content.slides.length, phase: 'preparing' },
        sourceDigest: result.contentDigest || taskJson(row.input_request).contentDigest,
        stale: (result.contentDigest || taskJson(row.input_request).contentDigest) !== computePresentationDigest(document.content) };
}

async function cancelQualityTask(user, presentationId, taskId) {
    const task = await getQualityTask(user, presentationId, taskId);
    if (!task) return null;
    await taskStore.requestCancel(task.id, user);
    return getQualityTask(user, presentationId, task.id);
}

module.exports = { createQualityTask, getQualityTask, cancelQualityTask, runQualityTask };
