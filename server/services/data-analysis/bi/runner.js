'use strict';

const crypto = require('node:crypto');
const { clearImmediate } = require('node:timers');
const fs = require('node:fs/promises');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { readTypedEnv } = require('../../../config/env-registry');
const jobs = require('../../../repositories/analysis-model-jobs');
const modelRepository = require('../../../repositories/analysis-production-models');
const objectRepository = require('../../../repositories/analysis-objects');
const { captureManifest, resolveManifest } = require('./manifests');
const { authorize: createResultAuthorization } = require('./jobs');
const { normalizeModelDefinition } = require('./definition');
const objects = require('./objects');
const runtime = require('./runtime');
const { resolveAnalysisUser, tempRoot, resolveInside } = require('../shared');
const { biError } = require('./errors');

const owner = `analysis_${process.pid}_${crypto.randomUUID()}`;
const controllers = new Map();
const dispatched = new Set();
let scheduling = null;
const executions = new Map();
let draining = 0, wake = null;
let stopping = false;
let lastMaintenanceAt = 0;

async function executeJob(job) {
    const preparationStarted = performance.now();
    const controller = new AbortController(); controllers.set(job.id, controller);
    if (stopping) controller.abort();
    const outputRoot = resolveInside(tempRoot, 'model-jobs', `${job.id}-${job.execution_epoch}`);
    let retained = null, heartbeat = null, lastRenewal = Date.now(), mayRelease = true;
    const renew = async () => {
        try { if (!await jobs.renew(job)) controller.abort(); else lastRenewal = Date.now(); }
        catch (_) { if (Date.now() - lastRenewal > 25000) controller.abort(); }
    };
    const timer = setInterval(() => { if (Date.now() - lastRenewal > 25000) controller.abort(); if (!heartbeat) heartbeat = renew().finally(() => { heartbeat = null; }); }, 2000);
    timer.unref?.();
    const deadline = setTimeout(() => controller.abort(), ['model_check', 'model_refresh', 'model_export', 'dataset_ingest', 'model_node_dataset'].includes(job.execution_kind) ? 300000 : 180000);
    deadline.unref?.();
    try {
        const user = await resolveAnalysisUser(job.user_id);
        if (!user || user.deleted_at || user.status !== 'active') throw biError('ANALYSIS_MODEL_NOT_FOUND', '任务所属账号已失效，请检查账号状态。', 404);
        if (job.execution_kind === 'dataset_ingest') { await require('./ingestions').executeIngestion(job, { outputRoot, signal: controller.signal }); return; }
        if (require('./flow-pipeline').isNodeJob(job)) { await require('./flow-pipeline').executeNodeJob(job, { outputRoot, signal: controller.signal }); return; }
        let definition;
        if (job.check_id) {
            const checked = await jobs.check(user.id, job.model_id, job.check_id);
            if (job.execution_kind === 'model_check' && require('./canonical').canonicalHash(checked.comparison_json) !== require('./canonical').canonicalHash(job.query_ast_json)) throw biError('ANALYSIS_MODEL_REQUEST_CONFLICT', '检查请求与固定对照合同不一致，请重新检查。', 409);
            definition = normalizeModelDefinition(checked.definition_json).definition;
        } else definition = normalizeModelDefinition((await modelRepository.version(job.model_id, job.published_version)).definition_json).definition;
        if (!job.manifest_id) {
            const manifest = await captureManifest({ user, modelId: job.model_id, definition, signal: controller.signal, comparison: job.query_ast_json?.migrationComparison });
            if (!await jobs.attachManifest(job, manifest.id)) throw biError('ANALYSIS_MODEL_LEASE_LOST', '分析执行租约已失效。', 409);
            job.manifest_id = manifest.id;
        }
        const isCheck = ['model_check', 'model_refresh'].includes(job.execution_kind);
        retained = await resolveManifest({ user, modelId: job.model_id, definition, manifestId: job.manifest_id, query: isCheck ? null : job.query_ast_json, allFields: isCheck, comparison: job.query_ast_json?.migrationComparison, leaseId: `${job.id}:${job.execution_epoch}`, seconds: 600 });
        if (controller.signal.aborted) throw biError('ANALYSIS_MODEL_LEASE_LOST', '分析已取消或租约失效。', 409);
        const cacheContext = { semanticHash: require('./canonical').canonicalHash(definition), timezone: definition.timezone, manifestHash: retained.manifest.manifest_hash };
        if (['model_query', 'model_trial'].includes(job.execution_kind)) require('./query').compileModelQuery(definition, job.query_ast_json, retained.sources);
        const authorizeResult = createResultAuthorization(user, job.model_id, definition, { all: isCheck, query: isCheck ? null : job.query_ast_json, comparison: job.query_ast_json?.migrationComparison });
        if (await require('./result-cache').reuseModelResult({ job, context: cacheContext, authorize: authorizeResult, signal: controller.signal, inputResolutionMs: Math.ceil(performance.now() - preparationStarted) })) return;
        let inputResult = null, exportMetadata = null;
        if (job.execution_kind === 'model_export') {
            const source = await jobs.get(user.id, job.source_run_id);
            if (!source?.result_object_id || source.status !== 'succeeded' || source.execution_kind !== 'model_query' || source.manifest_id !== job.manifest_id || Number(source.published_version) !== Number(job.published_version)) throw biError('ANALYSIS_MODEL_RESULT_UNAVAILABLE', '原分析结果已不可用，请重新计算。', 409);
            inputResult = await objects.verify(await objectRepository.get(source.result_object_id));
            exportMetadata = { sourceRunId: source.id, publishedVersion: Number(job.published_version), manifestId: job.manifest_id, queryHash: source.result_metadata_json.queryHash, timezone: definition.timezone,
                computedAt: source.result_metadata_json.cache?.computedAt || source.completed_at, reusedResult: source.result_metadata_json.cache?.hit === true,
                coverage: retained.snapshot.coverage, dataTimes: retained.snapshot.members.map(member => ({ nodeId: member.nodeId, ...member.watermark })) };
        }
        const inputResolutionMs = Math.ceil(performance.now() - preparationStarted);
        const result = await runtime.runIsolated({ job, definition, query: job.query_ast_json, sources: job.execution_kind === 'model_export' ? {} : retained.sources, inputResult, metadata: exportMetadata, outputRoot, signal: controller.signal });
        const registrationStarted = performance.now();
        await renew();
        if (controller.signal.aborted) throw biError('ANALYSIS_MODEL_LEASE_LOST', '分析已取消或租约失效。', 409);
        let resultObject = null, resultPageObject = null;
        if (!isCheck) resultObject = await objects.importFile({ file: path.join(outputRoot, `result.${job.result_format || 'ndjson'}`), userId: job.user_id, purpose: job.execution_kind === 'model_export' ? 'export' : 'result', leaseId: `${job.id}:result`, signal: controller.signal });
        if (!isCheck && job.execution_kind !== 'model_export') resultPageObject = await objects.importFile({ file: path.join(outputRoot, 'pages.ndjson'), userId: job.user_id, purpose: 'result', leaseId: `${job.id}:result`, signal: controller.signal });
        if (result.result) Object.assign(result.result, { runId: job.id, modelId: job.model_id, publishedVersion: job.published_version === null ? null : Number(job.published_version), manifestId: job.manifest_id,
            semanticHash: require('./canonical').canonicalHash(definition), coverage: retained.snapshot.coverage, dataTimes: retained.snapshot.members.map(member => ({ nodeId: member.nodeId, ...member.watermark })), trial: job.execution_kind === 'model_trial',
            rules: require('./policy').BI_POLICY, engine: result.engine });
        if (result.result?.columns) result.result.columnLabels = { dimensions: Object.fromEntries(result.result.columns.dimensions.map(id => [id, definition.dimensions.find(item => item.id === id)?.name || id])),
            metrics: Object.fromEntries(result.result.columns.metrics.map(id => [id, definition.metrics.find(item => item.id === id)?.name || id])) };
        const committed = await jobs.complete(job, { report: result.report, result: result.result, resultObject, resultPageObject, cacheContext, runtimeMetrics: { ...result.runtimeMetrics, cacheHit: false, inputResolutionMs, resultRegistrationMs: Math.ceil(performance.now() - registrationStarted) }, authorize: authorizeResult });
        if (!committed) throw biError('ANALYSIS_MODEL_LEASE_LOST', '分析完成时租约已失效，结果未登记。', 409);
        if (resultObject) await objectRepository.release('lease', `${job.id}:result`);
    } catch (error) {
        if (error.code === 'ANALYSIS_MODEL_ISOLATION_UNCONFIRMED') { mayRelease = false; return; }
        const safeCode = /^ANALYSIS_[A-Z_]+$/.test(error.code || '') ? error.code : 'ANALYSIS_MODEL_EXECUTION_FAILED';
        const safeMessage = safeCode === 'ANALYSIS_MODEL_EXECUTION_FAILED' ? '分析执行失败，请检查模型口径或联系维护者。' : error.message;
        await jobs.fail(job, { code: safeCode, message: safeMessage, errorStatus: Number(error.status) || 500, runtimeMetrics: error.runtimeMetrics, retryable: ['ANALYSIS_MODEL_EXECUTOR_LOST'].includes(safeCode) });
    } finally {
        clearInterval(timer); clearTimeout(deadline); if (heartbeat) await heartbeat;
        controllers.delete(job.id);
        if (retained) await objectRepository.release('lease', retained.leaseId);
        if (mayRelease) await jobs.releaseSlot(job);
        const target = path.resolve(outputRoot), parent = path.resolve(tempRoot, 'model-jobs');
        if (mayRelease && path.dirname(target) === parent && /^query_job_[a-zA-Z0-9-]+-\d+$/.test(path.basename(target))) await fs.rm(target, { recursive: true, force: true });
        if (mayRelease && !stopping && !draining && !wake) wake = setImmediate(() => {
            wake = null;
            if (!draining && !stopping) void dispatchModelJobs();
        });
    }
}

