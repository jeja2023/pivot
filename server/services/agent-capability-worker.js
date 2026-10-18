/**
 * Capability Package 的 Docker 隔离执行器。
 * 仅接受平台管理员登记的不可变 image@sha256 与固定入口命令；没有已批准镜像时 fail-closed。
 */
const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { verifyExecutionGrant } = require('./agent-execution-grant');
const { canonicalJson } = require('./canonical-json');

const IMAGE_PATTERN = /^[a-z0-9][a-z0-9./:_-]{1,240}@sha256:[a-f0-9]{64}$/;
const ARG_PATTERN = /^[A-Za-z0-9_./:=+@,-]{1,200}$/;
const WORKER_MANIFEST_SIGNATURE_ALGORITHM = 'RSA-SHA256';
const activeCapabilityWorkers = new Set();

function stopCapabilityWorker(worker) {
    if (!worker) return;
    try { worker.child.kill('SIGKILL'); } catch (_) {}
    // docker CLI 被杀并不保证已创建的容器同时退出；使用服务端生成的
    // 固定格式名称精确清理，避免超时与服务关闭时遗留无主能力容器。
    try {
        const cleanup = spawn(worker.command, ['rm', '--force', worker.containerName], {
            stdio: 'ignore', windowsHide: true, env: { PATH: process.env.PATH || '' }
        });
        cleanup.unref?.();
    } catch (_) {}
}

function shutdownCapabilityWorkers() {
    const workers = [...activeCapabilityWorkers];
    activeCapabilityWorkers.clear();
    for (const worker of workers) {
        stopCapabilityWorker(worker);
    }
    return workers.length;
}

function workerError(message, code = 'CAPABILITY_WORKER_INVALID', status = 400) {
    const error = new Error(message); error.code = code; error.status = status; error.statusCode = status; error.expose = true; return error;
}

function signatureRequired(env = process.env) {
    // 开发/测试可显式关闭签名校验以便运行隔离夹具；生产执行面则不得依赖
    // “镜像摘要看起来固定”的人工承诺，必须同时有已签名的发布清单。
    return String(env.PIVOT_CAPABILITY_WORKER_SIGNATURE_REQUIRED || '').trim().toLowerCase() === 'true'
        || String(env.NODE_ENV || '').trim().toLowerCase() === 'production';
}

function readSignedWorkerManifest(env = process.env) {
    const manifestPath = String(env.PIVOT_CAPABILITY_WORKER_TRUSTED_MANIFEST || '').trim();
    if (!manifestPath) throw workerError('已启用 Worker 签名校验，但未配置 PIVOT_CAPABILITY_WORKER_TRUSTED_MANIFEST。', 'CAPABILITY_WORKER_TRUST_MANIFEST_REQUIRED', 503);
    const resolved = path.resolve(manifestPath);
    let parsed;
    try { parsed = JSON.parse(fs.readFileSync(resolved, 'utf8')); } catch (error) {
        throw workerError(`无法读取受信任 Worker 清单：${error.message}`, 'CAPABILITY_WORKER_TRUST_MANIFEST_INVALID', 503);
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !Array.isArray(parsed.images) || !parsed.signature) {
        throw workerError('受信任 Worker 清单缺少 images 或 signature。', 'CAPABILITY_WORKER_TRUST_MANIFEST_INVALID', 503);
    }
    return { manifest: parsed, resolved };
}

