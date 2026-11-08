'use strict';

const crypto = require('node:crypto');
const repository = require('../../../repositories/presentation-storyline');
const store = require('../../tool-tasks');
const service = require('../presentation-service');
const { isAdmin } = require('../../../permissions');
const { getRunnableModelForUserAsync, getModelDailyUsageAsync } = require('../../models');
const { callModelTextWithBudget } = require('../../model-text-call');
const { computePresentationDigest, presentationError } = require('../presentation-schema');
const planner = require('./plan');
const executions = new Map();

async function accessible(user, id, editing = true) {
    const document = await service.getPresentation(user, id);
    if (!document) throw presentationError('文稿不存在或已无权访问。', 404, 'PRESENTATION_NOT_FOUND');
    if (editing && !document.isOwner && document.collaboratorRole !== 'editor' && !isAdmin(user)) throw presentationError('当前角色不能调整页面。', 403, 'PRESENTATION_EDIT_FORBIDDEN');
    return document;
}
async function modelFor(user, id) {
    const model = await getRunnableModelForUserAsync(id, user);
    if (!model || model.secret_error) throw presentationError('所选模型不可用，请检查授权。', 403, 'PRESENTATION_MODEL_UNAVAILABLE');
    if (Number(model.daily_token_limit) > 0 && await getModelDailyUsageAsync(user.id, model.id) >= Number(model.daily_token_limit)) throw presentationError('所选模型今日用量已达上限。', 429, 'PRESENTATION_MODEL_QUOTA');
    return model;
}
async function get(user, presentationId, id) {
    const document = await accessible(user, presentationId, false), row = await repository.read(user, presentationId, id);
    if (!row) return null;
    const task = await store.getForUser(row.id, user), result = row.result_json;
    return { id: row.id, status: task.status, phase: result.phase || 'generating', error: task.error, sourceDigest: row.input_request.contentDigest,
        stale: result.phase !== 'applied' && (computePresentationDigest(document.content) !== row.input_request.contentDigest || Number(document.version) !== row.input_request.baseVersion),
        preview: result.preview || null, planDigest: result.planDigest || '', appliedVersion: result.appliedVersion || null, usage: result.usage || null,
        canResumeApply: task.status === 'working' && result.phase === 'applying' && Number(result._leaseUntil) < Date.now() / 1000 };
}
async function run(user, presentationId, id, deps = {}) {
    const lease = crypto.randomUUID(); if (!await repository.claim(user, id, lease)) return;
    const controller = store.beginExecution(id), signal = controller.signal;
    executions.set(id, controller);
    const heartbeat = setInterval(() => repository.renew(user, id, lease).then(row => { if (!row) controller.abort(); }).catch(error => controller.abort(error)), 10000); heartbeat.unref?.();
    try {
        const row = await repository.read(user, presentationId, id), request = row.input_request;
        const document = await accessible(user, presentationId);
        if (computePresentationDigest(document.content) !== request.contentDigest || Number(document.version) !== request.baseVersion) throw presentationError('文稿已修改，请基于最新内容重新生成方案。', 409, 'PRESENTATION_STORY_STALE');
        const model = await modelFor(user, request.modelId);
        const response = await (deps.callModel || callModelTextWithBudget)({ modelCfg: model, user, messages: planner.messages(document, request.scope, request.slideId, request.instruction), source: 'presentation_storyline', maxTokens: 12000, maxOutputTokensCap: 12000, timeout: 120000, signal });
        signal.throwIfAborted();
        const latest = await accessible(user, presentationId);
        if (computePresentationDigest(latest.content) !== request.contentDigest || Number(latest.version) !== request.baseVersion) throw presentationError('生成期间文稿已修改，旧方案不再可用。', 409, 'PRESENTATION_STORY_STALE');
        const result = planner.prepare(response.content, document, request.scope, request.slideId);
        if (!await repository.propose(user, id, lease, { plan: result.plan, planDigest: result.planDigest, preview: result.preview, usage: response.usage })) throw presentationError('任务已停止或过期。', 409, 'PRESENTATION_STORY_STOPPED');
    } catch (error) {
        await store.complete(id, user, { phase: 'failed' }, { expectedLease: lease, failed: true, errorCode: error.code || 'PRESENTATION_STORY_FAILED', errorMessage: String(error.message).slice(0, 600) });
    } finally { clearInterval(heartbeat); store.endExecution(id, controller); if (executions.get(id) === controller) executions.delete(id); }
}
async function start(user, presentationId, input) {
    const document = await accessible(user, presentationId), scope = input.scope || 'deck';
    if (!['deck', 'page'].includes(scope) || typeof input.modelId !== 'string' || !input.modelId || input.modelId.length > 160 || typeof (input.instruction || '') !== 'string' || String(input.instruction || '').length > 2000) throw presentationError('请选择有效的模型、范围和调整要求。');
    if (scope === 'page' && !document.content.slides.some(slide => slide.id === input.slideId && slide.review?.status !== 'approved')) throw presentationError('所选页面不存在或已批准，请先解除批准。');
    await modelFor(user, input.modelId);
    const request = { presentationId, scope, slideId: scope === 'page' ? input.slideId : '', instruction: input.instruction || '', modelId: input.modelId,
        contentDigest: computePresentationDigest(document.content), baseVersion: Number(document.version) };
    const task = await repository.create(user, request, client => store.createToolTaskStore({ queryOne: client.queryOne, execute: client.execute }).create({ user, toolName: repository.TOOL, inputRequest: request, ttlMs: 30 * 60 * 1000 }));
    setImmediate(() => run(user, presentationId, task.id).catch(() => {})); return { id: task.id, status: 'working', phase: 'generating' };
}
async function cancel(user, presentationId, id) {
    await accessible(user, presentationId); if (!await repository.read(user, presentationId, id)) return null;
    if (!await repository.discard(user, id)) throw presentationError('方案正在确认保存或状态已变化，请刷新核对。', 409, 'PRESENTATION_STORY_BUSY');
    executions.get(id)?.abort(); return get(user, presentationId, id);
}
async function apply(user, presentationId, id, input) {
    const document = await accessible(user, presentationId), row = await repository.read(user, presentationId, id);
    if (!row) throw presentationError('调整方案不存在或无权访问。', 404, 'PRESENTATION_STORY_NOT_FOUND');
    const previous = await repository.appliedVersion(user, presentationId, id);
    if (previous) { await repository.finished(user, id, Number(previous.version)); return { presentation: document, reused: true, appliedVersion: Number(previous.version) }; }
    if (input.confirm !== true || input.planDigest !== row.result_json.planDigest || !row.result_json.plan) throw presentationError('请确认当前预览方案后再应用。', 409, 'PRESENTATION_STORY_CONFIRM_REQUIRED');
    if (computePresentationDigest(document.content) !== row.input_request.contentDigest || Number(document.version) !== row.input_request.baseVersion) throw presentationError('文稿或制作目标已变化，请重新生成方案。', 409, 'PRESENTATION_STORY_STALE');
    const prepared = planner.prepare(row.result_json.plan, document, row.input_request.scope, row.input_request.slideId);
    if (prepared.planDigest !== input.planDigest) throw presentationError('方案摘要已变化，请重新预览。');
    const lease = crypto.randomUUID();
    if (!await repository.claimApply(user, id, lease)) throw presentationError('方案已过期、被放弃或正在应用。', 409, 'PRESENTATION_STORY_BUSY');
    try {
        const saved = await service.savePresentationContent(user, presentationId, { baseVersion: document.version, title: document.title, content: prepared.content, isMilestone: true, note: '按故事线调整:' + id }, { isMilestone: true, expectedContentDigest: row.input_request.contentDigest });
        await repository.finished(user, id, saved.version); return { presentation: saved, appliedVersion: saved.version };
    } catch (error) { await store.complete(id, user, { ...row.result_json, phase: 'failed' }, { expectedLease: lease, failed: true, errorCode: error.code || 'PRESENTATION_STORY_APPLY_FAILED', errorMessage: String(error.message).slice(0, 600) }); throw error; }
}
module.exports = { start, get, cancel, apply, run };
