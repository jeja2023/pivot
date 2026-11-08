'use strict';

const crypto = require('node:crypto');
const os = require('node:os');
const { AsyncLocalStorage } = require('node:async_hooks');
const { transaction } = require('../../db/client');
const repository = require('../../repositories/analysis-runtime-budget');
const { analysisSemaphore } = require('../concurrency');

const contexts = new AsyncLocalStorage();
const owner = `legacy:${os.hostname()}:${process.pid}:${crypto.randomUUID()}`;
const controllers = new Map();
const invalid = () => Object.assign(new Error('分析执行已取消、超时或租约失效，请重新运行。'), { status: 409, code: 'ANALYSIS_MODEL_LEASE_LOST' });

async function withRuntimeBudget(fn, { userId, job: supplied = null } = {}) {
    const parent = contexts.getStore();
    if (parent) {
        if (parent.signal.aborted) throw invalid();
        if (userId && Number(userId) !== Number(parent.job.user_id)) throw Object.assign(new Error('嵌套分析的执行账号不一致。'), { status: 403, code: 'ANALYSIS_ACTOR_MISMATCH' });
        return fn();
    }
    if (!Number.isSafeInteger(Number(userId)) || Number(userId) <= 0) throw Object.assign(new Error('分析操作缺少有效的执行账号。'), { status: 403, code: 'ANALYSIS_ACTOR_REQUIRED' });
    let job = supplied;
    if (!job) {
        await recoverStoppedAnalysis();
        const queued = await repository.createLegacy(Number(userId));
        try {
            const end = Date.now() + 120000;
            while (!job && Date.now() < end) {
                job = await transaction(trx => repository.claim(trx, { owner, kinds: ['legacy_operation'], jobId: queued.id }));
                if (!job) await new Promise(resolve => setTimeout(resolve, 100));
            }
            if (!job) throw Object.assign(new Error('分析排队已超时，请稍后重试。'), { status: 429, code: 'ANALYSIS_MODEL_QUEUE_EXPIRED' });
        } catch (error) { await repository.abandonLegacy(queued.id).catch(() => {}); throw error; }
    }
    const controller = new AbortController();
    controllers.set(job.id, controller);
    let lastConfirmed = Date.now(), heartbeat = null, acquired = false, succeeded = false;
    const timer = setInterval(() => {
        if (Date.now() - lastConfirmed >= 10000) controller.abort();
        if (heartbeat) return;
        heartbeat = repository.renew(job).then(owned => { if (owned) lastConfirmed = Date.now(); else controller.abort(); }).catch(() => {}).finally(() => { heartbeat = null; });
    }, 2000);
    timer.unref?.();
    const deadline = setTimeout(() => controller.abort(), Math.max(1, new Date(job.execution_deadline_at).getTime() - Date.now()));
    deadline.unref?.();
    try {
        await analysisSemaphore.acquire(); acquired = true;
        if (controller.signal.aborted) throw invalid();
        const result = await contexts.run({ signal: controller.signal, job }, fn);
        if (supplied) { if (controller.signal.aborted) throw invalid(); succeeded = true; }
        // 写入型操作可在同一事务完成版本和任务；提交后的续租拒绝不能把已成功提交误报为取消。
        else succeeded = await repository.settleLegacy(job, !controller.signal.aborted);
        if (!succeeded) throw invalid();
        return result;
    } finally {
        clearInterval(timer); clearTimeout(deadline); if (heartbeat) await heartbeat;
        if (acquired) analysisSemaphore.release();
        controllers.delete(job.id);
        if (supplied) await transaction(trx => repository.release(trx, job));
        else if (!succeeded) await repository.settleLegacy(job, false, '分析未成功完成，请检查查询或重试。');
    }
}

function executionSignal() { return contexts.getStore()?.signal; }
function executionJob() { return contexts.getStore()?.job; }

async function recoverStoppedAnalysis() {
    for (const job of await repository.expiredNative()) {
        const active = controllers.get(job.id);
        if (active) { active.abort(); continue; }
        const parts = String(job.lease_owner).split(':');
        if (!['legacy', 'dataset'].includes(parts[0]) || parts[1] !== os.hostname()) continue;
        const pid = Number(parts[2]);
        if (!Number.isSafeInteger(pid) || pid <= 0) continue;
        if (pid !== process.pid) {
            try { process.kill(pid, 0); continue; } catch (error) { if (error.code !== 'ESRCH') continue; }
        }
        await repository.settleStopped(job);
    }
}

module.exports = { withRuntimeBudget, executionSignal, executionJob, recoverStoppedAnalysis };
