'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { performance } = require('node:perf_hooks');
const { readTypedEnv } = require('../../../config/env-registry');
const { BI_POLICY } = require('./policy');
const { biError } = require('./errors');
const executeFile = promisify(execFile);

function resolveRuntimeSettings() {
    const mode = readTypedEnv('DATA_ANALYSIS_MODEL_RUNTIME'), image = readTypedEnv('DATA_ANALYSIS_MODEL_WORKER_IMAGE');
    if (mode === 'development_process' && !process.env.PG_TEST_SCHEMA && process.env.NODE_ENV !== 'development') throw biError('ANALYSIS_MODEL_RUNTIME_UNSAFE', '独立进程开发模式不能用于正式部署，请配置受限容器执行器。', 503);
    if (mode === 'docker' && !/^(?:sha256:[a-f0-9]{64}|[a-zA-Z0-9._/:+-]+@sha256:[a-f0-9]{64})$/.test(image)) throw biError('ANALYSIS_MODEL_RUNTIME_UNREADY', '请配置带摘要的离线分析执行器镜像。', 503);
    // Linux 协调进程与执行器使用同一非 root 身份，保持 0600 对象私有且可读。
    const workerIdentity = process.platform === 'win32' ? { uid: 65532, gid: 65532 } : { uid: process.getuid(), gid: process.getgid() };
    if (mode === 'docker' && (!workerIdentity.uid || !workerIdentity.gid)) throw biError('ANALYSIS_MODEL_RUNTIME_UNSAFE', '容器分析协调服务必须使用非 root 用户和用户组，请调整部署身份后重试。', 503);
    return { mode, image, workerIdentity };
}

async function stopContainer(name) {
    if (!/^pivot-bi-[A-Za-z0-9-]{1,100}$/.test(name)) return;
    try { await executeFile('docker', ['rm', '-f', name], { windowsHide: true, timeout: 5000 }); }
    catch (error) { if (!/No such container|不存在|not found/i.test(String(error.stderr || error.message))) throw error; }
}

async function currentModelExecutors() {
    if (readTypedEnv('DATA_ANALYSIS_MODEL_RUNTIME') !== 'docker') return { mode: 'development_process', running: [] };
    let stdout;
    try { ({ stdout } = await executeFile('docker', ['ps', '--filter', 'name=^/pivot-bi-queryjob', '--format', '{{.Names}}'], { windowsHide: true, timeout: 5000, maxBuffer: 64 * 1024 })); }
    catch (_) { throw biError('ANALYSIS_MODEL_ISOLATION_UNCONFIRMED', '无法核对当前分析执行单元，保持暂停；请检查容器服务后重试。', 503); }
    const running = stdout.split(/\r?\n/).filter(Boolean);
    if (running.some(name => !/^pivot-bi-queryjob[A-Za-z0-9]+-\d+$/.test(name))) throw biError('ANALYSIS_MODEL_ISOLATION_UNCONFIRMED', '分析执行单元标识不符合运行合同，请先人工核对。', 503);
    return { mode: 'docker', running };
}