function verifyWorkerSignature(definition, options = {}) {
    const env = options.env || process.env;
    if (!signatureRequired(env)) return { verified: false, mode: 'not_required' };
    const publicKey = String(env.PIVOT_CAPABILITY_WORKER_SIGNING_PUBLIC_KEY || '').trim();
    if (!publicKey) throw workerError('已启用 Worker 签名校验，但未配置签名公钥。', 'CAPABILITY_WORKER_SIGNING_KEY_REQUIRED', 503);
    const { manifest, resolved } = readSignedWorkerManifest(env);
    const signed = { ...manifest };
    delete signed.signature;
    delete signed.signatureAlgorithm;
    const algorithm = String(manifest.signatureAlgorithm || WORKER_MANIFEST_SIGNATURE_ALGORITHM).trim().toUpperCase();
    // 清单本身不应有能力把发布链降级到弱摘要或不同签名协议。升级算法必须
    // 随平台版本和验收夹具一起发布，而不是由远端清单静默改变。
    if (algorithm !== WORKER_MANIFEST_SIGNATURE_ALGORITHM) {
        throw workerError(`Worker 清单必须使用 ${WORKER_MANIFEST_SIGNATURE_ALGORITHM} 签名。`, 'CAPABILITY_WORKER_SIGNATURE_ALGORITHM_INVALID', 503);
    }
    let verified = false;
    try {
        const verifier = crypto.createVerify(algorithm);
        verifier.update(canonicalJson(signed));
        verifier.end();
        verified = verifier.verify(publicKey, Buffer.from(String(manifest.signature).trim(), 'base64'));
    } catch (error) {
        throw workerError(`Worker 清单签名无法验证：${error.message}`, 'CAPABILITY_WORKER_SIGNATURE_INVALID', 503);
    }
    if (!verified) throw workerError('Worker 清单签名无效。', 'CAPABILITY_WORKER_SIGNATURE_INVALID', 503);
    const command = definition.command.join(',');
    const image = manifest.images.find(item => item && String(item.image || '').toLowerCase() === definition.image);
    if (!image) throw workerError('当前 Worker 镜像摘要不在已签名信任清单中。', 'CAPABILITY_WORKER_IMAGE_UNTRUSTED', 403);
    const allowedCommands = Array.isArray(image.commands) ? image.commands.map(item => String(item || '').trim()).filter(Boolean) : [];
    if (!allowedCommands.includes(command)) {
        throw workerError('当前 Worker 入口命令不在已签名信任清单中。', 'CAPABILITY_WORKER_COMMAND_UNTRUSTED', 403);
    }
    return { verified: true, mode: 'signed_manifest', manifestPath: resolved, manifestVersion: Number(manifest.version) || 1 };
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
function buildWorkerDockerArguments(spec, { containerName, workspaceMount = null, limits = spec.limits } = {}) {
    const effectiveLimits = { ...spec.limits, ...(limits || {}) };
    const mountSource = workspaceMount?.source ? String(workspaceMount.source) : '';
    const mountTarget = workspaceMount?.target ? String(workspaceMount.target) : '/workspace';
    const args = ['run', '--rm', '-i', '--pull', 'never', '--name', String(containerName || ''), '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--pids-limit', String(Number(effectiveLimits.pids) || 64), '--memory', `${effectiveLimits.memoryMb}m`, '--cpus', String(effectiveLimits.cpu), '--tmpfs', '/tmp:rw,noexec,nosuid,size=64m', '--user', '65532:65532', '--env', 'NVIDIA_VISIBLE_DEVICES=void', '--env', 'CUDA_VISIBLE_DEVICES='];
    if (mountSource) args.push('--mount', `type=bind,src=${mountSource},dst=${mountTarget}${workspaceMount.readOnly === true ? ',readonly' : ''}`, '--workdir', mountTarget);
    return [...args, spec.image, ...spec.command];
}
async function runCapabilityWorker(definition, input, options = {}) {
    if (!isWorkerEnabled(options.env || process.env)) throw workerError('Capability Worker 未启用；请先登记已审计内网镜像并显式开启。', 'CAPABILITY_WORKER_DISABLED', 503);
    const spec = normalizeDefinition(definition);
    const trust = verifyWorkerSignature(spec, options);
    let verifiedGrant = null;
    if (options.requireExecutionGrant === true) {
        if (!options.executionGrant) {
            throw workerError('Capability Worker 缺少控制面签发的短期执行授权。', 'AGENT_EXECUTION_GRANT_REQUIRED', 403);
        }
        try {
            verifiedGrant = verifyExecutionGrant(options.executionGrant, options.executionGrantExpected || {}, { env: options.env || process.env });
        } catch (error) {
            throw workerError(error.message || '执行授权校验失败。', error.code || 'AGENT_EXECUTION_GRANT_INVALID', error.status || 403);
        }
    }
    // 授权只由控制面在启动容器前校验；容器入口不需要、也绝不能接收该令牌。
    // 这样 Worker 输出、崩溃转储和业务日志均无法泄露短期授权内容。
    const payload = JSON.stringify(input ?? {});
    if (Buffer.byteLength(payload) > 1024 * 1024) throw workerError('Capability Worker 输入超过 1MB 上限。', 'CAPABILITY_WORKER_INPUT_TOO_LARGE', 413);
    const command = dockerCommand(options.env || process.env);
    const containerName = `pivot-capability-${crypto.randomUUID().replace(/-/g, '')}`;
    const workspaceMount = options.workspaceMount && typeof options.workspaceMount === 'object' ? options.workspaceMount : null;
    const mountSource = workspaceMount?.source ? String(workspaceMount.source) : '';
    const mountTarget = workspaceMount?.target ? String(workspaceMount.target) : '/workspace';
    if (mountSource && (!require('path').isAbsolute(mountSource) || !/^\/[A-Za-z0-9._/-]{1,240}$/.test(mountTarget) || mountTarget.includes('..'))) {
        throw workerError('Capability Worker 工作区挂载配置无效。', 'CAPABILITY_WORKER_MOUNT_INVALID');
    }
    const grantResources = verifiedGrant?.payload?.resources || null;
    const effectiveLimits = {
        ...spec.limits,
        timeoutMs: grantResources ? Math.min(spec.limits.timeoutMs, Number(grantResources.timeoutMs) || spec.limits.timeoutMs) : spec.limits.timeoutMs,
        memoryMb: grantResources ? Math.min(spec.limits.memoryMb, Math.max(16, Math.floor((Number(grantResources.memoryBytes) || 0) / (1024 * 1024)))) : spec.limits.memoryMb,
        pids: grantResources ? Math.min(64, Math.max(1, Number.parseInt(grantResources.pids, 10) || 64)) : 64
    };
    // Docker 默认不会将父进程 stdin 转发给容器；Worker 协议完全依赖 JSON stdin，
    // 因此必须显式开启 -i，且不启用 tty。此构建器也由 staging 隔离演练复用，
    // 防止演练的隔离标志与真实生产执行路径发生漂移。
    // 即使 image@sha256 被签名清单锁定，Docker 默认 pull=missing 仍会访问 registry；
    // 生产执行面只接受部署流水线验证并预置在受控节点的镜像，缺失即 fail-closed。
    const args = buildWorkerDockerArguments(spec, { containerName, workspaceMount, limits: effectiveLimits });
    const spawnProcess = options.spawn || spawn;
    return await new Promise((resolve, reject) => {
        const child = spawnProcess(command, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: { PATH: process.env.PATH || '' } });
        const worker = { child, command, containerName };
        activeCapabilityWorkers.add(worker);
        let output = '', error = '', settled = false, abortHandler = null;
        const finish = (fn, value) => {
            if (!settled) {
                settled = true;
                activeCapabilityWorkers.delete(worker);
                clearTimeout(timer);
                if (abortHandler && options.signal) options.signal.removeEventListener?.('abort', abortHandler);
                fn(value);
            }
        };
        const timer = setTimeout(() => {
            stopCapabilityWorker(worker);
            finish(reject, workerError('Capability Worker 执行超时。', 'CAPABILITY_WORKER_TIMEOUT', 504));
        }, effectiveLimits.timeoutMs);
        if (options.signal) {
            abortHandler = () => {
                stopCapabilityWorker(worker);
                const reason = options.signal.reason instanceof Error ? options.signal.reason : workerError('Capability Worker 已取消。', 'CAPABILITY_WORKER_CANCELLED', 499);
                if (!reason.code) reason.code = 'CAPABILITY_WORKER_CANCELLED';
                finish(reject, reason);
            };
            if (options.signal.aborted) return abortHandler();
            options.signal.addEventListener?.('abort', abortHandler, { once: true });
        }
        child.stdout.on('data', chunk => {
            output += chunk;
            if (Buffer.byteLength(output) > spec.limits.maxOutputBytes) {
                stopCapabilityWorker(worker);
                finish(reject, workerError('Capability Worker 输出超过上限。', 'CAPABILITY_WORKER_OUTPUT_TOO_LARGE', 413));
            }
        });
        child.stderr.on('data', chunk => { error = `${error}${chunk}`.slice(0, 4000); });
        child.on('error', err => finish(reject, workerError(`Capability Worker 启动失败：${err.message}`, 'CAPABILITY_WORKER_START_FAILED', 503)));
        child.on('close', code => {
            if (settled) return;
            if (code !== 0) return finish(reject, workerError(`Capability Worker 执行失败：${error || `退出码 ${code}`}`, 'CAPABILITY_WORKER_FAILED', 502));
            try { finish(resolve, { ...JSON.parse(output), workerTrust: trust }); } catch (_) { finish(reject, workerError('Capability Worker 必须输出一个 JSON 对象。', 'CAPABILITY_WORKER_OUTPUT_INVALID', 502)); }
        });
        child.stdin.end(payload);
    });
}

module.exports = {
    IMAGE_PATTERN,
    buildWorkerDockerArguments,
    isWorkerEnabled,
    normalizeDefinition,

    runCapabilityWorker,
    shutdownCapabilityWorkers,
    signatureRequired,
    verifyWorkerSignature
};
