'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { readTypedEnv } = require('../../../config/env-registry');
const { analysisRoot, tempRoot, ensureAnalysisDirs } = require('../shared');
const { createContentStore } = require('../../content-addressed-files');
const repository = require('../../../repositories/analysis-model-readiness');
const runtime = require('./runtime');
const { BI_POLICY } = require('./policy');
const { biError } = require('./errors');

let cached = null, pending = null;
let pendingKey = '', pendingFull = false;

async function storageState({ batch = false, write = true, reserveBytes = 0 } = {}) {
    await ensureAnalysisDirs();
    const stat = await fs.statfs(analysisRoot, { bigint: true });
    const total = stat.blocks * stat.bsize, free = stat.bavail * stat.bsize;
    const usedPercent = total ? Number((total - free) * 10000n / total) / 100 : 100;
    const minimum = 2n * (8n * 1024n ** 3n + 200n * 1024n ** 2n);
    const reserved = BigInt(reserveBytes) > minimum ? BigInt(reserveBytes) : minimum;
    if (write && (usedPercent >= 95 || free < reserved) || batch && usedPercent >= 85) throw biError('ANALYSIS_MODEL_STORAGE_PRESSURE', '分析存储空间不足，已停止新写入；请联系维护者扩容或按引用保留策略清理。', 503);
    return { usedPercent, freeBytes: free.toString(), totalBytes: total.toString(), reserveBytes: reserved.toString(), warning: usedPercent >= 70 };
}

async function probeAnalysisReadiness() {
    const settings = runtime.settings();
    const schema = await repository.schemaContract();
    const storage = await storageState();
    const root = path.join(tempRoot, 'model-readiness', crypto.randomUUID());
    await fs.mkdir(root, { recursive: true, mode: 0o700 });
    const store = createContentStore({ rootResolver: () => root, durable: true });
    const bytes = crypto.randomBytes(64), key = 'promoted/input';
    let controller, timer;
    try {
        const temp = await store.writeBufferToTemp(bytes); await store.promoteTempToStorage(temp, key);
        if (!(await fs.readFile(store.resolveStoragePath(key))).equals(bytes)) throw biError('ANALYSIS_MODEL_STORAGE_UNREADY', '受控存储原子提升与校验失败，请检查文件系统。', 503);
        const file = store.resolveStoragePath(key);
        controller = new AbortController(); timer = setTimeout(() => controller.abort(), 45000);
        const response = await runtime.runIsolated({ job: { execution_kind: 'probe', container_id: `pivot-bi-probe-${crypto.randomUUID()}` }, definition: null, query: {}, sources: {}, inputResult: file, outputRoot: path.join(root, 'output'), signal: controller.signal });
        clearTimeout(timer);
        const limits = response.probe;
        if (!limits?.inputReadable || limits.inputSha256 !== crypto.createHash('sha256').update(bytes).digest('hex')) throw biError('ANALYSIS_MODEL_STORAGE_UNREADY', '执行器无法读取同一私有分析对象，请核对协调服务与容器宿主机的共享绝对路径和用户身份。', 503);
        if (!['check', 'query', 'export', 'ingest', 'cancel', 'migration_compare', 'column_projection', 'runtime_metrics'].every(kind => limits?.capabilities?.includes(kind))) throw biError('ANALYSIS_MODEL_RUNTIME_UNREADY', '分析执行器未具备本版本所需能力，请先升级执行器再启用新任务。', 503);
        if (!limits?.outputWritable || !limits.extensionsDisabled || !limits.noCredentials || !limits.nonPrivileged && settings.mode === 'docker') throw biError('ANALYSIS_MODEL_RUNTIME_UNREADY', '分析执行器输出、扩展、凭据或身份检查未通过，请检查隔离配置。', 503);
        if (settings.mode === 'docker') {
            const cpu = String(limits.cpu).split(' ').map(Number);
            if (BigInt(limits.memory || 0) !== 2n * 1024n ** 3n || limits.pids !== '64' || cpu[0] / cpu[1] !== 2 || !limits.networkIsolated || !limits.inputReadOnly || !limits.rootReadOnly || !limits.noCoordinatorSocket || !limits.capabilitiesDropped || !limits.noNewPrivileges || limits.uid !== settings.workerIdentity.uid || limits.gid !== settings.workerIdentity.gid || BigInt(limits.spillBytes || 0) > 8n * 1024n ** 3n) throw biError('ANALYSIS_MODEL_ISOLATION_INVALID', '分析执行器硬资源、只读挂载、身份或网络隔离检查未通过，请检查容器配置。', 503);
        }
        const cancellation = await runtime.cancellationProbe(path.join(root, 'cancel'));
        const checkedAt = new Date().toISOString();
        return { ready: true, mode: settings.mode, productionIsolation: settings.mode === 'docker', engine: response.engine, compilerVersion: BI_POLICY.compilerVersion, schema, storage, cancellation, checkedAt, isolationCheckedAt: checkedAt, key: JSON.stringify(settings) };
    } finally {
        clearTimeout(timer);
        const target = path.resolve(root), parent = path.resolve(tempRoot, 'model-readiness');
        if (path.dirname(target) === parent) await fs.rm(target, { recursive: true, force: true });
    }
}

async function ensureReady({ force = false, batch = false } = {}) {
    if (!readTypedEnv('DATA_ANALYSIS_MODEL_ENABLED')) throw biError('ANALYSIS_MODEL_RUNTIME_UNREADY', '数据建模执行服务尚未启用，请联系维护者配置隔离执行器。草稿仍可保存。', 503);
    const security = await require('./security-journal').flush({ force });
    if (security.mode !== 'ready') throw biError('ANALYSIS_SECURITY_RECOVERY_REQUIRED', '当前安全高水位与恢复授权尚未核对，执行服务保持关闭。', 503);
    const key = JSON.stringify(runtime.settings());
    await storageState({ batch });
    if (pending && (pendingKey !== key || force && !pendingFull)) { await pending; return ensureReady({ force, batch }); }
    if (force || !cached || cached.key !== key) {
        if (!pending) { pendingKey = key; pendingFull = true; pending = probeAnalysisReadiness().then(result => { cached = result; return result; }).catch(error => { cached = null; throw error; }).finally(() => { pending = null; pendingKey = ''; pendingFull = false; }); }
        await pending;
    } else if (Date.now() - Date.parse(cached.checkedAt) > 60000) {
        // 不可变镜像及启动参数保持原预检结论，周期复核数据库保护；主动终止试验仅在启动、变更或强制检查时执行。
        if (!pending) { pendingKey = key; pendingFull = false; pending = repository.schemaContract().then(schema => { cached = { ...cached, schema, checkedAt: new Date().toISOString() }; return cached; }).catch(error => { cached = null; throw error; }).finally(() => { pending = null; pendingKey = ''; }); }
        await pending;
    }
    return { ...cached, security: { mode: security.mode, position: security.position, hash: security.hash, durability: security.durability }, productionPlatformSupported: process.platform === 'linux' && cached.mode === 'docker' && security.durability === 'file-and-directory-fsync' };
}

module.exports = { ensureReady, storageState };
