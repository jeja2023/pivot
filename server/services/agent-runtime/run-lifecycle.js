const { isPersistedDagOutputPartial, resolvePersistedDagOutput } = require('../agent-dag-output');
const { transaction: dbTransaction } = require('../../db/client');

function createRunLifecycle(deps = {}) {
const {
    activeRunControllers,
    ACTIVE_STATUSES,
    buildAgentResumeContext,
    clampText,
    createAgentNotification,
    createAgentRun,
    getAgentRunTitle,
    getBeijingTimestamp,
    getRunForUser,
    getRunMetadata,
    insertStep,
    isChatAgentRun,
    listDagNodes,
    listSteps,
    normalizeDagSpec,
    normalizeToolAllowlist,
    parseJsonObject,
    publishAgentRunEvent,
    query,
    updateRun,
    updateRunCas
} = deps;
const runTransaction = deps.transaction || dbTransaction;


function isRunCancelled(runId) {
    return activeRunControllers.get(runId)?.signal?.aborted === true;
}

    function assertRunNotCancelled(runId) {
        const controller = activeRunControllers.get(runId);
        if (controller?.signal?.aborted !== true) return;
        if (controller.signal.reason instanceof Error) throw controller.signal.reason;
        const err = new Error('任务已停止。');
        err.code = 'AGENT_RUN_CANCELLED';
        throw err;
    }

async function cancelAgentRun(runId, user) {
    const run = await getRunForUser(runId, user);
    if (!run) return null;
    if (!ACTIVE_STATUSES.has(run.status)) return run;
    if (run.status === 'awaiting_commit') {
        const error = new Error('任务事务正在等待提交决定，请在事务详情中确认提交或执行回滚。');
        error.code = 'AGENT_TASK_COMMIT_DECISION_REQUIRED';
        error.status = 409;
        throw error;
    }
    const now = getBeijingTimestamp();
    const changed = await updateRunCas(runId, [run.status], {
        status: 'cancelled',
        error_message: '智能体运行已被用户主动取消。',
        cancelled_at: now,
        completed_at: now,
        updated_at: now
    });
    if (!changed) {
        const current = await getRunForUser(runId, user);
        if (!current || !ACTIVE_STATUSES.has(current.status)) return current;
        const error = new Error(current.status === 'awaiting_commit'
            ? '任务事务正在等待提交决定，请在事务详情中确认提交或执行回滚。'
            : '任务状态已发生变化，请刷新后重试。');
        error.code = current.status === 'awaiting_commit' ? 'AGENT_TASK_COMMIT_DECISION_REQUIRED' : 'AGENT_RUN_STATUS_CONFLICT';
        error.status = 409;
        throw error;
    }
    const abortError = new Error('智能体运行已被用户主动取消。');
    abortError.code = 'AGENT_RUN_CANCELLED';
    activeRunControllers.get(runId)?.abort(abortError);
    // Parent cancellation propagates through the persisted Agent tree so a
    // child cannot continue consuming tools after its supervisor has stopped.
    const childRuns = await query(`
        SELECT id
        FROM agent_runs
        WHERE parent_run_id = ?
          AND user_id = ?
          AND status IN ('queued', 'running', 'planning', 'executing', 'observing', 'diagnosing', 'replanning', 'resuming', 'approval_required', 'awaiting_approval', 'waiting_approval', 'awaiting_commit')
          AND deleted_at IS NULL
    `, [runId, user.id]);
    const pendingCommitChildren = [];
    for (const child of childRuns) {
        try {
            await cancelAgentRun(child.id, user);
        } catch (error) {
            if (error?.code !== 'AGENT_TASK_COMMIT_DECISION_REQUIRED') throw error;
            pendingCommitChildren.push(child.id);
        }
    }
    const steps = await listSteps(runId);
    await insertStep(runId, (steps || []).length + 1, {
        type: 'control',
        title: '用户主动取消运行',
        output: { status: 'cancelled', pendingCommitChildren }
    });
    await createAgentNotification(user.id, runId, 'cancelled', '任务运行已停止', pendingCommitChildren.length
        ? `${getAgentRunTitle(run)}；${pendingCommitChildren.length} 个子任务仍需处理提交或回滚。`
        : getAgentRunTitle(run));
    return await getRunForUser(runId, user);
}

async function pauseAgentRun(runId, user) {
    const run = await getRunForUser(runId, user);
    if (!run) return null;
    // `needs_input` 是既有的、可从检查点续跑的非终态。只暂停真正还在执行
    // 的阶段；审批和提交边界本来就在等待用户，不能被伪装成另一种暂停。
    const pausableStatuses = new Set(['queued', 'planning', 'executing', 'observing', 'diagnosing', 'replanning', 'running', 'resuming']);
    if (!pausableStatuses.has(String(run.status || ''))) return run;
    const pauseError = new Error('智能体运行已由用户暂停，可从安全检查点续跑。');
    pauseError.code = 'AGENT_RUN_PAUSED';
    activeRunControllers.get(runId)?.abort(pauseError);
    const now = getBeijingTimestamp();
    await updateRun(runId, {
        status: 'needs_input',
        error_message: '智能体运行已由用户暂停，可从安全检查点续跑。',
        updated_at: now,
        last_heartbeat_at: now
    });
    const childRuns = await query(`
        SELECT id
        FROM agent_runs
        WHERE parent_run_id = ? AND user_id = ?
          AND status IN ('queued', 'running', 'planning', 'executing', 'observing', 'diagnosing', 'replanning', 'resuming')
          AND deleted_at IS NULL
    `, [runId, user.id]);
    for (const child of childRuns) await pauseAgentRun(child.id, user);
    const steps = await listSteps(runId);
    await insertStep(runId, (steps || []).length + 1, {
        type: 'control',
        title: '用户暂停运行',
        output: { status: 'needs_input', resumable: true }
    });
    await createAgentNotification(user.id, runId, 'warning', '任务已暂停', getAgentRunTitle(run));
    return await getRunForUser(runId, user);
}

async function createChildRunFromExisting(run, user) {
    const metadata = getRunMetadata(run);
    return await createAgentRun({
        user,
        goal: run.goal,
        modelId: run.model_id,
        sessionId: run.session_id,
        title: run.title,
        maxSteps: run.max_steps,
        priority: run.priority,
        runMode: run.run_mode,
        toolPolicy: run.tool_policy,
        approvalPolicy: run.approval_policy,
        toolAllowlist: normalizeToolAllowlist(run.tool_allowlist),
        timeoutMs: run.timeout_ms,
        toolTimeoutMs: run.tool_timeout_ms,
        retryLimit: run.retry_limit,
        maxTokenBudget: run.max_token_budget,
        budgetConfig: parseJsonObject(run.budget_config) || {},
        networkPolicy: parseJsonObject(run.network_policy) || {},
        templateId: run.template_id,
        scheduleId: run.schedule_id,
        contextConfig: parseJsonObject(run.context_config) || {},
        parentRunId: run.id,
        metadata,
        chatAgent: isChatAgentRun(run),
        forkHistory: metadata.forkHistory || metadata.fork_history || 'none',
        dagSpec: metadata.dagSpec
    });
}

async function rerunAgentRun(runId, user) {
    const run = await getRunForUser(runId, user);
    if (!run) return null;
    if (ACTIVE_STATUSES.has(run.status)) {
        const err = new Error('当前任务仍在执行中，请停止或等待结束后再重新运行。');
        err.status = 400;
        throw err;
    }
    return await createChildRunFromExisting(run, user);
}

async function buildDagResumeSpec(originalRun, startNodeId = '', user = null) {
    const metadata = getRunMetadata(originalRun);
    const dagSpec = normalizeDagSpec(metadata.dagSpec || metadata.dag || {});
    if (!dagSpec.nodes.length) return null;
    const dagNodes = await listDagNodes(originalRun.id);
    const failed = (dagNodes || []).filter(node => node.status === 'error');
    const startIds = startNodeId
        ? [String(startNodeId)]
        : failed.map(node => node.node_key);
    const validStartIds = startIds.filter(id => dagSpec.nodes.some(node => node.id === id));
    if (!validStartIds.length) return null;
    const include = new Set(validStartIds);
    let changed = true;
    while (changed) {
        changed = false;
        dagSpec.nodes.forEach(node => {
            if (include.has(node.id)) return;
            if ((node.dependsOn || []).some(dep => include.has(dep))) {
                include.add(node.id);
                changed = true;
            }
        });
    }
    const hydratedNodes = await Promise.all((dagNodes || []).map(async node => {
        if (!user || !isPersistedDagOutputPartial(node.output)) return node;
        const restored = await resolvePersistedDagOutput(node.output, { user });
        return { ...node, output: restored.value, output_complete: restored.complete };
    }));
    const previousById = new Map(hydratedNodes.map(node => [String(node.node_key || ''), node]));
    const outputIsPartial = output => isPersistedDagOutputPartial(output);
    const terminalStatuses = new Set(['completed', 'continued_error', 'error', 'skipped']);

    // 如果待重跑节点依赖的上游结果已被截断或没有完成状态，不能把预览当作完整输入；
    // 将该上游连同它的下游重新纳入范围，直到所有边界输入可安全复用。
    let expanded = true;
    while (expanded) {
        expanded = false;
        dagSpec.nodes.forEach(node => {
            if (!include.has(node.id)) return;
            (node.dependsOn || []).forEach(depId => {
                if (include.has(depId)) return;
                const previous = previousById.get(String(depId));
                const reusable = previous && terminalStatuses.has(previous.status) && !outputIsPartial(previous.output);
                if (reusable) return;
                include.add(depId);
                expanded = true;
            });
        });
        if (expanded) {
            dagSpec.nodes.forEach(node => {
                if ((node.dependsOn || []).some(dep => include.has(dep)) && !include.has(node.id)) {
                    include.add(node.id);
                    expanded = true;
                }
            });
        }
    }

    const reusable = {};
    dagSpec.nodes.forEach(node => {
        if (include.has(node.id)) return;
        const previous = previousById.get(node.id);
        if (previous && terminalStatuses.has(previous.status) && !outputIsPartial(previous.output)) {
            reusable[node.id] = {
                status: previous.status,
                input: previous.input,
                output: previous.output,
                error: previous.error_message || '',
                reusedFromRunId: originalRun.id
            };
            return;
        }
        // 已取消或未完成的旁支在新运行中保持显式跳过，不能重新变回 pending 后被误执行。
        reusable[node.id] = {
            status: 'skipped',
            output: { status: 'skipped', reason: 'rerun_outside_scope' },
            error: '',
            skipReason: 'rerun_outside_scope'
        };
    });
    return {
        dagSpec,
        reusable,
        rerunNodeIds: [...include]
    };
}

async function rerunAgentDagFromNode(runId, user, nodeId = '') {
    const run = await getRunForUser(runId, user);
    if (!run) return null;
    if (ACTIVE_STATUSES.has(run.status)) {
        const err = new Error('当前任务仍在执行中，请停止或等待结束后再重跑节点。');
        err.status = 400;
        throw err;
    }
    if (run.run_mode !== 'dag') {
        const err = new Error('只有工作流任务可以从节点重新运行。');
        err.status = 400;
        throw err;
    }
    const resume = await buildDagResumeSpec(run, nodeId, user);
    if (!resume || !resume.dagSpec.nodes.length) {
        const err = new Error('没有找到可重用的工作流节点。');
        err.status = 400;
        throw err;
    }
    const metadata = getRunMetadata(run);
    return await createAgentRun({
        user,
        goal: run.goal,
        modelId: run.model_id,
        sessionId: run.session_id,
        title: `重跑节点：${getAgentRunTitle(run)}`.slice(0, 80),
        maxSteps: run.max_steps,
        priority: run.priority,
            runMode: 'dag',
        toolPolicy: run.tool_policy,
        approvalPolicy: run.approval_policy,
        toolAllowlist: normalizeToolAllowlist(run.tool_allowlist),
        timeoutMs: run.timeout_ms,
        toolTimeoutMs: run.tool_timeout_ms,
        retryLimit: run.retry_limit,
        maxTokenBudget: run.max_token_budget,
        budgetConfig: parseJsonObject(run.budget_config) || {},
        networkPolicy: parseJsonObject(run.network_policy) || {},
        templateId: run.template_id,
        scheduleId: run.schedule_id,
        contextConfig: parseJsonObject(run.context_config) || {},
        parentRunId: run.id,
        metadata: {
            ...metadata,
            dagSpec: resume.dagSpec,
            reusedDagNodes: resume.reusable,
            rerunNodeIds: resume.rerunNodeIds,
            rerunFromRunId: run.id,
            rerunFromNodeId: nodeId || '',
            workflowVersionMode: metadata.workflowVersionMode || ''
        },
        forkHistory: metadata.forkHistory || metadata.fork_history || 'none',
        dagSpec: resume.dagSpec
    });
}

async function resumeAgentRun(runId, user) {
    const run = await getRunForUser(runId, user);
    if (!run) return null;
    if ((ACTIVE_STATUSES.has(run.status) && run.status !== 'needs_input') || run.status === 'approval_required') {
        const err = new Error('当前任务仍在执行中，无需断点续跑。');
        err.status = 400;
        throw err;
    }
    if (run.run_mode === 'dag') {
        const dagResume = await buildDagResumeSpec(run, '', user);
        if (dagResume?.dagSpec?.nodes?.length) return await rerunAgentDagFromNode(runId, user, '');
    }
    const steps = await listSteps(run.id);
    const lastStep = (steps || []).length ? Math.max(...steps.map(step => Number(step.step_index || 0))) : 0;
    const failed = (steps || []).filter(step => step.status === 'error').slice(-3);
    const resumeContext = await buildAgentResumeContext(run.id);
    const previousMetadata = getRunMetadata(run);
    return await createAgentRun({
        user,
        goal: run.goal,
        modelId: run.model_id,
        sessionId: run.session_id,
        title: `断点续跑：${getAgentRunTitle(run)}`.slice(0, 80),
        maxSteps: run.max_steps,
        priority: run.priority,
        runMode: run.run_mode,
        toolPolicy: run.tool_policy,
        approvalPolicy: run.approval_policy,
        toolAllowlist: normalizeToolAllowlist(run.tool_allowlist),
        timeoutMs: run.timeout_ms,
        toolTimeoutMs: run.tool_timeout_ms,
        retryLimit: run.retry_limit,
        maxTokenBudget: run.max_token_budget,
        budgetConfig: parseJsonObject(run.budget_config) || {},
        networkPolicy: parseJsonObject(run.network_policy) || {},
        templateId: run.template_id,
        scheduleId: run.schedule_id,
        contextConfig: parseJsonObject(run.context_config) || {},
        resumeFromStep: lastStep,
        parentRunId: run.id,
        metadata: {
            ...previousMetadata,
            pendingApproval: null,
            resumedFromRunId: run.id,
            failedSteps: failed.map(step => step.id),
            resumeContext: {
                ...resumeContext,
                previousStatus: run.status,
                previousAnswer: clampText(run.final_answer || '', 1200),
                previousError: run.error_message || ''
            }
        },
        chatAgent: isChatAgentRun(run),
        forkHistory: previousMetadata.forkHistory || previousMetadata.fork_history || 'none'
    });
}

async function softDeleteAgentRun(runId, user, reason = '') {
    if (!user?.id) return null;
    const now = getBeijingTimestamp();
    const deleted = await runTransaction(async trx => {
        const run = await trx.queryOne('SELECT id, status FROM agent_runs WHERE id = ? AND user_id = ? AND deleted_at IS NULL FOR UPDATE', [runId, user.id]);
        if (!run) return false;
        if (ACTIVE_STATUSES.has(run.status)) {
            const err = new Error('正在执行的任务不能删除。');
            err.status = 400;
            throw err;
        }
        const risk = await trx.queryOne(`
        SELECT EXISTS (
            SELECT 1 FROM agent_task_transactions t
            JOIN agent_task_effects e ON e.transaction_id = t.id
            WHERE t.run_id = ? AND t.user_id = ? AND (
                e.status IN ('executing', 'failed', 'compensation_pending')
                OR (e.commit_mode = 'preview' AND e.status = 'staged' AND t.status <> 'committed')
                OR (e.status = 'committed' AND t.status <> 'committed')
                OR (e.status = 'staged' AND t.status IN ('awaiting_commit', 'compensating'))
            )
        ) AS unresolved_effect,
        EXISTS (
            SELECT 1 FROM agent_run_checkpoints c
            JOIN agent_runs r ON r.id = c.run_id
            WHERE c.run_id = ? AND r.user_id = ?
              AND (c.status = 'uncertain' OR (c.status = 'pending' AND c.idempotent IS NOT TRUE))
        ) AS unresolved_checkpoint
        `, [runId, user.id, runId, user.id]);
        if (risk?.unresolved_effect || risk?.unresolved_checkpoint) {
            const error = new Error('任务仍有待核实的副作用或检查点，不能隐藏；请先核对事务和外部状态。');
            error.code = 'AGENT_RUN_UNRESOLVED_EFFECTS';
            error.status = 409;
            throw error;
        }
        return await trx.execute('UPDATE agent_runs SET deleted_at = ?, deleted_by_user = ?, delete_reason = ?, updated_at = ? WHERE id = ? AND user_id = ? AND deleted_at IS NULL', [
            now, user.id, String(reason || '').trim().slice(0, 500), now, runId, user.id
        ]) > 0;
    });
    if (!deleted) return null;
    try { await publishAgentRunEvent?.(runId, 'updated'); } catch (_) {}
    await insertStep(runId, (await listSteps(runId)).length + 1, {
        type: 'control',
        title: '任务记录已移除',
        output: {
            status: 'deleted',
            deletedAt: now,
            deletedBy: user.username || user.id
        }
    });
    return await getRunForUser(runId, user, { includeDeleted: true });
}

    return {
        assertRunNotCancelled,
        buildDagResumeSpec,
        cancelAgentRun,
        isRunCancelled,
        pauseAgentRun,
        rerunAgentDagFromNode,
        rerunAgentRun,
        resumeAgentRun,
        softDeleteAgentRun
    };
}

module.exports = { createRunLifecycle };
