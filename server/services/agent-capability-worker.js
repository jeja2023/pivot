/**
 * Capability Package 的 Docker 隔离执行器。
 * 仅接受平台管理员登记的不可变 image@sha256 与固定入口命令；没有已批准镜像时 fail-closed。
 */
const { spawn } = require('child_process');

const IMAGE_PATTERN = /^[a-z0-9][a-z0-9./:_-]{1,240}@sha256:[a-f0-9]{64}$/;
const ARG_PATTERN = /^[A-Za-z0-9_./:=+@,-]{1,200}$/;

function workerError(message, code = 'CAPABILITY_WORKER_INVALID', status = 400) {
    const error = new Error(message); error.code = code; error.status = status; error.statusCode = status; error.expose = true; return error;
}
function normalizeDefinition(value = {}) {
    const image = String(value.image || '').trim().toLowerCase();
    if (!IMAGE_PATTERN.test(image)) throw workerError('Capability Worker 镜像必须是锁定摘要的 image@sha256:...，不接受 tag 或 latest。', 'CAPABILITY_WORKER_IMAGE_UNPINNED');
    const command = Array.isArray(value.command) ? value.command.map(item => String(item).trim()).filter(Boolean) : [];
    if (!command.length || command.some(item => !ARG_PATTERN.test(item))) throw workerError('Capability Worker 入口命令必须由平台登记的安全参数组成。', 'CAPABILITY_WORKER_COMMAND_INVALID');
    const limits = value.limits && typeof value.limits === 'object' ? value.limits : {};
    const cpu = Math.min(Math.max(Number(limits.cpu) || 1, 0.1), 2);
    const memoryMb = Math.min(Math.max(Number.parseInt(limits.memoryMb, 10) || 512, 128), 2048);
    const timeoutMs = Math.min(Math.max(Number.parseInt(limits.timeoutMs, 10) || 30000, 1000), 120000);
    const maxOutputBytes = Math.min(Math.max(Number.parseInt(limits.maxOutputBytes, 10) || 1024 * 1024, 1024), 4 * 1024 * 1024);
    return { image, command, limits: { cpu, memoryMb, timeoutMs, maxOutputBytes } };
}
function dockerCommand(env = process.env) { return String(env.PIVOT_CAPABILITY_WORKER_DOCKER || 'docker').trim() || 'docker'; }
function isWorkerEnabled(env = process.env) { return String(env.PIVOT_CAPABILITY_WORKER_ENABLED || '').toLowerCase() === 'true'; }
async function runCapabilityWorker(definition, input, options = {}) {
    if (!isWorkerEnabled(options.env || process.env)) throw workerError('Capability Worker 未启用；请先登记已审计内网镜像并显式开启。', 'CAPABILITY_WORKER_DISABLED', 503);
    const spec = normalizeDefinition(definition);
    const payload = JSON.stringify(input ?? {});
    if (Buffer.byteLength(payload) > 1024 * 1024) throw workerError('Capability Worker 输入超过 1MB 上限。', 'CAPABILITY_WORKER_INPUT_TOO_LARGE', 413);
    const args = ['run', '--rm', '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--pids-limit', '64', '--memory', `${spec.limits.memoryMb}m`, '--cpus', String(spec.limits.cpu), '--tmpfs', '/tmp:rw,noexec,nosuid,size=64m', '--user', '65532:65532', '--env', 'NVIDIA_VISIBLE_DEVICES=void', '--env', 'CUDA_VISIBLE_DEVICES=', spec.image, ...spec.command];
    return await new Promise((resolve, reject) => {
        const child = spawn(dockerCommand(options.env || process.env), args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: { PATH: process.env.PATH || '' } });
        let output = '', error = '', settled = false;
        const finish = (fn, value) => { if (!settled) { settled = true; clearTimeout(timer); fn(value); } };
        const timer = setTimeout(() => { child.kill('SIGKILL'); finish(reject, workerError('Capability Worker 执行超时。', 'CAPABILITY_WORKER_TIMEOUT', 504)); }, spec.limits.timeoutMs);
        child.stdout.on('data', chunk => { output += chunk; if (Buffer.byteLength(output) > spec.limits.maxOutputBytes) { child.kill('SIGKILL'); finish(reject, workerError('Capability Worker 输出超过上限。', 'CAPABILITY_WORKER_OUTPUT_TOO_LARGE', 413)); } });
        child.stderr.on('data', chunk => { error = `${error}${chunk}`.slice(0, 4000); });
        child.on('error', err => finish(reject, workerError(`Capability Worker 启动失败：${err.message}`, 'CAPABILITY_WORKER_START_FAILED', 503)));
        child.on('close', code => {
            if (settled) return;
            if (code !== 0) return finish(reject, workerError(`Capability Worker 执行失败：${error || `退出码 ${code}`}`, 'CAPABILITY_WORKER_FAILED', 502));
            try { finish(resolve, JSON.parse(output)); } catch (_) { finish(reject, workerError('Capability Worker 必须输出一个 JSON 对象。', 'CAPABILITY_WORKER_OUTPUT_INVALID', 502)); }
        });
        child.stdin.end(payload);
    });
}

module.exports = { IMAGE_PATTERN, isWorkerEnabled, normalizeDefinition, runCapabilityWorker };