async function recoverExpired() {
    for (const job of await jobs.expired()) {
        const local = controllers.get(job.id);
        if (local) { local.abort(); continue; }
        const { mode } = runtime.settings();
        if (mode === 'docker') await runtime.stopContainer(job.container_id);
        // 开发进程只在当前控制进程内运行；正式容器必须先确认终止再释放资源和重试。
        await jobs.fail(job, { code: job.cancel_requested_at ? 'ANALYSIS_MODEL_QUERY_CANCELLED' : 'ANALYSIS_MODEL_LEASE_EXPIRED', message: job.cancel_requested_at ? '分析已取消。' : '执行器租约过期，已终止旧执行单元。', retryable: !job.cancel_requested_at });
    }
}

async function scheduleModelJobs() {
    if (scheduling) return scheduling;
    if (stopping || !readTypedEnv('DATA_ANALYSIS_MODEL_ENABLED')) return { processed: 0 };
    scheduling = (async () => {
        const now = Date.now();
        if (now - lastMaintenanceAt >= 1000) {
            await recoverExpired();
            await require('./readiness').ensureReady();
            await require('../../../repositories/analysis-operations').workerHeartbeat();
            await require('../../../repositories/analysis-ingestions').expireAbandoned();
            lastMaintenanceAt = Date.now();
        }
        let processed = 0;
        for (let index = 0; !stopping && index < readTypedEnv('DATA_ANALYSIS_MODEL_RUNNING_LIMIT'); index++) {
            const job = await jobs.claim({ owner, slots: readTypedEnv('DATA_ANALYSIS_MODEL_RUNNING_LIMIT') });
            if (!job) break;
            const task = executeJob(job).finally(() => executions.delete(job.id));
            executions.set(job.id, task);
            void task.catch(error => require('../../../logger').logger.warn({ err: error.message }, '数据建模持久任务执行失败'));
            processed++;
        }
        return { processed };
    })();
    try { return await scheduling; }
    finally { scheduling = null; }
}

