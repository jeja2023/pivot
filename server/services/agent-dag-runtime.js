const { queryOne, execute } = require('../db/client');
const { getBeijingTimestamp } = require('../time');
const { approvalInputHash } = require('./agent-runtime/approvals');
const { calculateDagRetryDelayMs, waitForDagRetry } = require('./agent-dag-retry');
const { resolveDagToolApproval, stableDagOperationKey } = require('./agent-dag-approval');
const { assertWorkflowLlmNodesConfigured, normalizeDagRunInputs } = require('./agent-workflows');
const { normalizeDagNodePolicy, resolveDagNodeInput, evaluateDagWhen, dagJoinConditionSatisfied, getDagNodeRouteState } = require('./agent-dag-utils');
const { listDagNodes, listSteps } = require('./agent-runs');
const { recordAgentToolCall } = require('./agent-tool-audit');
const { diagnoseError } = require('./agent-diagnosis');
const { clampText, executeToolByName, findAgentToolByName } = require('./agent-tool-runtime');
const { normalizeToolInput } = require('./agent-policy');
const { createSubworkflowRuntime } = require('./agent-dag-subworkflow-runtime');
const { inspectDagTopology, normalizeDagSpec } = require('./agent-validators');
const { parseCasRef, incrementRefCount } = require('./agent-artifact-cas');
const {
    recordDagCacheResult,
    recordDagNodeResult
} = require('./agent-governance-metrics');
const {
    normalizeJsonSchema,
    outputValueForContract,
    schemaHasRules,
    validateJsonSchemaDefinition,
    validateValueAgainstSchema
} = require('./agent-dag-contracts');

const {
    persistDagOutput,
    persistedDagOutput,
    compactPreparedDagOutput,
    extractReadableDagOutput
} = require('./agent-dag-output');
const {
    computeDagNodeCacheKey,
    getCachedNodeOutput,
    setCachedNodeOutput,
    isCacheableDagTool
} = require('./agent-dag-cache');

function buildDagFallbackFinalAnswer(dagSpec, states) {
    const nodes = Array.isArray(dagSpec?.nodes) ? dagSpec.nodes : [];
    const completedNodes = nodes.filter(node => ['completed', 'continued_error'].includes(states.get(node.id)?.status));
    const dependencyIds = new Set(nodes.flatMap(node => Array.isArray(node.dependsOn) ? node.dependsOn : []));
    const terminalOutputs = completedNodes
        .filter(node => !dependencyIds.has(node.id))
        .map(node => ({ node, text: extractReadableDagOutput(states.get(node.id)?.output) }))
        .filter(item => item.text);
    if (terminalOutputs.length === 1) return terminalOutputs[0].text;
    if (terminalOutputs.length > 1) {
        return terminalOutputs
            .map(({ node, text }) => `## ${node.title || node.id}\n\n${text}`)
            .join('\n\n');
    }
    const reversedCompleted = completedNodes.slice().reverse();
    for (const node of reversedCompleted) {
        const text = extractReadableDagOutput(states.get(node.id)?.output);
        if (text) return text;
    }
    if (completedNodes.length) return `工作流执行完成，共 ${completedNodes.length} 个节点完成。`;
    return '';
}

async function upsertDagNode(runId, node, patch = {}) {
    const nodeKey = String(patch.nodeKey || node.nodeKey || node.id || '').trim();
    const existing = await queryOne('SELECT id, output FROM agent_dag_nodes WHERE run_id = ? AND node_key = ?', [runId, nodeKey]);
    const now = getBeijingTimestamp();
    const row = {
        title: patch.title ?? node.title,
        toolName: patch.toolName ?? node.tool,
        input: patch.input ?? node.input ?? {},
        inputSchema: patch.inputSchema ?? node.inputSchema ?? {},
        outputSchema: patch.outputSchema ?? node.outputSchema ?? {},
        dependsOn: patch.dependsOn ?? node.dependsOn ?? [],
        condition: patch.condition ?? node.condition ?? 'success',
        status: patch.status ?? 'pending',
        output: patch.output ?? null,
        outputSerialized: patch.outputSerialized,
        reusedFromRunId: patch.reusedFromRunId ?? patch.reused_from_run_id ?? null,
        errorMessage: patch.errorMessage ?? '',
        errorInfo: patch.errorInfo ?? patch.error_info ?? {},
        contractStatus: patch.contractStatus ?? 'unchecked',
        contractIssues: patch.contractIssues ?? [],
        attemptCount: patch.attemptCount ?? 0,
        durationMs: patch.durationMs ?? null,
        startedAt: patch.startedAt ?? null,
        completedAt: patch.completedAt ?? null
    };
    const extractOutputRef = value => {
        let parsed = value;
        if (typeof parsed === 'string') {
            try { parsed = JSON.parse(parsed); } catch (_) { return null; }
        }
        return parseCasRef(parsed?.outputRef);
    };
    const previousOutputRef = extractOutputRef(existing?.output);
    const nextOutputRef = extractOutputRef(row.output);
    const refChanged = previousOutputRef !== nextOutputRef;
    if (refChanged && nextOutputRef) await incrementRefCount(nextOutputRef, 1);
    if (existing) {
        try {
            await execute(`
            UPDATE agent_dag_nodes
            SET title = ?, tool_name = ?, input = ?, input_schema = ?, output_schema = ?, depends_on = ?, condition = ?, status = ?,
                output = ?, error_message = ?, error_info = ?, contract_status = ?, contract_issues = ?,
                attempt_count = ?, duration_ms = ?, started_at = ?, completed_at = ?, reused_from_run_id = ?
            WHERE id = ?
            `, [
            row.title,
            row.toolName,
            JSON.stringify(row.input),
            JSON.stringify(row.inputSchema),
            JSON.stringify(row.outputSchema),
            JSON.stringify(row.dependsOn),
            row.condition,
            row.status,
            row.output === null ? null : (row.outputSerialized ?? JSON.stringify(row.output)),
            row.errorMessage,
            JSON.stringify(row.errorInfo),
            row.contractStatus,
            JSON.stringify(row.contractIssues),
            row.attemptCount,
            row.durationMs,
            row.startedAt,
            row.completedAt,
            row.reusedFromRunId,
            existing.id
            ]);
        } catch (error) {
            if (refChanged && nextOutputRef) await incrementRefCount(nextOutputRef, -1).catch(() => {});
            throw error;
        }
        if (refChanged && previousOutputRef) await incrementRefCount(previousOutputRef, -1).catch(() => {});
        return existing.id;
    }
    let inserted;
    try {
        inserted = await queryOne(`
        INSERT INTO agent_dag_nodes (
            run_id, node_key, title, tool_name, input, input_schema, output_schema, depends_on, condition, status,
            output, reused_from_run_id, error_message, error_info, contract_status, contract_issues, attempt_count, duration_ms, started_at, completed_at, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        RETURNING id
        `, [
        runId,
        nodeKey,
        row.title,
        row.toolName,
        JSON.stringify(row.input),
        JSON.stringify(row.inputSchema),
        JSON.stringify(row.outputSchema),
        JSON.stringify(row.dependsOn),
        row.condition,
        row.status,
        row.output === null ? null : (row.outputSerialized ?? JSON.stringify(row.output)),
        row.reusedFromRunId,
        row.errorMessage,
        JSON.stringify(row.errorInfo),
        row.contractStatus,
        JSON.stringify(row.contractIssues),
        row.attemptCount,
        row.durationMs,
        row.startedAt,
        row.completedAt,
        now
        ]);
    } catch (error) {
        if (refChanged && nextOutputRef) await incrementRefCount(nextOutputRef, -1).catch(() => {});
        throw error;
    }
    return inserted?.id;
}

