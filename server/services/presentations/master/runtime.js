'use strict';

const fs = require('node:fs/promises');
const { checkInputSize, saveInputSnapshot } = require('./input-snapshots');
const path = require('node:path');
const { readTypedEnv } = require('../../../config/env-registry');
const worker = require('../../agent-capability-worker');
const lock = require('../../../../config/ppt-master-engine.json');
const deployment = require('./deployment');
const remote = require('./service-client');
const comparable = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
const progressFiles = new Set(['progress-sources.zip', 'progress-review.pptx', 'progress-passed.pptx']);

function error(message, code = 'PPT_MASTER_INVALID', status = 400) { return Object.assign(new Error(message), { code, status, statusCode: status, expose: true }); }
function config() {
    const image = readTypedEnv('PIVOT_PPT_MASTER_IMAGE');
    return { enabled: readTypedEnv('PIVOT_PPT_MASTER_ENABLED'), image,
        command: ['python', '/runner/runner.py'], limits: { memoryMb: 1024, cpu: 1, timeoutMs: 120000, maxOutputBytes: 1024 * 1024 } };
}
async function availability() {
    try {
        if (await remote.configured()) {
            const health = await remote.info({ force: true });
            if (!health) return { enabled: false, transport: 'service', message: '完整制作服务已停用，标准PPT功能继续可用。' };
            const generationReady = health.deliveryChecklist === 1 && health.currentExport === 1;
            return { enabled: true, transport: 'service', version: health.version, revision: health.revision, runtimeId: health.runtimeId,
                checklistReady: health.deliveryChecklist === 1, currentExportReady: health.currentExport === 1, pageRepairReady: health.pageRepair === 1,
                checklistDisplayEquivalence: health.checklistDisplayEquivalence === 1,
                checklistGroupedValues: health.checklistGroupedValues === 1,
                expandedChecklist: health.expandedChecklist === 1,
                projectSpecReceipts: health.projectSpecReceipts === 1,
                generationReady, templateReady: health.deliveryChecklist === 1, progressSnapshotsReady: health.progressSnapshots === 1,
                message: generationReady ? '独立PPT制作服务可用。' : '独立服务已连接，生成或编辑 PPTX 需要更新镜像以启用完整导出核验。' };
        }
    } catch (failure) {
        const message = failure.code === 'PPT_SERVICE_TIMEOUT' ? '独立 PPT 制作服务状态查询超时，请稍后重试。'
            : failure.code === 'PPT_SERVICE_PROTOCOL_MISMATCH' ? '独立 PPT 制作服务协议不兼容，请检查镜像版本。'
                : '独立PPT制作服务暂不可用，标准PPT创建、编辑和导出继续可用。';
        return { enabled: false, transport: 'service', message };
    }
    if (!deployment.accepting()) return { enabled: false, message: 'PPT制作引擎正在更新，请稍后重新提交。' };
    const definition = config();
    if (!definition.enabled || !definition.image) return { enabled: false, message: '完整制作引擎尚未配置。' };
    if (!worker.isWorkerEnabled(process.env)) return { enabled: false, message: '受限制作执行服务尚未启用。' };
    try { worker.verifyWorkerSignature(worker.normalizeDefinition(definition), { env: deployment.workerEnv() }); }
    catch (_) { return { enabled: false, message: '完整制作镜像尚未通过当前部署的签名信任检查。' }; }
    return { enabled: true, message: '完整制作引擎已登记，任务启动时还将核对完整运行包。' };
}
function requireReady(available, operation) {
    if (!available.enabled) throw error(available.message, 'PPT_MASTER_UNAVAILABLE', 503);
    if (available.transport === 'service' && (!available.checklistReady || operation !== 'create_template' && !available.currentExportReady)) {
        throw error('请更新独立PPT制作镜像，以启用交付清单与本次导出核验。', 'PPT_MASTER_CHECKLIST_UNVERIFIED', 503);
    }
}
function taskDirectory(user, id) {
    if (!Number.isSafeInteger(Number(user?.id)) || Number(user.id) <= 0 || !/^tooltask_[A-Za-z0-9_-]{24,80}$/.test(String(id))) throw error('制作任务标识无效。');
    const root = process.env.PIVOT_PPT_MASTER_WORKSPACE_DIR ? path.resolve(process.env.PIVOT_PPT_MASTER_WORKSPACE_DIR) : path.resolve(process.env.DATA_DIR || path.join(__dirname, '../../../../data'), 'ppt-master');
    return path.join(root, 'user-' + user.id, id);
}
async function workspace(user, id) {
    const directory = path.join(taskDirectory(user, id), 'workspace');
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const resolved = await fs.realpath(directory);
    if (comparable(resolved) !== comparable(directory)) throw error('制作目录不能经过链接或重定向。', 'PPT_MASTER_WORKSPACE_INVALID');
    // 外层账号/任务目录保持私有；仅此随机任务挂载点允许固定的非特权 Worker UID 写入。
    await fs.chmod(directory, 0o777);
    return directory;
}
async function execute(user, id, input, { signal, env = process.env, runWorker = worker.runCapabilityWorker } = {}) {
    if (await remote.configured(env)) {
        const output = await remote.execute(user, id, input, { signal, env });
        if (!output.ok) throw error(String(output.error || '制作服务执行失败。').slice(0, 1600), 'PPT_MASTER_OPERATION_FAILED', 422);
        return { ...output.result, ...(input.action === 'health' ? { runtimeId: output.runtimeId, serviceProtocol: output.serviceProtocol } : {}) };
    }
    const definition = config();
    if (!definition.enabled || !definition.image) throw error('PPT Master 制作引擎尚未配置，请由管理员准备固定版本运行镜像。', 'PPT_MASTER_UNAVAILABLE', 503);
    if (String(input?.action || '').startsWith('native_')) definition.limits.memoryMb = 1536;
    signal?.throwIfAborted();
    const output = await runWorker(definition, input, { signal, env: deployment.workerEnv(env), workspaceMount: { source: await workspace(user, id), target: '/workspace' } });
    if (output.revision !== lock.revision) throw error('制作引擎版本不匹配，请重新部署已登记的版本。', 'PPT_MASTER_REVISION_MISMATCH', 503);
    if (!output.ok && String(input?.action || '').startsWith('native_') && /执行动作未登记/.test(String(output.error || ''))) throw error('当前制作镜像尚未包含原稿编辑和离线视频适配，请管理员重建镜像并登记新的摘要与签名。', 'PRESENTATION_NATIVE_PROTOCOL_UNAVAILABLE', 503);
    if (!output.ok) throw error(String(output.error || '制作引擎执行失败。').slice(0, 1600), 'PPT_MASTER_OPERATION_FAILED', 422);
    return output.result;
}
async function inputFile(user, id, name, buffer) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,120}$/.test(name) || !Buffer.isBuffer(buffer)) throw error('制作输入文件无效。');
    checkInputSize(name, buffer.length);
    if (await remote.configured()) return remote.inputFile(user, id, name, buffer);
    const root = await workspace(user, id), directory = path.join(root, 'inputs');
    await fs.mkdir(directory, { recursive: true });
    await saveInputSnapshot(directory, name, buffer);
    return 'inputs/' + name;
}
async function readOutput(user, id, name, maxBytes = 60 * 1024 * 1024) {
    const review = isReviewImage(name);
    if (!review && !progressFiles.has(name) && !['presentation.pptx', 'project.zip', 'manifest.json', 'video.mp4', 'video-first.png', 'review-draft.pptx'].includes(name) && !/^preview-(?:[1-9]|[1-3]\d|40)\.png$/.test(name)) throw error('交付文件类型无效。');
    if (await remote.configured()) return remote.file(user, id, 'outputs', name, maxBytes);
    const root = await workspace(user, id);
    const file = progressFiles.has(name) ? path.join(root, '.pivot', 'progress', name)
        : review ? path.join(root, '.pivot', 'review-preview', name) : name.startsWith('preview-') ? path.join(root, 'native-preview', name.replace('preview-', 'slide-'))
        : path.join(root, name === 'review-draft.pptx' ? '.pivot' : 'delivery', name);
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || !comparable(await fs.realpath(file)).startsWith(comparable(root) + path.sep)) throw error('交付文件不存在或越过当前任务范围。', 'PPT_MASTER_OUTPUT_INVALID', 422);
    if (stat.size > maxBytes) throw error('交付文件超过允许大小。', 'PPT_MASTER_OUTPUT_TOO_LARGE', 413);
    return fs.readFile(file);
}
function isReviewImage(name) { return typeof name === 'string' && /^review-[a-f0-9]{64}-(?:[1-9]|[1-9]\d|100)\.png$/.test(name); }

async function cleanupWorkspace(user, id) {
    if (await remote.configured()) return remote.cleanup(user, id);
    const directory = taskDirectory(user, id);
    const actual = await fs.realpath(directory).catch(() => null);
    if (!actual) return;
    if (comparable(actual) !== comparable(directory)) throw error('制作任务清理目录已重定向，已停止清理。');
    await fs.rm(actual, { recursive: true, force: true });
}

async function identity(checkpoint) { return await remote.configured() ? remote.identity(process.env, checkpoint) : config().image; }
async function inputBuffer(user, id, name, maximum) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,120}$/.test(name)) throw error('输入快照文件名无效。');
    if (await remote.configured()) return remote.file(user, id, 'inputs', name, maximum);
    const root = await workspace(user, id), file = path.join(root, 'inputs', name), stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || comparable(await fs.realpath(file)) !== comparable(file) || stat.size > maximum) throw error('输入快照不存在、已变化或超过大小限制。');
    return fs.readFile(file);
}
module.exports = { lock, error, config, availability, requireReady, workspace, execute, inputFile, readOutput, isReviewImage, cleanupWorkspace, identity, inputBuffer };
