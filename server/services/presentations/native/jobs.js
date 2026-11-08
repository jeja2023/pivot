'use strict';

const crypto = require('node:crypto');
const taskStore = require('../../tool-tasks');
const repository = require('../../../repositories/presentation-native');
const contract = require('./contract');
const storage = require('./storage');
const runtime = require('../master/runtime');
const deployment = require('../master/deployment');
const active = new Set();

async function get(user, id) {
    const row = await repository.readJob(user, id);
    if (!row) return null;
    const task = await taskStore.getForUser(id, user);
    const state = row.result_json.state || { request: row.input_request };
    if (state?.request) await storage.access(user, state.request);
    return { id: task.id, status: task.status, error: task.error, progress: row.result_json.progress || { message: '正在准备离线原稿任务。' },
        result: row.result_json.publicResult || null, recoverable: Boolean(Date.parse(row.updated_at) > Date.now() - 86400000 && (task.status === 'failed' || task.status === 'working' && Date.parse(row.updated_at) < Date.now() - 30000 && Number(row.result_json._leaseUntil || 0) < Date.now() / 1000)) };
}
async function run(user, id, deps = {}) {
    if (active.has(id)) return;
    const repo = deps.repository || repository, store = deps.store || taskStore, runtimeClient = deps.runtime || runtime, persistence = deps.storage || storage;
    const lease = crypto.randomUUID();
    if (!await repo.claim(user, id, lease)) return;
    active.add(id);
    const controller = store.beginExecution(id);
    let state, progress = { message: '正在准备离线原稿任务。' }, renewing = false;
    const current = async () => {
        controller.signal.throwIfAborted();
        if (state.runtimeImage && (await runtimeClient.identity?.() || runtimeClient.config?.().image) !== state.runtimeImage) throw runtime.error('原稿执行镜像已变化，请重新创建任务以使用一致的渲染环境。', 'PRESENTATION_NATIVE_IMAGE_CHANGED', 409);
        const row = await repo.readJob(user, id);
        if (!row || row.status !== 'working' || row.result_json._lease !== lease || Number(row.result_json._leaseUntil || 0) <= Date.now() / 1000 || Date.parse(row.expires_at) <= Date.now()) throw runtime.error('原稿任务已停止、过期或租约已变化。', 'PRESENTATION_NATIVE_STOPPED', 409);
        return persistence.access(user, state.request);
    };
    const save = async message => {
        await current(); progress = { message, completedSlides: state.clips?.length || 0, totalSlides: state.pageCount || 0 };
        if (!await repo.checkpoint(user, id, lease, state, progress)) throw runtime.error('原稿任务租约已变化。');
    };
    const execute = async input => { await current(); return runtimeClient.execute(user, id, input, { signal: controller.signal }); };
    const heartbeat = setInterval(() => {
        if (!state || renewing) return; renewing = true;
        current().then(() => repo.checkpoint(user, id, lease, state, progress)).then(row => { if (!row) throw runtime.error('原稿任务租约已变化。'); })
            .catch(error => controller.abort(error)).finally(() => { renewing = false; });
    }, 10000); heartbeat.unref?.();
    try {
        const row = await repo.readJob(user, id);
        state = row.result_json.state || { request: row.input_request };
        state.runtimeImage ||= await runtimeClient.identity?.() || runtimeClient.config?.().image || '';
        const tenant = await current();
        if (!state.snapshot) { state.snapshot = await persistence.snapshot(user, id, state.request); await save('原稿和媒体输入快照已保存，开始离线渲染。'); }
        const request = state.request;
        let result;
        if (request.kind === 'video') {
            if (!state.pageCount) {
                const prepared = await execute({ action: 'native_video_prepare', source: state.snapshot.source });
                if (prepared.sourceDigest !== state.snapshot.sourceDigest) throw runtime.error('视频源稿摘要发生变化。');
                state.pageCount = prepared.slideCount; state.clips = [];
                if (state.pageCount * request.video.duration > 600 || request.video.narration.some(audio => audio.slideIndex >= state.pageCount)) throw runtime.error('视频总时长超过10分钟或旁白页码超出文稿范围。');
                await save('页面已离线渲染，开始逐页编码视频。');
            }
            for (let index = state.clips.length; index < state.pageCount; index++) {
                const audio = state.snapshot.narration.find(item => item.slideIndex === index)?.path;
                const clip = await execute({ action: 'native_video_clip', source: state.snapshot.source, slideIndex: index,
                    options: { duration: request.video.duration, fps: request.video.fps, resolution: request.video.resolution, transition: request.video.transition }, ...(audio ? { audio } : {}) });
                state.clips.push(clip);
                if (state.clips.reduce((sum, item) => sum + item.duration, 0) > 600) throw runtime.error('旁白延长后的总时长超过10分钟，请分批导出。');
                await save(`已编码第${index + 1}/${state.pageCount}页；视频仅包含静态页面、所选转场与旁白。`);
            }
            const report = await execute({ action: 'native_video_finish', source: state.snapshot.source, clips: state.clips });
            await save('视频已完成本地编码，正在核对并登记MP4。');
            await repo.withExecution(user, id, lease, async executor => {
                const completionStore = executor && !deps.store ? taskStore.createToolTaskStore({ queryOne: executor.queryOne, execute: executor.execute }) : store;
                result = { documentId: request.documentId, version: request.baseVersion, report, file: await persistence.deliver(user, id, request, 'video.mp4', report, { executor }) };
                controller.signal.throwIfAborted();
                const saved = await completionStore.complete(id, user, { state, progress: { ...progress, message: '离线原稿任务已完成。' }, publicResult: result }, { expectedLease: lease });
                if (saved?.status !== 'completed') throw runtime.error('交付时任务已停止或过期，未提交文件记录。', 'PRESENTATION_NATIVE_STOPPED', 409);
            });
            return;
        } else {
            const receipt = await execute({ action: request.kind === 'patch' ? 'native_patch' : 'native_inspect', source: state.snapshot.source, ...(request.patches ? { patches: request.patches } : {}) });
            if (receipt.offlineProtocol !== 1 || receipt.status !== 'passed') throw runtime.error('当前镜像尚未通过原稿编辑协议检查。');
            await save('原生对象已读回，正在持久保存新版本和离线预览。');
            const output = await persistence.storeVersion(user, id, receipt);
            await current();
            await repo.withExecution(user, id, lease, async executor => {
                const completionStore = executor && !deps.store ? taskStore.createToolTaskStore({ queryOne: executor.queryOne, execute: executor.execute }) : store;
                const committed = await repo.commit(user, tenant.tenantId, id, lease, request, output, executor);
                result = { documentId: committed.document_id, version: Number(committed.version), preservation: receipt.preservation };
                controller.signal.throwIfAborted();
                const saved = await completionStore.complete(id, user, { state, progress: { ...progress, message: '离线原稿任务已完成。' }, publicResult: result }, { expectedLease: lease });
                if (saved?.status !== 'completed') throw runtime.error('保存时任务已停止或过期，未提交新版本。', 'PRESENTATION_NATIVE_STOPPED', 409);
            });
            return;
        }
    } catch (error) {
        await store.complete(id, user, { state, progress, publicResult: null }, { expectedLease: lease, failed: true, errorCode: error.code || 'PRESENTATION_NATIVE_FAILED', errorMessage: String(error.message).slice(0, 1200) });
    } finally {
        clearInterval(heartbeat); await repo.release(user, id, lease).catch(() => {}); store.endExecution(id, controller); active.delete(id);
        const final = await repo.readJob(user, id).catch(() => null);
        if (['completed', 'cancelled'].includes(final?.status)) await runtimeClient.cleanupWorkspace(user, id).catch(() => {});
    }
}
async function start(user, input) {
    const available = await runtime.availability();
    if (!available.enabled) throw runtime.error(available.message, 'PRESENTATION_NATIVE_UNAVAILABLE', 503);
    const request = contract.normalize(input);
    if (request.kind === 'import') request.documentId = 'native_' + crypto.randomUUID().replace(/-/g, '');
    const tenant = await storage.access(user, request);
    if (['patch', 'restore'].includes(request.kind)) {
        const current = await repository.header(user, tenant.tenantId, request.documentId);
        if (Number(current?.current_version) !== request.baseVersion) throw runtime.error('文稿已有新版本，请刷新后核对修改。', 'PRESENTATION_NATIVE_CONFLICT', 409);
    }
    const task = await repository.admit(user, client => { deployment.assertAccepting(); return taskStore.createToolTaskStore({ queryOne: client.queryOne, execute: client.execute }).create({ user, toolName: repository.TOOL, inputRequest: request, ttlMs: 3600000 }); });
    setImmediate(() => run(user, task.id).catch(() => {}));
    return { id: task.id, status: task.status };
}
async function cancel(user, id) { if (!await get(user, id)) return null; await taskStore.requestCancel(id, user); return get(user, id); }
async function resume(user, id) {
    const row = await repository.readJob(user, id);
    if (!row || active.has(id)) throw runtime.error('任务正在执行或没有可恢复的检查点。');
    if (row.result_json.state?.runtimeImage && row.result_json.state.runtimeImage !== await runtime.identity()) throw runtime.error('制作镜像已升级，请新建原稿任务，不能混用旧检查点与新渲染器。', 'PRESENTATION_NATIVE_IMAGE_CHANGED', 409);
    await storage.access(user, row.result_json.state?.request || row.input_request);
    if (!await repository.admit(user, () => { deployment.assertAccepting(); return repository.resume(user, id); }, id)) throw runtime.error('任务状态已变化，请刷新后核对。');
    setImmediate(() => run(user, id).catch(() => {})); return get(user, id);
}
async function latest(user) { const row = await repository.latestJob(user); return row ? get(user, row.id) : null; }
async function cleanup() {
    for (const row of await repository.cleanupCandidates()) if (!active.has(row.id)) await runtime.cleanupWorkspace({ id: row.user_id }, row.id);
}

module.exports = { start, get, cancel, resume, run, latest, cleanup };