function buildDagErrorInfo(error, node = {}, { attempt = 1, timedOut = false } = {}) {
    const diagnosis = diagnoseError(error || new Error('DAG 节点执行失败'), {
        tool: node.tool || '',
        step: attempt
    });
    return {
        category: diagnosis.category,
        code: error?.code || diagnosis.code || 'AGENT_DAG_NODE_ERROR',
        message: diagnosis.message,
        nodeId: String(node.id || ''),
        retryable: Boolean(diagnosis.retryable),
        remediation: diagnosis.remediation,
        attempt: Math.max(Number(attempt) || 1, 1),
        timedOut: Boolean(timedOut)
    };
}

function cloneDagFallbackValue(value) {
    if (value === undefined || value === null || typeof value !== 'object') return value;
    try { return JSON.parse(JSON.stringify(value)); } catch (_) { return value; }
}

/** 兜底值必须被显式配置，且通过当前节点的输出契约校验。 */
function prepareDagFallbackOutput(node = {}, outputSchema = {}, errorInfo = {}) {
    const hasFallback = Object.prototype.hasOwnProperty.call(node, 'fallbackOutput')
        || Object.prototype.hasOwnProperty.call(node, 'fallback_output');
    if (!hasFallback) return { usable: false, issues: ['节点未配置兜底输出。'] };
    const output = cloneDagFallbackValue(node.fallbackOutput ?? node.fallback_output);
    const issues = [];
    if (schemaHasRules(outputSchema)) {
        validateValueAgainstSchema(outputValueForContract(output, node), outputSchema, {}, `${node.title || node.id} 兜底输出`, issues);
    }
    if (issues.length) return { usable: false, output, issues };
    return {
        usable: true,
        output,
        errorInfo: { ...errorInfo, fallbackApplied: true }
    };
}

