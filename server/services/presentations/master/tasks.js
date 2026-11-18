'use strict';

const crypto = require('node:crypto');
const taskStore = require('../../tool-tasks');
const repository = require('../../../repositories/presentation-master-tasks');
const service = require('../presentation-service');
const runtime = require('./runtime');
const contract = require('./contract');
const { drive } = require('./driver');
const { actionSummary } = require('./observations');
const { prepareDelivery, commitDelivery } = require('./delivery');
const { pendingInput, parseDecision } = require('./confirmation');
const { markMilestone } = require('./milestones');
const { checkModel } = require('./model-preflight');
const { initializeReview, exportReview, verifyReceipt, reviewRecoveryGuidance } = require('./review-plan');
const { imageCoverage } = require('./model-input');
const deployment = require('./deployment');
const active = require('./continuation').createContinuationCoordinator();

function reviewDraftFor(row, task) {
    return ['failed', 'expired'].includes(task.status) ? row.result_json.state?.reviewDraft : null;
}

async function ensureAccess(user, request) {
    let visionRequired = false;
    if (request.template?.type === 'organization') {
        const template = await service.resolveTemplateVersionForUser(user, request.template.id, request.template.version, { forCreation: true });
        if (!template?.sourceAvailable || (template.sourceFormat || template.definition?.importMetadata?.sourceFormat) !== 'pptx') throw runtime.error('单位模板版本已不存在、未获授权或没有可保留的PPTX原稿，请重新选择模板。', 'PPT_MASTER_TEMPLATE_FORBIDDEN', 403);
    }
    if (request.presentationId && !await service.getPresentation(user, request.presentationId)) throw runtime.error('关联文稿已不存在或无权访问。', 'PPT_MASTER_PRESENTATION_FORBIDDEN', 403);
    for (const id of new Set([request.sourceAssetId, ...(request.assetIds || [])].filter(Boolean))) {
        const item = await service.getPresentationAsset(user, id, { metadataOnly: true });
        if (!item) throw runtime.error('源文件或补充素材已不存在或无权访问。', 'PPT_MASTER_SOURCE_FORBIDDEN', 403);
        if (/^image\/(?:png|jpeg|webp)$/.test(item.asset?.mimeType || '')) visionRequired = true;
    }
    return visionRequired;
}
function publicResult(row, task) {
    const data = row.result_json || {}, state = data.state;
    const pending = pendingInput(row.id, state, row.input_request);
    return { ...task, toolName: repository.TOOL, progress: data.progress || { phase: 'preparing', message: '正在准备完整制作引擎。' },
        request: state ? { title: state.request.title, operation: state.request.operation, profile: state.request.profile, presentationId: state.request.presentationId,
            pageCount: state.request.pageCount, modelId: state.request.modelId, maxSteps: state.request.maxSteps, tokenBudget: state.request.tokenBudget, productionProfile: state.request.productionProfile, template: state.request.template || null } : undefined,
        usedTokens: state?.usedTokens ?? data.usedTokens ?? 0, steps: state?.steps ?? data.steps ?? 0,
        actionSummary: actionSummary(state?.messages), modelRequest: state?.modelRequest, milestones: state?.milestones,
        imageCoverage: state?.prepared ? imageCoverage(state) : undefined, actionRetries: state?.actionRetries || 0,
        usageDiagnostics: Array.isArray(state?.usageDiagnostics) ? state.usageDiagnostics.map(({ call, step, inputTokens, outputTokens, inputEstimated, outputEstimated, inputEstimate, originalEstimate, compactedWrites, cumulativeTokens, breakdown }) => ({ call, step, inputTokens, outputTokens, inputEstimated, outputEstimated, inputEstimate, originalEstimate, compactedWrites, cumulativeTokens, breakdown })) : [],
        recoverable: Boolean(state && (!state.pendingKind || state.response) && (task.status === 'failed' || task.status === 'expired' || task.status === 'working' && Number(data._leaseUntil || 0) < Date.now() / 1000)),
        ...(reviewDraftFor(row, task) ? { hasReviewDraft: true } : {}),
        ...(reviewDraftFor(row, task) && state.pageReview ? { pageReview: state.pageReview, draftRevision: state.reviewDraft.sha256,
            canRepairPages: state.engine?.pageRepair === 1 } : {}),
        ...((task.status === 'input_required' || ['expired', 'failed'].includes(task.status)) && !state?.response && pending ? { inputRequest: pending } : {}),
        result: ['completed', 'failed', 'cancelled', 'expired'].includes(task.status) ? data.publicResult || { message: data.message || '' } : undefined };
}
async function accessibleTask(user, id) {
    const row = await repository.read(user, id);
    if (!row) return null;
    const task = await taskStore.getForUser(id, user);
    if (!task) return null;
    await ensureAccess(user, row.result_json.state?.request || row.input_request);
    return { row, task };
}
async function get(user, id) {
    const result = await accessibleTask(user, id);
    return result && publicResult(result.row, result.task);
}
async function readReviewDraft(user, id, { lookup = accessibleTask, readOutput = runtime.readOutput } = {}) {
    const result = await lookup(user, id);
    const draft = result && reviewDraftFor(result.row, result.task);
    if (!draft) throw runtime.error('待核验草稿暂不可用，请刷新任务状态。', 'PPT_MASTER_DRAFT_UNAVAILABLE', 404);
    let buffer;
    try {
        buffer = await readOutput(user, id, 'review-draft.pptx');
    } catch (error) {
        if (!['ENOENT', 'PPT_SERVICE_OUTPUT_MISSING'].includes(error.code)) throw error;
        throw runtime.error('待核验草稿已不可用，请在检查点可用时继续制作。', 'PPT_MASTER_DRAFT_UNAVAILABLE', 404);
    }
    const current = await lookup(user, id);
    const stillAvailable = current && reviewDraftFor(current.row, current.task);
    if (!stillAvailable || stillAvailable.sha256 !== draft.sha256 || buffer.length !== draft.byteSize
        || crypto.createHash('sha256').update(buffer).digest('hex') !== draft.sha256) {
        throw runtime.error('待核验草稿已变化，请刷新任务后重试。', 'PPT_MASTER_DRAFT_CHANGED', 409);
    }
    const title = current.row.result_json.state.request.title || '演示文稿';
    return { buffer, filename: title.replace(/[\r\n\\/]/g, '_') + '-待核验草稿.pptx' };
}
async function prepareInputs(user, id, request, deps = {}) {
    const input = deps.inputFile || runtime.inputFile;
    const inputFiles = [], inputDigests = [];
    for (const [index, material] of request.materials.entries()) {
        const name = 'material-' + (index + 1) + '.md';
        const file = await input(user, id, name, Buffer.from(material.text, 'utf8'));
        material.path = file; inputFiles.push({ path: file, title: material.title, kind: 'text' }); inputDigests.push(material.digest);
    }
    if (request.template?.type === 'organization') {
        const template = await service.resolveTemplateVersionForUser(user, request.template.id, request.template.version, { forCreation: true });
        if (!template?.sourceAvailable || (template.sourceFormat || template.definition?.importMetadata?.sourceFormat) !== 'pptx') throw runtime.error('单位模板没有可用的授权PPTX源文件。', 'PPT_MASTER_TEMPLATE_FORBIDDEN', 403);
        const ref = template.definition?.importMetadata?.sourceRef;
        if (!ref) throw runtime.error('单位模板的源文件引用缺失，请管理员重新导入。');
        const tenant = await require('../../agent-tenant-context').assertTenantContext(user);
        const loaded = await require('../../agent-artifact-cas').readBuffer({ ref, tenantId: tenant.tenantId, userId: user.id, tenantScoped: true });
        const file = await input(user, id, 'source.pptx', loaded.buffer);
        inputFiles.push({ path: file, title: template.name, kind: 'native_pptx', templateVersion: template.version });
        inputDigests.push(crypto.createHash('sha256').update(loaded.buffer).digest('hex'));
    }
    if (request.sourceAssetId) {
        const loaded = await (deps.getAsset || service.getPresentationAsset)(user, request.sourceAssetId);
        if (!loaded) throw runtime.error('源文件不存在或无权访问。', 'PPT_MASTER_SOURCE_FORBIDDEN', 403);
        const extension = loaded.asset.mimeType === 'application/vnd.openxmlformats-officedocument.presentationml.presentation' ? '.pptx'
            : ({ 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp' })[loaded.asset.mimeType];
        if (!extension || (request.operation === 'edit_native' && extension !== '.pptx')) throw runtime.error('原稿编辑需要PPTX；图片重建需要受控图片。');
        if (request.profile === 'image_to_pptx' && extension === '.pptx' || request.profile === 'beautify' && extension !== '.pptx') throw runtime.error('图片重建请选择图片，美化原稿请选择PPTX。');
        const file = await input(user, id, 'source' + extension, loaded.buffer);
        inputFiles.push({ path: file, title: loaded.asset.filename, kind: extension === '.pptx' ? 'native_pptx' : 'image' });
        inputDigests.push(crypto.createHash('sha256').update(loaded.buffer).digest('hex'));
    }
    for (const assetId of request.assetIds || []) {
        if (assetId === request.sourceAssetId) continue;
        const loaded = await (deps.getAsset || service.getPresentationAsset)(user, assetId);
        if (!loaded) throw runtime.error('补充素材不存在或无权访问。', 'PPT_MASTER_SOURCE_FORBIDDEN', 403);
        const extension = ({ 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'audio/wav': '.wav', 'audio/x-wav': '.wav', 'audio/mpeg': '.mp3', 'audio/ogg': '.ogg',
            'video/mp4': '.mp4', 'font/ttf': '.ttf', 'font/otf': '.otf', 'application/vnd.openxmlformats-officedocument.presentationml.presentation': '.pptx' })[loaded.asset.mimeType];
        if (!extension) throw runtime.error('补充素材格式尚未支持，请使用图片、音频、视频、字体或PPTX。');
        const file = await input(user, id, 'asset-' + assetId + extension, loaded.buffer);
        inputFiles.push({ path: file, title: loaded.asset.filename, kind: loaded.asset.mimeType }); inputDigests.push(crypto.createHash('sha256').update(loaded.buffer).digest('hex'));
    }
    return { ...request, inputFiles, inputDigests, materials: request.materials.map(({ text: _text, ...material }) => material) };
}
async function run(id, user, deps = {}) {
    if (!active.begin(id)) return;
    const lease = crypto.randomUUID(), store = deps.store || taskStore, repo = deps.repository || repository;
    let claimed;
    try { claimed = await repo.claim(user, id, lease); } catch (error) { active.finish(id); throw error; }
    if (!claimed) { active.finish(id); return; }
    const controller = store.beginExecution(id), signal = controller.signal;
    let state, progress = { phase: 'preparing', message: '正在准备完整制作引擎。' }, renewing = false;
    const ensureCurrent = async () => {
        signal.throwIfAborted();
        const task = await store.getForUser(id, user);
        if (task?.status !== 'working') throw runtime.error('制作任务已停止或过期。', 'PPT_MASTER_STOPPED', 409);
        const leased = await repo.read(user, id);
        if (leased.result_json._lease !== lease || Number(leased.result_json._leaseUntil || 0) < Date.now() / 1000) throw runtime.error('制作任务租约已被其他执行单元接管。', 'PPT_MASTER_LEASE_LOST', 409);
        if (!await (deps.parentActive || repository.parentActive)(state.request.runId, user)) throw runtime.error('所属任务已停止，制作引擎不再继续执行。', 'PPT_MASTER_PARENT_STOPPED', 409);
        await (deps.ensureAccess || ensureAccess)(user, state.request);
    };
    const checkpoint = async (nextState, nextProgress) => {
        await ensureCurrent(); state = nextState;
        progress = { ...nextProgress, steps: state.steps, maxSteps: state.request.maxSteps, usedTokens: state.usedTokens, tokenBudget: state.request.tokenBudget };
        if (!await repo.save(user, id, lease, state, progress)) throw runtime.error('制作任务租约已变化，旧执行已停止。', 'PPT_MASTER_LEASE_LOST', 409);
    };
    const heartbeat = setInterval(() => {
        if (renewing || !state) return;
        renewing = true;
        ensureCurrent().then(() => repo.renew(user, id, lease)).then(saved => {
            if (!saved) throw runtime.error('制作任务租约已变化。', 'PPT_MASTER_LEASE_LOST', 409);
        }).catch(error => controller.abort(error)).finally(() => { renewing = false; });
    }, 10000);
    heartbeat.unref?.();
    try {
        const row = await repo.read(user, id);
        state = row.result_json.state || { request: row.input_request, steps: 0, usedTokens: 0, bootstrapped: false };
        state.startedAt ||= Date.parse(row.created_at) || Date.now();
        const currentRuntime = await runtime.identity();
        deployment.assertCheckpoint(state, currentRuntime);
        state.runtimeImage ||= currentRuntime;
        await ensureCurrent();
        if (!state.prepared) { state.request = await prepareInputs(user, id, state.request, deps); state.prepared = true; await checkpoint(state, progress); }
        if (initializeReview(state)) {
            if (state.bootstrapped) state.messages?.push({ role: 'user', content: '请按当前宿主阶段要求核对方案与现有文件。旧确认没有分阶段清单，请重新提交用户批准。' });
            await checkpoint(state, { phase: 'preparing', message: '已启用分阶段确认与交付清单核验。' });
        }
        const result = state.deliveryReceipt ? { receipt: state.deliveryReceipt }
            : await (deps.drive || drive)(user, id, state, { signal, ensureCurrent, checkpoint }, deps.driverDeps || {});
        await ensureCurrent();
        if (result.pending) {
            await checkpoint(state, { phase: 'input_required', message: result.pending.question });
            await store.requestInput(id, user, result.pending, { expectedLease: lease }); return;
        }
        if (state.deliveryReview) verifyReceipt(result.receipt, exportReview(state, state.deliveryReview.project, state.deliveryReview.templateOnly));
        else throw runtime.error('交付缺少已批准的核验记录，请重新确认。', 'PPT_MASTER_CHECKLIST_UNVERIFIED', 422);
        const prepared = deps.deliver ? null : await (deps.prepareDelivery || prepareDelivery)(user, id, state.request, result.receipt, { signal, engine: state.engine });
        await ensureCurrent();
        const message = result.receipt.templateOnly ? '模板工作区通过上游校验，完整模板源包已登记。尚未自动发布到组织模板库。'
            : '制作完成；可下载原生PPTX和项目源包。复杂对象在PowerPoint或上游项目中继续编辑，尚未转换为Pivot画布元素。';
        const finish = async executor => {
            const completionStore = executor ? taskStore.createToolTaskStore({ queryOne: executor.queryOne, execute: executor.execute }) : store;
            const output = deps.deliver ? await deps.deliver(user, id, state.request, result.receipt, { signal, engine: state.engine })
                : await commitDelivery(user, id, state.request, prepared, executor);
            signal.throwIfAborted();
            markMilestone(state, 'delivered');
            const completed = await completionStore.complete(id, user, { state, usedTokens: state.usedTokens, steps: state.steps, progress: { ...progress, phase: 'finished', message },
                publicResult: { ...output, engineRevision: state.engine?.revision || runtime.lock.revision, message } }, { expectedLease: lease });
            if (executor && completed?.status !== 'completed') throw runtime.error('交付时任务已停止，未提交文件记录。', 'PPT_MASTER_STOPPED', 409);
        };
        if (deps.deliver) await finish();
        else await repo.withExecution(user, id, lease, finish);
    } catch (error) {
        const latestTask = await store.getForUser(id, user).catch(() => null);
        if (latestTask?.status === 'working') await store.complete(id, user, { state, progress: { ...progress, phase: 'interrupted' }, publicResult: { message: String(error.message).slice(0, 1200) } },
            { expectedLease: lease, failed: true, errorCode: error.code || 'PPT_MASTER_FAILED', errorMessage: String(error.message).slice(0, 1200) });
    } finally { clearInterval(heartbeat); await repo.release(user, id, lease).catch(() => {}); store.endExecution(id, controller); active.finish(id); }
}
async function start(user, input, context = {}) {
    const available = await runtime.availability();
    if (!available.enabled) throw runtime.error(available.message, 'PPT_MASTER_UNAVAILABLE', 503);
    if (available.transport === 'service' && !available.checklistReady) {
        throw runtime.error('独立PPT制作服务尚未支持交付清单核验，请更新执行镜像。', 'PPT_MASTER_CHECKLIST_UNVERIFIED', 503);
    }
    const request = { ...contract.normalize(input), runId: String(context.run?.id || context.runId || '') };
    const visionRequired = await ensureAccess(user, request);
    await checkModel(user, request, { visionRequired });
    const task = await repository.admit(user, client => { deployment.assertAccepting(); return taskStore.createToolTaskStore({ queryOne: client.queryOne, execute: client.execute }).create({ user, toolName: repository.TOOL, inputRequest: request, ttlMs: 60 * 60 * 1000 }); });
    setImmediate(() => run(task.id, user, { driverDeps: { budget: context.budget } }).catch(error => require('../../../logger').logger.warn({ taskId: task.id, code: error.code }, '完整PPT制作任务无法登记状态')));
    return { ...task, progress: { phase: 'preparing', message: '制作任务已创建。' } };
}
async function respond(user, id, input, deps = {}) {
    const repo = deps.repository || repository, store = deps.store || taskStore;
    const row = await repo.read(user, id), task = await store.getForUser(id, user);
    if (!row || !task) throw runtime.error('制作任务不存在或无权访问。', 'PPT_MASTER_NOT_FOUND', 404);
    if (task.status !== 'input_required' && !(['expired', 'failed'].includes(task.status) && row.result_json.state?.pendingKind)) throw runtime.error('当前任务没有待确认问题。', 'PPT_MASTER_NOT_WAITING', 409);
    const state = row.result_json.state;
    const decision = parseDecision(input, pendingInput(id, state, row.input_request));
    deployment.assertCheckpoint(state, await (deps.identity || runtime.identity)());
    await (deps.ensureAccess || ensureAccess)(user, state.request); state.response = decision;
    const accept = () => repo.acceptResponse(user, id, state);
    const accepted = task.status === 'input_required' ? await accept() : await repo.admit(user, () => { deployment.assertAccepting(); return accept(); }, id);
    if (!accepted) throw runtime.error('确认问题状态已变化，请刷新后核对。', 'PPT_MASTER_BUSY', 409);
    active.continue(id, () => (deps.run || run)(id, user).catch(() => {})); return (deps.get || get)(user, id);
}
async function cancel(user, id) {
    if (!await repository.read(user, id)) return null;
    await taskStore.requestCancel(id, user);
    try { return await get(user, id); } catch (error) {
        if (![403, 404].includes(error.status)) throw error;
        const task = await taskStore.getForUser(id, user);
        return task && { id: task.id, status: task.status };
    }
}
async function latest(user, presentationId) { const row = await repository.latest(user, presentationId); return row ? get(user, row.id) : null; }
async function activeTask(user) {
    const row = await repository.findActive(user);
    if (!row) return null;
    try { return await get(user, row.id); } catch (error) {
        if (![403, 404].includes(error.status)) throw error;
        const task = await taskStore.getForUser(row.id, user);
        return task && { id: task.id, status: task.status, progress: { message: '该任务的来源已不可访问，可停止任务。' } };
    }
}
async function resume(user, id, input = {}) {
    const row = await repository.read(user, id), state = row?.result_json.state;
    if (!state || active.has(id)) throw runtime.error('任务尚在执行或没有可恢复的检查点。', 'PPT_MASTER_BUSY', 409);
    deployment.assertCheckpoint(state, await runtime.identity());
    await ensureAccess(user, state.request);
    if (input.pages !== undefined) {
        if (!['failed', 'expired'].includes(row.status) || !state.reviewDraft || !state.pageReview || state.engine?.pageRepair !== 1) {
            throw runtime.error('当前任务没有可按页修复的草稿，请检查任务或重新生成整份。', 'PPT_MASTER_PAGE_REPAIR_UNAVAILABLE', 409);
        }
        if (input.draftRevision !== state.reviewDraft.sha256) throw runtime.error('草稿已更新，请刷新后重新选择页面。', 'PPT_MASTER_DRAFT_CHANGED', 409);
        const failedPages = new Set(state.pageReview.failedPages.map(page => page.page));
        if (!Array.isArray(input.pages) || !input.pages.length || input.pages.length > failedPages.size
            || new Set(input.pages).size !== input.pages.length || input.pages.some(page => !failedPages.has(page))) {
            throw runtime.error('请选择需要修复的未通过页面。');
        }
        if (input.repairNote !== undefined && (typeof input.repairNote !== 'string' || input.repairNote.length > 1000)) {
            throw runtime.error('修改意见请填写一千字以内的文字。');
        }
        state.pageRepair = { sha256: state.reviewDraft.sha256, pages: [...input.pages].sort((a, b) => a - b) };
        const issues = state.pageReview.failedPages.filter(page => input.pages.includes(page.page));
        state.messages.push({ role: 'user', content: '用户要求只修复选中的页面，保留其他页面。以下是已确认清单与本次修改意见：'
            + JSON.stringify({ issues, note: input.repairNote?.trim() || '' }) });
    }
    const modelId = input.modelId === undefined ? state.request.modelId : String(input.modelId || '').trim();
    if (!modelId || modelId.length > 160) throw runtime.error('请选择可用的制作模型。');
    if (modelId !== state.request.modelId) {
        await checkModel(user, { ...state.request, modelId }, { visionRequired: imageCoverage(state).total > 0 });
    }
    const maxSteps = Number(input.maxSteps || state.request.maxSteps), tokenBudget = contract.normalizeTokenBudget(input.tokenBudget, state.request.tokenBudget);
    if (!Number.isInteger(maxSteps) || maxSteps < state.request.maxSteps || maxSteps > 160) throw runtime.error('继续轮次只能在上限内增加，不能重置累计消耗。');
    state.request.maxSteps = maxSteps; state.request.tokenBudget = tokenBudget; state.request.modelId = modelId;
    if (row.error_code === 'PPT_MASTER_ACTION_INVALID' && state.citationRepair) state.citationRepairAttempts = 0;
    if (row.error_code === 'PPT_MASTER_NO_PROGRESS') {
        state.inspectionRepairAttempts = 0;
        state.inspectionRepairPending = true;
    }
    // 旧检查点可能只保存了转发超时或带超时原因的熔断错误。
    if (['PPT_MASTER_MODEL_TIMEOUT', 'ECONNABORTED', 'ETIMEDOUT'].includes(row.error_code)
        || row.error_code === 'AI_ENDPOINT_CIRCUIT_OPEN' && /timeout of \d+ms exceeded/i.test(row.error_message || '')) {
        state.focusModelHistory = true;
    }
    if (state.messages) {
        const repair = reviewRecoveryGuidance(state, row.error_code, row.error_message);
        state.messages.push({ role: 'user', content: '宿主中断后从已保存检查点继续。上一轮动作可能已经部分执行，请先list/read核对现有任务文件，再决定下一步；不能盲目覆盖或重复创建项目。累计用量与步骤没有重置。' + repair });
    }
    if (!await repository.admit(user, () => { deployment.assertAccepting(); return repository.resume(user, id, state); }, id)) throw runtime.error('任务状态已变化或仍持有有效执行租约。', 'PPT_MASTER_BUSY', 409);
    setImmediate(() => run(id, user).catch(() => {})); return get(user, id);
}

async function regenerate(user, id, dependencies = {}) {
    const previous = await (dependencies.lookup || accessibleTask)(user, id);
    if (!previous || !['failed', 'expired'].includes(previous.task.status) || previous.row.result_json.state?.request?.runId) {
        throw runtime.error('此任务当前不能重新生成整份。', 'PPT_MASTER_REGENERATE_UNAVAILABLE', 409);
    }
    const request = previous.row.result_json.state?.request || previous.row.input_request;
    const readOriginal = dependencies.readOriginal || runtime.inputBuffer;
    const materials = await Promise.all((request.materials || []).map(async material => {
        if (typeof material.text === 'string') return material;
        const path = /^inputs\/(material-[1-9]\d*\.md)$/.exec(material.path || '');
        if (!path) throw runtime.error('原材料快照已不可用，请使用原材料新建制作。', 'PPT_MASTER_REGENERATE_UNAVAILABLE', 409);
        try {
            const buffer = await readOriginal(user, id, path[1], 500000);
            if (crypto.createHash('sha256').update(buffer).digest('hex') !== material.digest) throw new Error();
            return { ...material, text: buffer.toString('utf8') };
        } catch (_) {
            throw runtime.error('原材料快照已不可用，请使用原材料新建制作。', 'PPT_MASTER_REGENERATE_UNAVAILABLE', 409);
        }
    }));
    const { sourceAssetId, ...settings } = request;
    return (dependencies.start || start)(user, { ...settings, ...(sourceAssetId ? { sourceAssetId } : {}), materials });
}

module.exports = { start, get, readReviewDraft, respond, cancel, latest, activeTask, run, resume, regenerate };