async function runIsolated({ job, definition, query, sources, inputResult = null, metadata = null, outputRoot, signal }) {
    const runtimeStarted = performance.now();
    const { mode, image, workerIdentity } = resolveRuntimeSettings();
    await fs.mkdir(outputRoot, { recursive: true, mode: 0o700 });
    if (process.platform !== 'win32') await fs.chmod(outputRoot, 0o700);
    let command, args, payloadSources = sources;
    if (mode === 'docker') {
        const mounts = [];
        payloadSources = Object.create(null);
        for (const [index, [nodeId, source]] of Object.entries(sources).entries()) {
            const target = `/inputs/input_${index}.parquet`;
            mounts.push('--mount', `type=bind,src=${source.file},dst=${target},readonly`);
            payloadSources[nodeId] = { ...source, file: target };
        }
        if (inputResult) mounts.push('--mount', `type=bind,src=${inputResult},dst=/inputs/result.ndjson,readonly`);
        command = 'docker'; args = ['run', '--rm', '-i', '--pull=never', '--name', job.container_id, '--network=none', '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--pids-limit=64', '--memory=2g', '--memory-swap=2g', '--cpus=2', `--user=${workerIdentity.uid}:${workerIdentity.gid}`,
            '--tmpfs', '/tmp:rw,noexec,nosuid,size=64m', '--tmpfs', '/spill:rw,noexec,nosuid,size=8g,mode=1777', ...mounts, '--mount', `type=bind,src=${outputRoot},dst=/output`, image];
    } else {
        command = process.execPath; args = ['--max-old-space-size=512', path.resolve(__dirname, '../../../workers/analysis-model-worker.js')];
    }
    const payload = { protocol: 2, compilerVersion: BI_POLICY.compilerVersion, kind: ['probe', 'probe_cancel'].includes(job.execution_kind) ? job.execution_kind : job.execution_kind === 'dataset_ingest' ? 'ingest' : job.execution_kind === 'model_export' ? 'export' : ['model_check', 'model_refresh'].includes(job.execution_kind) ? 'check' : 'query', definition, query, sources: payloadSources,
        inputResult: inputResult && (mode === 'docker' ? '/inputs/result.ndjson' : inputResult), resultFormat: job.result_format, metadata,
        outputRoot: mode === 'docker' ? '/output' : outputRoot, spillRoot: mode === 'docker' ? '/spill' : path.join(outputRoot, 'spill'), evaluationTime: Date.now() };
    const safeEnv = mode === 'docker' ? { PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT, USERPROFILE: process.env.USERPROFILE, DOCKER_CONFIG: process.env.DOCKER_CONFIG } : { PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT, TEMP: process.env.TEMP, TMP: process.env.TMP, LANG: 'C.UTF-8' };
    const child = spawn(command, args, { windowsHide: true, env: safeEnv, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '', stderr = '', terminated = false, termination = null, closed = false, exitStatus = null, responded = false;
    // 取消与 close/finally 共享一次终止确认，避免同时删除同一容器造成“正在删除”的假失联。
    const kill = () => {
        if (!termination) {
            terminated = true;
            termination = (async () => { if (mode === 'docker') await stopContainer(job.container_id); child.kill('SIGKILL'); })();
        }
        return termination;
    };
    const abort = () => { void kill().catch(() => child.kill('SIGKILL')); };
    let outputFailure = null, checkingOutput = null;
    const outputWatcher = job.execution_kind === 'dataset_ingest' ? setInterval(() => {
        if (checkingOutput || terminated) return;
        checkingOutput = fs.stat(path.join(outputRoot, 'dataset.parquet')).then(stat => {
            if (stat.size > 2 * 1024 ** 3) { outputFailure = biError('ANALYSIS_INGESTION_INVALID', '导入产物超过 2 GiB，已停止执行且未登记数据集。', 413); abort(); }
        }).catch(error => { if (error.code !== 'ENOENT') { outputFailure = biError('ANALYSIS_INGESTION_INVALID', '导入产物空间校验失败，已停止执行。', 503); abort(); } }).finally(() => { checkingOutput = null; });
    }, 250) : null;
    outputWatcher?.unref?.();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    try {
        const completed = new Promise((resolve, reject) => {
            child.once('error', reject);
            child.stdout.on('data', chunk => { output += chunk.toString(); if (Buffer.byteLength(output) > 4 * 1024 * 1024) { abort(); reject(biError('ANALYSIS_MODEL_OUTPUT_LIMIT', '执行器预览超过协议大小上限，请减少展示维度。', 413)); } });
            child.stderr.on('data', chunk => { if (stderr.length < 4096) stderr += chunk.toString().slice(0, 4096 - stderr.length); });
            child.once('close', code => { closed = true; exitStatus = code; resolve(code); });
        });
        child.stdin.on('error', () => {}); child.stdin.end(JSON.stringify(payload));
        const exitCode = await completed;
        if (outputFailure) throw outputFailure;
        if (signal?.aborted || terminated) throw biError('ANALYSIS_MODEL_QUERY_CANCELLED', '分析已取消或执行租约失效。', 409);
        let result;
        try { result = JSON.parse(output); } catch (_) {
            const lost = biError('ANALYSIS_MODEL_EXECUTOR_LOST', '分析执行器异常退出，请联系维护者检查资源与镜像。', 503);
            lost.runtimeMetrics = { runtimeMs: Math.ceil(performance.now() - runtimeStarted), executorExitCode: exitCode };
            try {
                const progressFile = path.join(outputRoot, 'execution-progress.json'), stat = await fs.lstat(progressFile);
                if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) throw new Error('执行进度不符合受控边界。');
                const handle = await fs.open(progressFile, 'r'), buffer = Buffer.alloc(4096);
                let progress;
                try { const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0); progress = JSON.parse(buffer.subarray(0, bytesRead).toString('utf8')); }
                finally { await handle.close(); }
                if (/^(merge|schema|count|parquet|profile|verify)$/.test(progress.phase)) lost.runtimeMetrics.lastPhase = progress.phase;
                if (Number.isSafeInteger(progress.column) && progress.column >= 0 && progress.column < 120) lost.runtimeMetrics.lastColumn = progress.column;
                if (Number.isSafeInteger(progress.maxRssBytes) && progress.maxRssBytes >= 0) lost.runtimeMetrics.maxRssBytes = progress.maxRssBytes;
            } catch (_) { /* 强制终止可能未留下完整进度，保持测量缺失。 */ }
            throw lost;
        }
        responded = result.protocol === 2;
        const fields = ['workerMs', 'userCpuMs', 'systemCpuMs', 'maxRssBytes', 'peakSpillBytes', 'cgroupPeakBytes'];
        result.runtimeMetrics = Object.fromEntries(fields.filter(key => Number.isSafeInteger(result.runtimeMetrics?.[key]) && result.runtimeMetrics[key] >= 0).map(key => [key, result.runtimeMetrics[key]]));
        result.runtimeMetrics.runtimeMs = Math.ceil(performance.now() - runtimeStarted);
        if (result.error) { const error = biError(result.error.code, result.error.message, 409); error.runtimeMetrics = result.runtimeMetrics; throw error; }
        if (exitCode !== 0 || result.protocol !== 2 || !/^v1\.5\./.test(result.engine)) throw biError('ANALYSIS_MODEL_EXECUTOR_INCOMPATIBLE', '分析执行器协议或引擎版本不兼容。', 503);
        return result;
    } finally {
        clearInterval(outputWatcher); if (checkingOutput) await checkingOutput;
        signal?.removeEventListener('abort', abort);
        if (mode === 'docker') {
            try {
                if (termination) await termination;
                else if (!closed || !(exitStatus === 0 || responded && exitStatus === 1)) await stopContainer(job.container_id);
            }
            catch (_) { throw biError('ANALYSIS_MODEL_ISOLATION_UNCONFIRMED', '执行器终止状态尚未确认，已保留资源槽位；请检查容器服务后恢复。', 503); }
        }
    }
}