async function executeDagNodeWithPolicy({ run, user, modelCfg, node, resolvedInput, toolList, deadline, policy, stepIndex = 0, executionContext = {} }, deps) {
    const executeDagTool = deps.executeToolByName || executeToolByName, recordToolCall = deps.recordAgentToolCall || recordAgentToolCall;
    const listRunSteps = deps.listSteps || listSteps, waitForRetry = deps.waitForDagRetry || waitForDagRetry;
    const startedAt = Date.now();
    const startedAtText = getBeijingTimestamp();
    const stepContext = executionContext.stepContext || await deps.captureStepContext?.({
        run,
        user,
        turnId: `dag:${executionContext.executionPath ? `${executionContext.executionPath}:` : ''}${node.id}`,
        stepIndex,
        modelCfg,
        toolList,
        contextConfig: { mode: 'dag', nodeId: node.id, toolName: node.tool },
        policy,
        approval: {
            granted: Boolean(executionContext.approvalGranted),
            allowApproval: executionContext.allowApproval !== false
        },
        deadline,
        signal: executionContext.signal || deps.signal || null
    });
    if (stepContext) {
        executionContext.stepContext = stepContext;
        executionContext.contextHash = stepContext.contextHash;
    }
    const contextHash = stepContext?.contextHash || executionContext.contextHash || '';
    // 重试次数只能区分审计步骤，不能参与 checkpoint operation key。
    executionContext.operationKey = executionContext.operationKey || stableDagOperationKey(run, node, resolvedInput, executionContext.executionPath);
    let lastError = null;
    let attempted = 0;
    const attempts = Math.max(1, Number(policy.retryLimit || 0) + 1);
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
        attempted = attempt;
        await deps.assertRunNotCancelled(run.id);
        try {
            executionContext.autonomous = true;
            executionContext.stepId = `${run.id}:${executionContext.executionPath ? `${executionContext.executionPath}:` : ''}${node.id}:${attempt}`;
            executionContext.stepIndex = stepIndex;
            const remainingRunMs = Math.max(deadline - Date.now(), 1);
            const nodeOwnsDeadline = policy.timeoutMs < remainingRunMs;
            const output = await deps.withTimeout(
                signal => executeDagTool(node.tool, resolvedInput, user, toolList, { run, modelCfg, node, ...executionContext, signal }),
                Math.min(policy.timeoutMs, Math.max(remainingRunMs, 1000)),
                `执行 DAG 节点：${node.title || node.id}`,
                {
                    signal: executionContext.signal || deps.signal || null,
                    timeoutCode: nodeOwnsDeadline ? 'AGENT_NODE_TIMEOUT' : 'AGENT_TIMEOUT'
                }
            );
            try {
                await recordToolCall({
                    runId: run.id,
                    stepId: executionContext.stepId,
                    toolName: node.tool,
                    input: resolvedInput,
                    output,
                    policyDecision: 'allow',
                    status: 'success',
                    durationMs: Date.now() - startedAt,
                    attempt,
                    contextHash
                });
            } catch (auditError) {
                throw auditError;
            }
            recordDagNodeResult({ tool: node.tool, status: 'completed' });
            return {
                ok: true,
                output,
                attempt,
                startedAt,
                startedAtText,
                durationMs: Date.now() - startedAt
            };
        } catch (e) {
            if (e.code === 'AGENT_RECOVERY_REQUIRES_APPROVAL') {
                e.recoveryApprovalKey = e.recoveryApprovalKey || executionContext.approvalKey || `${node.tool}:${node.id}`;
                e.recoveryApprovalInput = e.recoveryApprovalInput || resolvedInput;
                e.recoveryApprovalTool = e.recoveryApprovalTool || node.tool;
                throw e;
            }
            if (['AGENT_APPROVAL_REQUIRED', 'AGENT_RUN_CANCELLED', 'AGENT_TIMEOUT'].includes(e.code)) throw e;
            lastError = e;
            if (e.code === 'AGENT_NODE_TIMEOUT') break;
            await deps.insertStep(run.id, (await listRunSteps(run.id)).length + 1, {
                type: 'dag',
                title: `DAG 节点重试：${node.title || node.id}（${attempt}/${attempts}）`,
                toolName: node.tool,
                input: resolvedInput,
                output: { error: e.message, attempt, attempts, retrying: attempt < attempts },
                errorMessage: e.message,
                status: attempt < attempts ? 'success' : 'error',
                durationMs: Date.now() - startedAt,
                contextHash
            });
            if (attempt >= attempts) break;
            const retryDelayMs = calculateDagRetryDelayMs(attempt);
            await waitForRetry(retryDelayMs, executionContext.signal || deps.signal || null);
        }
    }
    try {
        await recordToolCall({
            runId: run.id,
            stepId: `${run.id}:${executionContext.executionPath ? `${executionContext.executionPath}:` : ''}${node.id}:${attempted || 1}`,
            toolName: node.tool,
            input: resolvedInput,
            output: { error: lastError?.message || '执行失败' },
            policyDecision: lastError?.code === 'AGENT_POLICY_DENIED' ? 'denied' : 'allow',
            status: 'error',
            errorCategory: diagnoseError(lastError || new Error('DAG 节点执行失败')).category,
            errorMessage: lastError?.message || '执行失败',
            durationMs: Date.now() - startedAt,
            attempt: attempted || 1,
            contextHash
        });
    } catch (auditError) {
        auditError.cause = lastError;
        throw auditError;
    }
    recordDagNodeResult({ tool: node.tool, status: 'error' });
    return {
        ok: false,
        error: lastError || new Error('DAG 节点执行失败，但没有返回错误信息。'),
        attempt: attempted || 1,
        startedAt,
        startedAtText,
        durationMs: Date.now() - startedAt
    };
}

function buildIncompleteDagAnswer(dagSpec, states) {
    const nodes = Array.isArray(dagSpec?.nodes) ? dagSpec.nodes : [];
    const outputNodes = nodes.filter(node => String(node.tool || '') === 'workflow.output');
    const dependencyIds = new Set(nodes.flatMap(node => Array.isArray(node.dependsOn) ? node.dependsOn : []));
    const expected = outputNodes.length
        ? outputNodes
        : nodes.filter(node => ['agent.llm', 'agent.content_review'].includes(String(node.tool || '')) && !dependencyIds.has(node.id));
    if (expected.length && expected.every(node => states.get(node.id)?.status === 'completed')) return '';
    const unfinished = expected.filter(node => !['completed', 'continued_error'].includes(states.get(node.id)?.status));
    if (!unfinished.length) return '';
    const failed = nodes.filter(node => ['error', 'continued_error'].includes(states.get(node.id)?.status));
    const lines = [
        '## 工作流交付未完成',
        '',
        '查询或前置处理可能已经成功，但预期的分析/输出节点没有完成，因此不能把行数摘要视为校对结果。',
        ''
    ];
    failed.forEach(node => lines.push('- 失败节点：' + (node.title || node.id) + '；原因：' + (states.get(node.id)?.error || '未知错误')));
    unfinished.filter(node => !failed.includes(node)).forEach(node => lines.push('- 未完成节点：' + (node.title || node.id) + '；状态：' + (states.get(node.id)?.status || 'pending')));
    return lines.join('\n');
}

