'use strict';

const crypto = require('node:crypto');
const taskStore = require('../../tool-tasks');
const repository = require('../../../repositories/presentation-master-tasks');
const service = require('../presentation-service');
const runtime = require('./runtime');
const contract = require('./contract');
const { drive } = require('./driver');
const { deliver } = require('./delivery');
const deployment = require('./deployment');
const active = new Set();

async function ensureAccess(user, request) {
    if (request.template?.type === 'organization') {
        const template = await service.resolveTemplateVersionForUser(user, request.template.id, request.template.version, { forCreation: true });
        if (!template?.sourceAvailable || (template.sourceFormat || template.definition?.importMetadata?.sourceFormat) !== 'pptx') throw runtime.error('单位模板版本已不存在、未获授权或没有可保留的PPTX原稿，请重新选择模板。', 'PPT_MASTER_TEMPLATE_FORBIDDEN', 403);
    }
    if (request.presentationId && !await service.getPresentation(user, request.presentationId)) throw runtime.error('关联文稿已不存在或无权访问。', 'PPT_MASTER_PRESENTATION_FORBIDDEN', 403);
    if (request.sourceAssetId && !await service.getPresentationAsset(user, request.sourceAssetId, { metadataOnly: true })) throw runtime.error('源文件已不存在或无权访问。', 'PPT_MASTER_SOURCE_FORBIDDEN', 403);
    for (const id of request.assetIds || []) if (!await service.getPresentationAsset(user, id, { metadataOnly: true })) throw runtime.error('补充素材已不存在或无权访问。', 'PPT_MASTER_SOURCE_FORBIDDEN', 403);
}
function publicResult(row, task) {
    const data = row.result_json || {}, state = data.state;
    return { ...task, toolName: repository.TOOL, progress: data.progress || { phase: 'preparing', message: '正在准备完整制作引擎。' },
        request: state ? { title: state.request.title, operation: state.request.operation, profile: state.request.profile, presentationId: state.request.presentationId,
            pageCount: state.request.pageCount, modelId: state.request.modelId, maxSteps: state.request.maxSteps, tokenBudget: state.request.tokenBudget, productionProfile: state.request.productionProfile, template: state.request.template || null } : undefined,
        usedTokens: state?.usedTokens ?? data.usedTokens ?? 0, steps: state?.steps ?? data.steps ?? 0,
        recoverable: Boolean(state && (task.status === 'failed' || task.status === 'working' && Number(data._leaseUntil || 0) < Date.now() / 1000)),
        ...(task.status === 'input_required' ? { inputRequest: { question: row.input_request.question, context: row.input_request.context } } : {}),
        result: ['completed', 'failed', 'cancelled', 'expired'].includes(task.status) ? data.publicResult || { message: data.message || '' } : undefined };
}
async function get(user, id) {
    const row = await repository.read(user, id);
    if (!row) return null;
    const task = await taskStore.getForUser(id, user);
    if (!task) return null;
    if (row.result_json.state?.request) await ensureAccess(user, row.result_json.state.request);
    return publicResult(row, task);
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
    if (active.has(id)) return;
    const lease = crypto.randomUUID(), store = deps.store || taskStore, repo = deps.repository || repository;
    if (!await repo.claim(user, id, lease)) return;
    active.add(id);
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
        deployment.assertCheckpoint(state, runtime.config().image);
        state.runtimeImage ||= runtime.config().image;
        await ensureCurrent();
        if (!state.prepared) { state.request = await prepareInputs(user, id, state.request, deps); state.prepared = true; await checkpoint(state, progress); }
        const result = await (deps.drive || drive)(user, id, state, { signal, ensureCurrent, checkpoint }, deps.driverDeps || {});
        await ensureCurrent();
        if (result.pending) {
            await checkpoint(state, { phase: 'input_required', message: result.pending.question });
            await store.requestInput(id, user, result.pending, { expectedLease: lease }); return;
        }
        const output = await (deps.deliver || deliver)(user, id, state.request, result.receipt, { signal });
        await ensureCurrent();
        const message = result.receipt.templateOnly ? '模板工作区通过上游校验，完整模板源包已登记。尚未自动发布到组织模板库。'
            : '制作完成；可下载原生PPTX和项目源包。复杂对象在PowerPoint或上游项目中继续编辑，尚未转换为Pivot画布元素。';
        await store.complete(id, user, { state, usedTokens: state.usedTokens, steps: state.steps, progress: { ...progress, phase: 'finished', message },
            publicResult: { ...output, engineRevision: runtime.lock.revision, message } }, { expectedLease: lease });
    } catch (error) {
        const latestTask = await store.getForUser(id, user).catch(() => null);
        if (latestTask?.status === 'working') await store.complete(id, user, { state, progress: { ...progress, phase: 'interrupted' }, publicResult: { message: String(error.message).slice(0, 1200) } },
            { expectedLease: lease, failed: true, errorCode: error.code || 'PPT_MASTER_FAILED', errorMessage: String(error.message).slice(0, 1200) });
    } finally { clearInterval(heartbeat); await repo.release(user, id, lease).catch(() => {}); store.endExecution(id, controller); active.delete(id); }
}
async function start(user, input, context = {}) {
    const available = runtime.availability();
    if (!available.enabled) throw runtime.error(available.message, 'PPT_MASTER_UNAVAILABLE', 503);
    const request = { ...contract.normalize(input), runId: String(context.run?.id || context.runId || '') };
    await ensureAccess(user, request);
    const task = await repository.admit(user, client => { deployment.assertAccepting(); return taskStore.createToolTaskStore({ queryOne: client.queryOne, execute: client.execute }).create({ user, toolName: repository.TOOL, inputRequest: request, ttlMs: 60 * 60 * 1000 }); });
    setImmediate(() => run(task.id, user, { driverDeps: { budget: context.budget } }).catch(error => require('../../../logger').logger.warn({ taskId: task.id, code: error.code }, '完整PPT制作任务无法登记状态')));
    return { ...task, progress: { phase: 'preparing', message: '制作任务已创建。' } };
}
async function respond(user, id, answer) {
    const row = await repository.read(user, id), task = await taskStore.getForUser(id, user);
    if (!row || !task) throw runtime.error('制作任务不存在或无权访问。', 'PPT_MASTER_NOT_FOUND', 404);
    if (task.status !== 'input_required') throw runtime.error('当前任务没有待确认问题。', 'PPT_MASTER_NOT_WAITING', 409);
    if (typeof answer !== 'string' || !answer.trim() || answer.length > 12000) throw runtime.error('请提供不超过12000字的明确答复。');
    const state = row.result_json.state;
    deployment.assertCheckpoint(state, runtime.config().image);
    await ensureAccess(user, state.request); state.response = answer.trim();
    if (!await repository.acceptResponse(user, id, state)) throw runtime.error('确认问题状态已变化，请刷新后核对。', 'PPT_MASTER_BUSY', 409);
    setImmediate(() => run(id, user).catch(() => {})); return get(user, id);
}
async function cancel(user, id) { if (!await get(user, id)) return null; await taskStore.requestCancel(id, user); return get(user, id); }
async function latest(user, presentationId) { const row = await repository.latest(user, presentationId); return row ? get(user, row.id) : null; }
async function resume(user, id, input = {}) {
    const row = await repository.read(user, id), state = row?.result_json.state;
    if (!state || active.has(id)) throw runtime.error('任务尚在执行或没有可恢复的检查点。', 'PPT_MASTER_BUSY', 409);
    deployment.assertCheckpoint(state, runtime.config().image);
    await ensureAccess(user, state.request);
    const maxSteps = Number(input.maxSteps || state.request.maxSteps), tokenBudget = Number(input.tokenBudget || state.request.tokenBudget);
    if (!Number.isInteger(maxSteps) || maxSteps < state.request.maxSteps || maxSteps > 160 || !Number.isInteger(tokenBudget) || tokenBudget < state.request.tokenBudget || tokenBudget > 500000) throw runtime.error('继续预算只能在上限内增加，不能重置累计消耗。');
    state.request.maxSteps = maxSteps; state.request.tokenBudget = tokenBudget;
    if (state.messages) state.messages.push({ role: 'user', content: '宿主中断后从已保存检查点继续。上一轮动作可能已经部分执行，请先list/read核对现有任务文件，再决定下一步；不能盲目覆盖或重复创建项目。累计用量与步骤没有重置。' });
    if (!await repository.admit(user, () => { deployment.assertAccepting(); return repository.resume(user, id, state); }, id)) throw runtime.error('任务状态已变化或仍持有有效执行租约。', 'PPT_MASTER_BUSY', 409);
    setImmediate(() => run(id, user).catch(() => {})); return get(user, id);
}

module.exports = { start, get, respond, cancel, latest, run, resume };