async function cancellationProbe(outputRoot) {
    const controller = new AbortController();
    let settled = false, failure = null;
    const executing = runIsolated({ job: { execution_kind: 'probe_cancel', container_id: `pivot-bi-cancel-${require('node:crypto').randomUUID()}` }, definition: null, query: {}, sources: {}, outputRoot, signal: controller.signal }).catch(error => { failure = error; }).finally(() => { settled = true; });
    const started = Date.now(); let active = false;
    while (!settled && Date.now() - started < 30000) {
        try { await fs.access(path.join(outputRoot, 'cancel-ready')); active = true; break; } catch (_) { /* 等待执行器进入真实计算。 */ }
        await new Promise(resolve => setTimeout(resolve, 20));
    }
    const cancellingAt = Date.now(); controller.abort(); await executing;
    if (failure?.code === 'ANALYSIS_MODEL_ISOLATION_UNCONFIRMED') throw failure;
    if (!active || failure?.code !== 'ANALYSIS_MODEL_QUERY_CANCELLED' || Date.now() - cancellingAt > 5000) throw biError('ANALYSIS_MODEL_ISOLATION_INVALID', '执行器真实计算中断或五秒终止检查未通过，请检查容器终止能力。', 503);
    return { cancelled: true, durationMs: Date.now() - cancellingAt };
}

module.exports = { settings: resolveRuntimeSettings, runIsolated, stopContainer, cancellationProbe, currentModelExecutors };