// 显式处理入口等待队列和本进程已认领任务收敛；后台轮询只接纳，不等待长任务。
async function processModelJobs() {
    let processed = 0;
    draining++;
    if (wake) { clearImmediate(wake); wake = null; }
    try {
        while (!stopping) {
            processed += (await scheduleModelJobs()).processed;
            const active = [...executions.values()];
            if (!active.length) break;
            await Promise.all(active);
        }
        return { processed };
    } finally { draining--; }
}

async function cancelActiveModelJob(id) { controllers.get(id)?.abort(); }
function dispatchModelJobs() {
    const task = scheduleModelJobs().catch(error => {
        require('../../../logger').logger.warn({ err: error.message }, '数据建模持久任务调度失败');
        return { processed: 0 };
    }).finally(() => dispatched.delete(task));
    dispatched.add(task);
    return task;
}
async function stopModelJobs() {
    stopping = true;
    if (wake) { clearImmediate(wake); wake = null; }
    for (const controller of controllers.values()) controller.abort();
    await Promise.allSettled([...dispatched, ...(scheduling ? [scheduling] : [])]);
    await Promise.allSettled([...executions.values()]);
}
function activeModelExecutions() { return [...controllers.keys()]; }

module.exports = { processModelJobs, dispatchModelJobs, cancelActiveModelJob, stopModelJobs, executeJob, recoverExpired, activeModelExecutions };
