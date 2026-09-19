const crypto = require('crypto');
const { queryOne, execute } = require('../db/client');
const { getBeijingTimestamp } = require('../time');
const { assertWorkflowLlmNodesConfigured, normalizeDagRunInputs, resolveAgentWorkflowVersion } = require('./agent-workflows');
const { resolveAgentWorkflowDependencyBindings } = require('./agent-workflow-dependencies');
const { normalizeDagNodePolicy, resolveDagInputValue, resolveDagNodeInput, evaluateDagWhen, dagJoinConditionSatisfied, getDagNodeRouteState } = require('./agent-dag-utils');
const { listDagNodes } = require('./agent-runs');
const { clampText, findAgentToolByName } = require('./agent-tool-runtime');
const { normalizeToolInput } = require('./agent-policy');
const { inspectDagTopology, normalizeDagSpec } = require('./agent-validators');
const { normalizeJsonSchema, schemaHasRules } = require('./agent-dag-contracts');
const { recordWorkflowInvocationResult, recordWorkflowIterationItemResult } = require('./agent-governance-metrics');

function buildInvocationId(runId, invocationPath) {
    return crypto.createHash('sha256').update(`${String(runId || '')}\u0000${String(invocationPath || '')}`).digest('hex').slice(0, 64);
}

function compactInvocationOutput(value, maxChars = 120000) {
    let serialized = '';
    try { serialized = JSON.stringify(value); } catch (_) { serialized = JSON.stringify({ text: clampText(value, maxChars) }); }
    if (serialized.length <= maxChars) return value;
    return { __partial: true, originalChars: serialized.length, text: serialized.slice(0, maxChars), warning: '子工作流完整输出已由节点输出持久化，调用实例仅保存受限预览。' };
}

async function writeInvocation(deps, payload) {
    if (typeof deps?.upsertSubworkflowInvocation === 'function') return await deps.upsertSubworkflowInvocation(payload);
    const now = getBeijingTimestamp();
    return await execute(`
        INSERT INTO agent_workflow_invocations (
            invocation_id, run_id, parent_invocation_id, caller_node_key, workflow_id, workflow_version_id, workflow_version,
            invocation_path, status, input_json, output_json, error_message, created_at, updated_at, completed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(invocation_id) DO UPDATE SET
            status = excluded.status, output_json = excluded.output_json, error_message = excluded.error_message,
            updated_at = excluded.updated_at, completed_at = excluded.completed_at
    `, [
        payload.invocationId, payload.runId, payload.parentInvocationId || null, payload.callerNodeId || '',
        payload.workflowId, payload.workflowVersionId || null, payload.workflowVersion || null, payload.executionPath,
        payload.status, JSON.stringify(payload.input || {}), payload.output === undefined ? null : JSON.stringify(compactInvocationOutput(payload.output)),
        String(payload.error || '').slice(0, 4000), now, now, payload.completedAt ? now : null
    ]);
}

async function readInvocation(deps, runId, executionPath) {
    if (typeof deps?.getSubworkflowInvocation === 'function') return await deps.getSubworkflowInvocation(runId, executionPath);
    return await queryOne('SELECT * FROM agent_workflow_invocations WHERE run_id = ? AND invocation_path = ?', [runId, executionPath]);
}

function normalizeIterationInput(input = {}) {
    const items = Array.isArray(input.items) ? input.items : null;
    if (!items) throw new Error('逐项调用子工作流需要数组输入。');
    const workflowId = Number.parseInt(input.workflowId ?? input.workflow_id, 10);
    if (!workflowId) throw new Error('逐项调用子工作流需要选择有效的工作流。');
    const maxItems = Math.max(1, Math.min(Number.parseInt(input.maxItems ?? input.max_items, 10) || 1000, 1000));
    if (items.length > maxItems) throw new Error(`逐项调用子工作流最多处理 ${maxItems} 项，当前输入为 ${items.length} 项。`);
    return {
        items, workflowId, version: String(input.version || 'published').trim() || 'published', goal: input.goal,
        inputs: input.inputs && typeof input.inputs === 'object' && !Array.isArray(input.inputs) ? input.inputs : { item: '{{item}}', itemIndex: '{{itemIndex}}' },
        concurrency: Math.max(1, Math.min(Number.parseInt(input.concurrency, 10) || 1, 10)),
        onItemError: ['stop', 'continue', 'drop'].includes(String(input.onItemError || input.on_item_error || 'stop')) ? String(input.onItemError || input.on_item_error || 'stop') : 'stop'
    };
}

