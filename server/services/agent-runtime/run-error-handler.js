'use strict';

function createAgentRunErrorHandler(deps = {}) {
    const {
        requeueAgentRunAfterLeaseLoss, execute, getBeijingTimestamp, enqueueAgentRun, instanceId, logger,
        updateRun, getRunStatus, isRunCancelled, continueRunFromCheckpoint, withTimeout, synthesizeFinalAnswer,
        getRunMetadata, normalizePositiveInt, buildAgentResumeContext, calculateAgentRetryDelayMs,
        setRunMetadata, recordRunRetryReason, listSteps, insertStep, getRunUser, createAgentNotification,
        loadRetryRow, TERMINAL_STATUSES
    } = deps;

    async function handle(error, context = {}) {
        const { runId, user, runForSummary, modelCfgForSummary, observations = [], taskBudget, markExecutionLeaseLost } = context;
        const e = error;
        if (e.code === 'AGENT_RUN_LEASE_LOST') {
            // 持久化取消状态和租约归属为准。旧实例失去执行权后不能提交结果；
            // 仍归属本实例的任务会安全回到队列。
            markExecutionLeaseLost?.();
            await requeueAgentRunAfterLeaseLoss({ execute, getTimestamp: getBeijingTimestamp, enqueueAgentRun, instanceId, runId, error: e })
                .catch(error => logger.warn({ runId, err: error.message }, '执行租约失效后的安全回队失败'));
            return;
        }
        if (e.code === 'AGENT_RUN_CANCELLED' || e.code === 'AGENT_RUN_PAUSED') {
            return;
        }
        if (e.code === 'AGENT_APPROVAL_REQUIRED') {
            await updateRun(runId, { last_heartbeat_at: getBeijingTimestamp(), updated_at: getBeijingTimestamp() });
            return;
        }
        logger.error({ err: e.message, runId }, '智能体运行失败');
        const currentStatus = await getRunStatus(runId);
        if (e.code === 'AGENT_USER_REVOKED' || isRunCancelled(runId) || currentStatus === 'cancelled') {
            if (currentStatus !== 'cancelled' && currentStatus !== 'deleted') {
                await updateRun(runId, {
                    status: 'cancelled',
                    error_message: e.message,
                    cancelled_at: getBeijingTimestamp(),
                    completed_at: getBeijingTimestamp(),
                    updated_at: getBeijingTimestamp()
                });
            }
            return;
        }
        if (e.code === 'AGENT_BUDGET_EXCEEDED' || e.code === 'AGENT_TIMEOUT') {
            if (e.code === 'AGENT_TIMEOUT' && runForSummary && await continueRunFromCheckpoint({ run: runForSummary, runId, user, error: e, reason: 'timeout' })) {
                return;
            }
            const isModelRequestTimeout = /(?:智能体规划|流式工具规划|final summary|escalated final summary)执行超时/i.test(String(e.message || ''));
            const reason = e.code === 'AGENT_TIMEOUT'
                ? (isModelRequestTimeout
                    ? '模型响应超过单次调用时限，以下为已完成的部分结果。'
                    : '任务已达到运行时间上限，以下为已完成的部分结果。')
                : '任务已达到预算上限，以下为已完成的部分结果。';
            let answer = '';
            if (modelCfgForSummary && runForSummary) {
                try {
                    answer = await withTimeout(
                        () => synthesizeFinalAnswer(modelCfgForSummary, runForSummary.goal, observations, user, runId, {
                            budget: taskBudget,
                            allowBudgetExceeded: true,
                            chatAgent: runForSummary ? getRunMetadata(runForSummary).chatBridge : null
                        }),
                        30000,
                        'partial final summary'
                    );
                } catch (summaryError) {
                    logger.warn({ runId, err: summaryError.message }, '资源受限后的部分结果总结失败');
                }
            }
            if (!String(answer || '').trim()) {
                answer = observations.length
                    ? `已完成 ${observations.length} 项执行观察，但未能生成完整总结。`
                    : '任务在产生可用总结前被中止。';
            }
            if (!TERMINAL_STATUSES.has(currentStatus)) {
                await updateRun(runId, {
                    status: 'completed_with_errors',
                    final_answer: `${reason}\n\n${answer}`,
                    error_message: e.message || reason,
                    completed_at: getBeijingTimestamp(),
                    last_heartbeat_at: getBeijingTimestamp(),
                    updated_at: getBeijingTimestamp()
                });
                await createAgentNotification(user.id, runId, 'warning', '任务已生成部分结果', reason);
            }
            return;
        }
        if (currentStatus === 'cancelled' || currentStatus === 'deleted' || isRunCancelled(runId)) {
            return;
        }
        const retryRow = await loadRetryRow(runId);
        const retryLimit = normalizePositiveInt(retryRow?.retry_limit, 0, 0, 5);
        const retryCount = normalizePositiveInt(retryRow?.retry_count, 0, 0, 99);
        if (retryCount < retryLimit && e.code !== 'AGENT_BUDGET_EXCEEDED' && e.code !== 'AGENT_TIMEOUT' && e.code !== 'AGENT_INVALID_STATUS_TRANSITION') {
            const resumeContext = await buildAgentResumeContext(runId);
            const retryAttempt = retryCount + 1;
            const retryDelayMs = calculateAgentRetryDelayMs(retryAttempt);
            const retryAfter = getBeijingTimestamp(new Date(Date.now() + retryDelayMs));
            await setRunMetadata(runId, { resumeContext });
            await recordRunRetryReason(runId, {
                attempt: retryAttempt,
                limit: retryLimit,
                code: e.code || '',
                error: e.message,
                retryAfter,
                retryDelayMs
            });
            await updateRun(runId, {
                status: 'queued',
                error_message: e.message,
                retry_count: retryAttempt,
                retry_after: retryAfter,
                resume_from_step: Number(resumeContext.latestStepIndex || 0),
                updated_at: getBeijingTimestamp()
            });
            await insertStep(runId, (await listSteps(runId)).length + 1, {
                type: 'control',
                title: `任务失败重试：${retryCount + 1}/${retryLimit}`,
                output: { error: e.message }
            });
            // 重新拉取用户，避免复用运行开始时捕获的过期用户对象（运行中用户可能被禁用或修改）
            enqueueAgentRun(runId, (await getRunUser(runId)) || user, { retryAfter });
            return;
        }
        const latestStatus = await getRunStatus(runId);
        if (TERMINAL_STATUSES.has(latestStatus)) return;
        await updateRun(runId, {
            status: 'error',
            error_message: e.message,
            completed_at: getBeijingTimestamp(),
            last_heartbeat_at: getBeijingTimestamp(),
            updated_at: getBeijingTimestamp()
        });
        await createAgentNotification(user.id, runId, 'error', '智能体运行失败', e.message);
    }

    return { handle };
}

module.exports = { createAgentRunErrorHandler };

