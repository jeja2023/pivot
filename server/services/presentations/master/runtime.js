'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { readTypedEnv } = require('../../../config/env-registry');
const worker = require('../../agent-capability-worker');
const lock = require('../../../../config/ppt-master-engine.json');
const deployment = require('./deployment');
const comparable = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);

function error(message, code = 'PPT_MASTER_INVALID', status = 400) { return Object.assign(new Error(message), { code, status, statusCode: status, expose: true }); }
function config() {
    const image = readTypedEnv('PIVOT_PPT_MASTER_IMAGE');
    return { enabled: readTypedEnv('PIVOT_PPT_MASTER_ENABLED'), image,
        command: ['python', '/runner/runner.py'], limits: { memoryMb: 1024, cpu: 1, timeoutMs: 120000, maxOutputBytes: 1024 * 1024 } };
}
function availability() {
    if (!deployment.accepting()) return { enabled: false, message: 'PPT制作引擎正在更新，请稍后重新提交。' };
    const definition = config();
    if (!definition.enabled || !definition.image) return { enabled: false, message: '完整制作引擎尚未配置。' };
    if (!worker.isWorkerEnabled(process.env)) return { enabled: false, message: '受限制作执行服务尚未启用。' };
    try { worker.verifyWorkerSignature(worker.normalizeDefinition(definition), { env: deployment.workerEnv() }); }
    catch (_) { return { enabled: false, message: '完整制作镜像尚未通过当前部署的签名信任检查。' }; }
    return { enabled: true, message: '完整制作引擎已登记，任务启动时还将核对完整运行包。' };
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
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,120}$/.test(name) || !Buffer.isBuffer(buffer) || buffer.length > 50 * 1024 * 1024) throw error('制作输入文件无效或超过上限。');
    const root = await workspace(user, id), directory = path.join(root, 'inputs');
    await fs.mkdir(directory, { recursive: true });
    const file = path.join(directory, name);
    try { await fs.writeFile(file, buffer, { flag: 'wx', mode: 0o444 }); }
    catch (failure) {
        if (failure.code !== 'EEXIST') throw failure;
        const stat = await fs.lstat(file);
        if (!stat.isFile() || stat.isSymbolicLink() || !Buffer.from(await fs.readFile(file)).equals(buffer)) throw error('输入快照已变化，不能覆盖原任务材料。', 'PPT_MASTER_INPUT_CHANGED', 409);
    }
    return 'inputs/' + name;
}
async function readOutput(user, id, name, maxBytes = 60 * 1024 * 1024) {
    if (!['presentation.pptx', 'project.zip', 'manifest.json', 'video.mp4', 'video-first.png'].includes(name) && !/^preview-(?:[1-9]|[1-3]\d|40)\.png$/.test(name)) throw error('交付文件类型无效。');
    const root = await workspace(user, id), file = name.startsWith('preview-') ? path.join(root, 'native-preview', name.replace('preview-', 'slide-')) : path.join(root, 'delivery', name);
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes || !comparable(await fs.realpath(file)).startsWith(comparable(root) + path.sep)) throw error('交付文件不存在或越过当前任务范围。', 'PPT_MASTER_OUTPUT_INVALID', 422);
    return fs.readFile(file);
}

async function cleanupWorkspace(user, id) {
    const directory = taskDirectory(user, id);
    const actual = await fs.realpath(directory).catch(() => null);
    if (!actual) return;
    if (comparable(actual) !== comparable(directory)) throw error('制作任务清理目录已重定向，已停止清理。');
    await fs.rm(actual, { recursive: true, force: true });
}

module.exports = { lock, error, config, availability, workspace, execute, inputFile, readOutput, cleanupWorkspace };