function createSubworkflowRuntime({ executeDagNodeWithPolicy, buildDagErrorInfo, prepareDagFallbackOutput, buildDagFallbackFinalAnswer, extractReadableDagOutput, upsertDagNode }) {
    async function executeWorkflowIteration({ input, run, user, modelCfg, toolList, deadline, deps, parentContext = {}, invocation = {} }) {
        const config = normalizeIterationInput(input);
        const results = new Array(config.items.length), errors = [];
        let cursor = 0, stoppedOnError = false;
        const baseExecutionPath = String(invocation.executionPath || parentContext.executionPath || '').trim();
        const parentInvocationId = String(invocation.parentInvocationId || parentContext.invocationId || '').trim();
        const callerNodeId = String(invocation.callerNodeId || parentContext.callerNodeId || 'iteration').trim() || 'iteration';
        const workerCount = config.onItemError === 'stop' ? 1 : Math.min(config.concurrency, config.items.length || 1);
        const executeItem = async index => {
            const item = config.items[index];
            const variableContext = { goal: run.goal, inputs: parentContext.dagInputs || {}, states: parentContext.states || new Map(), nodeMap: parentContext.nodeMap || new Map(), item, itemIndex: index };
            const childInputs = resolveDagNodeInput({ input: config.inputs }, variableContext);
            const childGoal = typeof config.goal === 'string' ? resolveDagInputValue(config.goal, variableContext) : (run.goal || '');
            try {
                const child = await executeSubworkflowDag({
                    input: { workflowId: config.workflowId, version: config.version, goal: childGoal, inputs: childInputs }, run, user, modelCfg, toolList, deadline, deps,
                    stack: parentContext.stack || [], invocation: { parentInvocationId, callerNodeId: `${callerNodeId}:item:${index}`, executionPath: baseExecutionPath, iterationMode: true }
                });
                results[index] = { inputIndex: index, status: 'completed', value: child.output, outputs: child.outputs, invocationId: child.invocationId, workflowId: child.workflowId, version: child.version, versionId: child.versionId };
                recordWorkflowIterationItemResult({ status: 'completed' });
            } catch (error) {
                const entry = { inputIndex: index, status: 'error', error: String(error?.message || error || '逐项子工作流执行失败').slice(0, 4000) };
                results[index] = entry; errors.push(entry); recordWorkflowIterationItemResult({ status: 'error' });
                if (config.onItemError === 'stop') stoppedOnError = true;
            }
        };
        const worker = async () => {
            while (!stoppedOnError) {
                const index = cursor; cursor += 1;
                if (index >= config.items.length) return;
                await executeItem(index);
            }
        };
        await Promise.all(Array.from({ length: workerCount }, () => worker()));
        const collected = config.onItemError === 'drop' ? results.filter(item => item?.status === 'completed') : results.slice(0, cursor).map(item => item || null);
        return { items: collected, count: collected.length, inputCount: config.items.length, processedCount: results.filter(Boolean).length, errors, stoppedOnError, workflowId: config.workflowId, version: errors.length ? null : (collected.find(item => item?.version)?.version || null) };
    }

    async function executeSubworkflowDag({ input, run, user, modelCfg, toolList, deadline, deps, stack = [], invocation = {} }) {
        const workflowId = Number.parseInt(input.workflowId ?? input.workflow_id, 10);
        if (!workflowId) throw new Error('子工作流节点需要选择有效的工作流。');
        if (stack.includes(workflowId)) throw new Error(`检测到子工作流循环调用：${[...stack, workflowId].join(' -> ')}`);
        if (stack.length >= 3) throw new Error('子工作流最多允许嵌套 3 层。');
        const callerNodeId = String(invocation.callerNodeId || 'root').trim() || 'root';
        const executionPath = [...String(invocation.executionPath || '').split('/').filter(Boolean), `subworkflow:${callerNodeId}:${workflowId}`].join('/');
        const existingInvocation = await readInvocation(deps, run.id, executionPath);
        const fixedVersion = Number.parseInt(existingInvocation?.workflow_version, 10) || null;
        const resolveWorkflowVersion = deps.resolveAgentWorkflowVersion || resolveAgentWorkflowVersion;
        const resolveWorkflowBindings = deps.resolveAgentWorkflowDependencyBindings || resolveAgentWorkflowDependencyBindings;
        const sourceWorkflow = await resolveWorkflowVersion(workflowId, user, fixedVersion ? String(fixedVersion) : (input.version || 'published'), { allowPinnedVersion: Boolean(fixedVersion) });
        if (!sourceWorkflow) throw new Error(`子工作流不存在或无权访问：${workflowId}`);
        const resolved = await resolveWorkflowBindings(sourceWorkflow, user);
        const dagSpec = normalizeDagSpec(resolved.dagSpec), topology = inspectDagTopology(dagSpec);
        if (topology.blockers.length) throw new Error(`子工作流结构无效：${topology.blockers[0]}`);
        assertWorkflowLlmNodesConfigured(dagSpec);
        if (invocation.iterationMode === true) {
            const blocked = dagSpec.nodes.find(node => {
                const tool = findAgentToolByName(node.tool, toolList);
                return !tool || tool.side_effect === true || tool.approval_required === true || ['workflow.approval', 'workflow.delay', 'workflow.foreach', 'workflow.iteration'].includes(String(node.tool || ''));
            });
            if (blocked) {
                const error = new Error(`逐项调用子工作流暂不支持副作用、审批、延时或循环节点：${blocked.title || blocked.id}`);
                error.code = 'AGENT_ITERATION_SUBWORKFLOW_UNSAFE'; error.nodeId = blocked.id; throw error;
            }
        }
        const dagInputs = normalizeDagRunInputs(input.inputs || {}), childRun = { ...run, goal: String(input.goal || run.goal || '') };
        const nodeMap = new Map(dagSpec.nodes.map(node => [node.id, node])), states = new Map(dagSpec.nodes.map(node => [node.id, { status: 'pending' }]));
        const childStack = [...stack, workflowId], invocationId = buildInvocationId(run.id, executionPath);
        const invocationState = {
            invocationId, runId: run.id, parentInvocationId: invocation.parentInvocationId || '', callerNodeId, workflowId,
            workflowVersionId: sourceWorkflow.version_id, workflowVersion: sourceWorkflow.version, executionPath,
            input: { goal: childRun.goal, inputs: dagInputs, workflowDigest: crypto.createHash('sha256').update(JSON.stringify(dagSpec)).digest('hex') }, status: 'running'
        };
        await writeInvocation(deps, invocationState);
        try {
            const invocationNodeKey = node => `${executionPath}:${node.tool}:${node.id}`;
            const readNodes = deps.listDagNodes || listDagNodes, writeNode = deps.upsertDagNode || upsertDagNode;
            const persisted = new Map((await readNodes(run.id)).filter(item => String(item.node_key || '').startsWith(`${executionPath}:`)).map(item => [String(item.node_key || '').split(':').at(-1), item]));
            const terminal = new Set(['completed', 'continued_error', 'error', 'skipped']);
            for (const node of dagSpec.nodes) {
                const existing = persisted.get(node.id);
                if (!existing || !terminal.has(existing.status)) await writeNode(run.id, node, { nodeKey: invocationNodeKey(node), status: 'pending' });
            }
            dagSpec.nodes.forEach(node => {
                const existing = persisted.get(node.id);
                if (existing && terminal.has(existing.status)) states.set(node.id, { status: existing.status, input: existing.input || {}, output: existing.output, error: existing.error_message || '', compactOutput: clampText(existing.output, 12000) });
            });
            while ([...states.values()].some(state => state.status === 'pending')) {
                await deps.assertRunNotCancelled(run.id);
                const ready = dagSpec.nodes.filter(node => states.get(node.id)?.status === 'pending' && node.dependsOn.every(dep => ['completed', 'continued_error', 'error', 'skipped'].includes(states.get(dep)?.status)));
                if (!ready.length) throw new Error(`子工作流“${resolved.workflow.name}”执行停滞。`);
                for (const node of ready) {
                    const depStates = node.dependsOn.map(dep => states.get(dep)?.status), routeState = getDagNodeRouteState(node, dagSpec, states);
                    if (!dagJoinConditionSatisfied(node, depStates, routeState, states)) {
                        const skipReason = node.joinMode === 'any_active' && routeState.routed && !routeState.active ? 'route_not_matched' : 'dependency_not_satisfied';
                        states.set(node.id, { status: 'skipped', skipReason });
                        await writeNode(run.id, node, { nodeKey: invocationNodeKey(node), status: 'skipped', output: { status: 'skipped', reason: skipReason }, completedAt: getBeijingTimestamp() });
                        continue;
                    }
                    const when = evaluateDagWhen(node.when, { goal: childRun.goal, inputs: dagInputs, states, nodeMap });
                    if (when.skipped || (routeState.routed && !routeState.active)) {
                        const reason = when.skipped ? when.reason : 'route_not_matched';
                        states.set(node.id, { status: 'skipped', skipReason: reason });
                        await writeNode(run.id, node, { nodeKey: invocationNodeKey(node), status: 'skipped', output: { status: 'skipped', reason }, completedAt: getBeijingTimestamp() });
                        continue;
                    }
                    const selectedTool = findAgentToolByName(node.tool, toolList);
                    if (!selectedTool) throw new Error(`子工作流节点工具不可用：${node.tool || '-'}`);
                    const resolvedInput = normalizeToolInput(node.tool, resolveDagNodeInput(node, { goal: childRun.goal, inputs: dagInputs, states, nodeMap }), { ...childRun, model_id: childRun.model_id ?? modelCfg?.id, chosen_model_id: childRun.chosen_model_id ?? modelCfg?.id });
                    const approvalKey = invocationNodeKey(node);
                    const workflowApprovalResult = node.tool === 'workflow.approval' ? await deps.waitForWorkflowApproval({ run, user, node, input: resolvedInput, key: approvalKey }) : null;
                    const workflowDelayResult = node.tool === 'workflow.delay' ? await deps.waitForWorkflowDelay({ run, node, input: resolvedInput, key: approvalKey }) : null;
                    if (node.tool !== 'workflow.approval' && await deps.maybePauseForApproval(run, selectedTool, resolvedInput, approvalKey)) {
                        const error = new Error('子工作流节点需要工具审批。'); error.code = 'AGENT_APPROVAL_REQUIRED'; throw error;
                    }
                    const policy = normalizeDagNodePolicy(node, childRun, deps.agentToolTimeoutMs, selectedTool);
                    const explicitOutputSchema = normalizeJsonSchema(node.outputSchema || node.output_schema || {});
                    const outputSchema = schemaHasRules(explicitOutputSchema) ? explicitOutputSchema : normalizeJsonSchema(selectedTool?.output_schema || selectedTool?.outputSchema || {});
                    const executionContext = {
                        dagInputs, workflowApprovalResult, workflowDelayResult, budget: deps.taskBudget, approvalKey,
                        approvalGranted: deps.isApprovalGranted(run, selectedTool.name, approvalKey, resolvedInput), allowApproval: true, invocationId, executionPath,
                        executeSubworkflow: childInput => executeSubworkflowDag({ input: childInput, run, user, modelCfg, toolList, deadline, deps, stack: childStack, invocation: { parentInvocationId: invocationId, callerNodeId: node.id, executionPath, iterationMode: invocation.iterationMode === true } }),
                        executeIteration: iterationInput => executeWorkflowIteration({ input: iterationInput, run, user, modelCfg, toolList, deadline, deps, parentContext: { dagInputs, states, nodeMap, stack: childStack, executionPath, invocationId, callerNodeId: node.id } })
                    };
                    const result = await executeDagNodeWithPolicy({ run: childRun, user, modelCfg, node, resolvedInput, toolList, deadline, policy, stepIndex: 0, executionContext }, deps);
                    if (result.ok) {
                        states.set(node.id, { status: 'completed', input: resolvedInput, output: result.output, compactOutput: clampText(result.output, 12000) });
                        await writeNode(run.id, node, { nodeKey: invocationNodeKey(node), status: 'completed', input: resolvedInput, output: result.output, attemptCount: result.attempt, durationMs: result.durationMs, completedAt: getBeijingTimestamp() });
                        continue;
                    }
                    const errorInfo = buildDagErrorInfo(result.error, node, { attempt: result.attempt });
                    const fallback = policy.onError === 'fallback' ? prepareDagFallbackOutput(node, outputSchema, errorInfo) : null;
                    if (fallback && !fallback.usable) { errorInfo.fallbackRejected = true; errorInfo.fallbackIssues = fallback.issues; }
                    const fallbackApplied = Boolean(fallback?.usable), continued = policy.onError === 'continue' || fallbackApplied;
                    const output = fallbackApplied ? fallback.output : { error: result.error.message, continued: true, errorInfo };
                    const status = continued ? 'continued_error' : 'error';
                    states.set(node.id, { status, input: resolvedInput, error: result.error.message, errorInfo: fallbackApplied ? fallback.errorInfo : errorInfo, fallbackApplied, ...(continued ? { output } : {}) });
                    await writeNode(run.id, node, { nodeKey: invocationNodeKey(node), status, input: resolvedInput, ...(continued ? { output } : {}), errorMessage: result.error.message, errorInfo: fallbackApplied ? fallback.errorInfo : errorInfo, contractIssues: fallback && !fallback.usable ? fallback.issues : [], attemptCount: result.attempt, durationMs: result.durationMs, completedAt: getBeijingTimestamp() });
                    if (policy.onError === 'stop') throw result.error;
                }
            }
            const outputs = {};
            dagSpec.nodes.filter(node => node.tool === 'workflow.output').forEach(node => {
                const value = states.get(node.id)?.output;
                if (value?.name) outputs[value.name] = value.presentation === 'table' ? { value: value.value, format: value.format, presentation: value.presentation, table: value.table, text: value.text } : value.presentation === 'file' ? { value: value.value, format: value.format, presentation: value.presentation, file: value.file, text: value.text } : value.value;
            });
            const failedNodes = dagSpec.nodes.filter(node => states.get(node.id)?.status === 'error');
            if (failedNodes.length) {
                const failed = failedNodes[0], error = new Error(`子工作流“${resolved.workflow.name}”节点失败：${failed.title || failed.id}；${states.get(failed.id)?.error || '未知错误'}`);
                error.code = 'AGENT_SUBWORKFLOW_NODE_FAILED'; error.nodeId = failed.id;
                error.failedNodes = failedNodes.map(node => ({ id: node.id, title: node.title || node.id, error: states.get(node.id)?.error || '' }));
                throw error;
            }
            const fallback = buildDagFallbackFinalAnswer(dagSpec, states), outputNames = Object.keys(outputs);
            const output = outputNames.length === 1 ? outputs[outputNames[0]] : (outputNames.length ? outputs : fallback);
            const result = { workflowId, workflowName: resolved.workflow.name, version: resolved.version, versionId: resolved.version_id, invocationId, executionPath, output, outputs, text: extractReadableDagOutput(output) || fallback };
            await writeInvocation(deps, { ...invocationState, status: 'completed', output: result, completedAt: true });
            recordWorkflowInvocationResult({ status: 'completed' });
            return result;
        } catch (error) {
            await writeInvocation(deps, { ...invocationState, status: 'error', error: error.message, completedAt: true }).catch(() => {});
            recordWorkflowInvocationResult({ status: 'error' });
            throw error;
        }
    }
    return { executeSubworkflowDag, executeWorkflowIteration, writeSubworkflowInvocation: writeInvocation };
}

module.exports = { createSubworkflowRuntime, normalizeIterationInput };