const { executeSubworkflowDag, executeWorkflowIteration } = createSubworkflowRuntime({
    executeDagNodeWithPolicy,
    buildDagErrorInfo,
    prepareDagFallbackOutput,
    buildDagFallbackFinalAnswer,
    extractReadableDagOutput,
    upsertDagNode
});

async function runAgentDag({ run, user, modelCfg, toolList, deadline, assertRunWithinBudget }, deps) {
    const readDagNodes = deps.listDagNodes || listDagNodes;
    const readSteps = deps.listSteps || listSteps;
    const writeDagNode = deps.upsertDagNode || upsertDagNode;
    const metadata = deps.getRunMetadata(run);
    const dagSpec = normalizeDagSpec(metadata.dagSpec || metadata.dag || {});
    const dagInputs = normalizeDagRunInputs(metadata.dagInputs || metadata.inputs || {});
    const reusedDagNodes = metadata.reusedDagNodes && typeof metadata.reusedDagNodes === 'object' ? metadata.reusedDagNodes : {};
    if (!dagSpec.nodes.length) {
        throw new Error('DAG 模式至少需要一个有效节点。');
    }
    const topology = inspectDagTopology(dagSpec);
    if (topology.blockers.length) throw new Error(`DAG 拒绝执行：${topology.blockers[0]}`);
    assertWorkflowLlmNodesConfigured(dagSpec);

    const persistedDagNodes = new Map((await readDagNodes(run.id)).map(node => [node.node_key, node]));
    for (const node of dagSpec.nodes) {
        const existing = persistedDagNodes.get(node.id);
        if (existing && ['completed', 'continued_error', 'skipped', 'waiting_approval'].includes(existing.status)) continue;
        await writeDagNode(run.id, node, { status: 'pending' });
    }
    const nodeMap = new Map(dagSpec.nodes.map(node => [node.id, node]));
    const states = new Map(dagSpec.nodes.map(node => {
        const existing = persistedDagNodes.get(node.id);
        if (existing && ['completed', 'continued_error', 'skipped'].includes(existing.status)) {
            return [node.id, {
                status: existing.status,
                input: existing.input || {},
                output: existing.output,
                compactOutput: clampText(existing.output, 12000),
                attemptCount: existing.attempt_count || 0,
                reused: false
            }];
        }
        return [node.id, { status: 'pending' }];
    }));
    Object.entries(reusedDagNodes).forEach(([nodeId, state]) => {
        states.set(nodeId, {
            status: state?.status || 'completed',
            input: state?.input || {},
            output: state?.output,
            compactOutput: clampText(state?.output, 12000),
            error: state?.error || '',
            skipReason: state?.skipReason || '',
            reused: Boolean(state?.reusedFromRunId),
            reusedFromRunId: state?.reusedFromRunId || null
        });
    });
    for (const [nodeId, state] of states.entries()) {
        if (!Object.prototype.hasOwnProperty.call(reusedDagNodes, nodeId)) continue;
        const node = nodeMap.get(nodeId);
        if (!node) continue;
        await writeDagNode(run.id, node, {
            status: state.status,
            input: state.input,
            output: state.output,
            errorMessage: state.error || '',
            contractStatus: state.status === 'error' ? 'error' : 'unchecked',
            reusedFromRunId: state.reusedFromRunId,
            completedAt: getBeijingTimestamp()
        });
    }
    const observations = [];
    let stepIndex = (await readSteps(run.id)).length + 1;
    const rootWorkflowId = Number.parseInt(metadata.workflowId || metadata.workflow_id, 10);
    const subworkflowStack = rootWorkflowId ? [rootWorkflowId] : [];

    while ([...states.values()].some(state => state.status === 'pending')) {
        assertRunWithinBudget();
        await deps.assertRunNotCancelled(run.id);
        const readyNodes = dagSpec.nodes.filter(node => {
            const state = states.get(node.id);
            if (state?.status !== 'pending') return false;
            return node.dependsOn.every(dep => ['completed', 'continued_error', 'error', 'skipped'].includes(states.get(dep)?.status));
        });
        if (!readyNodes.length) {
            throw new Error('DAG 执行已停滞：当前没有可运行的节点。');
        }

        const runnable = [];
        const stopErrors = [];
        for (const node of readyNodes) {
            const depStates = node.dependsOn.map(dep => states.get(dep)?.status);
            const routeState = getDagNodeRouteState(node, dagSpec, states);
            // 第一道门禁：依赖状态是否满足 condition（success / failure / always）。
            if (!dagJoinConditionSatisfied(node, depStates, routeState, states)) {
                const routeNotMatched = node.joinMode === 'any_active' && routeState.routed && !routeState.active;
                const reason = routeNotMatched
                    ? 'route_not_matched'
                    : node.condition === 'failure'
                        ? 'dependency_not_failed'
                        : 'dependency_not_completed';
                const routeDetail = routeNotMatched ? {
                    route: routeState.inactiveEdges.map(edge => edge.route).join(','),
                    routeSource: routeState.inactiveEdges.map(edge => edge.from)
                } : {};
                states.set(node.id, { status: 'skipped', skipReason: reason });
                await writeDagNode(run.id, node, {
                    status: 'skipped',
                    output: { status: 'skipped', reason, condition: node.condition, ...routeDetail },
                    completedAt: getBeijingTimestamp()
                });
                await deps.insertStep(run.id, stepIndex, {
                    type: 'dag',
                    nodeId: node.id,
                    title: `跳过 DAG 节点：${node.title || node.id}`,
                    toolName: node.tool,
                    input: node.input,
                    output: { status: 'skipped', reason, condition: node.condition, dependsOn: node.dependsOn, ...routeDetail }
                });
                stepIndex += 1;
                continue;
            }
            // 第二道门禁：when 条件规则（Dify 风格的条件分支）。
            const whenResult = evaluateDagWhen(node.when, {
                goal: run.goal,
                inputs: dagInputs,
                states,
                nodeMap
            });
            if (whenResult.skipped) {
                states.set(node.id, { status: 'skipped', skipReason: 'when_not_matched', skipDetail: whenResult.reason });
                await writeDagNode(run.id, node, {
                    status: 'skipped',
                    output: {
                        status: 'skipped',
                        reason: 'when_not_matched',
                        when: {
                            source: whenResult.source,
                            operator: whenResult.operator,
                            operatorLabel: whenResult.operatorLabel,
                            expected: whenResult.expected,
                            actual: whenResult.actual
                        }
                    },
                    errorMessage: '',
                    completedAt: getBeijingTimestamp()
                });
                await deps.insertStep(run.id, stepIndex, {
                    type: 'dag',
                    nodeId: node.id,
                    title: `条件不满足，跳过节点：${node.title || node.id}`,
                    toolName: node.tool,
                    input: node.input,
                    output: { status: 'skipped', reason: whenResult.reason, when: whenResult }
                });
                stepIndex += 1;
                continue;
            }
            if (routeState.routed && !routeState.active) {
                const routeDetail = {
                    status: 'skipped',
                    reason: 'route_not_matched',
                    route: routeState.inactiveEdges.map(edge => edge.route).join(','),
                    routeSource: routeState.inactiveEdges.map(edge => edge.from)
                };
                states.set(node.id, { status: 'skipped', skipReason: 'route_not_matched', output: routeDetail });
                await writeDagNode(run.id, node, {
                    status: 'skipped',
                    output: routeDetail,
                    completedAt: getBeijingTimestamp()
                });
                await deps.insertStep(run.id, stepIndex, {
                    type: 'dag',
                    nodeId: node.id,
                    title: `路由未命中，跳过节点：${node.title || node.id}`,
                    toolName: node.tool,
                    input: node.input,
                    output: routeDetail
                });
                stepIndex += 1;
                continue;
            }
            runnable.push(node);
        }

        const batchController = new AbortController();
        const batchSignal = (deps.signal && typeof AbortSignal.any === 'function')
            ? AbortSignal.any([deps.signal, batchController.signal])
            : batchController.signal;
        const batchResults = await Promise.allSettled(runnable.slice(0, deps.dagNodeConcurrency).map(async node => {
            batchSignal.throwIfAborted();
            deps.taskBudget?.consumeStep();
            const nodeStepIndex = stepIndex;
            stepIndex += 1;
            const selectedTool = findAgentToolByName(node.tool, toolList);
            const runMetadata = typeof run.metadata === 'string' ? (() => { try { return JSON.parse(run.metadata); } catch (_) { return {}; } })() : (run.metadata || {});
            if (String(runMetadata.workflowRunSource || runMetadata.runSource || '').toLowerCase() === 'preview'
                && (selectedTool?.side_effect || selectedTool?.sideEffect || selectedTool?.requiresApproval || selectedTool?.approval_required)) {
                const previewError = new Error('预览模式禁止执行副作用节点。');
                previewError.code = 'AGENT_PREVIEW_SIDE_EFFECT_BLOCKED';
                throw previewError;
            }
            const resolvedInput = normalizeToolInput(node.tool, resolveDagNodeInput(node, {
                goal: run.goal,
                inputs: dagInputs,
                states,
                nodeMap
            }), {
                ...run,
                model_id: run.model_id ?? modelCfg?.id,
                chosen_model_id: run.chosen_model_id ?? modelCfg?.id
            });
            const explicitInputSchema = normalizeJsonSchema(node.inputSchema || node.input_schema || {});
            const inputSchema = schemaHasRules(explicitInputSchema)
                ? explicitInputSchema
                : normalizeJsonSchema(selectedTool?.input_schema || selectedTool?.inputSchema || selectedTool?.parameters || {});
            const explicitOutputSchema = normalizeJsonSchema(node.outputSchema || node.output_schema || {});
            const outputSchema = schemaHasRules(explicitOutputSchema)
                ? explicitOutputSchema
                : normalizeJsonSchema(selectedTool?.output_schema || selectedTool?.outputSchema || {});
            const inputContractIssues = [];
            validateJsonSchemaDefinition(inputSchema, `${node.title || node.id} 输入契约`, inputContractIssues);
            validateValueAgainstSchema(resolvedInput, inputSchema, {}, `${node.title || node.id} 输入`, inputContractIssues);
            const outputDefinitionIssues = validateJsonSchemaDefinition(outputSchema, `${node.title || node.id} 输出契约`, []);
            const policy = normalizeDagNodePolicy(node, run, deps.agentToolTimeoutMs, selectedTool);
                const { approvalKey, approvalGranted } = resolveDagToolApproval({
                    run, node, selectedTool, input: resolvedInput, isApprovalGranted: deps.isApprovalGranted, executionPath: ''
            });
            const startedAtText = getBeijingTimestamp();
            const stepContext = await deps.captureStepContext?.({
                run,
                user,
                turnId: `dag:${node.id}`,
                stepIndex: nodeStepIndex,
                modelCfg,
                toolList,
                contextConfig: { mode: 'dag', nodeId: node.id, toolName: node.tool, inputs: dagInputs },
                resumeContext: { nodeId: node.id, attempt: 0 },
                policy,
                approval: { granted: approvalGranted, allowApproval: true },
                deadline,
                signal: batchSignal
            });
            states.set(node.id, { status: 'running', input: resolvedInput });
            await writeDagNode(run.id, node, {
                status: 'running',
                input: resolvedInput,
                inputSchema,
                outputSchema,
                contractStatus: 'validating',
                contractIssues: [],
                startedAt: startedAtText
            });
            const delegatedAgent = node.tool === 'agent.delegate';
            const handoffNode = node.tool === 'agent.handoff';
            const nodeSpanId = deps.startAgentTraceSpan?.(run.id, {
                type: delegatedAgent ? 'agent' : (handoffNode ? 'handoff' : 'dag_node'),
                name: node.title || node.id,
                input: resolvedInput,
                contextHash: stepContext?.contextHash || '',
                details: {
                    nodeId: node.id,
                    toolName: node.tool,
                    retryLimit: policy.retryLimit,
                    agentName: delegatedAgent ? resolvedInput.agentName : undefined,
                    role: delegatedAgent ? resolvedInput.role : undefined,
                    handoffTo: delegatedAgent ? 'Supervisor' : (handoffNode ? resolvedInput.toAgent : undefined)
                }
            });
            try {
                if (inputContractIssues.length || outputDefinitionIssues.length) {
                    const issues = [...inputContractIssues, ...outputDefinitionIssues];
                    const contractError = new Error(`节点契约校验失败：${issues[0]}`);
                    contractError.code = 'AGENT_DAG_CONTRACT_INVALID';
                    contractError.contractIssues = issues;
                    throw contractError;
                }
                if (!selectedTool) throw new Error(`节点工具不可用或无权访问：${node.tool || '-'}`);
                let workflowApprovalResult = null;
                let workflowDelayResult = null;
                if (node.tool === 'workflow.approval') {
                    workflowApprovalResult = await deps.waitForWorkflowApproval({
                        run,
                        user,
                        node,
                        input: resolvedInput,
                        key: `${node.tool}:${node.id}`
                    });
                } else if (node.tool === 'workflow.delay') {
                    workflowDelayResult = await deps.waitForWorkflowDelay({
                        run,
                        node,
                        input: resolvedInput,
                        key: `${node.tool}:${node.id}`
                    });
                }
                if (node.tool !== 'workflow.approval' && await deps.maybePauseForApproval(run, selectedTool, resolvedInput, approvalKey)) {
                    const approvalError = new Error('DAG 节点需要工具审批。');
                    approvalError.code = 'AGENT_APPROVAL_REQUIRED';
                    throw approvalError;
                }
                const executionContext = {
                    dagInputs,
                    signal: batchSignal,
                    budget: deps.taskBudget,
                    approvalKey,
                    // Reaching this point means the approval helper either found
                    // a prior grant or determined that this tool is safe to run.
                    approvalGranted,
                    allowApproval: true,
                    stepContext,
                    contextHash: stepContext?.contextHash || '',
                    workflowApprovalResult,
                    workflowDelayResult,
                    timeoutMs: policy.timeoutMs,
                    executeSubworkflow: childInput => executeSubworkflowDag({
                        input: childInput,
                        run,
                        user,
                        modelCfg,
                        toolList,
                        deadline,
                        deps,
                        stack: subworkflowStack,
                        invocation: { callerNodeId: node.id }
                    }),
                    executeIteration: iterationInput => executeWorkflowIteration({
                        input: iterationInput,
                        run,
                        user,
                        modelCfg,
                        toolList,
                        deadline,
                        deps,
                        parentContext: { dagInputs, states, nodeMap, stack: subworkflowStack, callerNodeId: node.id }
                    }),
                    sandboxExecution: node.tool === 'workflow.foreach'
                };
                let result = null;
                const dependsOnOutputs = {};
                (node.dependsOn || []).forEach(depId => {
                    const s = states.get(depId);
                    if (s && s.output !== undefined) dependsOnOutputs[depId] = s.output;
                });
                const workflowBinding = metadata.workflowDependencyBinding && typeof metadata.workflowDependencyBinding === 'object'
                    ? metadata.workflowDependencyBinding
                    : {};
                const cacheKey = (dagSpec.cacheEnabled !== false && node.cache !== false && isCacheableDagTool(selectedTool))
                    ? computeDagNodeCacheKey({
                        tool: selectedTool.name || node.tool,
                        input: resolvedInput,
                        dependsOnOutputs,
                        workflowId: metadata.workflowId || metadata.workflow_id || run.workflow_id,
                        nodeKey: node.id,
                        scope: {
                            userId: user.id,
                            tenantId: run.tenant_id ?? user.tenant_id ?? user.tenantId,
                            workflowVersionId: metadata.workflowVersionId || metadata.workflow_version_id,
                            toolVersion: selectedTool.version,
                            modelId: modelCfg?.id || run.model_id,
                            modelName: modelCfg?.model_name || modelCfg?.name,
                            bindingVersionId: workflowBinding.versionId,
                            bindingUpdatedAt: workflowBinding.updatedAt
                        }
                    })
                    : null;
                const cachedHit = cacheKey ? getCachedNodeOutput(cacheKey) : null;
                if (cachedHit && cachedHit.hit) {
                    recordDagCacheResult('hit');
                    recordDagNodeResult({ tool: node.tool, status: 'cached' });
                    result = {
                        ok: true,
                        output: cachedHit.output,
                        attempt: 1,
                        startedAt: Date.now(),
                        startedAtText: getBeijingTimestamp(),
                        durationMs: 1,
                        cached: true
                    };
                } else {
                    if (cacheKey) recordDagCacheResult('miss');
                    result = await executeDagNodeWithPolicy({ run, user, modelCfg, node, resolvedInput, toolList, deadline, policy, stepIndex: nodeStepIndex, executionContext }, deps);
                    if (result?.ok && cacheKey) {
                        setCachedNodeOutput(cacheKey, result.output);
                    }
                }
                await deps.assertRunNotCancelled(run.id);
                if (!result.ok) {
                    result.error.dagAttempt = result.attempt;
                    result.error.dagDurationMs = result.durationMs;
                    throw result.error;
                }
                const { output } = result;
                const outputContractIssues = schemaHasRules(outputSchema)
                    ? validateValueAgainstSchema(outputValueForContract(output, node), outputSchema, {}, `${node.title || node.id} 输出`, [])
                    : [];
                if (outputContractIssues.length) {
                    const contractError = new Error(`节点输出不符合契约：${outputContractIssues[0]}`);
                    contractError.code = 'AGENT_DAG_OUTPUT_CONTRACT';
                    contractError.contractIssues = outputContractIssues;
                    contractError.dagAttempt = result.attempt;
                    contractError.dagDurationMs = result.durationMs;
                    throw contractError;
                }
                const preparedOutput = await persistDagOutput(output, { user });
                const compactOutput = compactPreparedDagOutput(output, preparedOutput.serialized, 12000);
                states.set(node.id, {
                    status: 'completed',
                    input: resolvedInput,
                    output,
                    compactOutput,
                    attemptCount: result.attempt,
                    cached: Boolean(result.cached),
                    durationMs: result.durationMs
                });
                await writeDagNode(run.id, node, {
                    status: 'completed',
                    input: resolvedInput,
                    output: preparedOutput.value,
                    outputSerialized: preparedOutput.serialized,
                    contractStatus: 'valid',
                    contractIssues: [],
                    attemptCount: result.attempt,
                    durationMs: result.durationMs,
                    completedAt: getBeijingTimestamp()
                });
                observations.push({
                    node: node.id,
                    title: node.title,
                    tool: node.tool,
                    input: resolvedInput,
                    output: compactOutput,
                    attempts: result.attempt,
                    cached: Boolean(result.cached),
                    durationMs: result.durationMs
                });
                await deps.insertStep(run.id, nodeStepIndex, {
                    type: 'dag',
                    nodeId: node.id,
                    title: `${result.cached ? '[快取复用] DAG 节点' : '完成 DAG 节点'}：${node.title || node.id}`,
                    toolName: node.tool,
                    input: resolvedInput,
                    output: compactOutput,
                    durationMs: result.durationMs,
                    contextHash: stepContext?.contextHash || ''
                });
                deps.finishAgentTraceSpan?.(nodeSpanId, {
                    output: { nodeId: node.id, result: compactOutput },
                    details: { nodeId: node.id, toolName: node.tool, contractStatus: 'valid', attempts: result.attempt },
                    durationMs: result.durationMs
                });
            } catch (e) {
                if (e.code === 'AGENT_APPROVAL_REQUIRED') {
                    if (!batchController.signal.aborted) batchController.abort(e);
                    deps.finishAgentTraceSpan?.(nodeSpanId, {
                        status: 'waiting',
                        details: { nodeId: node.id, toolName: node.tool, reason: 'approval_required' },
                        errorMessage: e.message
                    });
                    throw e;
                }
                if (e.code === 'AGENT_RECOVERY_REQUIRES_APPROVAL') {
                    const now = getBeijingTimestamp();
                    const recoveryKey = e.recoveryApprovalKey || `${node.tool}:${node.id}`;
                    const recoveryInput = e.recoveryApprovalInput || resolvedInput;
                    await deps.setRunMetadata(run.id, {
                        pendingApproval: {
                            tool: e.recoveryApprovalTool || node.tool,
                            key: recoveryKey,
                            input: recoveryInput,
                            inputHash: approvalInputHash(recoveryInput),
                            requestedAt: now,
                            expiresAt: getBeijingTimestamp(new Date(Date.now() + 15 * 60 * 1000)),
                            recovery: true
                        }
                    });
                    await deps.updateRun(run.id, {
                        status: 'approval_required',
                        error_message: '检测到未完成的非幂等工具调用，需要重新审批。',
                        updated_at: now,
                        last_heartbeat_at: now
                    });
                    if (!batchController.signal.aborted) batchController.abort(e);
                    deps.finishAgentTraceSpan?.(nodeSpanId, {
                        status: 'waiting',
                        details: { nodeId: node.id, toolName: node.tool, reason: 'recovery_approval_required' },
                        errorMessage: e.message
                    });
                    throw e;
                }
                if (['AGENT_RUN_CANCELLED', 'AGENT_TIMEOUT'].includes(e.code)) throw e;
                const attemptCount = Number(e.dagAttempt || Math.max(1, Number(policy.retryLimit || 0) + 1));
                const durationMs = Number(e.dagDurationMs || 0);
                const timedOut = e.code === 'AGENT_NODE_TIMEOUT';
                const errorInfo = buildDagErrorInfo(e, node, { attempt: attemptCount, timedOut });
                const fallback = policy.onError === 'fallback'
                    ? prepareDagFallbackOutput(node, outputSchema, errorInfo)
                    : null;
                if (fallback && !fallback.usable) {
                    errorInfo.fallbackRejected = true;
                    errorInfo.fallbackIssues = fallback.issues;
                }
                const fallbackApplied = Boolean(fallback?.usable);
                const status = policy.onError === 'continue' || fallbackApplied ? 'continued_error' : 'error';
                const failureOutput = {
                    error: e.message,
                    code: e.code || 'AGENT_DAG_NODE_ERROR',
                    timedOut,
                    onError: policy.onError,
                    errorInfo,
                    ...(policy.onError === 'continue' ? { continued: true } : {})
                };
                const persistedOutput = fallbackApplied ? fallback.output : failureOutput;
                states.set(node.id, {
                    status,
                    input: resolvedInput,
                    error: e.message,
                    errorInfo: fallbackApplied ? fallback.errorInfo : errorInfo,
                    fallbackApplied,
                    output: policy.onError === 'continue' || fallbackApplied ? persistedOutput : undefined,
                    attemptCount,
                    onError: policy.onError
                });
                await writeDagNode(run.id, node, {
                    status,
                    input: resolvedInput,
                    output: persistedOutput,
                    errorMessage: e.message,
                    errorInfo: fallbackApplied ? fallback.errorInfo : errorInfo,
                    contractStatus: timedOut ? 'timeout' : (e.contractIssues?.length ? 'invalid' : 'error'),
                    contractIssues: [...(e.contractIssues || []), ...(fallback && !fallback.usable ? fallback.issues : [])],
                    attemptCount,
                    durationMs,
                    completedAt: getBeijingTimestamp()
                });
                observations.push({ node: node.id, title: node.title, tool: node.tool, input: resolvedInput, error: e.message, errorInfo: fallbackApplied ? fallback.errorInfo : errorInfo, fallbackApplied, code: e.code || '', timedOut, onError: policy.onError, attempts: attemptCount });
                await deps.insertStep(run.id, nodeStepIndex, {
                    type: 'dag',
                    nodeId: node.id,
                    title: timedOut
                        ? `DAG 节点执行超时：${node.title || node.id}`
                        : (fallbackApplied
                            ? `DAG 节点失败，已使用兜底输出：${node.title || node.id}`
                            : (policy.onError === 'continue' ? `DAG 节点失败后继续：${node.title || node.id}` : `DAG 节点执行失败：${node.title || node.id}`)),
                    toolName: node.tool,
                    input: resolvedInput,
                    output: persistedOutput,
                    errorMessage: e.message,
                    status: 'error',
                    durationMs,
                    contextHash: stepContext?.contextHash || ''
                });
                deps.finishAgentTraceSpan?.(nodeSpanId, {
                    status: fallbackApplied ? 'completed' : 'error',
                    output: { nodeId: node.id, code: e.code || '', timedOut, onError: policy.onError, fallbackApplied },
                    details: { nodeId: node.id, toolName: node.tool, timedOut, fallbackApplied, errorInfo, contractIssues: e.contractIssues || [] },
                    errorMessage: e.message,
                    durationMs
                });
                if (policy.onError === 'stop') stopErrors.push(e);
            } finally {
                await deps.updateRun(run.id, { last_heartbeat_at: getBeijingTimestamp(), updated_at: getBeijingTimestamp() });
            }
        }));
        const rejected = batchResults.find(result => result.status === 'rejected');
        if (rejected) throw rejected.reason;
        if (stopErrors.length) throw stopErrors[0];
    }

    const failedNodes = dagSpec.nodes.filter(node => ['error', 'continued_error'].includes(states.get(node.id)?.status));
    const incompleteResultNodes = dagSpec.nodes.filter(node => (
        String(node.tool || '') === 'agent.content_review'
        && states.get(node.id)?.status === 'completed'
        && states.get(node.id)?.output?.reviewComplete === false
    ));
    const skippedNodes = dagSpec.nodes.filter(node => states.get(node.id)?.status === 'skipped');
    if (failedNodes.length || skippedNodes.length || incompleteResultNodes.length) {
        await deps.insertStep(run.id, stepIndex, {
            type: 'control',
            title: failedNodes.length
                ? 'DAG 完成，但存在失败节点'
                : (incompleteResultNodes.length ? 'DAG 完成，但存在未完整处理节点' : 'DAG 完成，但存在跳过节点'),
            output: {
                failedNodes: failedNodes.map(node => ({
                    id: node.id,
                    title: node.title,
                    error: states.get(node.id)?.error || ''
                })),
                skippedNodes: skippedNodes.map(node => ({ id: node.id, title: node.title })),
                incompleteResultNodes: incompleteResultNodes.map(node => ({ id: node.id, title: node.title }))
            },
            status: failedNodes.length || incompleteResultNodes.length ? 'error' : 'success'
        });
    }

    const answer = buildIncompleteDagAnswer(dagSpec, states)
        || buildDagFallbackFinalAnswer(dagSpec, states)
        || `工作流执行完成，共 ${dagSpec.nodes.length} 个节点。`;
    await deps.updateRun(run.id, {
        status: failedNodes.length || incompleteResultNodes.length ? 'completed_with_errors' : 'completed',
        final_answer: answer,
        error_message: failedNodes.length
            ? `DAG 失败节点数：${failedNodes.length}`
            : (incompleteResultNodes.length ? `DAG 未完整处理节点数：${incompleteResultNodes.length}` : ''),
        completed_at: getBeijingTimestamp(),
        last_heartbeat_at: getBeijingTimestamp(),
        updated_at: getBeijingTimestamp()
    });
    await deps.createAgentNotification(
        user.id,
        run.id,
        failedNodes.length || incompleteResultNodes.length ? 'warning' : 'completed',
        failedNodes.length || incompleteResultNodes.length ? 'DAG 运行已完成，但存在未完成结果' : 'DAG 运行已完成',
        deps.getAgentRunTitle(run)
    );
}

module.exports = {
    calculateDagRetryDelayMs,
    buildDagErrorInfo,
    buildDagFallbackFinalAnswer,
    buildIncompleteDagAnswer,
    executeDagNodeWithPolicy,
    executeWorkflowIteration,
    extractReadableDagOutput,
    persistedDagOutput,
    runAgentDag,
    prepareDagFallbackOutput,
    upsertDagNode
};
