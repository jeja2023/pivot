'use strict';

const controls = require('../../../repositories/analysis-release-controls');
const { biError } = require('./errors');

function releaseInput(body) {
    const actions = ['stop_admission', 'pause', 'drain', 'close_writes', 'resume', 'prepare_rollback'];
    if (!actions.includes(body.action) || !Number.isSafeInteger(body.expectedRevision) || body.expectedRevision < 1 || typeof body.reason !== 'string' || !body.reason.trim() || body.reason.length > 500 ||
        body.waitSeconds !== undefined && (!Number.isSafeInteger(body.waitSeconds) || body.waitSeconds < 0 || body.waitSeconds > 30) ||
        body.cancel !== undefined && typeof body.cancel !== 'boolean' || body.reopenWrites !== undefined && typeof body.reopenWrites !== 'boolean') {
        throw biError('ANALYSIS_RELEASE_CONTROL_INVALID', '请选择维护操作、当前修订号并填写五百字以内的原因；单次等待最多三十秒。');
    }
    return { ...body, reason: body.reason.trim(), waitSeconds: body.waitSeconds || 0 };
}

async function releaseOverview(user) {
    await require('./operations').requireOperator(user);
    const [state, workload] = await Promise.all([controls.state(), controls.workload()]);
    const executors = workload.idle ? await releaseExecutors() : null;
    return { controls: state, workload, executors, readyForBinaryChange: !state.createEnabled && !state.publishEnabled && !state.admissionEnabled && !state.dispatchEnabled && workload.idle && executors.idle };
}

async function releaseExecutors() {
    const local = require('./runner').activeModelExecutions();
    try {
        const current = await require('./runtime').currentModelExecutors();
        return { ...current, available: true, local, idle: current.running.length === 0 && local.length === 0 };
    } catch (_) { return { available: false, local, idle: false, errorCode: 'ANALYSIS_MODEL_ISOLATION_UNCONFIRMED' }; }
}

async function cancelReleaseWorkload() {
    for (const job of (await controls.workload()).jobs) {
        if (job.execution_kind.startsWith('model_') || job.execution_kind === 'dataset_ingest') {
            await require('../../../repositories/analysis-model-jobs').cancel(Number(job.user_id), job.id, { cause: 'system' });
            await require('./runner').cancelActiveModelJob(job.id);
        } else if (job.execution_kind === 'dataset_sql') await require('../../../repositories/analysis-query-jobs').cancel(Number(job.user_id), job.id, { cause: 'system' });
        else if (job.execution_kind === 'legacy_operation') await require('../../../repositories/analysis-runtime-budget').cancelLegacyForRelease(Number(job.user_id), job.id);
    }
    // 容器回收确认删除后才释放槽位；独立本机控制器须等待原所有者终止实际子进程。
    if (require('../../../config/env-registry').readTypedEnv('DATA_ANALYSIS_MODEL_RUNTIME') === 'docker') await require('./runner').recoverExpired();
}

async function waitReleaseIdle(seconds) {
    const deadline = Date.now() + seconds * 1000;
    let workload = await controls.workload();
    while (!workload.idle && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, Math.min(250, deadline - Date.now())));
        workload = await controls.workload();
    }
    return workload;
}

async function performReleaseAction(user, body = {}) {
    const actor = await require('./operations').requireOperator(user), input = releaseInput(body), before = await controls.state();
    if (before.revision !== input.expectedRevision) throw biError('ANALYSIS_RELEASE_CONTROL_CONFLICT', '发布控制已变化，请重新核对当前状态后重试。', 409);
    if (input.action === 'resume') {
        if (before.admissionEnabled || before.dispatchEnabled || !(await controls.workload()).idle) throw biError('ANALYSIS_RELEASE_WORKLOAD_BUSY', '请先暂停准入并排空或取消任务，确认执行单元停止后再恢复。', 409);
        const readiness = await require('./readiness').ensureReady({ force: true });
        if (!(await releaseExecutors()).idle) throw biError('ANALYSIS_RELEASE_WORKLOAD_BUSY', '仍有分析执行单元未停止，保持暂停；请先完成回收再恢复。', 409);
        const flags = { admissionEnabled: true, dispatchEnabled: true, ...(input.reopenWrites ? { createEnabled: true, publishEnabled: true } : {}) };
        const state = await controls.change({ userId: actor.id, reason: input.reason, expectedRevision: before.revision, flags, action: 'resumed', requireIdle: true });
        return { controls: state, workload: await controls.workload(), resumed: true, readiness };
    }
    const flags = input.action === 'close_writes' ? { createEnabled: false, publishEnabled: false }
        : input.action === 'pause' ? { admissionEnabled: false, dispatchEnabled: false }
        : { admissionEnabled: false, dispatchEnabled: input.cancel ? false : true,
            ...(input.action === 'prepare_rollback' ? { createEnabled: false, publishEnabled: false } : {}) };
    let state = await controls.change({ userId: actor.id, reason: input.reason, expectedRevision: before.revision, flags, action: input.action });
    let cancellationPending = false;
    if (input.cancel) {
        try { await cancelReleaseWorkload(); }
        catch (_) { cancellationPending = true; }
    }
    const workload = await waitReleaseIdle(input.waitSeconds);
    const executors = workload.idle ? await releaseExecutors() : null;
    if (workload.idle && executors.idle && ['drain', 'prepare_rollback'].includes(input.action) && state.dispatchEnabled) {
        state = await controls.change({ userId: actor.id, reason: input.reason, expectedRevision: state.revision, flags: { dispatchEnabled: false }, action: 'drained', requireIdle: true });
    }
    return { controls: state, workload, executors, applied: true, cancellationPending, drained: workload.idle && executors.idle,
        readyForBinaryChange: workload.idle && executors.idle && !state.createEnabled && !state.publishEnabled && !state.admissionEnabled && !state.dispatchEnabled };
}

module.exports = { overview: releaseOverview, act: performReleaseAction };
