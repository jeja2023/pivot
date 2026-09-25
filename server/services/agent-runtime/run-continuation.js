function runStartedAtMs(run = {}) {
    const parsed = Date.parse(String(run.started_at || run.created_at || '').replace(' ', 'T'));
    return Number.isFinite(parsed) ? parsed : Date.now();
}

function autoContinuationState(run = {}, getRunMetadata) {
    const value = getRunMetadata ? getRunMetadata(run).autoContinuation : run?.metadata?.autoContinuation;
    return value && typeof value === 'object' ? value : {};
}

async function continueRunFromCheckpoint({ run, runId, user, error, reason = 'timeout' }, deps = {}) {
    const {
        AGENT_AUTO_CONTINUE_ON_STEP_LIMIT,
        AGENT_AUTO_CONTINUE_ON_TIMEOUT,
        AGENT_MAX_AUTO_CONTINUATIONS,
        AGENT_MAX_TOTAL_RUNTIME_MS,
        TERMINAL_STATUSES,
        getRunMetadata,
        getRunStatus,
        queryOne,
        buildAgentResumeContext,
        getBeijingTimestamp,
        setRunMetadata,
        updateRun,
        listSteps,
        insertStep,
        createAgentNotification,
        enqueueAgentRun
    } = deps;

    const enabled = reason === 'step_limit' ? AGENT_AUTO_CONTINUE_ON_STEP_LIMIT : AGENT_AUTO_CONTINUE_ON_TIMEOUT;
    if (!enabled || AGENT_MAX_AUTO_CONTINUATIONS <= 0) return false;
    const prior = autoContinuationState(run, getRunMetadata);
    const count = Math.max(Number.parseInt(prior.count, 10) || 0, 0);
    const elapsedMs = Math.max(Date.now() - runStartedAtMs(run), 0);
    if (count >= AGENT_MAX_AUTO_CONTINUATIONS || elapsedMs >= AGENT_MAX_TOTAL_RUNTIME_MS) return false;
    const currentStatus = await getRunStatus(runId);
    if (TERMINAL_STATUSES.has(currentStatus)) return false;
    // 工具尚未提交时不能立刻续跑：底层进程可能仍在收尾，直接再次执行会制造
    // 重复副作用。幂等工具可由既有恢复机制重放，非幂等工具必须走人工审批。
    const pendingTool = await queryOne(`
        SELECT checkpoint_id FROM agent_run_checkpoints
        WHERE run_id = ? AND checkpoint_type = 'tool' AND status = 'pending'
        ORDER BY step_index DESC, id DESC LIMIT 1
    `, [runId]);
    if (pendingTool) return false;
    const resumeContext = await buildAgentResumeContext(runId);
    if (reason === 'step_limit' && Number(resumeContext.latestStepIndex || 0) <= 0) return false;
    const nextCount = count + 1;
    const resumeFromStep = Math.max(
        Number(run.resume_from_step || 0),
        Number(resumeContext.latestStepIndex || 0),
        0
    );
    const now = getBeijingTimestamp();
    await setRunMetadata(runId, {
        resumeContext,
        autoContinuation: {
            count: nextCount,
            max: AGENT_MAX_AUTO_CONTINUATIONS,
            totalRuntimeMs: elapsedMs,
            totalRuntimeLimitMs: AGENT_MAX_TOTAL_RUNTIME_MS,
            reason,
            lastReason: String(error?.message || '任务时间片结束').slice(0, 1000),
            lastAt: now
        }
    });
    await updateRun(runId, {
        status: 'queued',
        error_message: '',
        resume_from_step: resumeFromStep,
        last_heartbeat_at: now,
        updated_at: now
    });
    const title = reason === 'step_limit' ? '当前时间片达到轮次上限，自动续跑' : '任务时间片结束，自动续跑';
    await insertStep(runId, (await listSteps(runId)).length + 1, {
        type: 'control',
        title: `${title}：${nextCount}/${AGENT_MAX_AUTO_CONTINUATIONS}`,
        output: {
            reason: String(error?.message || ''),
            resumeFromStep,
            checkpointCount: Number(resumeContext.checkpointCount || 0),
            elapsedMs,
            totalRuntimeLimitMs: AGENT_MAX_TOTAL_RUNTIME_MS
        }
    });
    await createAgentNotification(user.id, runId, 'info', '任务将从安全检查点继续', `${title}，已准备第 ${nextCount} 次自动续跑。`);
    enqueueAgentRun(runId, user);
    return true;
}

module.exports = {
    continueRunFromCheckpoint
};
