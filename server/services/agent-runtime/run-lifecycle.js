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
    query,
    updateRun
} = deps;


function isRunCancelled(runId) {
    return activeRunControllers.get(runId)?.signal?.aborted === true;
}

function assertRunNotCancelled(runId) {
    if (isRunCancelled(runId)) {
        const err = new Error('任务已停止。');
        err.code = 'AGENT_RUN_CANCELLED';
        throw err;
    }
}

async function cancelAgentRun(runId, user) {
    const run = await getRunForUser(runId, user);
    if (!run) return null;
    if (!ACTIVE_STATUSES.has(run.status)) return run;
    const now = getBeijingTimestamp();
    await updateRun(runId, {
        status: 'cancelled',
        error_message: '智能体运行已被用户主动取消。',
        cancelled_at: now,
        completed_at: now,
        updated_at: now
    });
    // Parent cancellation propagates through the persisted Agent tree so a
    // child cannot continue consuming tools after its supervisor has stopped.
    const childRuns = await query(`
        SELECT id
        FROM agent_runs
        WHERE parent_run_id = ?
          AND user_id = ?
          AND status IN ('queued', 'running', 'planning', 'executing', 'observing', 'diagnosing', 'replanning', 'resuming', 'approval_required', 'awaiting_approval', 'waiting_approval')
          AND deleted_at IS NULL
    `, [runId, user.id]);
    for (const child of childRuns) {
        await cancelAgentRun(child.id, user);
    }
    const abortError = new Error('智能体运行已被用户主动取消。');
    abortError.code = 'AGENT_RUN_CANCELLED';
    activeRunControllers.get(runId)?.abort(abortError);
    const steps = await listSteps(runId);
    await insertStep(runId, (steps || []).length + 1, {
        type: 'control',
        title: '用户主动取消运行',
        output: { status: 'cancelled' }
    });
    await createAgentNotification(user.id, runId, 'cancelled', '任务运行已停止', getAgentRunTitle(run));
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

async function buildDagResumeSpec(originalRun, startNodeId = '') {
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
    const reusable = {};
    (dagNodes || []).forEach(node => {
        if (include.has(node.node_key)) return;
        if (node.status !== 'completed') return;
        reusable[node.node_key] = {
            status: node.status,
            input: node.input,
            output: node.output,
            reusedFromRunId: originalRun.id
        };
    });
    const nodes = dagSpec.nodes.filter(node => include.has(node.id)).map(node => ({
        ...node,
        dependsOn: (node.dependsOn || []).filter(dep => include.has(dep))
    }));
    const layout = Object.fromEntries(nodes
        .filter(node => dagSpec.layout?.[node.id])
        .map(node => [node.id, dagSpec.layout[node.id]]));
    return { dagSpec: { nodes, layout }, reusable };
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
    const resume = await buildDagResumeSpec(run, nodeId);
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
    if (ACTIVE_STATUSES.has(run.status) || run.status === 'approval_required') {
        const err = new Error('当前任务仍在执行中，无需断点续跑。');
        err.status = 400;
        throw err;
    }
    if (run.run_mode === 'dag') {
        const dagResume = await buildDagResumeSpec(run);
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
    const run = await getRunForUser(runId, user);
    if (!run) return null;
    if (ACTIVE_STATUSES.has(run.status)) {
        const err = new Error('正在执行的任务不能删除。');
        err.status = 400;
        throw err;
    }
    const now = getBeijingTimestamp();
    await updateRun(runId, {
        deleted_at: now,
        deleted_by_user: user.id,
        delete_reason: String(reason || '').trim().slice(0, 500),
        updated_at: now
    });
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
        rerunAgentDagFromNode,
        rerunAgentRun,
        resumeAgentRun,
        softDeleteAgentRun
    };
}

module.exports = { createRunLifecycle };
